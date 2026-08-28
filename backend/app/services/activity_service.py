"""Privacy-bounded user operation logging and administrator reporting."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import distinct, func
from sqlalchemy.exc import IntegrityError
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
    "douyin_logout": "退出抖音账号",
    "douyin_rebind": "换绑抖音账号",
    "douyin_connected": "抖音绑定成功",
    "douyin_sync": "发起抖音同步",
    "douyin_sync_completed": "抖音同步完成",
    "douyin_sync_failed": "抖音同步失败",
    "douyin_local_sync": "桌面端抖音同步",
    "douyin_local_sync_failed": "桌面端抖音同步失败",
    "library_extract": "生成视频文案与知识卡",
    "library_batch_extract": "批量生成视频文案与知识卡",
    "library_remove": "从视频资料库移除",
    "library_delete": "删除视频库知识内容",
    "library_ask": "向视频库提问",
    "agent_thread_create": "创建视频 Agent 任务",
    "agent_ask": "向视频 Agent 提问",
    "agent_thread_delete": "删除视频 Agent 任务",
    "automation_create": "创建每日视频摘要",
    "automation_update": "修改每日视频摘要",
    "automation_delete": "删除每日视频摘要",
    "automation_run": "运行每日视频摘要",
    "email_verification_send": "发送邮箱验证邮件",
    "email_verification_confirm": "完成邮箱验证",
    "note_ask": "向单个视频提问",
    "plan_create": "创建计划",
    "plan_agent": "让 AI 调整计划",
    "plan_focus_update": "安排今日重点",
    "plan_review_view": "查看计划复盘",
    "plan_coach_preview": "预览 AI 计划调整",
    "plan_coach_apply": "应用 AI 计划调整",
    "plan_update": "更新计划",
    "plan_task_reorder": "调整计划任务顺序",
    "plan_task_update": "更新计划任务",
    "plan_task_add": "新增计划任务",
    "plan_task_delete": "删除计划任务",
    "plan_delete": "删除计划",
    "feedback_submit": "提交用户反馈",
    "admin_operation": "执行管理操作",
    "api_operation": "执行接口操作",
}

EXPLICIT_ACTIVITY_ROUTES = {
    ("POST", "/api/library/douyin/collect"),
}

_DETAIL_KEYS = {
    "outcome",
    "error_category",
    "source_mode",
    "requested_count",
    "job_id",
    "total",
    "success",
    "failed",
    "skipped",
    "temporary_restored",
    "binding_method",
    "source_count",
    "delivery_status",
    "trigger",
    "accepted",
    "created",
    "reused",
    "ready",
    "quarantined",
    "client_version",
    "channel",
}
_DETAIL_INTEGER_KEYS = {
    "requested_count",
    "total",
    "success",
    "failed",
    "skipped",
    "temporary_restored",
    "source_count",
    "accepted",
    "created",
    "reused",
    "ready",
    "quarantined",
}
_DETAIL_STRING_LIMITS = {
    "outcome": 24,
    "error_category": 64,
    "source_mode": 24,
    "job_id": 96,
    "binding_method": 32,
    "delivery_status": 32,
    "trigger": 24,
    "client_version": 32,
    "channel": 32,
}
_SOURCE_MODE_LABELS = {
    "like": "喜欢",
    "collect": "收藏",
    "collection": "收藏",
    "post": "我的作品",
}
_OUTCOME_LABELS = {
    "success": "成功",
    "failed": "失败",
    "started": "已开始",
    "connected": "已连接",
}
_ERROR_CATEGORY_LABELS = {
    "account_not_found": "账号不存在",
    "invalid_password": "密码错误",
    "inactive_account": "账号已禁用",
    "email_already_registered": "邮箱已注册",
    "username_already_registered": "用户名已占用",
    "validation_failed": "信息校验未通过",
    "connector_unavailable": "连接暂不可用",
    "upstream_sync_failed": "同步任务未完成",
}


def is_explicit_activity_route(method: str, path: str) -> bool:
    return (method.upper(), path) in EXPLICIT_ACTIVITY_ROUTES


def classify_action(method: str, path: str) -> str:
    method = method.upper()
    exact = {
        ("POST", "/api/video/info"): "video_parse",
        ("POST", "/api/extract"): "content_extract",
        ("POST", "/api/library/douyin/login"): "douyin_login",
        ("POST", "/api/library/douyin/logout"): "douyin_logout",
        ("POST", "/api/library/douyin/rebind"): "douyin_rebind",
        ("POST", "/api/library/douyin/collect"): "douyin_sync",
        ("POST", "/api/library/douyin/extract"): "library_extract",
        ("POST", "/api/library/douyin/extractions/batch"): "library_batch_extract",
        ("POST", "/api/library/douyin/items/remove"): "library_remove",
        ("DELETE", "/api/library/douyin/extractions/{note_id}"): "library_delete",
        ("POST", "/api/library/ask"): "library_ask",
        ("POST", "/api/agent/threads"): "agent_thread_create",
        ("POST", "/api/agent/threads/{thread_id}/messages"): "agent_ask",
        ("DELETE", "/api/agent/threads/{thread_id}"): "agent_thread_delete",
        ("POST", "/api/agent/automations"): "automation_create",
        ("PATCH", "/api/agent/automations/{automation_id}"): "automation_update",
        ("DELETE", "/api/agent/automations/{automation_id}"): "automation_delete",
        ("POST", "/api/agent/automations/{automation_id}/run"): "automation_run",
        ("POST", "/api/agent/email/verification/send"): "email_verification_send",
        ("POST", "/api/notes/{note_id}/ask"): "note_ask",
        ("POST", "/api/notes/{note_id}/plan-agent"): "plan_agent",
        ("POST", "/api/plans"): "plan_create",
        ("PUT", "/api/plans/focus"): "plan_focus_update",
        ("GET", "/api/plans/review"): "plan_review_view",
        ("PATCH", "/api/plans/{plan_id}"): "plan_update",
        ("POST", "/api/plans/{plan_id}/coach/preview"): "plan_coach_preview",
        ("POST", "/api/plans/{plan_id}/coach/apply"): "plan_coach_apply",
        ("PUT", "/api/plans/{plan_id}/tasks/order"): "plan_task_reorder",
        ("PATCH", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_update",
        ("PUT", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_update",
        ("POST", "/api/plans/{plan_id}/tasks"): "plan_task_add",
        ("DELETE", "/api/plans/{plan_id}/tasks/{task_id}"): "plan_task_delete",
        ("DELETE", "/api/plans/{plan_id}"): "plan_delete",
        ("POST", "/api/feedback"): "feedback_submit",
    }
    if (method, path) in exact:
        return exact[(method, path)]
    if path.startswith("/api/admin/"):
        return "admin_operation"
    return "api_operation"


def sanitize_detail(detail: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only bounded, low-sensitivity event metadata."""
    if not isinstance(detail, dict):
        return {}
    sanitized: dict[str, Any] = {}
    for key in _DETAIL_KEYS:
        value = detail.get(key)
        if value is None:
            continue
        if key in _DETAIL_INTEGER_KEYS:
            if isinstance(value, bool):
                continue
            try:
                sanitized[key] = max(0, min(int(value), 1_000_000_000))
            except (TypeError, ValueError):
                continue
            continue
        clean = str(value).strip()
        if clean:
            sanitized[key] = clean[: _DETAIL_STRING_LIMITS[key]]
    return sanitized


