"""「创作工坊」视频创作 job 模型(Hypit SVML → MP4)。

一个 job 代表一次由自然语言需求驱动的 SVML 创作与渲染。draft 阶段可以
反复迭代而不计费;confirm 之后进入串行渲染队列。所有 JSON 字段只保存
有界元数据,媒体文件保存在 HYPIT_PROJECT_ROOT 下的 job 目录内。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

JOB_STATUSES = {
    "drafting",    # LLM 正在生成/修改 SVML(后台线程)
    "draft",       # 已生成 SVML 预览,等待用户确认
    "queued",      # 用户确认估价后排队等待渲染
    "rendering",   # hypit build 进行中
    "completed",   # MP4 已导出
    "failed",
    "cancelled",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class VideoCreationJob(Base):
    """一次 SVML 视频创作请求与其渲染产物。"""

    __tablename__ = "video_creation_jobs"
    __table_args__ = (
        Index("ix_video_creation_job_user_status", "user_id", "status", "created_at"),
        Index("ix_video_creation_job_status_updated", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # draft|queued|rendering|completed|failed|cancelled
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    # 用户当前生效的创作需求(创建或最近一次 iterate 的输入)。
    requirement_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # hypit 项目源文件与渲染产物;SVRUN 在 confirm 入队时固定。
    svml_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    svrun_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # LLM 面向用户的创作说明(讲述创作思路,不重复 SVML 本身)。
    explanation: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # hypit pricing --json 的真实估价快照;confirm 时校验仍存在。
    pricing_json: Mapped[str] = mapped_column(Text, default="", nullable=False)
    build_id: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    output_filename: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 实际渲染用时秒数,便于运维评估服务器容量。
    render_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "requirement_text": self.requirement_text,
            "svml_text": self.svml_text,
            "svrun_text": self.svrun_text,
            "explanation": self.explanation,
            "pricing": self.pricing,
            "build_id": self.build_id,
            "output_filename": self.output_filename,
            "error": self.error,
            "render_seconds": self.render_seconds,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }

    @property
    def pricing(self) -> dict:
        import json

        try:
            value = json.loads(self.pricing_json or "{}")
        except (TypeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}
