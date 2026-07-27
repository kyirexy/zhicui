"""Privacy-bounded user operation logging and administrator reporting."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.user import User
from app.models.user_activity_log import UserActivityLog


ACTION_LABELS: dict[str, str] = {
    "account_register": "注册账号",
    "account_login": "登录账号",
    "account_dev_session": "进入开发会话",
    "video_parse": "解析视频链接",
    "content_extract": "提取内容",
    "douyin_login": "发起抖音扫码登录",
    "douyin_sync": "同步抖音内容",
    "library_extract": "生成视频文案与知识卡",
    "library_delete": "删除视频库知识内容",
    "library_ask": "向视频库提问",
    "note_ask": "向单个视频提问",
    "plan_agent": "让 AI 调整计划",
    "plan_update": "更新计划",
    "plan_task_update": "更新计划任务",
    "plan_task_add": "新增计划任务",
    "plan_task_delete": "删除计划任务",
    "plan_delete": "删除计划",
    "admin_operation": "执行管理操作",
    "api_operation": "执行接口操作",
}


def classify_action(method: str, path: str) -> str:
    method = method.upper()
    exact = {
        ("POST", "/api/video/info"): "video_parse",
        ("POST", "/api/extract"): "content_extract",
        ("POST", "/api/library/douyin/login"): "douyin_login",
        ("POST", "/api/library/douyin/collect"): "douyin_sync",
        ("POST", "/api/library/douyin/extract"): "library_extract",
        ("DELETE", "/api/library/douyin/extractions/{note_id}"): "library_delete",
        ("POST", "/api/library/ask"): "library_ask",
        ("POST", "/api/notes/{note_id}/ask"): "note_ask",
        ("POST", "/api/notes/{note_id}/plan-agent"): "plan_agent",
        ("PATCH", "/api/plans/{plan_id}"): "plan_update",
        ("PATCH", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_update",
        ("PUT", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_update",
        ("POST", "/api/plans/{plan_id}/tasks"): "plan_task_add",
        ("DELETE", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_delete",
        ("DELETE", "/api/plans/{plan_id}"): "plan_delete",
    }
    if (method, path) in exact:
        return exact[(method, path)]
    if path.startswith("/api/admin/"):
        return "admin_operation"
    return "api_operation"


def log_activity(
    db: Session,
    *,
    user_id: str | None,
    action: str,
    method: str,
    path: str,
    status_code: int,
    duration_ms: int = 0,
    ip: str | None = None,
) -> UserActivityLog:
    """Store only bounded metadata. There is intentionally no detail/body column."""
    entry = UserActivityLog(
        user_id=user_id,
        action=action[:64],
        method=method.upper()[:12],
        path=path.split("?", 1)[0][:255],
        status_code=int(status_code),
        duration_ms=max(0, int(duration_ms)),
        ip=(ip or "")[:64] or None,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def log_activity_safely(**kwargs: Any) -> None:
    try:
        with SessionLocal() as db:
            log_activity(db, **kwargs)
    except Exception:
        # Logging cannot break authentication, extraction, plans, or admin actions.
        return


def get_activity_report(
    db: Session,
    *,
    days: int = 30,
    page: int = 1,
    per_page: int = 20,
    action: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    query = db.query(UserActivityLog).filter(UserActivityLog.created_at >= cutoff)
    if action:
        query = query.filter(UserActivityLog.action == action)
    if user_id:
        query = query.filter(UserActivityLog.user_id == user_id)

    total = query.count()
    error_count = query.filter(UserActivityLog.status_code >= 400).count()
    active_users = query.with_entities(
        func.count(distinct(UserActivityLog.user_id))
    ).scalar() or 0
    today_start = (
        datetime.now(ZoneInfo("Asia/Shanghai"))
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc)
    )
    today_count = query.filter(UserActivityLog.created_at >= today_start).count()

    rows = (
        query.order_by(UserActivityLog.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    user_ids = {row.user_id for row in rows if row.user_id}
    user_map: dict[str, str] = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_map = {user.id: (user.username or user.email) for user in users}

    return {
        "summary": {
            "total": total,
            "today": today_count,
            "active_users": int(active_users),
            "errors": error_count,
        },
        "items": [
            {
                "id": row.id,
                "user_id": row.user_id,
                "username": user_map.get(row.user_id or "", "未知用户"),
                "action": row.action,
                "action_label": ACTION_LABELS.get(row.action, row.action),
                "method": row.method,
                "path": row.path,
                "status_code": row.status_code,
                "duration_ms": row.duration_ms,
                "ip": row.ip,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
        "actions": [
            {"value": key, "label": label}
            for key, label in ACTION_LABELS.items()
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
        "days": days,
    }
