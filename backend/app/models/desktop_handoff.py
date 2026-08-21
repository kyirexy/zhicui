"""一次性登录交接票据：桌面客户端 ↔ Web 网页联动登录。

客户端生成随机会话票据并在本机打开浏览器；网页登录成功后声明票据；
客户端轮询到"已声明"后换取 JWT，完成登录回填。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DesktopHandoff(Base):
    __tablename__ = "desktop_handoffs"

    id: Mapped[str] = mapped_column(
        String(40),
        primary_key=True,
        default=lambda: f"dho-{uuid.uuid4().hex[:20]}",
    )
    session_id: Mapped[str] = mapped_column(
        String(64),
        unique=True,
        index=True,
        nullable=False,
    )
    # pending → claimed → consumed；过期直接视为 expired
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="pending",
        index=True,
    )
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "status": self.status,
            "user_id": self.user_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "claimed_at": self.claimed_at.isoformat() if self.claimed_at else None,
            "consumed_at": self.consumed_at.isoformat() if self.consumed_at else None,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }
