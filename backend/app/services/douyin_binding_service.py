"""Persist safe, user-scoped Douyin binding metadata.

Cookie values and video data remain in the loopback-only companion and are
never accepted by this service.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.douyin_account_binding import DouyinAccountBinding


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_scope() -> str:
    return secrets.token_urlsafe(32)


def get_or_create(
    db: Session,
    user_id: str,
) -> DouyinAccountBinding:
    for _ in range(3):
        binding = (
            db.query(DouyinAccountBinding)
            .filter(DouyinAccountBinding.user_id == user_id)
            .first()
        )
        if binding is not None:
            return binding

        binding = DouyinAccountBinding(
            user_id=user_id,
            session_scope=_new_scope(),
        )
        db.add(binding)
        try:
            db.commit()
        except IntegrityError:
            # This can be a first-request race on user_id or the vanishingly
            # unlikely scope collision. Roll back, observe a winner, or retry
            # with a fresh random scope.
            db.rollback()
            binding = (
                db.query(DouyinAccountBinding)
                .filter(DouyinAccountBinding.user_id == user_id)
                .first()
            )
            if binding is not None:
                return binding
            continue
        db.refresh(binding)
        return binding
    raise RuntimeError("无法为当前用户创建独立抖音会话")


def get_by_id(
    db: Session,
    binding_id: str,
) -> DouyinAccountBinding | None:
    return (
        db.query(DouyinAccountBinding)
        .filter(DouyinAccountBinding.id == binding_id)
        .first()
    )


def get_by_user(
    db: Session,
    user_id: str,
) -> DouyinAccountBinding | None:
    return (
        db.query(DouyinAccountBinding)
        .filter(DouyinAccountBinding.user_id == user_id)
        .first()
    )


def mark_login_pending(
    db: Session,
    binding: DouyinAccountBinding,
) -> DouyinAccountBinding:
    binding.status = "pending"
    binding.updated_at = _utcnow()
    db.commit()
    db.refresh(binding)
    return binding


def update_connection(
    db: Session,
    binding: DouyinAccountBinding,
    *,
    connected: bool,
    cookie_count: int = 0,
) -> DouyinAccountBinding:
    now = _utcnow()
    binding.status = "connected" if connected else "disconnected"
    binding.cookie_count = max(0, int(cookie_count))
    binding.last_verified_at = now
    if connected and binding.bound_at is None:
        binding.bound_at = now
    binding.updated_at = now
    db.commit()
    db.refresh(binding)
    return binding


def mark_disconnected(
    db: Session,
    binding: DouyinAccountBinding,
) -> DouyinAccountBinding:
    return update_connection(db, binding, connected=False, cookie_count=0)


def mark_sync_started(
    db: Session,
    binding: DouyinAccountBinding,
) -> DouyinAccountBinding:
    now = _utcnow()
    binding.last_sync_at = now
    binding.updated_at = now
    db.commit()
    db.refresh(binding)
    return binding
