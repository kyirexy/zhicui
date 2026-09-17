"""「创作工坊」视频创作 API(Hypit SVML → MP4)。

全部端点 user-scoped(envelope {success, data, error});创作(LLM 生成 SVML)
在后台线程执行并即时可见地推进状态,渲染由 video_creation_worker 串行消费。
功能默认关闭:HYPIT_ENABLED 环境开关 + 管理员 system_settings 副开关共同控制。
"""

from __future__ import annotations

import json
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin, get_current_user
from app.core.database import get_db
from app.models.user import User
from app.models.video_creation import VideoCreationJob
from app.services import audit_service, hypit_service, settings_service, video_creation_author
from app.services.hypit_service import HYPIHUB_KEY_SETTING, HypitError

router = APIRouter()

# 管理员运行时副开关的 system_settings 键;env 开 + 管理员开才可用。
FEATURE_TOGGLE_KEY = "hypit_enabled"
MAX_JOBS_PER_USER = 30


def _ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


def _error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"success": False, "data": None, "error": message},
    )


def _feature_unavailable(db: Session) -> str:
    """返回不可用原因;空串表示可用。"""
    from app.core.config import settings

    if not settings.HYPIT_ENABLED:
        return "创作工坊暂未开启"
    if settings_service.get_setting(db, FEATURE_TOGGLE_KEY, "true").strip().lower() in {
        "false", "0", "off"
    }:
        return "创作工坊已由管理员暂停"
    if not hypit_service.cli_available():
        return "服务器渲染组件尚未就绪,请稍后再试"
    return ""


class JobCreateInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    requirement_text: str = Field(min_length=1, max_length=4000)


class JobIterateInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    feedback: str = Field(min_length=1, max_length=2000)


def _get_owned_job(db: Session, job_id: str, user: User) -> VideoCreationJob:
    job = db.get(VideoCreationJob, job_id)
    if job is None or job.user_id != user.id:
        raise HTTPException(404, "创作任务不存在")
    return job


def _author_task(job_id: str, requirement: str, feedback: str) -> None:
    """后台创作线程:生成/迭代 SVML 并写回;失败时保持原稿并记录原因。"""
    from app.core.database import SessionLocal
    from app.models.video_creation import _utcnow

    try:
        with SessionLocal() as db:
            job = db.get(VideoCreationJob, job_id)
            if job is None or job.status != "drafting":
                return  # 已被取消
            current_svml = job.svml_text
            stored_requirement = job.requirement_text
        if feedback and current_svml:
            svml, explanation = video_creation_author.iterate_svml(
                job_id, current_svml, stored_requirement or requirement, feedback
            )
        else:
            svml, explanation = video_creation_author.draft_svml(job_id, requirement)
        with SessionLocal() as db:
            job = db.get(VideoCreationJob, job_id)
            if job is None or job.status != "drafting":
                return  # 创作期间被取消:丢弃结果
            job.svml_text = svml
            job.explanation = explanation
            job.status = "draft"
            job.error = ""
            job.updated_at = _utcnow()
            db.commit()
    except HypitError as exc:
        _author_fail(job_id, exc.message)
    except Exception as exc:  # noqa: BLE001 - 后台线程必须自愈
        from app.services import error_log_service

        error_log_service.record_exception_safely(
            exc, source="video_creation_author", metadata={"job_id": job_id}
        )
        _author_fail(job_id, "AI 创作出现意外错误,请稍后重试")


def _author_fail(job_id: str, message: str) -> None:
    from app.core.database import SessionLocal
    from app.models.video_creation import _utcnow

    with SessionLocal() as db:
        job = db.get(VideoCreationJob, job_id)
        if job is None:
            return
        if job.svml_text:
            # 迭代失败:保留原稿,用户可以直接再试。
            job.status = "draft"
        else:
            job.status = "failed"
        job.error = message
        job.updated_at = _utcnow()
        db.commit()


