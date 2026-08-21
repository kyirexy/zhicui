"""User-scoped custom BYOK chat models (multiple per user)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserCustomChatModel(Base):
    __tablename__ = "user_custom_chat_models"
    __table_args__ = (
        # 每个用户最多只有一个 is_selected=true 的自定义模型；允许任意多条未选中记录。
        Index(
            "ix_user_custom_chat_model_user",
            "user_id",
            "created_at",
        ),
        Index(
            "uq_user_custom_chat_model_selected",
            "user_id",
            unique=True,
            sqlite_where=text("is_selected"),
            postgresql_where=text("is_selected"),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    provider_name: Mapped[str] = mapped_column(String(80), default="OpenAI Compatible", nullable=False)
    model: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    api_base: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    encrypted_api_key: Mapped[str] = mapped_column(Text, default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_selected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
