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


def assert_session_active(db: Session, payload: dict, token: str = "") -> None:
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
        auth_session_id=row.id, ttl_seconds=ACCESS_SECONDS)
    return {"token": token, "user": user.to_dict(), "refresh_token": refresh,
        "expires_in": ACCESS_SECONDS, "session_id": row.id,
        "refresh_expires_at": aware(row.expires_at).isoformat()}


def issue(db: Session, user: User, client_type: str = "web", legacy_token: str = "", *, commit: bool = True) -> dict:
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
    row = db.query(UserAuthSession).filter(UserAuthSession.id == parts[2]).with_for_update().first()
    now = datetime.now(timezone.utc)
    if row is None or row.revoked_at or aware(row.expires_at) <= now or aware(row.absolute_expires_at) <= now:
        raise rejected("SESSION_EXPIRED")
    return row


def refresh(db: Session, token: str, request_id: str) -> dict:
    row = _row(db, token)
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise rejected("ACCOUNT_DISABLED")
    owner = "session:" + row.id
    receipt = read_receipt(db, owner, token, request_id)
    if receipt and secrets.compare_digest(digest(receipt["refresh_token"]), row.refresh_hash):
        # 重试不再次轮换或延长会话；回执里的访问令牌可能已过期，必须重新签发。
        return _payload(row, user, receipt["refresh_token"])
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
    user = db.query(User).filter(User.id == payload["sub"]).with_for_update().first()
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
        return _payload(row, user, receipt["refresh_token"])
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
    # 旧客户端尚无自动续期能力，继续使用其原有 30 天 JWT。
    if request.headers.get("X-Zhicui-Session-Version") != "2":
        return {"token": legacy or auth_service.create_access_token(user.id, user.email), "user": user.to_dict()}
    return public_session(issue(db, user), request, response)


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
