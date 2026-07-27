"""User feedback persistence, privacy bounds, and administrator queries."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.feedback import Feedback
from app.models.user import User


FEEDBACK_CATEGORIES = {"bug", "suggestion", "content", "account", "other"}
FEEDBACK_STATUSES = {"pending", "processing", "resolved", "closed"}


def _serialize_context(context: dict[str, str | None]) -> str | None:
    bounded = {
        "platform": (context.get("platform") or "")[:32] or None,
        "user_agent": (context.get("user_agent") or "")[:512] or None,
        "viewport": (context.get("viewport") or "")[:64] or None,
        "app_version": (context.get("app_version") or "")[:64] or None,
    }
    if not any(bounded.values()):
        return None
    return json.dumps(bounded, ensure_ascii=False)


def _parse_context(value: str | None) -> dict[str, str | None]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def create_feedback(
    db: Session,
    *,
    user_id: str,
    category: str,
    subject: str,
    content: str,
    page_path: str | None,
    client_context: dict[str, str | None],
) -> Feedback:
    feedback = Feedback(
        user_id=user_id,
        category=category,
        subject=subject.strip(),
        content=content.strip(),
        page_path=(page_path or "")[:512] or None,
        client_context=_serialize_context(client_context),
    )
    db.add(feedback)
    db.commit()
    db.refresh(feedback)
    return feedback


def recent_submission_count(
    db: Session,
    *,
    user_id: str,
    minutes: int = 10,
) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return (
        db.query(Feedback)
        .filter(Feedback.user_id == user_id, Feedback.created_at >= cutoff)
        .count()
    )


def list_user_feedback(
    db: Session,
    *,
    user_id: str,
    page: int,
    per_page: int,
) -> tuple[list[Feedback], int]:
    query = db.query(Feedback).filter(Feedback.user_id == user_id)
    total = query.count()
    items = (
        query.order_by(Feedback.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return items, total


def list_admin_feedback(
    db: Session,
    *,
    page: int,
    per_page: int,
    status: str | None = None,
    category: str | None = None,
    q: str | None = None,
) -> tuple[list[tuple[Feedback, User]], int, dict[str, int]]:
    query = db.query(Feedback, User).join(User, User.id == Feedback.user_id)
    if status:
        query = query.filter(Feedback.status == status)
    if category:
        query = query.filter(Feedback.category == category)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                Feedback.subject.ilike(like),
                Feedback.content.ilike(like),
                User.username.ilike(like),
                User.email.ilike(like),
            )
        )
    total = query.count()
    items = (
        query.order_by(Feedback.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    grouped = db.query(Feedback.status, func.count(Feedback.id)).group_by(Feedback.status).all()
    counts = {status_name: 0 for status_name in FEEDBACK_STATUSES}
    for status_name, count in grouped:
        if status_name in counts:
            counts[status_name] = int(count)
    counts["total"] = sum(counts.values())
    return items, total, counts


def get_feedback(db: Session, feedback_id: str) -> Feedback | None:
    return db.query(Feedback).filter(Feedback.id == feedback_id).first()


def update_feedback(
    db: Session,
    feedback: Feedback,
    *,
    status: str | None,
    admin_reply: str | None,
    handled_by: str,
) -> Feedback:
    if status is not None:
        feedback.status = status
    if admin_reply is not None:
        feedback.admin_reply = admin_reply.strip() or None
    feedback.handled_by = handled_by
    feedback.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(feedback)
    return feedback


def to_dict(
    feedback: Feedback,
    *,
    user: User | None = None,
    include_client_context: bool = False,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": feedback.id,
        "category": feedback.category,
        "subject": feedback.subject,
        "content": feedback.content,
        "page_path": feedback.page_path,
        "status": feedback.status,
        "admin_reply": feedback.admin_reply,
        "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
        "updated_at": feedback.updated_at.isoformat() if feedback.updated_at else None,
    }
    if user is not None:
        result["user"] = {
            "id": user.id,
            "username": user.username,
            "email": user.email,
        }
    if include_client_context:
        result["client_context"] = _parse_context(feedback.client_context)
    return result
