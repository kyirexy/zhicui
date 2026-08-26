"""桌面端 ↔ Web 联动登录的一次性票据服务。

票据生命周期：pending → claimed → consumed；超时未认领按过期处理。
session_id 由桌面客户端本地生成（32 字节随机数），仅在客户端与
用户自己的浏览器之间传递，充当一次性 Bearer 凭证。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models.desktop_handoff import DesktopHandoff

SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
HANDOFF_TTL_SECONDS = 5 * 60  # 5 分钟足够完成一次登录

# 便于测试与复用
EXPIRES_AT_DEFAULT = HANDOFF_TTL_SECONDS


def _utcnow() -> datetime:
    # SQLite 读回的 DateTime(timezone=True) 是 naive 值，统一使用 naive UTC 比较。
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime) -> datetime:
    """把不同数据库返回的时间统一成 naive UTC。

    SQLite 会丢失 ``DateTime(timezone=True)`` 的时区信息，而 PostgreSQL 会保留
    ``+00:00``。业务层若直接比较两者会在生产环境抛出
    ``can't compare offset-naive and offset-aware datetimes``。
    """
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _is_expired(expires_at: datetime, *, now: datetime | None = None) -> bool:
    """跨 SQLite/PostgreSQL 安全判断一次性票据是否过期。"""
    return _naive_utc(expires_at) < _naive_utc(now or _utcnow())


def normalize_session_id(raw: object) -> str | None:
    """校验并规范化 session_id；不合法返回 None。"""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not SESSION_ID_PATTERN.match(value):
        return None
    return value


def create_handoff(db: Session, session_id: str) -> DesktopHandoff | None:
    """创建一个 pending 票据；session_id 重复或已存在返回 None。"""
    existing = (
        db.query(DesktopHandoff)
        .filter(DesktopHandoff.session_id == session_id)
        .first()
    )
    if existing is not None:
        return None

    handoff = DesktopHandoff(
        session_id=session_id,
        status="pending",
        expires_at=_utcnow() + timedelta(seconds=HANDOFF_TTL_SECONDS),
    )
    db.add(handoff)
    db.commit()
    db.refresh(handoff)
    return handoff


def get_handoff(db: Session, session_id: str) -> DesktopHandoff | None:
    return (
        db.query(DesktopHandoff)
        .filter(DesktopHandoff.session_id == session_id)
        .first()
    )


def expire_stale(db: Session) -> int:
    """把已过期且未消费的票据标记为 expired，返回清理数量。"""
    now = _utcnow()
    stale = (
        db.query(DesktopHandoff)
        .filter(
            DesktopHandoff.status.in_(["pending", "claimed"]),
            DesktopHandoff.expires_at < now,
        )
        .all()
    )
    for handoff in stale:
        handoff.status = "expired"
    if stale:
        db.commit()
    return len(stale)


def claim_handoff(db: Session, session_id: str, user_id: str) -> str:
    """网页登录成功后声明票据。

    返回状态：claimed（成功）| not_found | expired | already_consumed。
    """
    handoff = get_handoff(db, session_id)
    if handoff is None:
        return "not_found"
    if _is_expired(handoff.expires_at):
        handoff.status = "expired"
        db.commit()
        return "expired"
    if handoff.status == "consumed":
        return "already_consumed"
    if handoff.status == "claimed":
        # 幂等：同一用户重复声明视为成功
        return "claimed" if handoff.user_id == user_id else "already_claimed"

    handoff.status = "claimed"
    handoff.user_id = user_id
    handoff.claimed_at = _utcnow()
    db.commit()
    return "claimed"


def consume_handoff(db: Session, session_id: str) -> tuple[str, str | None]:
    """客户端轮询：claimed → consumed 并返回 user_id。

    返回 (status, user_id)；status ∈ pending | success | expired | not_found | consumed。
    """
    handoff = get_handoff(db, session_id)
    if handoff is None:
        return "not_found", None
    if _is_expired(handoff.expires_at):
        handoff.status = "expired"
        db.commit()
        return "expired", None
    if handoff.status == "pending":
        return "pending", None
    if handoff.status == "consumed":
        return "consumed", handoff.user_id
    if handoff.status == "claimed" and handoff.user_id:
        handoff.status = "consumed"
        handoff.consumed_at = _utcnow()
        db.commit()
        return "success", handoff.user_id
    return "expired", None
