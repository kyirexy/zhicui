"""B站账号导入任务；只保存规范作品标识、顺序和处理状态，不保存凭据或文稿。"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PlatformImportJob(Base):
    __tablename__ = "platform_import_jobs"
    __table_args__ = (
        Index("ix_platform_import_jobs_owner_created", "user_id", "created_at"),
        Index("ix_platform_import_jobs_due", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: f"bili-import-{uuid.uuid4().hex}")
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    sync_run_id: Mapped[str] = mapped_column(String(48), ForeignKey("library_sync_runs.id", ondelete="CASCADE"), nullable=False, unique=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    source_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    source_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_rank_offset: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_snapshot_size: Mapped[int] = mapped_column(Integer, nullable=False)
    coverage: Mapped[str] = mapped_column(String(16), nullable=False)
    order_reliable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformImportJobItem(Base):
    __tablename__ = "platform_import_job_items"
    __table_args__ = (
        UniqueConstraint("job_id", "position", name="uq_platform_import_job_position"),
        UniqueConstraint("job_id", "video_id", name="uq_platform_import_job_video"),
        Index("ix_platform_import_job_items_state", "job_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id: Mapped[str] = mapped_column(String(64), ForeignKey("platform_import_jobs.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    video_id: Mapped[str] = mapped_column(String(32), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    result_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    note_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("notes.id", ondelete="SET NULL"))
    error: Mapped[str] = mapped_column(String(240), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
