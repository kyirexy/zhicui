"""用户隔离的增量同步批次记录，不保存凭据、媒体地址或正文。"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class LibrarySyncRun(Base):
    __tablename__ = "library_sync_runs"
    __table_args__ = (
        Index("ix_library_sync_user_started", "user_id", "started_at"),
        Index("ix_library_sync_source_snapshot", "user_id", "platform", "source_mode", "source_synced_at"),
    )

    id: Mapped[str] = mapped_column(String(48), primary_key=True, default=lambda: f"sync-{uuid.uuid4().hex}")
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    platform: Mapped[str] = mapped_column(String(24), nullable=False)
    source_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    source_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_rank_offset: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requested_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    coverage: Mapped[str] = mapped_column(String(16), nullable=False, default="partial")
    order_reliable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    accepted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reused: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ready: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quarantined: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    video_ids_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    error_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "platform": self.platform, "source_mode": self.source_mode,
            "source_synced_at": _iso(self.source_synced_at),
            "source_rank_offset": self.source_rank_offset, "requested_count": self.requested_count,
            "coverage": self.coverage, "order_reliable": self.order_reliable, "status": self.status,
            "attempt_count": self.attempt_count,
            "accepted": self.accepted, "created": self.created, "reused": self.reused, "skipped": self.skipped,
            "ready": self.ready, "failed": self.failed_count, "failed_count": self.failed_count,
            "pending_count": max(0, self.requested_count - self.accepted - self.failed_count - self.skipped),
            "quarantined": self.quarantined,
            "video_ids": json.loads(self.video_ids_json or "[]"), "error_code": self.error_code,
            "started_at": _iso(self.started_at), "finished_at": _iso(self.finished_at),
            "updated_at": _iso(self.updated_at),
        }
