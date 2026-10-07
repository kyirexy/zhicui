"""同一次刷新丢失响应后可以取回结果，不能用旧凭证发起新的刷新。"""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session
from app.core.config import settings
from app.models.auth_session import AuthRefreshReceipt


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=value.tzinfo or timezone.utc)


def _cipher() -> Fernet:
    # 独立用途派生，不允许像普通非敏感设置那样降级为明文存储。
    secret = settings.ENCRYPTION_KEY or settings.JWT_SECRET
    if not secret:
        raise RuntimeError("缺少会话加密配置")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("auth-receipt-v1:" + secret).encode()).digest()))


def _key(owner: str, token: str, request_id: str) -> str:
    return hashlib.sha256(f"{owner}\0{token}\0{request_id}".encode()).hexdigest()


def read_receipt(db: Session, owner: str, token: str, request_id: str | None) -> dict | None:
    if not request_id:
        return None
    row = db.get(AuthRefreshReceipt, _key(owner, token, request_id))
    if row is None or aware(row.expires_at) <= datetime.now(timezone.utc):
        return None
    return json.loads(_cipher().decrypt(row.encrypted_result.encode()).decode())


def save_receipt(db: Session, owner: str, token: str, request_id: str | None, result: dict) -> None:
    if not request_id:
        return
    now = datetime.now(timezone.utc)
    db.query(AuthRefreshReceipt).filter(AuthRefreshReceipt.expires_at <= now).delete(synchronize_session=False)
    db.merge(AuthRefreshReceipt(id=_key(owner, token, request_id), owner=owner,
        encrypted_result=_cipher().encrypt(json.dumps(result).encode()).decode(),
        expires_at=now + timedelta(minutes=10)))
