"""Failure-safe LLM Token metering and administrator reporting."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.request_context import (
    get_current_request_path,
    get_current_user_id,
)
from app.models.llm_usage_log import LlmUsageLog
from app.models.user import User


def _usage_value(usage: Any, key: str) -> int:
    if usage is None:
        return 0
    value = usage.get(key) if isinstance(usage, dict) else getattr(usage, key, 0)
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def record_response_usage(
    response: Any,
    *,
    provider: str,
    model: str,
    operation: str,
) -> LlmUsageLog | None:
    """Persist reported usage without ever inspecting prompts or response text."""
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return None

    prompt_tokens = _usage_value(usage, "prompt_tokens")
    completion_tokens = _usage_value(usage, "completion_tokens")
    total_tokens = _usage_value(usage, "total_tokens")
    if total_tokens <= 0:
        total_tokens = prompt_tokens + completion_tokens
    if total_tokens <= 0:
        return None

    try:
        with SessionLocal() as db:
            entry = LlmUsageLog(
                user_id=get_current_user_id(),
                provider=(provider or "custom")[:32],
                model=(model or "unknown")[:128],
                operation=(operation or "llm_call")[:64],
                request_path=(get_current_request_path() or "")[:255] or None,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
            )
            db.add(entry)
            db.commit()
            db.refresh(entry)
            return entry
    except Exception:
        # Observability must never change the outcome of the user's LLM call.
        return None


def get_usage_report(
    db: Session,
    *,
    days: int = 30,
    page: int = 1,
    per_page: int = 20,
    model: str | None = None,
) -> dict[str, Any]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    query = db.query(LlmUsageLog).filter(LlmUsageLog.created_at >= cutoff)
    if model:
        query = query.filter(LlmUsageLog.model == model)

    totals = query.with_entities(
        func.count(LlmUsageLog.id),
        func.coalesce(func.sum(LlmUsageLog.prompt_tokens), 0),
        func.coalesce(func.sum(LlmUsageLog.completion_tokens), 0),
        func.coalesce(func.sum(LlmUsageLog.total_tokens), 0),
    ).one()
    active_users = query.with_entities(
        func.count(distinct(LlmUsageLog.user_id))
    ).scalar() or 0

    model_rows = (
        query.with_entities(
            LlmUsageLog.provider,
            LlmUsageLog.model,
            func.count(LlmUsageLog.id),
            func.coalesce(func.sum(LlmUsageLog.prompt_tokens), 0),
            func.coalesce(func.sum(LlmUsageLog.completion_tokens), 0),
            func.coalesce(func.sum(LlmUsageLog.total_tokens), 0),
        )
        .group_by(LlmUsageLog.provider, LlmUsageLog.model)
        .order_by(func.sum(LlmUsageLog.total_tokens).desc())
        .all()
    )

    day_expr = func.date(LlmUsageLog.created_at)
    daily_rows = (
        query.with_entities(
            day_expr.label("day"),
            func.count(LlmUsageLog.id),
            func.coalesce(func.sum(LlmUsageLog.total_tokens), 0),
        )
        .group_by(day_expr)
        .order_by(day_expr.asc())
        .all()
    )

    total = int(totals[0] or 0)
    items = (
        query.order_by(LlmUsageLog.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    user_ids = {item.user_id for item in items if item.user_id}
    user_map: dict[str, str] = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        user_map = {user.id: (user.username or user.email) for user in users}

    return {
        "summary": {
            "calls": total,
            "prompt_tokens": int(totals[1] or 0),
            "completion_tokens": int(totals[2] or 0),
            "total_tokens": int(totals[3] or 0),
            "active_users": int(active_users),
        },
        "by_model": [
            {
                "provider": row[0],
                "model": row[1],
                "calls": int(row[2] or 0),
                "prompt_tokens": int(row[3] or 0),
                "completion_tokens": int(row[4] or 0),
                "total_tokens": int(row[5] or 0),
            }
            for row in model_rows
        ],
        "daily": [
            {
                "date": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                "calls": int(row[1] or 0),
                "total_tokens": int(row[2] or 0),
            }
            for row in daily_rows
        ],
        "items": [
            {
                "id": item.id,
                "user_id": item.user_id,
                "username": user_map.get(item.user_id or "", "系统任务"),
                "provider": item.provider,
                "model": item.model,
                "operation": item.operation,
                "request_path": item.request_path,
                "prompt_tokens": item.prompt_tokens,
                "completion_tokens": item.completion_tokens,
                "total_tokens": item.total_tokens,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in items
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
        "days": days,
    }
