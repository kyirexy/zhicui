"""AdminAuditLog ORM model — tracks all admin write operations.

Records who changed what (config keys, user status, note deletion, re-extract)
so configuration changes and destructive actions are traceable. Paired with
``audit_service.log_action`` which is called from every admin write endpoint.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AdminAuditLog(Base):
    __tablename__ = "admin_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 管理员注销后仍须保留不可篡改的动作、目标与时间；仅解除可识别主体。
    # 新库使用 SET NULL，旧库由启动迁移放宽 NOT NULL，并由注销事务显式匿名化。
    admin_user_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # e.g. user_disable / user_delete / llm_config_update / note_reextract
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(32), nullable=True)  # user/note/config
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON string
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
