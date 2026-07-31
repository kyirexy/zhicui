"""User-scoped provenance ledger for external video-library items.

The ledger stores only identifiers and source-order timestamps. Video bytes,
download paths, cookies, and other media payloads never belong in this table.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso_utc(value: datetime) -> str:
    aware = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return aware.isoformat().replace("+00:00", "Z")


class VideoSourceLedger(Base):
    """One user's observation of a video in one external source mode."""

    __tablename__ = "video_source_ledgers"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "video_id",
            "source_mode",
            name="uq_video_source_ledger_user_video_mode",
        ),
        CheckConstraint(
            "source_mode IN ('like', 'collect', 'post', 'unknown')",
            name="ck_video_source_ledger_source_mode",
        ),
        Index(
            "ix_video_source_ledger_user_mode_seen",
            "user_id",
            "source_mode",
            "last_seen_at",
        ),
    )

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    note_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("notes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    video_id: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        index=True,
    )
    source_mode: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="unknown",
        server_default="unknown",
        index=True,
    )
    source_rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )
    source_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )

    def to_dict(self) -> dict[str, object]:
        return {
            "video_id": self.video_id,
            "note_id": self.note_id,
            "source_mode": self.source_mode,
            "source_rank": self.source_rank,
            "first_seen_at": _iso_utc(self.first_seen_at),
            "last_seen_at": _iso_utc(self.last_seen_at),
            "source_synced_at": _iso_utc(self.source_synced_at),
        }
