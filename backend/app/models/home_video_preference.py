"""首页视频的账号级展示偏好，不改变原资料、来源顺序或同步记录。"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HomeVideoPreference(Base):
    __tablename__ = "home_video_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", "platform", "video_id", name="uq_home_video_preference_owner_video"),
        CheckConstraint("platform IN ('douyin', 'bilibili')", name="ck_home_video_preference_platform"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    video_id: Mapped[str] = mapped_column(String(128), nullable=False)
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    knowledge_entry_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("knowledge_entries.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
