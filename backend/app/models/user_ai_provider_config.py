"""Encrypted, user-scoped OpenAI-compatible provider configuration."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserAIProviderConfig(Base):
    __tablename__ = "user_ai_provider_configs"
    __table_args__ = (UniqueConstraint("user_id", name="uq_user_ai_provider_user"),)

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    mode: Mapped[str] = mapped_column(String(24), default="platform", nullable=False)
    provider_name: Mapped[str] = mapped_column(String(80), default="OpenAI Compatible", nullable=False)
    model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    api_base: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    encrypted_api_key: Mapped[str] = mapped_column(Text, default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
