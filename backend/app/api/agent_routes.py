"""User-scoped routes for the video Agent workspace and daily digests."""

from __future__ import annotations

import secrets
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import (
    activity_service,
    auth_service,
    agent_service,
    automation_runner,
    automation_service,
    email_delivery,
)


router = APIRouter(prefix="/api/agent", tags=["video-agent"])


def _ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


class ThreadCreateRequest(BaseModel):
    title: str = Field(default="", max_length=256)
    source_scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post", "selected",
    ] = "all_ready"
    source_ids: list[str] = Field(default_factory=list, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", max_length=64)


class ThreadUpdateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)


class ThreadMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=600)
    research_mode: Literal["fast", "deep"] = "fast"
    output_style: Literal[
        "answer", "summary", "comparison", "action_plan", "custom"
    ] = "answer"
    custom_instruction: str = Field(default="", max_length=600)
    web_scope: Literal["auto", "video_only"] = "auto"


class AutomationCreateRequest(BaseModel):
    name: str = Field(default="昨日视频摘要", min_length=1, max_length=160)
    enabled: bool = True
    schedule_time: str = Field(default="08:00", min_length=5, max_length=5)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    source_scope: Literal["yesterday", "yesterday_new"] = "yesterday_new"
    source_mode: Literal["all", "collect", "like", "post"] = "collect"
    instruction: str = Field(
        default=automation_service.DEFAULT_INSTRUCTION,
        min_length=1,
        max_length=2000,
    )
    recipient_email: str = Field(default="", max_length=256)
    destination: str = Field(default="", max_length=256)


class AutomationUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    enabled: bool | None = None
    schedule_time: str | None = Field(default=None, min_length=5, max_length=5)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    source_scope: Literal["yesterday", "yesterday_new"] | None = None
    source_mode: Literal["all", "collect", "like", "post"] | None = None
    instruction: str | None = Field(default=None, min_length=1, max_length=2000)
    recipient_email: str | None = Field(default=None, max_length=256)
    destination: str | None = Field(default=None, max_length=256)


class AutomationRunRequest(BaseModel):
    deliver: bool = False


class EmailVerificationConfirmRequest(BaseModel):
    token: str = Field(..., min_length=20, max_length=2048)