@router.post("/api/video-creation/jobs")
def create_job(
    body: JobCreateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """提交需求 → drafting;后台生成 SVML 草稿,前端轮询详情查看进度。"""
    unavailable = _feature_unavailable(db)
    if unavailable:
        return _error(503, unavailable)
    existing = db.scalars(
        select(VideoCreationJob)
        .where(VideoCreationJob.user_id == user.id)
        .order_by(VideoCreationJob.created_at.desc())
    ).all()
    if len(existing) >= MAX_JOBS_PER_USER:
        return _error(
            429, f"每个账号最多保留 {MAX_JOBS_PER_USER} 个创作,请先取消不用的创作"
        )
    job = VideoCreationJob(
        user_id=user.id, requirement_text=body.requirement_text, status="drafting"
    )
    db.add(job)
    db.commit()
    threading.Thread(
        target=_author_task,
        args=(job.id, body.requirement_text, ""),
        name=f"video-creation-author-{job.id}",
        daemon=True,
    ).start()
    return _ok(job.as_dict())


@router.get("/api/video-creation/jobs")
def list_jobs(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = db.scalars(
        select(VideoCreationJob)
        .where(VideoCreationJob.user_id == user.id)
        .order_by(VideoCreationJob.created_at.desc())
        .limit(MAX_JOBS_PER_USER)
    ).all()
    return _ok([job.as_dict() for job in rows])


@router.get("/api/video-creation/jobs/{job_id}")
def get_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _ok(_get_owned_job(db, job_id, user).as_dict())


@router.post("/api/video-creation/jobs/{job_id}/confirm")
def confirm_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """确认草稿 → 同步估价 → 入队渲染。估价失败保持 draft 并给出原因。"""
    unavailable = _feature_unavailable(db)
    if unavailable:
        return _error(503, unavailable)
    job = _get_owned_job(db, job_id, user)
    if job.status != "draft" or not job.svml_text:
        return _error(400, "当前状态无法确认渲染,请等待 AI 创作完成")
    directory = hypit_service.write_project(
        job.id, svml_text=job.svml_text, svrun_text=job.svrun_text or None
    )
    try:
        pricing = hypit_service.price_project(directory)
        job.pricing_json = json.dumps(pricing, ensure_ascii=False)[:8000]
        job.status = "queued"
        job.error = ""
        db.commit()
    except HypitError as exc:
        db.rollback()
        job.error = exc.message
        db.commit()
        return _error(400, exc.message)
    return _ok(job.as_dict())


@router.post("/api/video-creation/jobs/{job_id}/iterate")
def iterate_job(
    job_id: str,
    body: JobIterateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """按反馈修改草稿;draft/failed(有稿)状态可用,失败时保留原稿。"""
    unavailable = _feature_unavailable(db)
    if unavailable:
        return _error(503, unavailable)
    job = _get_owned_job(db, job_id, user)
    if job.status not in {"draft", "failed"} or not job.svml_text:
        return _error(400, "当前状态无法修改,请等待 AI 创作完成或重新发起创作")
    job.status = "drafting"
    job.error = ""
    if not job.requirement_text:
        job.requirement_text = body.feedback
    db.commit()
    threading.Thread(
        target=_author_task,
        args=(job.id, job.requirement_text, body.feedback),
        name=f"video-creation-iterate-{job.id}",
        daemon=True,
    ).start()
    return _ok(job.as_dict())


@router.post("/api/video-creation/jobs/{job_id}/cancel")
def cancel_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.models.video_creation import _utcnow

    job = _get_owned_job(db, job_id, user)
    if job.status not in {"drafting", "queued", "rendering"}:
        return _error(400, "当前状态无法取消")
    job.status = "cancelled"
    job.updated_at = _utcnow()
    db.commit()
    return _ok(job.as_dict())


@router.get("/api/video-creation/jobs/{job_id}/video")
def job_video(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """成品 MP4 走认证流播;令牌不进入媒体 URL。"""
    job = _get_owned_job(db, job_id, user)
    if job.status != "completed" or not job.output_filename:
        raise HTTPException(404, "成品尚未生成")
    path = hypit_service.job_dir(job.id) / job.output_filename
    if not path.is_file():
        raise HTTPException(404, "成品文件不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "inline",
            "X-Robots-Tag": "noindex",
        },
    )


class VideoCreationAdminConfigInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    admin_enabled: bool | None = None
    api_key: str | None = Field(default=None, max_length=400)


def _admin_enabled(db: Session) -> bool:
    stored = settings_service.get_setting(db, FEATURE_TOGGLE_KEY, "true").strip().lower()
    return stored not in {"false", "0", "off"}


@router.get("/api/admin/video-creation-config")
def admin_get_video_creation_config(
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    """创作工坊管理配置:双层开关状态 + 渲染组件就绪度 + HypiHub key 掩码。"""
    del admin
    from app.core.config import settings

    api_key = settings_service.get_secret(db, HYPIHUB_KEY_SETTING)
    return _ok({
        "env_enabled": settings.HYPIT_ENABLED,
        "admin_enabled": _admin_enabled(db),
        "enabled": settings.HYPIT_ENABLED and _admin_enabled(db),
        "cli_available": hypit_service.cli_available(),
        "api_key_masked": settings_service.mask_key(api_key),
    })


@router.put("/api/admin/video-creation-config")
def admin_put_video_creation_config(
    body: VideoCreationAdminConfigInput,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    """保存管理员副开关与 HypiHub key(Fernet 加密落库);env 未开时仅保存不生效。"""
    from app.core.config import settings

    changed: dict = {}
    if body.admin_enabled is not None:
        settings_service.set_setting(
            db, FEATURE_TOGGLE_KEY, "true" if body.admin_enabled else "false"
        )
        changed["admin_enabled"] = body.admin_enabled
    if body.api_key:
        settings_service.set_secret(db, HYPIHUB_KEY_SETTING, body.api_key)
        changed["api_key"] = "***updated***"
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=admin.id,
            action="video_creation_config_update",
            target_type="config",
            target_id="video-creation",
            detail=changed,
            ip=request.client.host if request.client else None,
        )
    api_key = settings_service.get_secret(db, HYPIHUB_KEY_SETTING)
    return _ok({
        "env_enabled": settings.HYPIT_ENABLED,
        "admin_enabled": _admin_enabled(db),
        "enabled": settings.HYPIT_ENABLED and _admin_enabled(db),
        "cli_available": hypit_service.cli_available(),
        "api_key_masked": settings_service.mask_key(api_key),
    })
