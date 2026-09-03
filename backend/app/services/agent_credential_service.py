"""Hashed PAT and browser device-authorization credentials."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.core.config import settings
from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
from app.models.user import User
from app.services.agent_rollout_service import user_is_enabled


PAT_TTL_DAYS = 90
ACCESS_TTL_MINUTES = 60
REFRESH_TTL_DAYS = 30
DEVICE_TTL_MINUTES = 10
MAX_ACTIVE_CREDENTIALS = 30


class CredentialError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class AgentPrincipal:
    user: User
    credential: AgentCredential | None
    scopes: frozenset[str]
    auth_type: str

    @property
    def credential_key(self) -> str:
        return self.credential.id if self.credential is not None else "browser-session"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _pepper() -> bytes:
    value = (settings.AGENT_TOKEN_PEPPER or settings.JWT_SECRET or "").encode("utf-8")
    if not value:
        raise RuntimeError("AGENT_TOKEN_PEPPER 或 JWT_SECRET 未配置")
    return value


def token_hash(token: str) -> str:
    return hmac.new(_pepper(), token.encode("utf-8"), hashlib.sha256).hexdigest()


def normalize_scopes(scopes: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    normalized = sorted({str(scope or "").strip() for scope in scopes if str(scope or "").strip()})
    invalid = [scope for scope in normalized if scope not in ALL_SCOPE_IDS]
    if invalid:
        raise CredentialError("INVALID_SCOPE", f"未知权限范围：{', '.join(invalid[:5])}")
    if not normalized:
        raise CredentialError("INVALID_SCOPE", "请至少选择一个权限范围")
    return normalized


def _new_token(kind: str, credential_id: str) -> str:
    return f"zhc_{kind}_{credential_id}_{secrets.token_urlsafe(36)}"


def _parse_token(token: str, allowed_kinds: set[str]) -> tuple[str, str]:
    parts = str(token or "").strip().split("_", 3)
    if len(parts) != 4 or parts[0] != "zhc" or parts[1] not in allowed_kinds:
        raise CredentialError("INVALID_CREDENTIAL", "Agent 凭证格式无效")
    credential_id = parts[2]
    if len(credential_id) != 32:
        raise CredentialError("INVALID_CREDENTIAL", "Agent 凭证格式无效")
    return parts[1], credential_id


def _assert_active(row: AgentCredential, now: datetime | None = None) -> None:
    current = now or utcnow()
    if row.revoked_at is not None:
        raise CredentialError("CREDENTIAL_REVOKED", "Agent 凭证已被吊销")
    if (_aware(row.expires_at) or current) <= current:
        raise CredentialError("CREDENTIAL_EXPIRED", "Agent 凭证已过期")


def issue_pat(
    db: Session,
    *,
    user_id: str,
    name: str,
    scopes: list[str],
    expires_in_days: int = PAT_TTL_DAYS,
) -> tuple[AgentCredential, str]:
    clean_scopes = normalize_scopes(scopes)
    active_count = db.query(AgentCredential).filter(
        AgentCredential.user_id == user_id,
        AgentCredential.revoked_at.is_(None),
    ).count()
    if active_count >= MAX_ACTIVE_CREDENTIALS:
        raise CredentialError("CREDENTIAL_LIMIT_REACHED", "已达到 Agent 凭证数量上限")
    ttl = max(1, min(int(expires_in_days), PAT_TTL_DAYS))
    row = AgentCredential(
        user_id=user_id,
        kind="pat",
        name=(name or "知萃 PAT").strip()[:120],
        client_type="pat",
        token_hash="pending",
        token_prefix="pending",
        scopes_json=json.dumps(clean_scopes, separators=(",", ":")),
        expires_at=utcnow() + timedelta(days=ttl),
    )
    db.add(row)
    db.flush()
    token = _new_token("pat", row.id)
    row.token_hash = token_hash(token)
    row.token_prefix = token[:18]
    db.commit()
    db.refresh(row)
    return row, token


def list_credentials(db: Session, user_id: str) -> list[AgentCredential]:
    return db.query(AgentCredential).filter(
        AgentCredential.user_id == user_id,
    ).order_by(AgentCredential.created_at.desc()).all()


def revoke_credential(db: Session, *, user_id: str, credential_id: str) -> AgentCredential:
    row = db.query(AgentCredential).filter(
        AgentCredential.id == credential_id,
        AgentCredential.user_id == user_id,
    ).first()
    if row is None:
        raise CredentialError("CREDENTIAL_NOT_FOUND", "Agent 凭证不存在")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        row.updated_at = utcnow()
        db.commit()
        db.refresh(row)
    return row


def authenticate_access_token(db: Session, token: str) -> AgentCredential:
    kind, credential_id = _parse_token(token, {"pat", "access"})
    row = db.query(AgentCredential).filter(
        AgentCredential.id == credential_id,
        AgentCredential.kind == kind,
    ).first()
    if row is None or not hmac.compare_digest(row.token_hash, token_hash(token)):
        raise CredentialError("INVALID_CREDENTIAL", "Agent 凭证无效")
    _assert_active(row)
    row.last_used_at = utcnow()
    db.commit()
    db.refresh(row)
    return row


def require_active_credential(
    db: Session,
    *,
    credential_id: str,
    user_id: str,
) -> AgentCredential:
    """Revalidate an already-authenticated long-lived connection.

    SSE connections outlive the request dependency session.  Looking the
    credential up again by its captured identity lets revocation, expiry and
    rollout removal take effect between event batches without retaining or
    re-reading the bearer token.
    """

    row = db.query(AgentCredential).filter(
        AgentCredential.id == credential_id,
        AgentCredential.user_id == user_id,
    ).first()
    if row is None:
        raise CredentialError("INVALID_CREDENTIAL", "Agent 凭证无效")
    _assert_active(row)
    if not user_is_enabled(row.user_id):
        raise CredentialError("ROLLOUT_RESTRICTED", "Agent 接口尚未向当前账号开放")
    return row


def create_device_authorization(
    db: Session,
    *,
    client_name: str,
    client_type: str,
    scopes: list[str],
) -> tuple[AgentDeviceAuthorization, str, str]:
    clean_scopes = normalize_scopes(scopes)
    device_code = secrets.token_urlsafe(36)
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    user_code = f"{raw[:4]}-{raw[4:]}"
    row = AgentDeviceAuthorization(
        device_code_hash=token_hash(device_code),
        user_code_hash=token_hash(user_code.upper()),
        # The approval code is itself a short-lived credential.  Persist only
        # a non-actionable suffix for diagnostics; the full code is returned
        # once to the CLI and otherwise exists only as a keyed digest.
        user_code_hint=user_code[-4:],
        requested_scopes_json=json.dumps(clean_scopes, separators=(",", ":")),
        client_name=(client_name or "知萃 CLI").strip()[:120],
        client_type=(client_type or "cli").strip()[:32],
        expires_at=utcnow() + timedelta(minutes=DEVICE_TTL_MINUTES),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, device_code, user_code


def approve_device_authorization(
    db: Session,
    *,
    user_id: str,
    user_code: str,
    approve: bool,
) -> AgentDeviceAuthorization:
    code_hash = token_hash(str(user_code or "").strip().upper())
    row = db.query(AgentDeviceAuthorization).filter(
        AgentDeviceAuthorization.user_code_hash == code_hash,
    ).with_for_update().first()
    if row is None:
        raise CredentialError("DEVICE_CODE_INVALID", "设备授权码无效")
    if (_aware(row.expires_at) or utcnow()) <= utcnow():
        row.status = "expired"
        db.commit()
        raise CredentialError("DEVICE_CODE_EXPIRED", "设备授权码已过期")
    if row.status != "pending":
        raise CredentialError("DEVICE_CODE_USED", "设备授权请求已处理")
    row.status = "approved" if approve else "denied"
    row.approved_user_id = user_id if approve else None
    row.approved_at = utcnow()
    db.commit()
    db.refresh(row)
    return row


def preview_device_authorization(
    db: Session,
    *,
    user_code: str,
) -> AgentDeviceAuthorization:
    """Resolve one pending device request without approving it.

    The browser uses this read-only lookup to show the requesting client and
    exact scopes before it enables Allow/Deny.  The full code remains hashed
    at rest and is never returned by this function.
    """
    code_hash = token_hash(str(user_code or "").strip().upper())
    row = db.query(AgentDeviceAuthorization).filter(
        AgentDeviceAuthorization.user_code_hash == code_hash,
    ).first()
    if row is None:
        raise CredentialError("DEVICE_CODE_INVALID", "设备授权码无效")
    if (_aware(row.expires_at) or utcnow()) <= utcnow():
        if row.status != "expired":
            row.status = "expired"
            db.commit()
        raise CredentialError("DEVICE_CODE_EXPIRED", "设备授权码已过期")
    if row.status != "pending":
        raise CredentialError("DEVICE_CODE_USED", "设备授权请求已处理")
    return row


def poll_device_authorization(
    db: Session,
    *,
    device_code: str,
) -> dict[str, Any]:
    digest = token_hash(str(device_code or "").strip())
    row = db.query(AgentDeviceAuthorization).filter(
        AgentDeviceAuthorization.device_code_hash == digest,
    ).with_for_update().first()
    if row is None:
        raise CredentialError("DEVICE_CODE_INVALID", "设备授权请求不存在")
    now = utcnow()
    if (_aware(row.expires_at) or now) <= now:
        row.status = "expired"
        db.commit()
        raise CredentialError("DEVICE_CODE_EXPIRED", "设备授权请求已过期")
    if row.status == "pending":
        row.last_polled_at = now
        db.commit()
        raise CredentialError("AUTHORIZATION_PENDING", "等待用户在浏览器中确认", retryable=True)
    if row.status == "denied":
        raise CredentialError("ACCESS_DENIED", "用户拒绝了设备授权")
    if row.status == "consumed":
        raise CredentialError("DEVICE_CODE_USED", "设备授权码已使用")
    if row.status != "approved" or not row.approved_user_id:
        raise CredentialError("DEVICE_CODE_INVALID", "设备授权状态无效")
    if not user_is_enabled(row.approved_user_id):
        raise CredentialError(
            "ROLLOUT_RESTRICTED", "Agent 接口尚未向当前账号开放",
        )

    credential = AgentCredential(
        user_id=row.approved_user_id,
        kind="access",
        name=row.client_name,
        client_type=row.client_type,
        token_hash="pending",
        token_prefix="pending",
        refresh_hash="pending",
        scopes_json=json.dumps(row.requested_scopes, separators=(",", ":")),
        expires_at=now + timedelta(minutes=ACCESS_TTL_MINUTES),
        refresh_expires_at=now + timedelta(days=REFRESH_TTL_DAYS),
    )
    db.add(credential)
    db.flush()
    access_token = _new_token("access", credential.id)
    refresh_token = _new_token("refresh", credential.id)
    credential.token_hash = token_hash(access_token)
    credential.refresh_hash = token_hash(refresh_token)
    credential.token_prefix = access_token[:18]
    row.status = "consumed"
    row.credential_id = credential.id
    row.consumed_at = now
    db.commit()
    db.refresh(credential)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_MINUTES * 60,
        "credential": credential.to_public_dict(),
    }


def rotate_refresh_token(db: Session, refresh_token: str) -> dict[str, Any]:
    kind, credential_id = _parse_token(refresh_token, {"refresh"})
    del kind
    row = db.query(AgentCredential).filter(
        AgentCredential.id == credential_id,
        AgentCredential.kind == "access",
    ).with_for_update().first()
    digest = token_hash(refresh_token)
    if row is None or not row.refresh_hash or not hmac.compare_digest(row.refresh_hash, digest):
        # Only a digest that matches the immediately previous token is a
        # confirmed replay signal.  A random malformed token must not be able
        # to revoke a credential merely because its public id is known.
        replayed = bool(
            row is not None
            and row.previous_refresh_hash
            and hmac.compare_digest(row.previous_refresh_hash, digest)
        )
        if replayed and row is not None and row.revoked_at is None:
            row.revoked_at = utcnow()
            db.commit()
        raise CredentialError(
            "REFRESH_TOKEN_REUSED" if replayed else "INVALID_CREDENTIAL",
            "刷新凭证已失效，请重新授权" if replayed else "刷新凭证无效",
        )
    now = utcnow()
    if row.revoked_at is not None:
        raise CredentialError("CREDENTIAL_REVOKED", "Agent 连接已被吊销")
    if not user_is_enabled(row.user_id):
        raise CredentialError(
            "ROLLOUT_RESTRICTED", "Agent 接口尚未向当前账号开放",
        )
    if not row.refresh_expires_at or (_aware(row.refresh_expires_at) or now) <= now:
        raise CredentialError("REFRESH_TOKEN_EXPIRED", "刷新凭证已过期，请重新授权")
    access_token = _new_token("access", row.id)
    next_refresh = _new_token("refresh", row.id)
    row.token_hash = token_hash(access_token)
    row.previous_refresh_hash = row.refresh_hash
    row.refresh_hash = token_hash(next_refresh)
    row.token_prefix = access_token[:18]
    row.refresh_generation += 1
    row.expires_at = now + timedelta(minutes=ACCESS_TTL_MINUTES)
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return {
        "access_token": access_token,
        "refresh_token": next_refresh,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_MINUTES * 60,
        "credential": row.to_public_dict(),
    }
