"""按用户保存已确认的媒体提取终态。"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class MediaExtractionOutcome(Base):
    __tablename__ = "media_extraction_outcomes"

    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
    )
    platform: Mapped[str] = mapped_column(String(24), primary_key=True)
    video_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    reason: Mapped[str] = mapped_column(String(48), nullable=False, default="no_audio_stream")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
