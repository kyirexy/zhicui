"""每个知萃用户独立的 B站授权；秘密仅以 Fernet 密文保存。"""
from datetime import datetime, timezone
import uuid
from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class BilibiliAccountBinding(Base):
    __tablename__ = "bilibili_account_bindings"
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    generation: Mapped[str] = mapped_column(String(36), default=lambda: uuid.uuid4().hex, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="disconnected", nullable=False)
    platform_user_id: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    display_name: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    credential_encrypted: Mapped[str] = mapped_column(Text, default="", nullable=False)
    credential_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    session_id: Mapped[str] = mapped_column(String(36), default="", nullable=False)
    challenge_encrypted: Mapped[str] = mapped_column(Text, default="", nullable=False)
    challenge_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
