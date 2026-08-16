"""管理员发布的聊天模型与用户每日免费额度。"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
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


class ChatModelOffering(Base):
    __tablename__ = "chat_model_offerings"
    __table_args__ = (
        UniqueConstraint("code", name="uq_chat_model_offering_code"),
        Index("ix_chat_model_offering_published", "enabled", "visible_to_users", "sort_order"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    provider_mode: Mapped[str] = mapped_column(String(24), default="platform", nullable=False)
    model_id: Mapped[str] = mapped_column(String(160), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    visible_to_users: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_free: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    free_daily_limit: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    points_per_request: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    supports_images: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    supports_tools: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class ChatModelFreeUsage(Base):
    __tablename__ = "chat_model_free_usage"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "offering_id", "period_date",
            name="uq_chat_model_free_usage_period",
        ),
        Index("ix_chat_model_free_usage_user_date", "user_id", "period_date"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    offering_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_model_offerings.id", ondelete="CASCADE"), nullable=False
    )
    period_date: Mapped[date] = mapped_column(Date, nullable=False)
    used_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    reserved_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class ChatModelChargeReservation(Base):
    """一次聊天请求的计费状态，避免重试造成重复扣费。"""

    __tablename__ = "chat_model_charge_reservations"

    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    offering_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_model_offerings.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    points: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    state: Mapped[str] = mapped_column(String(16), default="reserved", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
