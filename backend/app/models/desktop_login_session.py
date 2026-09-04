"""Secure, short-lived sessions for Android -> desktop QR login.

The two bearer credentials intentionally have different purposes.  Only
domain-separated SHA-256 digests are persisted; plaintext credentials exist
only in the create response held by the desktop renderer.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DesktopLoginSession(Base):
    __tablename__ = "desktop_login_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','approved','consumed','denied','cancelled','expired')",
            name="ck_desktop_login_sessions_status",
        ),
        CheckConstraint(
            "poll_interval_seconds >= 1",
            name="ck_desktop_login_sessions_poll_interval",
        ),
        Index(
            "ix_desktop_login_sessions_status_expires",
            "status",
            "expires_at",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(40),
        primary_key=True,
        default=lambda: f"dls-{uuid.uuid4().hex}",
    )
    approval_token_hash: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
    )
    poll_secret_hash: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="pending",
        index=True,
    )
    user_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    client_name: Mapped[str] = mapped_column(String(64), nullable=False)
    client_type: Mapped[str] = mapped_column(String(16), nullable=False)
    verification_code: Mapped[str] = mapped_column(String(4), nullable=False)
    poll_interval_seconds: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=2,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )
    last_polled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    denied_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
