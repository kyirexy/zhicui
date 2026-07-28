"""User-scoped metadata for an external Douyin account binding."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DouyinAccountBinding(Base):
    __tablename__ = "douyin_account_bindings"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: f"dyb-{uuid.uuid4().hex[:20]}",
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    session_scope: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(24),
        nullable=False,
        default="disconnected",
    )
    cookie_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
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

    def safe_dict(self) -> dict[str, object]:
        """Return non-secret state suitable for API responses and logs."""
        return {
            "status": self.status,
            "cookie_count": self.cookie_count,
            "bound_at": self.bound_at.isoformat() if self.bound_at else None,
            "last_verified_at": (
                self.last_verified_at.isoformat()
                if self.last_verified_at
                else None
            ),
            "last_sync_at": (
                self.last_sync_at.isoformat()
                if self.last_sync_at
                else None
            ),
        }