@router.get("/sources")
def list_agent_sources(
    scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post",
    ] = Query("all_ready"),
    q: str = Query("", max_length=80),
    timezone: str = Query("Asia/Shanghai", max_length=64),
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        result = agent_service.list_sources(
            db,
            user_id=current_user.id,
            scope=scope,
            search=q,
            timezone_name=timezone,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/threads")
def list_agent_threads(
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    items = agent_service.list_threads(
        db,
        user_id=current_user.id,
        limit=limit,
    )
    return _ok({"items": items, "total": len(items)})


@router.post("/threads")
def create_agent_thread(
    body: ThreadCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        thread = agent_service.create_thread(
            db,
            user_id=current_user.id,
            scope=body.source_scope,
            source_ids=body.source_ids,
            title=body.title,
            timezone_name=body.timezone,
        )
    except ValueError as exc:
        message = str(exc)
        status = 404 if "不存在" in message else 422
        raise HTTPException(status_code=status, detail=message) from exc
    return _ok(agent_service.serialize_thread(
        db,
        thread,
        include_messages=True,
        include_sources=True,
    ))


@router.get("/threads/{thread_id}")
def get_agent_thread(
    thread_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    return _ok(agent_service.serialize_thread(
        db,
        thread,
        include_messages=True,
        include_sources=True,
    ))


@router.patch("/threads/{thread_id}")
def update_agent_thread(
    thread_id: str,
    body: ThreadUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        agent_service.update_thread(db, thread, title=body.title)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(agent_service.serialize_thread(db, thread))


@router.delete("/threads/{thread_id}")
def delete_agent_thread(
    thread_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        agent_service.delete_thread(db, thread)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _ok({"deleted": True})


@router.post("/threads/{thread_id}/messages")
def send_agent_message(
    thread_id: str,
    body: ThreadMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        user_message, assistant_message = agent_service.ask_thread(
            db,
            thread=thread,
            content=body.content,
            research_mode=body.research_mode,
            output_style=body.output_style,
            custom_instruction=body.custom_instruction,
            web_scope=body.web_scope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail="视频 Agent 暂时没有完成回答，请稍后重试。",
        ) from exc
    return _ok({
        "thread": agent_service.serialize_thread(
            db,
            thread,
            include_messages=True,
            include_sources=True,
        ),
        "user_message": user_message.to_dict(),
        "assistant_message": assistant_message.to_dict(),
    })


@router.get("/automations/status")
def get_agent_automation_status(
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    runner_status = automation_runner.runner.status()
    return _ok({
        "runner": {
            "enabled": runner_status["enabled"],
            "running": runner_status["running"],
            "poll_seconds": runner_status["poll_seconds"],
        },
        "email": email_delivery.public_status(),
        "account_email": current_user.email,
        "email_verified": bool(current_user.email_verified),
        "recipient_policy": "account_email_only",
    })


@router.get("/email/status")
def get_agent_email_status(
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return _ok({
        "account_email": current_user.email,
        "email_verified": bool(current_user.email_verified),
        "delivery": email_delivery.public_status(),
    })


@router.post("/email/verification/send")
def send_agent_email_verification(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    user = (
        db.query(User)
        .filter(User.id == current_user.id)
        .with_for_update()
        .one()
    )
    if user.email_verified:
        return _ok({
            "status": "already_verified",
            "email_verified": True,
        })
    if not email_delivery.is_configured():
        raise HTTPException(
            status_code=503,
            detail="邮件服务尚未启用；定时摘要会先保存在知萃中，不会外发。",
        )
    now = datetime.now(timezone.utc)
    sent_at = user.email_verification_sent_at
    if sent_at is not None:
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if sent_at > now - timedelta(seconds=60):
            raise HTTPException(
                status_code=429,
                detail="验证邮件刚刚已经提交，请稍后再试。",
            )
    nonce = secrets.token_urlsafe(32)
    user.email_verification_nonce = nonce
    user.email_verification_sent_at = now
    db.commit()
    db.refresh(user)
    token = auth_service.create_email_verification_token(
        user,
        nonce,
    )
    delivery = email_delivery.send_verification(
        recipient=user.email,
        token=token,
        message_key=f"{user.id}-{nonce}",
    )
    if delivery["status"] != "sent":
        raise HTTPException(
            status_code=502,
            detail=delivery.get("error") or "验证邮件暂时没有提交成功。",
        )
    return _ok({
        "status": "submitted",
        "email_verified": False,
    })


@router.post("/email/verification/confirm")
def confirm_agent_email_verification(
    body: EmailVerificationConfirmRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    payload = auth_service.decode_email_verification_token(body.token)
    if payload is None:
        raise HTTPException(
            status_code=422,
            detail="验证链接无效或已过期，请重新发送。",
        )
    user = (
        db.query(User)
        .filter(
            User.id == str(payload.get("sub") or ""),
            User.email == str(payload.get("email") or "").lower(),
        )
        .first()
    )
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="账号不存在或已停用。")
    if user.email_verified:
        return _ok({"email_verified": True, "status": "already_verified"})
    token_nonce = str(payload.get("nonce") or "")
    stored_nonce = str(user.email_verification_nonce or "")
    if (
        not token_nonce
        or not stored_nonce
        or not secrets.compare_digest(token_nonce, stored_nonce)
    ):
        raise HTTPException(
            status_code=422,
            detail="验证链接已失效，请重新发送。",
        )
    user.email_verified = True
    user.email_verification_nonce = None
    db.commit()
    activity_service.log_activity_safely(
        user_id=user.id,
        action="email_verification_confirm",
        method="POST",
        path="/api/agent/email/verification/confirm",
        status_code=200,
        detail={"outcome": "success"},
    )
    return _ok({"email_verified": True, "status": "verified"})


@router.get("/automations")
def list_agent_automations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    items = [
        {
            **item.to_dict(),
            "channel": "email",
            "destination": item.recipient_email,
        }
        for item in automation_service.list_automations(db, current_user.id)
    ]
    return _ok({"items": items, "total": len(items)})


@router.post("/automations")
def create_agent_automation(
    body: AutomationCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        automation = automation_service.create_automation(
            db,
            user=current_user,
            name=body.name,
            enabled=body.enabled,
            schedule_time=body.schedule_time,
            timezone_name=body.timezone,
            source_scope=body.source_scope,
            source_mode=body.source_mode,
            instruction=body.instruction,
            recipient_email=body.recipient_email or body.destination,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.get("/automations/{automation_id}")
def get_agent_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.patch("/automations/{automation_id}")
def update_agent_automation(
    automation_id: str,
    body: AutomationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    changes = body.model_dump(exclude_unset=True)
    destination = changes.pop("destination", None)
    if destination and "recipient_email" not in changes:
        changes["recipient_email"] = destination
    try:
        automation_service.update_automation(
            db,
            automation,
            user=current_user,
            changes=changes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.delete("/automations/{automation_id}")
def delete_agent_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    automation_service.delete_automation(db, automation)
    return _ok({"deleted": True})


@router.post("/automations/{automation_id}/run")
def run_agent_automation(
    automation_id: str,
    body: AutomationRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if body.deliver:
        raise HTTPException(
            status_code=422,
            detail="手动运行只生成预览；邮件仅由已启用的每日摘要按时发送。",
        )
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    try:
        run = automation_service.create_manual_run(
            db,
            automation=automation,
        )
    except ValueError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    completed = automation_service.execute_run(
        db,
        run_id=run.id,
        deliver=False,
    )
    if completed is None:
        raise HTTPException(status_code=500, detail="未能创建运行记录")
    return _ok(completed.to_dict())


@router.get("/automations/{automation_id}/runs")
def list_agent_automation_runs(
    automation_id: str,
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db,
        automation_id,
        current_user.id,
        include_deleted=True,
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    runs = automation_service.list_runs(
        db,
        automation_id=automation.id,
        user_id=current_user.id,
        limit=limit,
    )
    return _ok({"items": [run.to_dict() for run in runs], "total": len(runs)})
