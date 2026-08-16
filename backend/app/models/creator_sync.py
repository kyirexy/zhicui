"""Persistent user-scoped creator sources and manual sync runs.

Only stable identifiers, display metadata, ordinary Note references and
redacted diagnostics belong here. Platform cookies, media URLs and paths must
never be persisted in these tables.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


CREATOR_PLATFORMS = ("douyin", "bilibili", "xiaohongshu")
ACTIVE_CREATOR_RUN_STATUSES = (
    "queued",
    "resolving",
    "discovering",
    "importing",
    "transcribing",
)
TERMINAL_CREATOR_RUN_STATUSES = (
    "succeeded",
    "partial",
    "failed",
    "cancelled",
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _uuid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


class CreatorSource(Base):
    __tablename__ = "creator_sources"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "platform", "creator_id",
            name="uq_creator_source_user_platform_creator",
        ),
        CheckConstraint(
            "platform IN ('douyin','bilibili','xiaohongshu')",
            name="ck_creator_source_platform",
        ),
        CheckConstraint(
            "status IN ('active','disabled','unavailable')",
            name="ck_creator_source_status",
        ),
        Index("ix_creator_sources_user_status", "user_id", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(48), primary_key=True, default=lambda: _uuid("creator")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    platform: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    creator_id: Mapped[str] = mapped_column(String(192), nullable=False)
    profile_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    display_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    avatar_url: Mapped[str] = mapped_column(String(2048), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "platform": self.platform,
            "creator_id": self.creator_id,
            "profile_url": self.profile_url,
            "display_name": self.display_name,
            "avatar_url": self.avatar_url,
            "status": self.status,
            "last_synced_at": _iso(self.last_synced_at),
            "last_success_at": _iso(self.last_success_at),
            "last_error_code": self.last_error_code,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }


class CreatorSourceItem(Base):
    __tablename__ = "creator_source_items"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "platform", "external_id",
            name="uq_creator_item_user_platform_external",
        ),
        CheckConstraint(
            "platform IN ('douyin','bilibili','xiaohongshu')",
            name="ck_creator_item_platform",
        ),
        CheckConstraint(
            "state IN ('discovered','ready','failed','removed')",
            name="ck_creator_item_state",
        ),
        Index("ix_creator_items_source_seen", "source_id", "last_seen_at"),
    )

    id: Mapped[str] = mapped_column(
        String(48), primary_key=True, default=lambda: _uuid("creator-item")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_id: Mapped[str] = mapped_column(
        String(48), ForeignKey("creator_sources.id", ondelete="CASCADE"), nullable=False, index=True
    )
    note_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="SET NULL"), index=True
    )
    platform: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    external_id: Mapped[str] = mapped_column(String(192), nullable=False, index=True)
    source_url: Mapped[str] = mapped_column(String(1024), nullable=False, default="")
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="discovered")
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_id": self.source_id,
            "note_id": self.note_id,
            "platform": self.platform,
            "external_id": self.external_id,
            "state": self.state,
            "error_code": self.error_code,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
            "removed_at": _iso(self.removed_at),
        }


class CreatorSyncRun(Base):
    __tablename__ = "creator_sync_runs"
    __table_args__ = (
        CheckConstraint(
            "requested_limit IN (20,50,100)",
            name="ck_creator_run_requested_limit",
        ),
        CheckConstraint(
            "status IN ('queued','resolving','discovering','importing','transcribing',"
            "'succeeded','partial','failed','cancelled')",
            name="ck_creator_run_status",
        ),
        Index("ix_creator_runs_user_status_updated", "user_id", "status", "updated_at"),
        Index("ix_creator_runs_source_status", "source_id", "status"),
        Index(
            "uq_creator_runs_active_user",
            "user_id",
            unique=True,
            sqlite_where=text(
                "status IN ('queued','resolving','discovering','importing','transcribing')"
            ),
            postgresql_where=text(
                "status IN ('queued','resolving','discovering','importing','transcribing')"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(48), primary_key=True, default=lambda: _uuid("creator-run")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_id: Mapped[str] = mapped_column(
        String(48), ForeignKey("creator_sources.id", ondelete="CASCADE"), nullable=False, index=True
    )
    platform: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued", index=True)
    requested_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    checked_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    new_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reused_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    results_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    def safe_results(self) -> list[dict[str, Any]]:
        try:
            value = json.loads(self.results_json or "[]")
        except (TypeError, json.JSONDecodeError):
            return []
        if not isinstance(value, list):
            return []
        safe: list[dict[str, Any]] = []
        for raw in value[:100]:
            if not isinstance(raw, dict):
                continue
            safe.append({
                "external_id": str(raw.get("external_id") or "")[:192],
                "status": str(raw.get("status") or "failed")[:40],
                "note_id": str(raw.get("note_id") or "")[:48] or None,
                "error_code": str(raw.get("error_code") or "")[:80],
            })
        return safe

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_id": self.source_id,
            "platform": self.platform,
            "status": self.status,
            "requested_limit": self.requested_limit,
            "checked_count": self.checked_count,
            "new_count": self.new_count,
            "reused_count": self.reused_count,
            "failed_count": self.failed_count,
            "skipped_count": self.skipped_count,
            "results": self.safe_results(),
            "error_code": self.error_code,
            "error_message": self.error_message,
            "cancellation_requested": self.cancellation_requested,
            "created_at": _iso(self.created_at),
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "updated_at": _iso(self.updated_at),
        }
