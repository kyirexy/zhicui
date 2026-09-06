"""官网真实案例；媒体原文件名和存储路径不进入公开响应。"""
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ShowcaseCase(Base):
    __tablename__ = "showcase_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    industry: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    person_name: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    role: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    challenge: Mapped[str] = mapped_column(Text, default="", nullable=False)
    workflow: Mapped[str] = mapped_column(Text, default="", nullable=False)
    outcome: Mapped[str] = mapped_column(Text, default="", nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_label: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    authenticity_confirmed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    published: Mapped[bool] = mapped_column(Boolean, default=False, index=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    media_name: Mapped[str | None] = mapped_column(String(48), nullable=True)
    poster_name: Mapped[str | None] = mapped_column(String(48), nullable=True)
    media_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    media_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
