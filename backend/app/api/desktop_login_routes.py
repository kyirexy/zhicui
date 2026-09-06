"""Secure v2 routes for Android-assisted desktop login."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import activity_service, auth_service, desktop_login_service


router = APIRouter()


class DesktopLoginCreateRequest(BaseModel):
    """Create a v2 session without accepting an untrusted display label."""

    model_config = ConfigDict(extra="forbid")

    client_name: str = Field(default="Windows 客户端", max_length=64)
    client_type: Literal["windows", "macos", "web"] = "windows"


class DesktopLoginApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Shape validation belongs to the service so malformed bearer secrets are
    # mapped generically instead of being echoed by request validation.
    approval_token: str


class DesktopLoginDecisionRequest(DesktopLoginApprovalRequest):
    decision: Literal["approve", "deny"]


class DesktopLoginPollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    poll_secret: str


def _response(
    data: dict[str, Any] | None = None,
    *,
    error: str | None = None,
    status_code: int = 200,
) -> Response:
    """Use the product envelope and prohibit credential response caches."""
    return JSONResponse(
        status_code=status_code,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
        content=(
            {"success": False, "data": None, "error": error}
            if error is not None
            else {"success": True, "data": data, "error": None}
        ),
    )


def _public_data(session) -> dict[str, Any]:
    return {
        "status": session.status,
        "session_id": session.id,
        "client_name": session.client_name,
        "client_type": session.client_type,
        "verification_code": session.verification_code,
        "expires_at": _utc_iso(session.expires_at),
    }


def _utc_iso(value: datetime) -> str:
    """将 SQLite 无时区值和 PostgreSQL 有时区值统一输出为明确的 UTC。"""
    aware = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return aware.isoformat().replace("+00:00", "Z")


@router.post("/api/auth/desktop-login/sessions", include_in_schema=False)
def create_desktop_login_session(
    body: DesktopLoginCreateRequest,
    db: Session = Depends(get_db),
) -> Response:
    """Create a five-minute QR session and return each secret only once."""
    created = desktop_login_service.create_session(
        db,
        client_type=body.client_type,
    )
    session = created.session
    return _response({
        **_public_data(session),
        "poll_secret": created.poll_secret,
        "approval_token": created.approval_token,
        "approval_url": created.approval_url,
        "poll_interval_seconds": session.poll_interval_seconds,
    })


@router.post(
    "/api/auth/desktop-login/sessions/{session_id}/preview",
    include_in_schema=False,
)
def preview_desktop_login_session(
    session_id: str,
    body: DesktopLoginApprovalRequest,
    db: Session = Depends(get_db),
) -> Response:
    """Validate the QR-side credential without authenticating or mutating it."""
    status, session = desktop_login_service.preview_session(
        db,
        session_id=session_id,
        approval_token=body.approval_token,
    )
    if status == "invalid" or session is None:
        return _response(error="登录二维码不存在或已失效", status_code=404)
    return _response(_public_data(session))


@router.post(
    "/api/auth/desktop-login/sessions/{session_id}/decision",
    include_in_schema=False,
)
def decide_desktop_login_session(
    session_id: str,
    body: DesktopLoginDecisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    """Bind the current account only after an explicit approve/deny action."""
    status, session = desktop_login_service.decide_session(
        db,
        session_id=session_id,
        approval_token=body.approval_token,
        user_id=current_user.id,
        decision=body.decision,
    )
    if status == "invalid" or session is None:
        return _response(error="登录二维码不存在或已失效", status_code=404)

    expected = "approved" if body.decision == "approve" else "denied"
    successful_decision = session.user_id == current_user.id and (
        status == expected
        or (body.decision == "approve" and status == "consumed")
    )
    if not successful_decision:
        return _response(
            error={
                "expired": "登录二维码已过期，请在电脑上刷新",
                "denied": "该登录请求已被拒绝",
                "cancelled": "该登录请求已取消",
                "approved": "该登录请求已由其他账号确认",
                "consumed": "该登录请求已完成",
            }.get(status, "登录请求状态已变化，请重新扫码"),
            status_code=410 if status == "expired" else 409,
        )

    activity_service.log_activity_safely(
        user_id=current_user.id,
        action=(
            "desktop_login_approved"
            if body.decision == "approve"
            else "desktop_login_denied"
        ),
        method="POST",
        path="/api/auth/desktop-login/sessions/{session_id}/decision",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={"status": expected, "session_id": session.id},
        event_key=f"desktop-login:{session.id}:{expected}",
    )
    return _response({"status": expected, "session_id": session.id})


@router.post(
    "/api/auth/desktop-login/sessions/{session_id}/token",
    include_in_schema=False,
)
def consume_desktop_login_session(
    session_id: str,
    body: DesktopLoginPollRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    """Poll or atomically consume an approved session with the desktop secret."""
    result = desktop_login_service.poll_and_consume(
        db,
        session_id=session_id,
        poll_secret=body.poll_secret,
    )
    if result.status == "invalid":
        return _response(error="登录会话不存在或已失效", status_code=404)
    if result.status == "success" and result.user is not None:
        user = result.user
        token = auth_service.create_access_token(user.id, user.email)
        activity_service.log_activity_safely(
            user_id=user.id,
            action="desktop_login_consumed",
            method="POST",
            path="/api/auth/desktop-login/sessions/{session_id}/token",
            status_code=200,
            ip=request.client.host if request.client else None,
            detail={"status": "consumed", "session_id": session_id},
            event_key=f"desktop-login:{session_id}:consumed",
        )
        return _response({
            "status": "success",
            "token": token,
            "user": user.to_dict(),
        })

    data: dict[str, Any] = {
        "status": result.status,
        "poll_interval_seconds": (
            result.session.poll_interval_seconds
            if result.session is not None
            else desktop_login_service.POLL_INTERVAL_SECONDS
        ),
    }
    if result.retry_after_seconds is not None:
        data["retry_after_seconds"] = result.retry_after_seconds
    return _response(data)


@router.post(
    "/api/auth/desktop-login/sessions/{session_id}/cancel",
    include_in_schema=False,
)
def cancel_desktop_login_session(
    session_id: str,
    body: DesktopLoginPollRequest,
    db: Session = Depends(get_db),
) -> Response:
    """Allow the desktop holder to cancel a pending QR session."""
    status, session = desktop_login_service.cancel_session(
        db,
        session_id=session_id,
        poll_secret=body.poll_secret,
    )
    if status == "invalid" or session is None:
        return _response(error="登录会话不存在或已失效", status_code=404)
    return _response({"status": status, "session_id": session.id})
