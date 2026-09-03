"""Durable, user-scoped transcript batch jobs.

Temporary media capabilities are deliberately never stored here.  A restarted
worker resolves media again through the user's bound platform session.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LibraryExtractionBatch(Base):
    __tablename__ = "library_extraction_batches"
    __table_args__ = (
        Index("ix_library_extraction_batches_user_updated", "user_id", "updated_at"),
        Index("ix_library_extraction_batches_status_updated", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True,
        default=lambda: f"extract-{uuid.uuid4().hex[:20]}",
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    operation: Mapped[str] = mapped_column(String(16), nullable=False, default="transcript")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    asr_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    llm_concurrency: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow,
    )


class LibraryExtractionBatchItem(Base):
    __tablename__ = "library_extraction_batch_items"
    __table_args__ = (
        UniqueConstraint("batch_id", "aweme_id", name="uq_library_extraction_batch_item"),
        Index("ix_library_extraction_batch_items_batch_state", "batch_id", "state"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4()),
    )
    batch_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("library_extraction_batches.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    aweme_id: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    note_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("notes.id", ondelete="SET NULL"))
    transcript_chars: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    card_type: Mapped[str | None] = mapped_column(String(32))
    ai_initialized: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    already_existed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow,
    )
