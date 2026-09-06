"""Secure Android-to-desktop QR login lifecycle.

The approval credential embedded in the QR code can never be used to claim a
JWT.  The independent polling credential never leaves the desktop renderer.
Both credentials are high-entropy, single-purpose bearer secrets and only
their domain-separated digests are written to the database.
"""

from __future__ import annotations

import hashlib
import math
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.desktop_login_session import DesktopLoginSession
from app.models.user import User, get_user_by_id


SESSION_TTL_SECONDS = 5 * 60
POLL_INTERVAL_SECONDS = 2
TERMINAL_RETENTION_SECONDS = 24 * 60 * 60

ACTIVE_STATUSES = ("pending", "approved")
TERMINAL_STATUSES = ("consumed", "denied", "cancelled", "expired")
SESSION_ID_PATTERN = re.compile(r"^dls-[a-f0-9]{32}$")
SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{40,64}$")


@dataclass(frozen=True)
class CreatedDesktopLoginSession:
    session: DesktopLoginSession
    approval_token: str
    poll_secret: str
    approval_url: str


@dataclass(frozen=True)
class DesktopLoginPollResult:
    status: str
    session: DesktopLoginSession | None = None
    user: User | None = None
    retry_after_seconds: int | None = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _naive_utc(value: datetime) -> datetime:
    """Normalize SQLite naive values and PostgreSQL aware values for Python."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _is_expired(expires_at: datetime, *, now: datetime | None = None) -> bool:
    return _naive_utc(expires_at) <= _naive_utc(now or _utcnow())


def _credential_hash(purpose: str, value: str) -> str:
    """Hash one purpose-bound credential without persisting the plaintext."""
    return hashlib.sha256(
        f"zhicui:desktop-login:v2:{purpose}:{value}".encode("utf-8")
    ).hexdigest()


def normalize_session_id(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    return value if SESSION_ID_PATTERN.fullmatch(value) else None


def normalize_secret(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    return value if SECRET_PATTERN.fullmatch(value) else None


def approval_token_hash(value: str) -> str:
    return _credential_hash("approval", value)


def poll_secret_hash(value: str) -> str:
    return _credential_hash("poll", value)


def cleanup_stale_sessions(
    db: Session,
    *,
    now: datetime | None = None,
) -> tuple[int, int]:
    """Expire active rows and delete terminal rows retained beyond one day."""
    current = now or _utcnow()
    expired = (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.status.in_(ACTIVE_STATUSES),
            DesktopLoginSession.expires_at <= current,
        )
        .update(
            {DesktopLoginSession.status: "expired"},
            synchronize_session=False,
        )
    )
    retention_cutoff = current - timedelta(seconds=TERMINAL_RETENTION_SECONDS)
    deleted = (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.status.in_(TERMINAL_STATUSES),
            DesktopLoginSession.expires_at <= retention_cutoff,
        )
        .delete(synchronize_session=False)
    )
    if expired or deleted:
        db.commit()
    return int(expired), int(deleted)


def create_session(
    db: Session,
    *,
    client_type: str = "windows",
    now: datetime | None = None,
) -> CreatedDesktopLoginSession:
    """Create a five-minute login session and return its two plaintext secrets."""
    current = now or _utcnow()
    cleanup_stale_sessions(db, now=current)
    normalized_type = client_type if client_type in {"windows", "macos", "web"} else "windows"
    client_name = {"windows": "Windows 客户端", "macos": "Mac 客户端", "web": "桌面浏览器"}[normalized_type]
    approval_token = secrets.token_urlsafe(32)
    poll_secret = secrets.token_urlsafe(32)
    session = DesktopLoginSession(
        approval_token_hash=approval_token_hash(approval_token),
        poll_secret_hash=poll_secret_hash(poll_secret),
        status="pending",
        client_name=client_name,
        client_type=normalized_type,
        verification_code=f"{secrets.randbelow(10_000):04d}",
        poll_interval_seconds=POLL_INTERVAL_SECONDS,
        created_at=current,
        expires_at=current + timedelta(seconds=SESSION_TTL_SECONDS),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    approval_url = (
        f"{settings.PUBLIC_APP_URL.rstrip('/')}/login"
        f"#desktop-login={session.id}.{approval_token}"
    )
    return CreatedDesktopLoginSession(
        session=session,
        approval_token=approval_token,
        poll_secret=poll_secret,
        approval_url=approval_url,
    )


def _session_for_approval(
    db: Session,
    session_id: str,
    approval_token: str,
) -> DesktopLoginSession | None:
    normalized_id = normalize_session_id(session_id)
    normalized_token = normalize_secret(approval_token)
    if normalized_id is None or normalized_token is None:
        return None
    return (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.id == normalized_id,
            DesktopLoginSession.approval_token_hash
            == approval_token_hash(normalized_token),
        )
        .first()
    )


def _session_for_poll(
    db: Session,
    session_id: str,
    poll_secret: str,
) -> DesktopLoginSession | None:
    normalized_id = normalize_session_id(session_id)
    normalized_secret = normalize_secret(poll_secret)
    if normalized_id is None or normalized_secret is None:
        return None
    return (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.id == normalized_id,
            DesktopLoginSession.poll_secret_hash
            == poll_secret_hash(normalized_secret),
        )
        .first()
    )


def _expire_one(
    db: Session,
    session: DesktopLoginSession,
    *,
    now: datetime,
) -> DesktopLoginSession:
    if session.status in ACTIVE_STATUSES and _is_expired(session.expires_at, now=now):
        db.query(DesktopLoginSession).filter(
            DesktopLoginSession.id == session.id,
            DesktopLoginSession.status.in_(ACTIVE_STATUSES),
            DesktopLoginSession.expires_at <= now,
        ).update(
            {DesktopLoginSession.status: "expired"},
            synchronize_session=False,
        )
        db.commit()
        db.expire_all()
        return db.query(DesktopLoginSession).filter(
            DesktopLoginSession.id == session.id
        ).one()
    return session


def preview_session(
    db: Session,
    *,
    session_id: str,
    approval_token: str,
    now: datetime | None = None,
) -> tuple[str, DesktopLoginSession | None]:
    current = now or _utcnow()
    session = _session_for_approval(db, session_id, approval_token)
    if session is None:
        return "invalid", None
    session = _expire_one(db, session, now=current)
    return session.status, session


def decide_session(
    db: Session,
    *,
    session_id: str,
    approval_token: str,
    user_id: str,
    decision: str,
    now: datetime | None = None,
) -> tuple[str, DesktopLoginSession | None]:
    """Atomically approve or deny one pending session."""
    if decision not in {"approve", "deny"}:
        return "invalid", None
    current = now or _utcnow()
    session = _session_for_approval(db, session_id, approval_token)
    if session is None:
        return "invalid", None
    session = _expire_one(db, session, now=current)
    if session.status != "pending":
        # Same-account retries are safe and make a lost HTTP response idempotent.
        if session.user_id == user_id and (
            (decision == "approve" and session.status in {"approved", "consumed"})
            or (decision == "deny" and session.status == "denied")
        ):
            return session.status, session
        return session.status, session

    target_status = "approved" if decision == "approve" else "denied"
    values: dict = {
        DesktopLoginSession.status: target_status,
        DesktopLoginSession.user_id: user_id,
    }
    if target_status == "approved":
        values[DesktopLoginSession.approved_at] = current
    else:
        values[DesktopLoginSession.denied_at] = current
    changed = (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.id == session.id,
            DesktopLoginSession.approval_token_hash
            == approval_token_hash(approval_token.strip()),
            DesktopLoginSession.status == "pending",
            DesktopLoginSession.expires_at > current,
        )
        .update(values, synchronize_session=False)
    )
    db.commit()
    db.expire_all()
    current_session = db.query(DesktopLoginSession).filter(
        DesktopLoginSession.id == session.id
    ).one()
    if changed == 1:
        return target_status, current_session
    return current_session.status, current_session


def cancel_session(
    db: Session,
    *,
    session_id: str,
    poll_secret: str,
    now: datetime | None = None,
) -> tuple[str, DesktopLoginSession | None]:
    """Cancel a still-pending desktop session using only the poll credential."""
    current = now or _utcnow()
    session = _session_for_poll(db, session_id, poll_secret)
    if session is None:
        return "invalid", None
    session = _expire_one(db, session, now=current)
    if session.status != "pending":
        return session.status, session
    changed = (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.id == session.id,
            DesktopLoginSession.poll_secret_hash == poll_secret_hash(poll_secret.strip()),
            DesktopLoginSession.status == "pending",
            DesktopLoginSession.expires_at > current,
        )
        .update(
            {
                DesktopLoginSession.status: "cancelled",
                DesktopLoginSession.cancelled_at: current,
            },
            synchronize_session=False,
        )
    )
    db.commit()
    db.expire_all()
    current_session = db.query(DesktopLoginSession).filter(
        DesktopLoginSession.id == session.id
    ).one()
    return ("cancelled" if changed == 1 else current_session.status), current_session


def poll_and_consume(
    db: Session,
    *,
    session_id: str,
    poll_secret: str,
    now: datetime | None = None,
) -> DesktopLoginPollResult:
    """Poll pending state or atomically consume one approved session."""
    current = now or _utcnow()
    session = _session_for_poll(db, session_id, poll_secret)
    if session is None:
        return DesktopLoginPollResult("invalid")
    session = _expire_one(db, session, now=current)
    if session.status in TERMINAL_STATUSES:
        return DesktopLoginPollResult(session.status, session=session)

    if session.status == "pending":
        threshold = current - timedelta(seconds=session.poll_interval_seconds)
        changed = (
            db.query(DesktopLoginSession)
            .filter(
                DesktopLoginSession.id == session.id,
                DesktopLoginSession.poll_secret_hash
                == poll_secret_hash(poll_secret.strip()),
                DesktopLoginSession.status == "pending",
                DesktopLoginSession.expires_at > current,
                or_(
                    DesktopLoginSession.last_polled_at.is_(None),
                    DesktopLoginSession.last_polled_at <= threshold,
                ),
            )
            .update(
                {DesktopLoginSession.last_polled_at: current},
                synchronize_session=False,
            )
        )
        db.commit()
        db.expire_all()
        current_session = db.query(DesktopLoginSession).filter(
            DesktopLoginSession.id == session.id
        ).one()
        if changed == 1:
            return DesktopLoginPollResult("pending", session=current_session)
        if current_session.status != "pending":
            session = current_session
        else:
            last_poll = current_session.last_polled_at or current
            elapsed = max(
                0.0,
                (_naive_utc(current) - _naive_utc(last_poll)).total_seconds(),
            )
            retry_after = max(
                1,
                math.ceil(current_session.poll_interval_seconds - elapsed),
            )
            return DesktopLoginPollResult(
                "slow_down",
                session=current_session,
                retry_after_seconds=retry_after,
            )

    if session.status != "approved" or not session.user_id:
        return DesktopLoginPollResult(session.status, session=session)

    user = get_user_by_id(db, session.user_id)
    if user is None or not user.is_active:
        db.query(DesktopLoginSession).filter(
            DesktopLoginSession.id == session.id,
            DesktopLoginSession.status == "approved",
        ).update(
            {
                DesktopLoginSession.status: "cancelled",
                DesktopLoginSession.cancelled_at: current,
            },
            synchronize_session=False,
        )
        db.commit()
        db.expire_all()
        unavailable = db.query(DesktopLoginSession).filter(
            DesktopLoginSession.id == session.id
        ).one()
        return DesktopLoginPollResult("account_unavailable", session=unavailable)

    changed = (
        db.query(DesktopLoginSession)
        .filter(
            DesktopLoginSession.id == session.id,
            DesktopLoginSession.poll_secret_hash == poll_secret_hash(poll_secret.strip()),
            DesktopLoginSession.status == "approved",
            DesktopLoginSession.user_id == user.id,
            DesktopLoginSession.expires_at > current,
            DesktopLoginSession.user_id.in_(
                select(User.id).where(
                    User.id == user.id,
                    User.is_active.is_(True),
                )
            ),
        )
        .update(
            {
                DesktopLoginSession.status: "consumed",
                DesktopLoginSession.consumed_at: current,
                DesktopLoginSession.last_polled_at: current,
            },
            synchronize_session=False,
        )
    )
    db.commit()
    db.expire_all()
    current_session = db.query(DesktopLoginSession).filter(
        DesktopLoginSession.id == session.id
    ).one()
    if changed == 1:
        db.refresh(user)
        if not user.is_active:
            return DesktopLoginPollResult(
                "account_unavailable",
                session=current_session,
            )
        return DesktopLoginPollResult(
            "success",
            session=current_session,
            user=user,
        )
    return DesktopLoginPollResult(current_session.status, session=current_session)
