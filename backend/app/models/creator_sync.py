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
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

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

CREATOR_RUN_OPERATIONS = (
    "recent_transcript",
    "catalog_all",
    "selected_transcript",
)

CREATOR_RUN_ITEM_STATES = (
    "pending",
    "importing",
    "succeeded",
    "reused",
    "failed",
    "skipped_removed",
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


def _safe_http_url(value: Any, *, keep_query: bool = False, limit: int = 2048) -> str:
    """Return a display-only HTTP URL without credentials or fragments."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    if parsed.username or parsed.password:
        return ""
    query = parsed.query if keep_query else ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))[:limit]


def _json_dict(value: str | None) -> dict[str, Any]:
    try:
        decoded = json.loads(value or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _safe_parts(value: str | None) -> list[dict[str, Any]]:
    try:
        decoded = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(decoded, list):
        return []
    parts: list[dict[str, Any]] = []
    for index, raw in enumerate(decoded[:200], start=1):
        if not isinstance(raw, dict):
            continue
        try:
            page = max(1, int(raw.get("page") or index))
        except (TypeError, ValueError):
            page = index
        raw_page_url = _safe_http_url(
            raw.get("page_url") or raw.get("source_url"),
            keep_query=True,
            limit=1024,
        )
        page_url = ""
        if raw_page_url:
            parsed = urlsplit(raw_page_url)
            query_page = parse_qs(parsed.query).get("p", [str(page)])[0]
            if (
                (parsed.hostname or "").lower() in {"bilibili.com", "www.bilibili.com"}
                and str(query_page).isdigit()
                and 1 <= int(query_page) <= 9999
            ):
                page_url = urlunsplit((
                    parsed.scheme,
                    parsed.netloc,
                    parsed.path,
                    urlencode({"p": int(query_page)}),
                    "",
                ))[:1024]
        part = {
            "cid": str(raw.get("cid") or "")[:80],
            "page": page,
            "title": str(raw.get("title") or "")[:240],
            "page_url": page_url,
            "url": page_url,
        }
        parts.append(part)
    return sorted(parts, key=lambda part: (part["page"], part["cid"]))


def _safe_source_snapshot(value: str | None) -> dict[str, Any]:
    raw = _json_dict(value)
    return {
        "id": str(raw.get("id") or "")[:48],
        "platform": str(raw.get("platform") or "")[:24],
        "creator_id": str(raw.get("creator_id") or "")[:192],
        "profile_url": _safe_http_url(raw.get("profile_url"), limit=1024),
        "display_name": str(raw.get("display_name") or "")[:160],
        "avatar_url": _safe_http_url(raw.get("avatar_url"), limit=2048),
    }


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
        Index(
            "ix_creator_items_source_catalog",
            "source_id", "is_available", "published_at", "external_id",
        ),
        Index("ix_creator_items_source_state", "source_id", "state", "note_id"),
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
    title: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    cover_url: Mapped[str] = mapped_column(String(2048), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    author_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    parts_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    last_seen_run_id: Mapped[str | None] = mapped_column(
        String(48), ForeignKey("creator_sync_runs.id", ondelete="SET NULL"), index=True
    )
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    unavailable_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="discovered")
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    def safe_parts(self) -> list[dict[str, Any]]:
        return _safe_parts(self.parts_json)

    def to_dict(self) -> dict[str, Any]:
        if self.removed_at is not None or self.state == "removed":
            availability_status = "removed"
            transcript_status = "removed"
        else:
            availability_status = "available" if self.is_available else "unavailable"
            if self.note_id:
                transcript_status = "imported"
            elif self.state == "failed":
                transcript_status = "failed"
            else:
                transcript_status = "untranscribed"
        return {
            "id": self.id,
            "source_id": self.source_id,
            "note_id": self.note_id,
            "platform": self.platform,
            "external_id": self.external_id,
            "source_url": _safe_http_url(self.source_url, limit=1024),
            "title": self.title,
            "cover_url": _safe_http_url(self.cover_url, keep_query=True, limit=2048),
            "description": self.description,
            "author_name": self.author_name,
            "published_at": _iso(self.published_at),
            "duration_seconds": self.duration_seconds,
            "order_index": self.order_index,
            "parts": self.safe_parts(),
            "last_seen_run_id": self.last_seen_run_id,
            "is_available": self.is_available,
            "availability_status": availability_status,
            "transcript_status": transcript_status,
            "status": transcript_status,
            "available": self.is_available,
            "can_transcribe": bool(
                self.is_available
                and self.removed_at is None
                and self.state != "removed"
                and not self.note_id
            ),
            "state": self.state,
            "error_code": self.error_code,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
            "discovered_at": _iso(self.first_seen_at),
            "updated_at": _iso(self.last_seen_at),
            "removed_at": _iso(self.removed_at),
            "unavailable_at": _iso(self.unavailable_at),
        }


class CreatorSyncRun(Base):
    __tablename__ = "creator_sync_runs"
    __table_args__ = (
        CheckConstraint(
            "requested_limit IN (20,50,100)",
            name="ck_creator_run_requested_limit",
        ),
        CheckConstraint(
            "operation IN ('recent_transcript','catalog_all','selected_transcript')",
            name="ck_creator_run_operation",
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
    operation: Mapped[str] = mapped_column(
        String(32), nullable=False, default="recent_transcript", index=True
    )
    requested_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    target_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    discovery_cursor_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    discovery_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    discovered_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checked_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    new_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reused_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    results_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    needs_action: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    needs_action_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    needs_action_message: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    source_snapshot_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
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
            "operation": self.operation or "recent_transcript",
            "requested_limit": self.requested_limit,
            "target_count": self.target_count or (
                self.requested_limit if (self.operation or "recent_transcript") == "recent_transcript" else 0
            ),
            "discovery_complete": self.discovery_complete,
            "discovered_count": self.discovered_count,
            "processed_count": self.processed_count,
            "total_count": self.total_count,
            "source_snapshot": _safe_source_snapshot(self.source_snapshot_json),
            "checked_count": self.checked_count,
            "new_count": self.new_count,
            "reused_count": self.reused_count,
            "failed_count": self.failed_count,
            "skipped_count": self.skipped_count,
            "results": self.safe_results(),
            "error_code": self.error_code,
            "error_message": self.error_message,
            "cancellation_requested": self.cancellation_requested,
            "attempt_count": self.attempt_count,
            "next_retry_at": _iso(self.next_retry_at),
            "needs_action": {
                "required": self.needs_action,
                "code": self.needs_action_code,
                "message": self.needs_action_message,
            },
            "created_at": _iso(self.created_at),
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "updated_at": _iso(self.updated_at),
        }


class CreatorSyncRunItem(Base):
    """Per-work progress for recent and explicitly selected transcript runs."""

    __tablename__ = "creator_sync_run_items"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "source_item_id", name="uq_creator_run_item_run_source_item"
        ),
        CheckConstraint(
            "state IN ('pending','importing','succeeded','reused','failed',"
            "'skipped_removed','cancelled')",
            name="ck_creator_run_item_state",
        ),
        Index("ix_creator_run_items_run_state_order", "run_id", "state", "ordinal"),
        Index("ix_creator_run_items_user_run", "user_id", "run_id"),
    )

    id: Mapped[str] = mapped_column(
        String(48), primary_key=True, default=lambda: _uuid("creator-run-item")
    )
    run_id: Mapped[str] = mapped_column(
        String(48), ForeignKey("creator_sync_runs.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    source_id: Mapped[str] = mapped_column(
        String(48), ForeignKey("creator_sources.id", ondelete="CASCADE"), nullable=False
    )
    source_item_id: Mapped[str] = mapped_column(
        String(48), ForeignKey("creator_source_items.id", ondelete="CASCADE"), nullable=False
    )
    external_id: Mapped[str] = mapped_column(String(192), nullable=False)
    note_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "run_id": self.run_id,
            "source_id": self.source_id,
            "source_item_id": self.source_item_id,
            "external_id": self.external_id,
            "note_id": self.note_id,
            "ordinal": self.ordinal,
            "state": self.state,
            "status": self.state,
            "attempt_count": self.attempt_count,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "next_retry_at": _iso(self.next_retry_at),
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }
