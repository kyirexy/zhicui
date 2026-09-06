"""官网案例公开读取与管理员 CMS；草稿文件始终要求 Bearer 管理员认证。"""
from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin
from app.core.database import get_db
from app.models.showcase_case import ShowcaseCase, utcnow
from app.services import showcase_case_service as service

router = APIRouter()


class CaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="", max_length=160)
    industry: str = Field(default="", max_length=80)
    person_name: str = Field(default="", max_length=80)
    role: str = Field(default="", max_length=120)
    summary: str = Field(default="", max_length=1200)
    challenge: str = Field(default="", max_length=6000)
    workflow: str = Field(default="", max_length=6000)
    outcome: str = Field(default="", max_length=6000)
    source_url: str | None = Field(default=None, max_length=2048)
    source_label: str = Field(default="", max_length=160)
    authenticity_confirmed: bool = Field(default=False, strict=True)
    published: bool = Field(default=False, strict=True)
    sort_order: int = Field(default=0, ge=-10000, le=10000, strict=True)

    @field_validator("source_url")
    @classmethod
    def validate_source(cls, value: str | None) -> str | None:
        if not value:
            return None
        try:
            parsed = urlsplit(value)
            if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                    or parsed.username or parsed.password or any(char.isspace() or ord(char) < 32 for char in value)):
                raise ValueError("来源地址必须是完整的 HTTP 或 HTTPS 链接")
        except ValueError as exc:
            raise ValueError("来源地址必须是完整的 HTTP 或 HTTPS 链接") from exc
        return value


def ok(data):
    return {"success": True, "data": data, "error": None}


@router.get("/api/showcase-cases")
def public_cases(response: Response, db: Session = Depends(get_db)):
    """仅展示已确认真实性并发布的案例；下架立即对新请求生效。"""
    response.headers["Cache-Control"] = "no-store"
    rows = db.query(ShowcaseCase).filter(ShowcaseCase.published.is_(True), ShowcaseCase.authenticity_confirmed.is_(True)).order_by(ShowcaseCase.sort_order, ShowcaseCase.id.desc()).all()
    return ok([service.as_dict(item) for item in rows])


@router.get("/api/admin/showcase-cases")
def admin_cases(response: Response, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """管理员查看包括草稿的全部案例。"""
    response.headers["Cache-Control"] = "no-store"
    rows = db.query(ShowcaseCase).order_by(ShowcaseCase.sort_order, ShowcaseCase.id.desc()).all()
    return ok([service.as_dict(item, admin=True) for item in rows])


@router.post("/api/admin/showcase-cases")
def create_case(body: CaseInput, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """先建立草稿，再上传媒体并复核发布。"""
    with service.upload_lock(service.media_root()):
        item = ShowcaseCase(**body.model_dump())
        service.ensure_publishable(item)
        db.add(item)
        try:
            db.flush()
            service.audit(db, admin.id, "showcase_create", item, {"published": item.published})
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return ok(service.as_dict(item, admin=True))


@router.patch("/api/admin/showcase-cases/{case_id}")
def update_case(case_id: int, body: CaseInput, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """只修改明确提交的字段；发布必须具备文字、媒体和授权确认。"""
    with service.upload_lock(service.media_root()):
        item = service.get_case(db, case_id, lock=True)
        changes = body.model_dump(exclude_unset=True)
        try:
            content_changed = any(key in service.TEXT_FIELDS and getattr(item, key) != value for key, value in changes.items())
            for key, value in changes.items():
                setattr(item, key, value)
            if content_changed:
                item.published = False
                item.authenticity_confirmed = False
            service.ensure_publishable(item)
            item.updated_at = utcnow()
            service.audit(db, admin.id, "showcase_update", item, {"fields": sorted(changes), "published": item.published})
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return ok(service.as_dict(item, admin=True))


@router.delete("/api/admin/showcase-cases/{case_id}")
def delete_case(case_id: int, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """删除案例及其关联媒体，保留管理员审计记录。"""
    with service.upload_lock(service.media_root()):
        item = service.get_case(db, case_id, lock=True)
        media, poster = item.media_name, item.poster_name
        try:
            service.audit(db, admin.id, "showcase_delete", item, {})
            db.delete(item)
            db.commit()
        except BaseException:
            db.rollback()
            raise
        service.remove_file(media)
        service.remove_file(poster)
    return ok({"deleted": True})


@router.post("/api/admin/showcase-cases/{case_id}/media")
async def upload_case_media(case_id: int, request: Request, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """管理员认证后流式接收单个 file；替换成功后回到草稿等待再次确认。"""
    item = await service.replace_media(db, request, case_id, admin.id)
    return ok(service.as_dict(item, admin=True))


def file_response(db: Session, case_id: int, *, public: bool, poster: bool = False):
    item = service.get_case(db, case_id, public=public)
    path = service.media_path(item.poster_name if poster else item.media_name)
    if not path.is_file():
        raise HTTPException(404, "案例媒体不存在")
    return FileResponse(path, media_type="image/jpeg" if poster else item.media_type, headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline", "X-Robots-Tag": "noindex",
    })


@router.get("/api/showcase-cases/{case_id}/media")
def public_case_media(case_id: int, db: Session = Depends(get_db)):
    """仅提供当前发布案例媒体，支持浏览器视频范围请求。"""
    return file_response(db, case_id, public=True)


@router.get("/api/showcase-cases/{case_id}/poster")
def public_case_poster(case_id: int, db: Session = Depends(get_db)):
    """仅提供当前发布案例的静止预览。"""
    return file_response(db, case_id, public=True, poster=True)


@router.get("/api/admin/showcase-cases/{case_id}/media")
def admin_case_media(case_id: int, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """使用管理员 Bearer 预览草稿，令牌不进入媒体 URL。"""
    return file_response(db, case_id, public=False)


@router.get("/api/admin/showcase-cases/{case_id}/poster")
def admin_case_poster(case_id: int, db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    """使用管理员 Bearer 查看草稿首帧。"""
    return file_response(db, case_id, public=False, poster=True)
