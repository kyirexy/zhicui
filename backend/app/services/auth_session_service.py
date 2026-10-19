"""Web/桌面登录续期，和权限受限的 Agent 凭证保持隔离。"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request, Response
from sqlalchemy import or_
from sqlalchemy.orm import Session
from app.models.auth_session import UserAuthSession
from app.models.user import User
from app.services import auth_service
from app.services.auth_refresh_receipt import aware, read_receipt, save_receipt

COOKIE = "zhicui_refresh"
ACCESS_SECONDS = 3600
IDLE_DAYS = 30
ABSOLUTE_DAYS = 365


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def rejected(code: str = "SESSION_REVOKED") -> HTTPException:
    return HTTPException(401, detail={"code": code, "message": "知萃登录需要重新验证"})


def lock_user_for_auth_change(db: Session, user_id: str, expected_version: int | None = None) -> User:
    """认证变更统一先锁用户；已鉴权请求不能跨越一次密码重置继续授权。"""
    if expected_version is None:
        expected_version = db.info.get("authenticated_versions", {}).get(user_id)
    user = db.query(User).filter(User.id == user_id).populate_existing().with_for_update().first()
    if user is None or not user.is_active or (expected_version is not None and user.auth_version != expected_version):
        raise rejected()
    return user


def assert_session_active(db: Session, payload: dict, token: str = "") -> None:
    # 直接读取标量，避免请求会话的 ORM 缓存掩盖并发密码重置。
    version = db.query(User.auth_version).filter(User.id == payload.get("sub")).scalar()
    submitted = payload.get("av", 0)
    if version is None or type(submitted) is not int or submitted != version or payload.get("purpose") is not None:
        raise rejected()
    sid = payload.get("sid")
    if not sid:
        # 已迁移会话退出后，原 JWT 不能再次复活它。
        if token and db.query(UserAuthSession).filter(
            UserAuthSession.legacy_token_hash == digest(token),
            UserAuthSession.revoked_at.is_not(None),
        ).first():
            raise rejected()
        return
    row = db.get(UserAuthSession, sid)
    now = datetime.now(timezone.utc)
    if row is None or row.user_id != payload.get("sub") or row.revoked_at or aware(row.expires_at) <= now or aware(row.absolute_expires_at) <= now:
        raise rejected()


def _payload(row: UserAuthSession, user: User, refresh: str) -> dict:
    token = auth_service.create_access_token(user.id, user.email,
        auth_session_id=row.id, ttl_seconds=ACCESS_SECONDS, auth_version=user.auth_version)
    return {"token": token, "user": user.to_dict(), "refresh_token": refresh,
        "expires_in": ACCESS_SECONDS, "session_id": row.id,
        "refresh_expires_at": aware(row.expires_at).isoformat()}


def issue(db: Session, user: User, client_type: str = "web", legacy_token: str = "", *, commit: bool = True) -> dict:
    expected_version = getattr(user, "_login_auth_version", user.auth_version)
    user = lock_user_for_auth_change(db, user.id, expected_version)
    now = datetime.now(timezone.utc)
    sid = uuid.uuid4().hex
    refresh = f"zhc_session_{sid}_{secrets.token_urlsafe(36)}"
    row = UserAuthSession(id=sid, user_id=user.id, client_type=client_type,
        refresh_hash=digest(refresh), created_at=now,
        expires_at=now + timedelta(days=IDLE_DAYS), absolute_expires_at=now + timedelta(days=ABSOLUTE_DAYS),
        legacy_token_hash=digest(legacy_token) if legacy_token else None)
    db.add(row)
    db.flush()
    result = _payload(row, user, refresh)
    if commit:
        db.commit()
    return result


def _row(db: Session, refresh: str) -> UserAuthSession:
    parts = refresh.split("_", 3)
    if len(parts) != 4 or parts[:2] != ["zhc", "session"] or len(parts[2]) != 32:
        raise rejected("SESSION_INVALID")
    row = db.query(UserAuthSession).filter(UserAuthSession.id == parts[2]).populate_existing().with_for_update().first()
    now = datetime.now(timezone.utc)
    if row is None or row.revoked_at or aware(row.expires_at) <= now or aware(row.absolute_expires_at) <= now:
        raise rejected("SESSION_EXPIRED")
    return row


def refresh(db: Session, token: str, request_id: str) -> dict:
    parts = token.split("_", 3)
    if len(parts) != 4 or parts[:2] != ["zhc", "session"] or len(parts[2]) != 32:
        raise rejected("SESSION_INVALID")
    user_id = db.query(UserAuthSession.user_id).filter(UserAuthSession.id == parts[2]).scalar()
    # 与重置密码、迁移一致：先锁用户再锁会话，重置提交后绝不轮换旧凭据。
    user = db.query(User).filter(User.id == user_id).populate_existing().with_for_update().first()
    if user is None or not user.is_active:
        raise rejected("ACCOUNT_DISABLED")
    row = _row(db, token)
    owner = "session:" + row.id
    receipt = read_receipt(db, owner, token, request_id)
    if receipt and secrets.compare_digest(digest(receipt["refresh_token"]), row.refresh_hash):
        # 重试不再次轮换或延长会话；回执里的访问令牌可能已过期，必须重新签发。
        result = _payload(row, user, receipt["refresh_token"])
        db.commit()
        return result
    if not secrets.compare_digest(row.refresh_hash, digest(token)):
        raise rejected("SESSION_REFRESH_REUSED")
    next_token = f"zhc_session_{row.id}_{secrets.token_urlsafe(36)}"
    row.previous_refresh_hash = row.refresh_hash
    row.refresh_hash = digest(next_token)
    row.expires_at = min(datetime.now(timezone.utc) + timedelta(days=IDLE_DAYS), aware(row.absolute_expires_at))
    result = _payload(row, user, next_token)
    save_receipt(db, owner, token, request_id, result,
        expires_at=min(aware(row.expires_at), aware(row.absolute_expires_at)), replace_owner=True)
    db.commit()
    return result


def migrate(db: Session, token: str, request_id: str, client_type: str = "web") -> dict:
    # 仅此恢复入口允许已过期的签名：它只能查找原请求回执，不能授权创建新会话。
    try:
        payload = jwt.decode(token, auth_service.SECRET_KEY, algorithms=[auth_service.ALGORITHM],
            options={"verify_exp": False, "require": ["exp", "sub"]})
        expired = int(payload["exp"]) <= datetime.now(timezone.utc).timestamp()
        if not payload["sub"] or payload.get("purpose") is not None:
            raise ValueError("不是登录访问令牌")
    except (jwt.PyJWTError, TypeError, ValueError, OverflowError):
        raise rejected("SESSION_INVALID") from None
    user = db.query(User).filter(User.id == payload["sub"]).populate_existing().with_for_update().first()
    if user is None or not user.is_active:
        raise rejected("ACCOUNT_DISABLED")
    assert_session_active(db, payload, token)
    owner = "migration:" + digest(token)
    receipt = read_receipt(db, owner, token, request_id)
    if receipt is not None:
        row = _row(db, receipt["refresh_token"])
        if row.user_id != user.id or row.legacy_token_hash != digest(token):
            raise rejected("SESSION_INVALID")
        if not secrets.compare_digest(row.refresh_hash, digest(receipt["refresh_token"])):
            raise rejected("SESSION_REFRESH_REUSED")
        result = _payload(row, user, receipt["refresh_token"])
        db.commit()
        return result
    if expired:
        raise rejected("SESSION_EXPIRED")
    result = issue(db, user, client_type, token, commit=False)
    row = db.get(UserAuthSession, result["session_id"])
    save_receipt(db, owner, token, request_id, result,
        expires_at=min(aware(row.expires_at), aware(row.absolute_expires_at)), replace_owner=True)
    db.commit()
    return result


def public_session(result: dict, request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if request.headers.get("X-Zhicui-Session-Transport") == "native":
        return result
    response.set_cookie(COOKIE, result["refresh_token"], max_age=IDLE_DAYS * 86400,
        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
        httponly=True, samesite="strict", path="/api/auth")
    return {key: value for key, value in result.items() if key != "refresh_token"}


def login_payload(db: Session, user: User, request: Request, response: Response, legacy: str | None = None) -> dict:
    expected_version = getattr(user, "_login_auth_version", user.auth_version)
    user = lock_user_for_auth_change(db, user.id, expected_version)
    if legacy:
        payload = auth_service.decode_access_token(legacy)
        if payload is None:
            raise rejected()
        assert_session_active(db, payload, legacy)
    # 旧客户端尚无自动续期能力，继续使用其原有 30 天 JWT。
    if request.headers.get("X-Zhicui-Session-Version") != "2":
        result = {"token": legacy or auth_service.create_access_token(user.id, user.email,
            auth_version=user.auth_version), "user": user.to_dict()}
        # 后续活动日志用独立连接写 user_id 外键；必须先释放此用户行锁。
        db.commit()
        return result
    return public_session(issue(db, user), request, response)


def reset_password_by_admin(db: Session, *, user_id: str, new_password: str,
                            admin_user_id: str, ip: str | None = None, commit: bool = True) -> bool:
    """密码、所有登录会话及审计在同一事务中落库，失败时全部回滚。"""
    from app.models.desktop_handoff import DesktopHandoff
    from app.models.desktop_login_session import DesktopLoginSession
    from app.models.phone_login_session import PhoneLoginSession
    from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
    from app.services import audit_service

    try:
        user = db.query(User).filter(User.id == user_id).populate_existing().with_for_update().first()
        if user is None:
            return False
        user.hashed_password = auth_service.hash_password(new_password)
        user.auth_version += 1
        now = datetime.now(timezone.utc)
        db.query(UserAuthSession).filter(UserAuthSession.user_id == user_id,
            UserAuthSession.revoked_at.is_(None)).update({UserAuthSession.revoked_at: now}, synchronize_session=False)
        # 先撤销待领取授权，再撤销凭证；所有兑换路径均按 user→授权/凭证加锁。
        db.query(AgentDeviceAuthorization).filter(AgentDeviceAuthorization.approved_user_id == user_id,
            AgentDeviceAuthorization.status.in_(("pending", "approved"))).update(
                {AgentDeviceAuthorization.status: "denied"}, synchronize_session=False)
        db.query(AgentCredential).filter(AgentCredential.user_id == user_id,
            AgentCredential.revoked_at.is_(None)).update({AgentCredential.revoked_at: now}, synchronize_session=False)
        db.query(DesktopHandoff).filter(DesktopHandoff.user_id == user_id,
            DesktopHandoff.status.in_(("pending", "claimed"))).update(
                {DesktopHandoff.status: "expired"}, synchronize_session=False)
        db.query(DesktopLoginSession).filter(DesktopLoginSession.user_id == user_id,
            DesktopLoginSession.status.in_(("pending", "approved"))).update(
                {DesktopLoginSession.status: "cancelled", DesktopLoginSession.cancelled_at: now}, synchronize_session=False)
        db.query(PhoneLoginSession).filter(PhoneLoginSession.user_id == user_id,
            PhoneLoginSession.status.in_(("pending", "scanned", "approved"))).update(
                {PhoneLoginSession.status: "cancelled"}, synchronize_session=False)
        # log_action 在此提交整个事务，不提前提交密码或撤销操作。
        audit_service.log_action(db, admin_user_id=admin_user_id, action="user_reset_password",
            target_type="user", target_id=user_id,
            detail={"username": user.username or user.email, "sessions_revoked": True}, ip=ip, commit=commit)
        return True
    except Exception:
        db.rollback()
        raise


def revoke(db: Session, token: str | None, access_token: str | None) -> None:
    payload = auth_service.decode_access_token(access_token or "")
    rows = []
    if payload and payload.get("sid"):
        row = db.get(UserAuthSession, payload["sid"])
        if row and row.user_id == payload.get("sub"):
            rows.append(row)
    if token:
        # 退出允许使用已到期但仍匹配的刷新凭证。
        # 刷新回包丢失后立刻退出，旧刷新凭据也必须能撤销同一会话。
        token_hash = digest(token)
        row = db.query(UserAuthSession).filter(or_(UserAuthSession.refresh_hash == token_hash,
            UserAuthSession.previous_refresh_hash == token_hash)).first()
        if row:
            rows.append(row)
    for row in rows:
        row.revoked_at = datetime.now(timezone.utc)
    db.commit()
