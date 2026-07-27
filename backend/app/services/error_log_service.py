"""Centralized, redacted application error persistence and reporting."""

from __future__ import annotations

import json
import re
import traceback as traceback_module
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.request_context import (
    get_current_request_path,
    get_current_user_id,
)
from app.models.application_error_log import ApplicationErrorLog
from app.models.user import User


ALLOWED_SOURCES = {
    "backend",
    "http",
    "validation",
    "llm",
    "asr",
    "frontend",
}
ALLOWED_SEVERITIES = {"warning", "error", "critical"}
SAFE_METADATA_KEYS = {
    "provider",
    "model",
    "operation",
    "environment",
    "component",
    "digest",
    "browser",
    "platform",
}
_REDACTED = "[REDACTED]"
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|authorization|bearer|password|passwd|secret|token)"
    r"\s*[:=]\s*([^\s,;\"']+)"
)
_BEARER_VALUE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_SECRET_KEY = re.compile(r"\b(?:sk|ak)-[A-Za-z0-9_-]{8,}", re.IGNORECASE)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}")
_URL_QUERY = re.compile(r"(https?://[^\s?#]+)\?[^\s#]*", re.IGNORECASE)


def sanitize_text(value: Any, limit: int) -> str:
    """Redact common credential shapes and bound persisted text."""
    text = str(value or "")
    text = _BEARER_VALUE.sub(f"Bearer {_REDACTED}", text)
    text = _SECRET_ASSIGNMENT.sub(
        lambda match: f"{match.group(1)}={_REDACTED}",
        text,
    )
    text = _SECRET_KEY.sub(f"sk-{_REDACTED}", text)
    text = _JWT.sub(_REDACTED, text)
    text = _URL_QUERY.sub(r"\1?[REDACTED]", text)
    if len(text) > limit:
        text = f"{text[:limit]}\n...[TRUNCATED]"
    return text


def sanitize_metadata(metadata: dict[str, Any] | None) -> dict[str, str]:
    if not metadata:
        return {}
    return {
        key: sanitize_text(value, 256)
        for key, value in metadata.items()
        if key in SAFE_METADATA_KEYS and value is not None
    }


def log_error(
    db: Session,
    *,
    source: str,
    severity: str,
    error_type: str,
    message: str,
    traceback: str | None = None,
    method: str | None = None,
    path: str | None = None,
    status_code: int | None = None,
    user_id: str | None = None,
    ip: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> ApplicationErrorLog:
    safe_source = source if source in ALLOWED_SOURCES else "backend"
    safe_severity = severity if severity in ALLOWED_SEVERITIES else "error"
    safe_metadata = sanitize_metadata(metadata)
    entry = ApplicationErrorLog(
        user_id=(user_id or "")[:64] or None,
        source=safe_source,
        severity=safe_severity,
        error_type=sanitize_text(error_type or "Error", 128),
        message=sanitize_text(message or "未知错误", 4000),
        traceback=sanitize_text(traceback, 16000) if traceback else None,
        method=(method or "")[:12].upper() or None,
        path=sanitize_text((path or "").split("?", 1)[0], 255) or None,
        status_code=status_code,
        ip=sanitize_text(ip, 64) if ip else None,
        metadata_json=(
            json.dumps(safe_metadata, ensure_ascii=False)
            if safe_metadata
            else None
        ),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def record_error_safely(**kwargs: Any) -> ApplicationErrorLog | None:
    """Persist in an isolated transaction without affecting the caller."""
    try:
        with SessionLocal() as db:
            return log_error(db, **kwargs)
    except Exception:
        return None


def record_exception_safely(
    exc: BaseException,
    *,
    source: str,
    severity: str = "error",
    status_code: int | None = None,
    method: str | None = None,
    path: str | None = None,
    user_id: str | None = None,
    ip: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> ApplicationErrorLog | None:
    trace = traceback_module.format_exc()
    if trace.strip() == "NoneType: None":
        trace = ""
    return record_error_safely(
        source=source,
        severity=severity,
        error_type=type(exc).__name__,
        message=str(exc) or type(exc).__name__,
        traceback=trace or None,
        method=method,
        path=path or get_current_request_path(),
        status_code=status_code,
        user_id=user_id or get_current_user_id(),
        ip=ip,
        metadata=metadata,
    )


def get_error_report(
    db: Session,
    *,
    days: int = 30,
    page: int = 1,
    per_page: int = 20,
    source: str | None = None,
    severity: str | None = None,
    status_code: int | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    query = db.query(ApplicationErrorLog).filter(
        ApplicationErrorLog.created_at >= cutoff
    )
    if source:
        query = query.filter(ApplicationErrorLog.source == source)
    if severity:
        query = query.filter(ApplicationErrorLog.severity == severity)
    if status_code:
        query = query.filter(ApplicationErrorLog.status_code == status_code)

    total = query.count()
    critical = query.filter(ApplicationErrorLog.severity == "critical").count()
    server_errors = query.filter(ApplicationErrorLog.status_code >= 500).count()
    affected_users = query.with_entities(
        func.count(distinct(ApplicationErrorLog.user_id))
    ).scalar() or 0
    today_start = (
        datetime.now(ZoneInfo("Asia/Shanghai"))
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc)
    )
    today = query.filter(ApplicationErrorLog.created_at >= today_start).count()

    source_rows = (
        query.with_entities(
            ApplicationErrorLog.source,
            func.count(ApplicationErrorLog.id),
        )
        .group_by(ApplicationErrorLog.source)
        .order_by(func.count(ApplicationErrorLog.id).desc())
        .all()
    )

    rows = (
        query.order_by(ApplicationErrorLog.created_at.desc())
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
            "today": today,
            "critical": critical,
            "server_errors": server_errors,
            "affected_users": int(affected_users),
        },
        "by_source": [
            {"source": row[0], "count": int(row[1] or 0)}
            for row in source_rows
        ],
        "items": [
            {
                "id": row.id,
                "user_id": row.user_id,
                "username": user_map.get(row.user_id or "", "未登录或系统任务"),
                "source": row.source,
                "severity": row.severity,
                "error_type": row.error_type,
                "message": row.message,
                "traceback": row.traceback,
                "method": row.method,
                "path": row.path,
                "status_code": row.status_code,
                "ip": row.ip,
                "metadata": (
                    json.loads(row.metadata_json)
                    if row.metadata_json
                    else {}
                ),
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
        "sources": sorted(ALLOWED_SOURCES),
        "severities": ["critical", "error", "warning"],
        "total": total,
        "page": page,
        "per_page": per_page,
        "days": days,
    }
