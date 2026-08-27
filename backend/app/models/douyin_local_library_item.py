"""User-scoped metadata snapshots discovered by the Windows connector."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class DouyinLocalLibraryItem(Base):
    """A bounded public metadata snapshot; private browser state never belongs here."""

    __tablename__ = "douyin_local_library_items"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "video_id",
            name="uq_douyin_local_library_user_video",
        ),
        Index(
            "ix_douyin_local_library_user_seen",
            "user_id",
            "last_seen_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    video_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="抖音作品")
    source_url: Mapped[str] = mapped_column(String(512), nullable=False)
    cover_url: Mapped[str] = mapped_column(String(2048), nullable=False, default="")
    caption: Mapped[str] = mapped_column(Text, nullable=False, default="")
    author_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    published_at: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
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
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
        onupdate=_utcnow,
    )

    def to_library_item(
        self,
        *,
        source_mode: str,
        source_rank: int | None,
        source_synced_at: datetime | None,
    ) -> dict[str, object]:
        published_timestamp: int | None = None
        if self.published_at:
            try:
                published_timestamp = int(
                    datetime.fromisoformat(
                        self.published_at.replace("Z", "+00:00")
                    ).timestamp()
                )
            except (TypeError, ValueError, OverflowError, OSError):
                published_timestamp = None
        display_date = self.published_at[:10] if self.published_at else ""
        return {
            "id": self.video_id,
            "aweme_id": self.video_id,
            "title": self.title or self.caption or "抖音作品",
            "caption": self.caption,
            "author_name": self.author_name,
            "source_url": self.source_url,
            "cover_url": self.cover_url,
            "recorded_at": _iso(self.last_seen_at),
            "published_at": self.published_at,
            "duration": self.duration_seconds,
            "date": display_date,
            "publish_timestamp": published_timestamp,
            "tags": [],
            "media_type": "video",
            "source_mode": source_mode,
            "source_rank": source_rank,
            "source_synced_at": _iso(source_synced_at or self.last_seen_at),
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
            "can_extract": bool(self.available),
            "media_url": "",
            "provider": "desktop-local",
            "metadata_only": True,
        }
