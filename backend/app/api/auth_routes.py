"""Authentication, desktop handoff, feedback, and client diagnostics routes."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models.user import User as UserModel, get_user_by_id
from app.services import (
    activity_service,
    auth_service,
    desktop_handoff_service,
    error_log_service,
    feedback_service,
    privacy_account_service,
)

router = APIRouter()


class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)
    username: str = Field(..., min_length=2, max_length=128)
    accepted_terms: bool = False
    accepted_privacy: bool = False
    terms_version: str = Field(default="", max_length=24)
    privacy_version: str = Field(default="", max_length=24)
    client_type: Literal["web", "windows", "macos", "android", "ios"] = "web"


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=128)


class DesktopHandoffRequest(BaseModel):
    session_id: str = Field(..., min_length=32, max_length=64)


class ClientErrorRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    stack: str = Field(default="", max_length=16000)
    path: str = Field(default="", max_length=512)
    error_type: str = Field(default="ClientError", max_length=128)
    environment: Literal["web", "capacitor"] = "web"
    component: str = Field(default="", max_length=128)
    digest: str = Field(default="", max_length=128)


class FeedbackCreateRequest(BaseModel):
    category: Literal["bug", "suggestion", "content", "account", "other"]
    subject: str = Field(..., min_length=2, max_length=160)
    content: str = Field(..., min_length=5, max_length=2000)
    page_path: str = Field(default="", max_length=512)
    platform: Literal["web", "android", "capacitor"] = "web"
    user_agent: str = Field(default="", max_length=512)
    viewport: str = Field(default="", max_length=64)
    app_version: str = Field(default="", max_length=64)


def _ok(data: object) -> dict[str, object]:
    return {"success": True, "data": data, "error": None}


def _err(message: str) -> dict[str, object]:
    return {"success": False, "data": None, "error": message}


def _auth_error_category(error: str | None) -> str:
    return {
        "账号不存在": "account_not_found",
        "密码错误": "invalid_password",
        "账号已被禁用": "inactive_account",
        "该邮箱已注册，请直接登录": "email_already_registered",
        "该用户名已被使用": "username_already_registered",
    }.get(str(error or ""), "validation_failed")


@router.post("/api/auth/register")
def auth_register(body: RegisterRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    user, error = privacy_account_service.register_with_consent(
        db, email=body.email, password=body.password, username=body.username,
        accepted_terms=body.accepted_terms, accepted_privacy=body.accepted_privacy,
        terms_version=body.terms_version, privacy_version=body.privacy_version,
        client_type=body.client_type,
    )
    if error:
        activity_service.log_activity_safely(
            user_id=None, action="account_register", method="POST", path="/api/auth/register",
            status_code=400, ip=request.client.host if request.client else None,
            detail={"outcome": "failed", "error_category": _auth_error_category(error)},
        )
        return _err(error)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id, action="account_register", method="POST", path="/api/auth/register",
        status_code=200, ip=request.client.host if request.client else None,
        detail={"outcome": "success"},
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/login")
def auth_login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    token, user, error = auth_service.login(db, body.email, body.password)
    if error:
        activity_service.log_activity_safely(
            user_id=user.id if user is not None else None, action="account_login", method="POST",
            path="/api/auth/login", status_code=401, ip=request.client.host if request.client else None,
            detail={"outcome": "failed", "error_category": _auth_error_category(error)},
        )
        return _err(error)
    activity_service.log_activity_safely(
        user_id=user.id, action="account_login", method="POST", path="/api/auth/login",
        status_code=200, ip=request.client.host if request.client else None,
        detail={"outcome": "success"},
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/dev-session", include_in_schema=False)
def auth_dev_session(request: Request, db: Session = Depends(get_db)) -> dict:
    if not settings.DEV_AUTH_BYPASS:
        raise HTTPException(status_code=404, detail="Not Found")
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="开发会话仅允许本机访问")
    user = auth_service.get_or_create_dev_user(db)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id, action="account_dev_session", method="POST", path="/api/auth/dev-session",
        status_code=200, ip=request.client.host if request.client else None,
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/desktop-handoff/request", include_in_schema=False)
def desktop_handoff_request(body: DesktopHandoffRequest, db: Session = Depends(get_db)) -> dict:
    session_id = desktop_handoff_service.normalize_session_id(body.session_id)
    if session_id is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    handoff = desktop_handoff_service.create_handoff(db, session_id)
    if handoff is None:
        raise HTTPException(status_code=409, detail="该登录票据已存在，请重新发起")
    return _ok({"status": handoff.status, "expires_at": handoff.expires_at.isoformat()})


@router.post("/api/auth/desktop-handoff/claim", include_in_schema=False)
def desktop_handoff_claim(
    body: DesktopHandoffRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    session_id = desktop_handoff_service.normalize_session_id(body.session_id)
    if session_id is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    result = desktop_handoff_service.claim_handoff(db, session_id, current_user.id)
    messages = {
        "not_found": (404, "登录票据不存在或已过期"),
        "expired": (410, "登录票据已过期，请返回客户端重新发起"),
        "already_consumed": (409, "登录票据已被使用"),
        "already_claimed": (409, "登录票据已被其他账号声明"),
    }
    if result in messages:
        status, detail = messages[result]
        raise HTTPException(status_code=status, detail=detail)
    return _ok({"status": "claimed"})


@router.get("/api/auth/desktop-handoff/status/{session_id}", include_in_schema=False)
def desktop_handoff_status(session_id: str, db: Session = Depends(get_db)) -> dict:
    normalized = desktop_handoff_service.normalize_session_id(session_id)
    if normalized is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    desktop_handoff_service.expire_stale(db)
    status, user_id = desktop_handoff_service.consume_handoff(db, normalized)
    if status == "not_found":
        return _err("登录票据不存在或已过期")
    if status == "pending":
        return _ok({"status": "pending"})
    if status in {"expired", "consumed"}:
        return _err("登录票据已过期或已被使用，请返回客户端重新发起")
    user = get_user_by_id(db, user_id) if user_id else None
    if user is None:
        return _err("登录用户不存在，请返回客户端重新发起")
    return _ok({"status": "success", "token": auth_service.create_access_token(user.id, user.email), "user": user.to_dict()})


@router.get("/api/auth/me")
def auth_me(current_user: UserModel = Depends(get_current_user)) -> dict:
    return _ok(current_user.to_dict())


@router.post("/api/client-errors")
def report_client_error(body: ClientErrorRequest, request: Request, current_user: UserModel = Depends(get_current_user)) -> dict:
    error_log_service.record_error_safely(
        source="frontend", severity="error", error_type=body.error_type, message=body.message,
        traceback=body.stack or None, method="CLIENT", path=body.path, user_id=current_user.id,
        ip=request.client.host if request.client else None,
        metadata={"environment": body.environment, "component": body.component, "digest": body.digest},
    )
    return _ok({"accepted": True})


@router.post("/api/feedback")
def submit_feedback(body: FeedbackCreateRequest, db: Session = Depends(get_db), current_user: UserModel = Depends(get_current_user)) -> dict:
    if len(body.subject.strip()) < 2:
        raise HTTPException(status_code=400, detail="反馈主题至少 2 个字符")
    if len(body.content.strip()) < 5:
        raise HTTPException(status_code=400, detail="请再具体描述一下问题或建议")
    if feedback_service.recent_submission_count(db, user_id=current_user.id) >= 5:
        raise HTTPException(status_code=429, detail="提交得有点频繁，请 10 分钟后再试")
    feedback = feedback_service.create_feedback(
        db, user_id=current_user.id, category=body.category, subject=body.subject,
        content=body.content, page_path=body.page_path,
        client_context={"platform": body.platform, "user_agent": body.user_agent,
                        "viewport": body.viewport, "app_version": body.app_version},
    )
    return _ok(feedback_service.to_dict(feedback))


@router.get("/api/feedback")
def list_my_feedback(
    page: int = Query(1, ge=1), per_page: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db), current_user: UserModel = Depends(get_current_user),
) -> dict:
    items, total = feedback_service.list_user_feedback(db, user_id=current_user.id, page=page, per_page=per_page)
    return _ok({"items": [feedback_service.to_dict(item) for item in items], "total": total, "page": page, "per_page": per_page})
