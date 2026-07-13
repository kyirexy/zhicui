"""Audit logging service — records admin write operations.

Called from every admin write endpoint (user patch/delete, note delete,
re-extract, LLM/ASR config update) so changes are traceable to an admin,
an action, a target, and a timestamp.
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.models.admin_audit_log import AdminAuditLog


def log_action(
    db: Session,
    *,
    admin_user_id: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: dict | None = None,
    ip: str | None = None,
) -> AdminAuditLog:
    """Record an admin action. Commits immediately."""
    entry = AdminAuditLog(
        admin_user_id=admin_user_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        detail=json.dumps(detail, ensure_ascii=False) if detail else None,
        ip=ip,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def list_audit_logs(
    db: Session,
    *,
    page: int = 1,
    per_page: int = 20,
    action: str | None = None,
    admin_user_id: str | None = None,
) -> tuple[list[AdminAuditLog], int]:
    """Paginated audit logs, newest first. Optional filters by action / admin."""
    q = db.query(AdminAuditLog)
    if action:
        q = q.filter(AdminAuditLog.action == action)
    if admin_user_id:
        q = q.filter(AdminAuditLog.admin_user_id == admin_user_id)
    total = q.count()
    items = (
        q.order_by(AdminAuditLog.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return items, total


def to_dict(entry: AdminAuditLog, admin_username: str | None = None) -> dict:
    """Serialize an audit log entry. admin_username is joined if provided."""
    return {
        "id": entry.id,
        "admin_user_id": entry.admin_user_id,
        "admin_username": admin_username,
        "action": entry.action,
        "target_type": entry.target_type,
        "target_id": entry.target_id,
        "detail": json.loads(entry.detail) if entry.detail else None,
        "ip": entry.ip,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
    }
