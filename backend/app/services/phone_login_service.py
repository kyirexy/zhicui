"""电脑确认、手机领取；二维码绝不能直接兑换账号会话。"""
import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.phone_login_session import PhoneLoginSession as Login
from app.models.user import User


ACTIVE = ("pending", "scanned", "approved")
ID_PATTERN = re.compile(r"^pls-[a-f0-9]{32}$")
SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")


def now():
    return datetime.now(timezone.utc)


def digest(purpose, value):
    return hashlib.sha256(f"zhicui:phone-login:v1:{purpose}:{value}".encode()).hexdigest()


def public(row):
    expires = row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
    return {"session_id": row.id, "status": row.status, "expires_at": expires.isoformat(),
            "verification_code": row.verification_code, "client_type": row.client_type}


def fresh(db, session_id):
    if not ID_PATTERN.fullmatch(session_id):
        return None
    current = now()
    db.query(Login).filter(Login.id == session_id, Login.status.in_(ACTIVE), Login.expires_at <= current).update(
        {Login.status: "expired"}, synchronize_session=False)
    db.commit()
    return db.query(Login).filter(Login.id == session_id).populate_existing().first()


def create(db: Session, user_id: str):
    current = now()
    # 同一账号只保留一个可用二维码；清理仅针对过期临时认证记录。
    db.query(Login).filter(Login.user_id == user_id, Login.status.in_(ACTIVE)).update(
        {Login.status: "cancelled"}, synchronize_session=False)
    db.query(Login).filter(Login.expires_at < current - timedelta(days=1)).delete(synchronize_session=False)
    secret = secrets.token_urlsafe(32)
    row = Login(user_id=user_id, scan_hash=digest("scan", secret), status="pending",
                created_at=current, expires_at=current + timedelta(minutes=5))
    db.add(row)
    db.commit()
    db.refresh(row)
    return {**public(row), "qr_url": f"{settings.PUBLIC_APP_URL.rstrip('/')}/login#phone-login={row.id}.{secret}"}


def owned(db, session_id, user_id):
    row = fresh(db, session_id)
    return row if row and row.user_id == user_id else None


def claim(db, session_id, scan_secret, claim_secret, client_type):
    if not SECRET_PATTERN.fullmatch(scan_secret) or not SECRET_PATTERN.fullmatch(claim_secret):
        return None
    row = fresh(db, session_id)
    if not row or not secrets.compare_digest(row.scan_hash, digest("scan", scan_secret)):
        return None
    claim_hash = digest("claim", claim_secret)
    if row.status == "pending":
        db.query(Login).filter(Login.id == session_id, Login.status == "pending", Login.expires_at > now()).update(
            {Login.status: "scanned", Login.claim_hash: claim_hash, Login.client_type: client_type,
             Login.verification_code: f"{secrets.randbelow(10000):04d}"}, synchronize_session=False)
        db.commit()
        db.refresh(row)
    # 网络重试仅允许原手机；另外一台手机不能抢走已经绑定的领取权。
    if not row.claim_hash or not secrets.compare_digest(row.claim_hash, claim_hash):
        return None
    return public(row)


def decide(db, session_id, user_id, decision, verification_code):
    row = owned(db, session_id, user_id)
    if row is None:
        return None
    if decision == "approve" and (row.status != "scanned" or row.verification_code != verification_code):
        return {**public(row), "error": "请核对手机上的确认码，再重新确认"}
    target = "approved" if decision == "approve" else "cancelled"
    eligible = ("scanned",) if decision == "approve" else ACTIVE
    db.query(Login).filter(Login.id == session_id, Login.user_id == user_id,
                          Login.status.in_(eligible), Login.expires_at > now()).update(
        {Login.status: target}, synchronize_session=False)
    db.commit()
    db.refresh(row)
    return public(row)


def consume(db, session_id, claim_secret):
    if not SECRET_PATTERN.fullmatch(claim_secret):
        return None, None
    row = fresh(db, session_id)
    if not row or not row.claim_hash or not secrets.compare_digest(row.claim_hash, digest("claim", claim_secret)):
        return None, None
    if row.status not in ("scanned", "approved"):
        return public(row), None
    user = db.query(User).filter(User.id == row.user_id, User.is_active.is_(True)).first()
    if user is None:
        return {"status": "account_unavailable"}, None
    current = now()
    if row.status == "approved":
        changed = db.query(Login).filter(
            Login.id == session_id, Login.status == "approved", Login.expires_at > current,
            Login.claim_hash == digest("claim", claim_secret),
            Login.user_id.in_(select(User.id).where(User.is_active.is_(True))),
        ).update({Login.status: "consumed", Login.last_polled_at: current}, synchronize_session=False)
        db.commit()
        db.refresh(row)
        db.refresh(user)
        if changed == 1 and user.is_active:
            return {"status": "success"}, user
        return public(row), None
    changed = db.query(Login).filter(
        Login.id == session_id, Login.status == "scanned",
        or_(Login.last_polled_at.is_(None), Login.last_polled_at <= current - timedelta(seconds=2)),
    ).update({Login.last_polled_at: current}, synchronize_session=False)
    db.commit()
    return {"status": "scanned" if changed else "slow_down", "retry_after_seconds": 2}, None