def parse_detail(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return sanitize_detail(value if isinstance(value, dict) else {})


def summarize_detail(action: str, detail: dict[str, Any]) -> str:
    if not detail:
        return ""
    outcome = _OUTCOME_LABELS.get(
        str(detail.get("outcome") or ""),
        str(detail.get("outcome") or ""),
    )
    if action in {"account_register", "account_login"}:
        reason = _ERROR_CATEGORY_LABELS.get(
            str(detail.get("error_category") or ""),
            "",
        )
        return f"{outcome} · {reason}" if reason else outcome
    if action == "douyin_connected":
        method = {
            "local_handoff": "本机扫码",
            "visible_chrome": "Chrome 扫码",
        }.get(str(detail.get("binding_method") or ""), "扫码")
        return f"{method}连接成功"
    source = _SOURCE_MODE_LABELS.get(
        str(detail.get("source_mode") or ""),
        "抖音内容",
    )
    if action == "douyin_sync":
        count = detail.get("requested_count")
        return f"{source} · 计划同步 {count} 条" if count is not None else source
    if action in {"douyin_sync_completed", "douyin_sync_failed"}:
        total = int(detail.get("total") or 0)
        success = int(detail.get("success") or 0)
        failed = int(detail.get("failed") or 0)
        skipped = int(detail.get("skipped") or 0)
        result = f"{source} · 共 {total} 条，成功 {success}，失败 {failed}"
        if skipped:
            result += f"，跳过 {skipped}"
        return result
    if action in {"douyin_local_sync", "douyin_local_sync_failed"}:
        accepted = int(detail.get("accepted") or detail.get("requested_count") or 0)
        ready = int(detail.get("ready") or 0)
        quarantined = int(detail.get("quarantined") or 0)
        version = str(detail.get("client_version") or "未知版本")
        result = f"{source} · 客户端 {version} · 读取 {accepted} 条"
        if ready or quarantined:
            result += f"，完整 {ready}，隔离 {quarantined}"
        return result
    return outcome


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
    detail: dict[str, Any] | None = None,
    event_key: str | None = None,
) -> UserActivityLog:
    """Store only bounded metadata and deduplicate explicit lifecycle events."""
    clean_event_key = str(event_key or "").strip()[:180] or None
    if clean_event_key:
        existing = (
            db.query(UserActivityLog)
            .filter(UserActivityLog.event_key == clean_event_key)
            .first()
        )
        if existing is not None:
            return existing
    safe_detail = sanitize_detail(detail)
    entry = UserActivityLog(
        user_id=user_id,
        action=action[:64],
        method=method.upper()[:12],
        path=path.split("?", 1)[0][:255],
        status_code=int(status_code),
        duration_ms=max(0, int(duration_ms)),
        ip=(ip or "")[:64] or None,
        detail_json=(
            json.dumps(
                safe_detail,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            if safe_detail
            else None
        ),
        event_key=clean_event_key,
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if clean_event_key:
            existing = (
                db.query(UserActivityLog)
                .filter(UserActivityLog.event_key == clean_event_key)
                .first()
            )
            if existing is not None:
                return existing
        raise
    db.refresh(entry)
    return entry


def log_activity_safely(**kwargs: Any) -> UserActivityLog | None:
    try:
        with SessionLocal() as db:
            return log_activity(db, **kwargs)
    except Exception:
        # Logging cannot break authentication, extraction, plans, or admin actions.
        return None


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

    activity_users = (
        db.query(User.id, User.username, User.email)
        .join(UserActivityLog, UserActivityLog.user_id == User.id)
        .filter(UserActivityLog.created_at >= cutoff)
        .distinct()
        .order_by(User.username.asc(), User.email.asc())
        .limit(500)
        .all()
    )

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
                "detail": parse_detail(row.detail_json),
                "detail_summary": summarize_detail(
                    row.action,
                    parse_detail(row.detail_json),
                ),
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
        "actions": [
            {"value": key, "label": label}
            for key, label in ACTION_LABELS.items()
        ],
        "users": [
            {
                "value": user.id,
                "label": user.username or user.email,
            }
            for user in activity_users
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
        "days": days,
    }
