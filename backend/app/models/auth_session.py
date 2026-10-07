"""可撤销登录会话；刷新凭证只存摘要，重试回执短时加密保存。"""
from __future__ import annotations

from datetime import datetime, timezone
import uuid

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class UserAuthSession(Base):
    __tablename__ = "user_auth_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    client_type: Mapped[str] = mapped_column(String(24), default="web")
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    previous_refresh_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    legacy_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuthRefreshReceipt(Base):
    __tablename__ = "auth_refresh_receipts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(96), index=True)
    encrypted_result: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
