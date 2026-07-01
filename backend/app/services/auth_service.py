"""
Authentication service — JWT issuance, password hashing, login/register.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from sqlalchemy.orm import Session
from werkzeug.security import generate_password_hash, check_password_hash

from app.models.user import User, create_user, get_user_by_email
from app.core.config import settings

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_JWT_SECRET = settings.JWT_SECRET or os.environ.get("JWT_SECRET", "")
if not _JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET 环境变量未设置。请生成一个随机密钥：\n"
        "  python -c \"import secrets; print(secrets.token_hex(32))\"\n"
        "然后将其写入 backend/.env 或部署平台的 Secret Manager。"
    )
SECRET_KEY: str = _JWT_SECRET
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 30  # long-lived for MVP, refresh later


# ---------------------------------------------------------------------------
# Password
# ---------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return generate_password_hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return check_password_hash(hashed, plain)


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------
def create_access_token(user_id: str, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ---------------------------------------------------------------------------
# Business logic
# ---------------------------------------------------------------------------
def register(db: Session, email: str, password: str) -> tuple[User | None, str | None]:
    """Register a new user. Returns (user, error)."""
    email = email.strip().lower()
    if not email or "@" not in email:
        return None, "请输入有效的邮箱地址"
    if len(password) < 6:
        return None, "密码至少需要 6 位字符"

    existing = get_user_by_email(db, email)
    if existing:
        return None, "该邮箱已注册，请直接登录"

    user = create_user(db, email, hash_password(password))
    return user, None


def login(db: Session, email: str, password: str) -> tuple[str | None, User | None, str | None]:
    """Login. Returns (token, user, error)."""
    email = email.strip().lower()
    user = get_user_by_email(db, email)
    if not user:
        return None, None, "邮箱未注册"
    if not verify_password(password, user.hashed_password):
        return None, None, "密码错误"
    if not user.is_active:
        return None, None, "账号已被禁用"

    token = create_access_token(user.id, user.email)
    return token, user, None
