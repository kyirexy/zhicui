"""
API route definitions for VideoCapsule.
"""

from __future__ import annotations

import json
import traceback
from typing import Any
from urllib.parse import unquote

import requests as http_requests
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.auth import get_current_user, get_current_user_optional, get_current_admin
from app.models.note import Note
from app.models.user import User as UserModel, list_users, count_users
from app.services import ai_juicer, note_service, plan_service, video_extractor, settings_service, audit_service
from app.services import auth_service
from app.services.video_extractor import _detect_platform
from app.services.wechat_extractor import extract_wechat_article

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class Envelope(BaseModel):
    """Standard response envelope."""
    success: bool
    data: Any = None
    error: str | None = None


class VideoURLRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


class ExtractRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)
    username: str = Field(..., min_length=2, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: Any) -> dict:
    return {"success": True, "data": data, "error": None}


def _err(msg: str) -> dict:
    return {"success": False, "data": None, "error": msg}


# ---------------------------------------------------------------------------
# Content type display labels (for progress messages)
# ---------------------------------------------------------------------------

_TYPE_LABELS: dict[str, str] = {
    "recipe": "食谱",
    "insight": "洞察",
    "history": "历史",
    "product": "产品",
    "plan": "计划",
    "general": "通用知识",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/health")
def health_check() -> dict:
    """Simple liveness probe."""
    return _ok({"status": "ok", "service": "zhicui-knowbrew"})


# ---------------------------------------------------------------------------
# Auth endpoints — email + password + JWT
# ---------------------------------------------------------------------------

@router.post("/api/auth/register")
def auth_register(body: RegisterRequest, db: Session = Depends(get_db)) -> dict:
    user, error = auth_service.register(db, body.email, body.password, body.username)
    if error:
        return _err(error)
    token = auth_service.create_access_token(user.id, user.email)
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/login")
def auth_login(body: LoginRequest, db: Session = Depends(get_db)) -> dict:
    token, user, error = auth_service.login(db, body.email, body.password)
    if error:
        return _err(error)
    return _ok({"token": token, "user": user.to_dict()})


@router.get("/api/auth/me")
def auth_me(
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(current_user.to_dict())


@router.post("/api/video/info")
def get_video_info(
    body: VideoURLRequest,
    current_user: UserModel = Depends(get_current_user_optional),
) -> dict:
    """Parse a video link and return metadata without downloading."""
    try:
        info = video_extractor.parse_video_info(body.url)
        return _ok(info)
    except Exception as exc:
        return _err(f"解析视频链接失败: {exc}")


@router.post("/api/extract")
def extract(
    body: ExtractRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Full pipeline: parse -> transcribe -> AI -> save -> return note."""
    try:
        platform = _detect_platform(body.url)

        # ── Xiaohongshu path: note content IS the transcript ──────────────
        if platform == "xiaohongshu":
            from app.services.xhs_extractor import parse_xhs_note, extract_xhs_content
            import os as _os
            cookie = _os.environ.get('XHS_COOKIE', '')
            note_data = parse_xhs_note(body.url, cookie=cookie)
            video_info = {
                "video_id": note_data.get("note_id", ""),
                "title": note_data.get("title", "小红书笔记"),
                "download_url": "",
                "platform": "xiaohongshu",
            }
            transcript = extract_xhs_content(body.url, cookie=cookie)

            if not transcript or not transcript.strip():
                return _err("未能从小红书笔记中提取到文本内容。")

            # AI processing -- mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            # Save to database
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

            # Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id

            result = note.to_dict()
            result["plan_id"] = plan_id
            return _ok(result)

        # ── WeChat path: article content IS the transcript ──────────────
        if platform == "wechat":
            article = extract_wechat_article(body.url)
            video_info = {
                "video_id": article["video_id"],
                "title": article["title"],
                "download_url": article["download_url"],
                "platform": "wechat",
            }
            transcript = article["content"]

            if not transcript or not transcript.strip():
                return _err("未能从微信公众号文章中提取到文本内容。")

            # AI processing — mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            # Save to database
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

            # Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id

            result = note.to_dict()
            result["plan_id"] = plan_id
            return _ok(result)

        # ── Video path (Douyin / Bilibili) ──────────────────────────────
        # 1. Parse video metadata
        video_info = video_extractor.parse_video_info(body.url)

        # 2. Extract transcript (with fallback)
        transcript = None

        # Try primary ASR (SiliconFlow/DashScope) — config from DB (admin-tunable)
        asr_cfg = settings_service.get_asr_config(db)
        if asr_cfg["api_key"]:
            try:
                transcript = video_extractor.extract_transcript(
                    body.url,
                    asr_cfg["api_key"],
                    asr_cfg["api_base_url"],
                    asr_cfg["model"],
                )
            except Exception:
                traceback.print_exc()
                # Fall through to local ASR

        # Fallback: local yt-dlp + faster-whisper
        if not transcript or not transcript.strip():
            try:
                transcript = video_extractor.fallback_local_asr(body.url)
            except Exception:
                traceback.print_exc()
                return _err("语音识别失败，请稍后重试或检查视频链接。")

        # 3. AI processing — mini agent chain
        use_images = False
        if not transcript or not transcript.strip():
            # Try image-based extraction as fallback
            video_url = video_info.get("download_url") or video_info.get("url", "")
            frames = ai_juicer.extract_video_frames(video_url)
            if frames:
                ai_result = ai_juicer.generate_card_from_images(
                    frames, video_info["title"],
                )
                if ai_result:
                    use_images = True
                    transcript = "[no audio transcript — analysed from video frames]"
                else:
                    return _err("未能从视频中提取到文本内容，截图分析也失败了。")
            else:
                return _err("未能从视频中提取到文本内容。")

        if not use_images:
            # Mini Agent 1: classify intent
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            # Mini Agent 2: generate plan (if applicable)
            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            # Mini Agent 3: generate card
            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            # Attach plan data to ai_result for persistence
            if plan_data:
                ai_result["plan"] = plan_data

        # 4. Save to database
        note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

        # 5. Auto-create plan
        plan_id: str | None = None
        plan = ai_result.get("plan")
        if isinstance(plan, dict) and plan.get("tasks"):
            fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
            days_data = plan.get("days") or []
            plan_obj = plan_service.create_plan(
                db=db,
                note_id=note.id,
                title=plan.get("goal") or note.video_title,
                user_id=current_user.id,
                fields=fields,
                tasks=tasks,
                total_days=total_days,
                days=days_data,
            )
            plan_id = plan_obj.id

        result = note.to_dict()
        result["plan_id"] = plan_id
        return _ok(result)

    except NotImplementedError as exc:
        return _err(str(exc))
    except Exception as exc:
        # Log the full traceback on the server for debugging.
        traceback.print_exc()
        return _err(f"处理失败: {exc}")


@router.get("/api/extract/stream")
def extract_stream(
    url: str = Query(..., min_length=1, description="Douyin share link"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
):
    """Full pipeline with SSE progress events.

    Returns ``text/event-stream`` with one event per pipeline step.
    Each event is a JSON line::

        data: {"step":"parse","message":"...","status":"active"}

    Final event has ``step: "done"`` with ``data`` containing the note.
    """
    def _event(step: str, message: str, status: str = "active", data: Any = None) -> str:
        payload: dict[str, Any] = {"step": step, "message": message, "status": status}
        if data is not None:
            payload["data"] = data
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def _generate():
        try:
            platform = _detect_platform(url)

            # ═══ WeChat path: article content IS the transcript ═══════════
            if platform == "wechat":
                yield _event("parse", "正在获取微信公众号文章...", "active")
                article = extract_wechat_article(url)
                video_info = {
                    "video_id": article["video_id"],
                    "title": article["title"],
                    "download_url": article["download_url"],
                    "platform": "wechat",
                }
                transcript = article["content"]
                yield _event("parse", f"文章获取完成：{video_info.get('title', '未知标题')}", "done")

                if not transcript or not transcript.strip():
                    yield _event("transcribe", "未能从微信公众号文章中提取到文本内容", "error")
                    yield _event("error", "未能从微信公众号文章中提取到文本内容。", "error")
                    return

                char_count = len(transcript)
                yield _event("transcribe", f"文章文本提取完成，共 {char_count} 字", "done")

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

                # Save to database
                yield _event("save", "正在保存笔记...", "active")
                note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)
                yield _event("save", "保存成功", "done")

                # Auto-create plan
                plan_id: str | None = None
                plan = ai_result.get("plan")
                if isinstance(plan, dict) and plan.get("tasks"):
                    fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                    days_data = plan.get("days") or []
                    plan_obj = plan_service.create_plan(
                        db=db,
                        note_id=note.id,
                        title=plan.get("goal") or note.video_title,
                        user_id=current_user.id,
                        fields=fields,
                        tasks=tasks,
                        total_days=total_days,
                        days=days_data,
                    )
                    plan_id = plan_obj.id
                    yield _event("plan", "已为文章中的计划自动建立任务清单", "done")

                result = note.to_dict()
                result["plan_id"] = plan_id
                yield _event("done", "提取完成", "done", result)
                return

            # ═══ Video path (Douyin / Bilibili) ════════════════════════════
            # Step 1: Parse video metadata
            yield _event("parse", "正在解析视频链接...", "active")
            try:
                video_info = video_extractor.parse_video_info(url)
                yield _event("parse", f"解析完成：{video_info.get('title', '未知标题')}", "done")
            except NotImplementedError as exc:
                yield _event("parse", f"解析失败: {exc}", "error")
                yield _event("error", str(exc), "error")
                return
            except Exception as exc:
                traceback.print_exc()
                yield _event("parse", f"解析失败: {exc}", "error")
                yield _event("error", str(exc), "error")
                return

            # Step 2: Extract transcript
            yield _event("transcribe", "正在提取视频文案...", "active")
            transcript: str | None = None

            asr_cfg = settings_service.get_asr_config(db)
            if asr_cfg["api_key"]:
                try:
                    transcript = video_extractor.extract_transcript(
                        url,
                        asr_cfg["api_key"],
                        asr_cfg["api_base_url"],
                        asr_cfg["model"],
                    )
                except Exception:
                    traceback.print_exc()

            if not transcript or not transcript.strip():
                try:
                    yield _event("transcribe", "本地语音识别启动,长视频需要1-3分钟,请耐心等待...", "active")
                    transcript = video_extractor.fallback_local_asr(url)
                except Exception:
                    traceback.print_exc()
                    yield _event("transcribe", "文案提取失败，请稍后重试或检查视频链接。", "error")
                    yield _event("error", "语音识别失败，请稍后重试或检查视频链接。", "error")
                    return

            use_images = False
            if not transcript or not transcript.strip():
                # Try image-based extraction
                video_url = video_info.get("download_url") or video_info.get("url", "")
                frames = ai_juicer.extract_video_frames(video_url)
                if frames:
                    yield _event("ai", f"未提取到音频文案，正在分析 {len(frames)} 张视频截图...", "active")
                    ai_result = ai_juicer.generate_card_from_images(frames, video_info["title"])
                    if ai_result:
                        use_images = True
                        transcript = "[no audio — analysed from video frames]"
                        yield _event("transcribe", f"截图分析完成，共 {len(frames)} 张", "done")
                    else:
                        yield _event("transcribe", "未能从视频中提取到文本内容", "error")
                        yield _event("error", "未能从视频中提取到文本内容，截图分析也失败。", "error")
                        return
                else:
                    yield _event("transcribe", "未能从视频中提取到文本内容", "error")
                    yield _event("error", "未能从视频中提取到文本内容。", "error")
                    return

            if not use_images:
                char_count = len(transcript)
                yield _event("transcribe", f"文案提取完成，共 {char_count} 字", "done")

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

            # Step 4: Save to database
            yield _event("save", "正在保存笔记...", "active")
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)
            yield _event("save", "保存成功", "done")

            # Step 5: Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id
                yield _event("plan", "已为视频中的计划自动建立任务清单", "done")


            result = note.to_dict()
            result["plan_id"] = plan_id
            yield _event("done", "提取完成", "done", result)

        except Exception as exc:
            traceback.print_exc()
            yield _event("error", f"处理失败: {exc}", "error")

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/api/notes")
def list_notes(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return a paginated list of saved notes."""
    notes, total = note_service.list_notes(db, page=page, per_page=per_page, user_id=current_user.id)
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [n.to_dict() for n in notes],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/notes/{note_id}")
def get_note(note_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    """Fetch a single note by ID. Includes plan_id if a plan exists."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    result = note.to_dict()
    # Attach plan_id for plan-type notes so the frontend can show a CTA.
    if note.card_type == "plan":
        plan = plan_service.get_plan_by_note(db, note_id)
        result["plan_id"] = plan.id if plan else None
    else:
        result["plan_id"] = None
    return _ok(result)


# ---------------------------------------------------------------------------
# Plan endpoints
# ---------------------------------------------------------------------------

class AddTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    day: int | None = None
    scheduled_at: str | None = None
    reminder_at: str | None = None


@router.get("/api/plans")
def list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    plans, total = plan_service.list_plans(db, page=page, per_page=per_page)
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [p.to_dict() for p in plans],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/plans/stats")
def get_plan_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    stats = plan_service.get_plan_stats(db)
    return _ok(stats)


@router.get("/api/plans/{plan_id}")
def get_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.get_plan(db, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}/tasks/{task_id}")
def toggle_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.toggle_task(db, plan_id, task_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.post("/api/plans/{plan_id}/tasks")
def add_plan_task(plan_id: str, body: AddTaskRequest, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.add_task(
        db, plan_id,
        title=body.title,
        day=body.day,
        scheduled_at=body.scheduled_at,
        reminder_at=body.reminder_at,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}/tasks/{task_id}")
def delete_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.delete_task(db, plan_id, task_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    deleted = plan_service.delete_plan(db, plan_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok({"deleted": True})


@router.get("/api/video/proxy")
def proxy_video(
    url: str = Query(..., min_length=1, description="Douyin video play URL"),
    note_id: str = Query("", description="Optional note ID to refresh expired URL"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
):
    """Proxy a video stream with Douyin-required headers.

    If ``note_id`` is provided and the stored video URL has expired, we re-parse
    the share link to get a fresh play URL (requires a source_url to be saved).

    Returns a ``video/mp4`` stream suitable for a ``<video>`` element.
    """
    target_url = unquote(url)

    # Try to refresh the URL if a note_id is given and the URL looks expired.
    if note_id:
        note = note_service.get_note(db, note_id, user_id=current_user.id)
        if note is not None:
            # Re-extract a fresh video URL from the source share link.
            try:
                fresh_info = video_extractor.parse_video_info(
                    f"https://www.douyin.com/video/{note.video_id}"
                )
                fresh_url = fresh_info.get("download_url") or fresh_info.get("url", "")
                if fresh_url:
                    target_url = fresh_url
            except Exception:
                pass  # use the original target_url

    VIDEO_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 "
            "Version/17.0 Mobile/15E148 Safari/604.1"
        ),
        "Referer": "https://www.douyin.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
    }

    try:
        resp = http_requests.get(
            target_url,
            headers=VIDEO_HEADERS,
            stream=True,
            timeout=30,
            allow_redirects=True,
        )
        resp.raise_for_status()

        content_length = resp.headers.get("content-length", "")
        headers = {
            "Content-Type": "video/mp4",
            "Cache-Control": "public, max-age=86400",
        }
        if content_length:
            headers["Content-Length"] = content_length

        def _iter():
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        return StreamingResponse(
            _iter(),
            media_type="video/mp4",
            headers=headers,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"视频代理失败: {exc}")


# ---------------------------------------------------------------------------
# Admin endpoints — manage users (admin only)
# ---------------------------------------------------------------------------
def _validate_http_url(value: str, field: str) -> None:
    """Validate http(s) URL or empty. Raises HTTPException(400) on invalid."""
    if not value:
        return
    from urllib.parse import urlparse
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{field} 必须是合法的 http/https URL")


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP (X-Forwarded-For or client host)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


class AdminUserPatch(BaseModel):
    is_active: bool | None = None
    is_admin: bool | None = None
    username: str | None = None
    email: str | None = None


@router.get("/api/admin/stats")
def admin_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan
    from sqlalchemy import func as _func

    recent_users_rows = (
        db.query(UserModel).order_by(UserModel.created_at.desc()).limit(5).all()
    )
    recent_users = [
        {
            "username": u.username or u.email,
            "email": u.email,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in recent_users_rows
    ]

    type_rows = (
        db.query(Note.card_type, _func.count(Note.id)).group_by(Note.card_type).all()
    )
    type_dist = {ct or "general": cnt for ct, cnt in type_rows}

    return _ok({
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
        "recent_users": recent_users,
        "type_dist": type_dist,
    })


@router.get("/api/admin/users")
def admin_list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按邮箱或用户名模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    query = db.query(UserModel)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (UserModel.email.ilike(like)) | (UserModel.username.ilike(like))
        )
    total = query.count()
    users = (
        query.order_by(UserModel.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return _ok({
        "items": [u.to_dict() for u in users],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.patch("/api/admin/users/{user_id}")
def admin_patch_user(
    user_id: str,
    body: AdminUserPatch,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")

    # Guard: cannot disable or demote yourself (would lock you out).
    if user_id == current_user.id:
        if body.is_active is False:
            return _err("不能禁用自己")
        if body.is_admin is False:
            return _err("不能取消自己的管理员权限")

    # Guard: must keep at least one enabled admin.
    demoting_admin = user.is_admin and (body.is_admin is False or body.is_active is False)
    if demoting_admin:
        active_admins = (
            db.query(UserModel)
            .filter(UserModel.is_admin.is_(True), UserModel.is_active.is_(True))
            .count()
        )
        if active_admins <= 1:
            return _err("至少保留一个启用的管理员")

    if body.is_active is not None:
        user.is_active = body.is_active
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.username is not None:
        new_username = body.username.strip()
        if len(new_username) < 2:
            return _err("用户名至少 2 个字符")
        dup = (
            db.query(UserModel)
            .filter(UserModel.username == new_username, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该用户名已被使用")
        user.username = new_username
    if body.email is not None:
        new_email = body.email.strip().lower()
        if "@" not in new_email:
            return _err("邮箱格式无效")
        dup = (
            db.query(UserModel)
            .filter(UserModel.email == new_email, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该邮箱已被使用")
        user.email = new_email
    db.commit()
    db.refresh(user)
    # Audit: record the specific action taken.
    if body.is_admin is not None:
        action = "user_promote" if body.is_admin else "user_demote"
    elif body.is_active is not None:
        action = "user_enable" if body.is_active else "user_disable"
    elif body.username is not None or body.email is not None:
        action = "user_edit"
    else:
        action = None
    if action:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action=action,
            target_type="user",
            target_id=user_id,
            detail={"username": user.username or user.email},
            ip=_client_ip(request),
        )
    return _ok(user.to_dict())


@router.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if user_id == current_user.id:
        return _err("不能删除自己")
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    username = user.username or user.email
    db.delete(user)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_delete",
        target_type="user",
        target_id=user_id,
        detail={"username": username},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


class AdminResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=128)


@router.get("/api/admin/users/{user_id}")
def admin_get_user_detail(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """用户详情聚合：基本信息 + 笔记/计划计数 + 最近 5 条笔记 + 最近 3 条计划。"""
    from app.models.plan import Plan

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    notes_count = db.query(Note).filter(Note.user_id == user_id).count()
    plans_count = db.query(Plan).filter(Plan.user_id == user_id).count()
    recent_notes = (
        db.query(Note)
        .filter(Note.user_id == user_id)
        .order_by(Note.created_at.desc())
        .limit(5)
        .all()
    )
    recent_plans = (
        db.query(Plan)
        .filter(Plan.user_id == user_id)
        .order_by(Plan.created_at.desc())
        .limit(3)
        .all()
    )
    return _ok({
        **user.to_dict(),
        "notes_count": notes_count,
        "plans_count": plans_count,
        "recent_notes": [
            {
                "id": n.id,
                "video_title": n.video_title,
                "card_type": n.card_type,
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in recent_notes
        ],
        "recent_plans": [
            {
                "id": p.id,
                "title": p.title,
                "status": p.status,
                "total_days": p.total_days,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in recent_plans
        ],
    })


@router.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_user_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """管理员重置任意用户密码。新密码经 werkzeug 哈希后存储。"""
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    user.hashed_password = auth_service.hash_password(body.new_password)
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_reset_password",
        target_type="user",
        target_id=user_id,
        detail={"username": user.username or user.email},
        ip=_client_ip(request),
    )
    return _ok({"reset": True})


# ---------------------------------------------------------------------------
# Admin endpoints — runtime LLM/ASR configuration (no restart needed)
# ---------------------------------------------------------------------------
class LlmConfigRequest(BaseModel):
    model: str | None = None
    api_base: str | None = None
    api_key: str | None = None  # None/empty = leave unchanged


class AsrConfigRequest(BaseModel):
    api_key: str | None = None
    api_base_url: str | None = None
    model: str | None = None


@router.get("/api/admin/llm-config")
def admin_get_llm_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_llm_config_masked(db))


@router.put("/api/admin/llm-config")
def admin_put_llm_config(
    body: LlmConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    # Validate api_base format before persisting (SSRF guard).
    if body.api_base:
        _validate_http_url(body.api_base, "API Base")
    changed: dict = {}
    if body.model is not None:
        settings_service.set_setting(db, settings_service.LLM_MODEL_KEY, body.model)
        changed["model"] = body.model
    if body.api_base is not None:
        settings_service.set_setting(db, settings_service.LLM_API_BASE_KEY, body.api_base)
        changed["api_base"] = body.api_base
    if body.api_key:  # empty string = leave unchanged
        settings_service.set_secret(db, settings_service.LLM_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="llm_config_update",
            target_type="config",
            target_id="llm",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_llm_config_masked(db))


@router.get("/api/admin/asr-config")
def admin_get_asr_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_asr_config_masked(db))


@router.put("/api/admin/asr-config")
def admin_put_asr_config(
    body: AsrConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if body.api_base_url:
        _validate_http_url(body.api_base_url, "API Base URL")
    changed: dict = {}
    if body.api_key:  # empty = leave unchanged
        settings_service.set_secret(db, settings_service.ASR_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if body.api_base_url is not None:
        settings_service.set_setting(db, settings_service.ASR_API_BASE_URL_KEY, body.api_base_url)
        changed["api_base_url"] = body.api_base_url
    if body.model is not None:
        settings_service.set_setting(db, settings_service.ASR_MODEL_KEY, body.model)
        changed["model"] = body.model
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="asr_config_update",
            target_type="config",
            target_id="asr",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_asr_config_masked(db))


# ---------------------------------------------------------------------------
# Admin endpoints — note management
# ---------------------------------------------------------------------------
@router.get("/api/admin/notes")
def admin_list_notes(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    card_type: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = note_service.list_notes_admin(
        db, page=page, per_page=per_page, search=search, card_type=card_type
    )
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/notes/{note_id}")
def admin_delete_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    title = note.video_title if note else None
    if not note_service.delete_note(db, note_id):
        return _err("笔记不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_delete",
        target_type="note",
        target_id=note_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


@router.post("/api/admin/notes/{note_id}/re-extract")
def admin_re_extract_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return _err("笔记不存在")
    transcript = note.transcript_raw or ""
    if not transcript.strip():
        return _err("该笔记没有转录文本，无法重新抽取")
    # Re-run AI on the existing transcript with current LLM config.
    content_type = ai_juicer.detect_content_type(transcript)
    ai_result = ai_juicer.generate_card(transcript, content_type, note.video_title)
    note = note_service.update_note_ai(db, note, ai_result)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_reextract",
        target_type="note",
        target_id=note_id,
        detail={"title": note.video_title, "content_type": content_type},
        ip=_client_ip(request),
    )
    return _ok(note.to_dict())


class AdminBatchDeleteNotesRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=200)


@router.post("/api/admin/notes/batch-delete")
def admin_batch_delete_notes(
    body: AdminBatchDeleteNotesRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    deleted = 0
    titles: list[str] = []
    for nid in body.ids:
        note = db.query(Note).filter(Note.id == nid).first()
        if note:
            titles.append(note.video_title)
            db.delete(note)
            deleted += 1
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_batch_delete",
        target_type="note",
        target_id=",".join(body.ids[:8]),
        detail={"count": deleted, "titles": titles[:5]},
        ip=_client_ip(request),
    )
    return _ok({"deleted": deleted})


# ---------------------------------------------------------------------------
# Admin endpoints — audit log viewer
# ---------------------------------------------------------------------------
@router.get("/api/admin/audit-logs")
def admin_list_audit_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = audit_service.list_audit_logs(
        db, page=page, per_page=per_page, action=action
    )
    # Join admin username for display.
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    return _ok({
        "items": [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


# ---------------------------------------------------------------------------
# Admin endpoints — plan management
# ---------------------------------------------------------------------------
@router.get("/api/admin/plans")
def admin_list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按标题模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan

    query = db.query(Plan)
    if q:
        query = query.filter(Plan.title.ilike(f"%{q.strip()}%"))
    total = query.count()
    plans = (
        query.order_by(Plan.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    user_ids = {p.user_id for p in plans if p.user_id}
    user_map: dict[str, str] = {}
    if user_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
        user_map = {r.id: (r.username or r.email) for r in rows}
    items = [{
        "id": p.id,
        "title": p.title,
        "user_id": p.user_id,
        "author": user_map.get(p.user_id, ""),
        "status": p.status,
        "total_days": p.total_days,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    } for p in plans]
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/plans/{plan_id}")
def admin_delete_plan(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    plan = plan_service.get_plan(db, plan_id)
    title = plan.title if plan else None
    if not plan_service.delete_plan(db, plan_id):
        return _err("计划不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="plan_delete",
        target_type="plan",
        target_id=plan_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


# ---------------------------------------------------------------------------
# Admin endpoints — config connection test
# ---------------------------------------------------------------------------
@router.post("/api/admin/llm-config/test")
def admin_test_llm_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current LLM config with a minimal completion request."""
    cfg = settings_service.get_llm_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    try:
        from litellm import completion
        kwargs: dict = {
            "model": cfg["model"],
            "messages": [{"role": "user", "content": "请只回复两个字：成功"}],
            "max_tokens": 16,
            "timeout": 20,
        }
        if cfg["api_base"]:
            kwargs["api_base"] = cfg["api_base"]
        kwargs["api_key"] = cfg["api_key"]
        resp = completion(**kwargs)
        reply = (resp.choices[0].message.content or "").strip()
        audit_service.log_action(
            db, admin_user_id=current_user.id, action="llm_config_test",
            target_type="config", target_id="llm", ip=_client_ip(request),
        )
        return _ok({"ok": True, "reply": reply[:80], "model": cfg["model"]})
    except Exception as e:
        return _ok({"ok": False, "error": str(e)[:200]})


@router.post("/api/admin/asr-config/test")
def admin_test_asr_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current ASR config by probing the endpoint with the configured key.

    A 400/422 on an empty audio payload means the key was accepted (auth ok)
    and only the payload was rejected — that counts as a pass. 401/403 means
    the key is invalid.
    """
    cfg = settings_service.get_asr_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    if not cfg["api_base_url"]:
        return _ok({"ok": False, "error": "未配置 API Base URL"})
    try:
        headers = {"Authorization": f"Bearer {cfg['api_key']}"}
        files = {"file": ("test.wav", b"", "audio/wav"), "model": (None, cfg["model"])}
        r = http_requests.post(cfg["api_base_url"], headers=headers, files=files, timeout=20)
        if r.status_code in (401, 403):
            return _ok({"ok": False, "error": f"API Key 无效 (HTTP {r.status_code})", "status": r.status_code})
        if r.status_code in (400, 422):
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "Key 有效（空音频被拒绝属正常）", "status": r.status_code})
        if r.status_code == 200:
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "连接成功", "status": 200})
        return _ok({"ok": False, "error": f"HTTP {r.status_code}: {r.text[:120]}", "status": r.status_code})
    except Exception as e:
        return _ok({"ok": False, "error": str(e)[:200]})


# ---------------------------------------------------------------------------
# Admin endpoints — system info (read-only, no secrets exposed)
# ---------------------------------------------------------------------------
@router.get("/api/admin/system-info")
def admin_system_info(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Read-only system info for the settings page. Secret keys are reported
    only as booleans (set / not set), never plaintext."""
    from app.models.plan import Plan

    db_type = "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite"
    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    return _ok({
        "db_type": db_type,
        "llm_model": llm_cfg["model"],
        "llm_api_base": llm_cfg["api_base"] or "(官方默认)",
        "llm_key_set": bool(llm_cfg["api_key_masked"]),
        "asr_model": asr_cfg["model"],
        "asr_api_base_url": asr_cfg["api_base_url"],
        "asr_key_set": bool(asr_cfg["api_key_masked"]),
        "encryption_key_set": bool(settings.ENCRYPTION_KEY),
        "jwt_secret_set": bool(settings.JWT_SECRET),
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
    })


# ---------------------------------------------------------------------------
# Admin endpoints — operations dashboard (health + table counts + recent audit)
# ---------------------------------------------------------------------------
@router.get("/api/admin/ops")
def admin_ops(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """运维概览：各表行数、最近 5 条审计、密钥配置状态。只读，不暴露明文。"""
    from app.models.plan import Plan
    from app.models.admin_audit_log import AdminAuditLog

    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    items, _ = audit_service.list_audit_logs(db, page=1, per_page=5)
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    recent = [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items]

    return _ok({
        "table_counts": {
            "users": count_users(db),
            "notes": db.query(Note).count(),
            "plans": db.query(Plan).count(),
            "audit_logs": db.query(AdminAuditLog).count(),
        },
        "recent_audit": recent,
        "keys": {
            "llm_key_set": bool(llm_cfg["api_key_masked"]),
            "asr_key_set": bool(asr_cfg["api_key_masked"]),
            "encryption_key_set": bool(settings.ENCRYPTION_KEY),
            "jwt_secret_set": bool(settings.JWT_SECRET),
        },
        "db_type": "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite",
    })
