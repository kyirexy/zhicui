"""普通用户 JWT 的每日研究产品接口，不依赖 Agent 接入权限。"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import daily_research_service as service

router = APIRouter(prefix="/api/daily-research", tags=["每日研究"])


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SubscriptionCreate(StrictRequest):
    name: str = Field(default="每日视频研究", min_length=1, max_length=160)
    enabled: bool = True
    schedule_time: str = Field(default="15:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str = Field(default="Asia/Shanghai", max_length=64)
    platforms: list[Literal["douyin"]] = Field(default_factory=lambda: ["douyin"], min_length=1, max_length=1)
    source_modes: list[Literal["like", "collect"]] = Field(default_factory=lambda: ["like", "collect"], min_length=1, max_length=2)
    window_days: Literal[2] = 2
    sync_limit: int = Field(default=500, ge=1, le=500)
    focus_topics: list[str] = Field(default_factory=list, max_length=12)
    recipient_email: str = Field(default="", max_length=256)
    instruction: str = Field(default=service.DEFAULT_INSTRUCTION, max_length=2000)


class SubscriptionUpdate(StrictRequest):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    enabled: bool | None = None
    schedule_time: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    platforms: list[Literal["douyin"]] | None = Field(default=None, min_length=1, max_length=1)
    source_modes: list[Literal["like", "collect"]] | None = Field(default=None, min_length=1, max_length=2)
    window_days: Literal[2] | None = None
    sync_limit: int | None = Field(default=None, ge=1, le=500)
    focus_topics: list[str] | None = Field(default=None, max_length=12)
    recipient_email: str | None = Field(default=None, max_length=256)
    instruction: str | None = Field(default=None, max_length=2000)


class RecipientEmail(StrictRequest):
    email: str = Field(min_length=3, max_length=256)


class RecipientCode(RecipientEmail):
    code: str = Field(pattern=r"^\d{6}$")


class DesktopClaim(StrictRequest):
    device_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    capabilities_version: Literal[1] = 1


class DesktopIdentity(StrictRequest):
    run_id: str = Field(min_length=1, max_length=36)
    device_id: str = Field(min_length=1, max_length=100)
    lease_token: str = Field(min_length=20, max_length=100)


class DesktopProgress(DesktopIdentity):
    stage: Literal["syncing", "waiting_for_user"] = "syncing"
    message: str = Field(default="", max_length=500)
    platform: Literal["douyin"] | None = None
    source_mode: Literal["like", "collect"] | None = None
    read: int | None = Field(default=None, ge=0, le=1000)
    saved: int | None = Field(default=None, ge=0, le=1000)
    created: int | None = Field(default=None, ge=0, le=1000)
    reused: int | None = Field(default=None, ge=0, le=1000)
    skipped: int | None = Field(default=None, ge=0, le=1000)
    failed: int | None = Field(default=None, ge=0, le=1000)


class Engagement(StrictRequest):
    likes: int | None = Field(default=None, ge=0, le=100_000_000_000)
    comments: int | None = Field(default=None, ge=0, le=100_000_000_000)
    shares: int | None = Field(default=None, ge=0, le=100_000_000_000)
    collects: int | None = Field(default=None, ge=0, le=100_000_000_000)
    views: int | None = Field(default=None, ge=0, le=100_000_000_000)


class MetadataItem(StrictRequest):
    video_id: str = Field(pattern=r"^[0-9]{5,32}$")
    title: str = Field(default="", max_length=500)
    author_name: str = Field(default="", max_length=200)
    caption: str = Field(default="", max_length=2000)
    published_at: str | None = Field(default=None, max_length=64)
    duration_seconds: int | None = Field(default=None, ge=0, le=86400)
    engagement: Engagement | None = None


class DesktopBatch(DesktopIdentity):
    batch_id: str = Field(min_length=1, max_length=160)
    platform: Literal["douyin"] = "douyin"
    source_mode: Literal["like", "collect"]
    items: list[MetadataItem] = Field(min_length=1, max_length=100)
    source_rank_offset: int = Field(default=0, ge=0, le=499)
    coverage: Literal["complete", "limited", "partial"] = "partial"
    order_reliable: bool = False


class CompletedSource(StrictRequest):
    platform: Literal["douyin"]
    source_mode: Literal["like", "collect"]
    coverage: Literal["complete", "limited", "partial"]
    read: int = Field(default=0, ge=0, le=500)
    saved: int = Field(default=0, ge=0, le=500)
    created: int = Field(default=0, ge=0, le=500)
    reused: int = Field(default=0, ge=0, le=500)
    failed: int = Field(default=0, ge=0, le=500)
    error: str | None = Field(default=None, max_length=500)


class DesktopComplete(DesktopIdentity):
    coverage: Literal["complete", "limited", "partial"]
    sources: list[CompletedSource] = Field(min_length=1, max_length=2)


def _call(operation):
    try:
        return {"success": True, "data": operation(), "error": None}
    except service.DailyResearchError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/status")
def get_status(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.status(db, user))


@router.get("/subscriptions")
def subscriptions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = service.list_subscriptions(db, user.id)
    return _call(lambda: {"items": [service.subscription_dict(row) for row in rows], "total": len(rows)})


@router.post("/subscriptions")
def create_subscription(body: SubscriptionCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.subscription_dict(service.save_subscription(db, user=user, payload=body.model_dump())))


@router.patch("/subscriptions/{subscription_id}")
def update_subscription(subscription_id: str, body: SubscriptionUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.subscription_dict(service.save_subscription(db, user=user,
        payload=body.model_dump(exclude_unset=True, exclude_none=True), subscription_id=subscription_id)))


@router.delete("/subscriptions/{subscription_id}")
def delete_subscription(subscription_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    def remove():
        service.delete_subscription(db, user.id, subscription_id)
        return {"deleted": True}
    return _call(remove)


@router.post("/subscriptions/{subscription_id}/run")
def enqueue(subscription_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.run_dict(service.enqueue_manual(db, user.id, subscription_id)))


@router.get("/runs")
def runs(subscription_id: str | None = None, limit: int = Query(30, ge=1, le=100),
         db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    def read():
        rows = service.list_runs(db, user.id, subscription_id, limit)
        return {"items": [service.run_dict(row) for row in rows], "total": len(rows)}
    return _call(read)


@router.get("/runs/{run_id}")
def run(run_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.run_dict(service.owned_run(db, user.id, run_id)))


@router.post("/recipients/verify/send")
def send_code(body: RecipientEmail, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.send_recipient_code(db, user_id=user.id, email=body.email))


@router.post("/recipients/verify/confirm")
def confirm_code(body: RecipientCode, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.confirm_recipient_code(db, user_id=user.id, email=body.email, code=body.code))


@router.post("/desktop/claim")
def claim(body: DesktopClaim, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.claim_desktop(db, user_id=user.id, **body.model_dump()))


@router.post("/desktop/progress")
def progress(body: DesktopProgress, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.desktop_progress(db, user_id=user.id, payload=body.model_dump(exclude_none=True)))


@router.post("/desktop/batch")
def batch(body: DesktopBatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.desktop_batch(db, user_id=user.id, payload=body.model_dump(exclude_none=True)))


@router.post("/desktop/complete")
def complete(body: DesktopComplete, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _call(lambda: service.desktop_complete(db, user_id=user.id, payload=body.model_dump(exclude_none=True)))
