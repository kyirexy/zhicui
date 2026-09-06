"""Legal consent, personal-data export and irreversible account deletion."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import secrets
import zipfile
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, inspect, select, update
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.privacy_account import (
    AccountActionGrant,
    AccountPrivacyAuditEvent,
    UserLegalConsent,
)
from app.models.user import (
    User,
    count_users,
    get_user_by_email,
    get_user_by_username,
)
from app.services.auth_service import SECRET_KEY, hash_password, verify_password


TERMS_VERSION = "2026-08-28"
PRIVACY_VERSION = "2026-09-06"
LEGAL_EFFECTIVE_DATE = "2026-08-28"
PRIVACY_EFFECTIVE_DATE = "2026-09-06"
ACCOUNT_DELETE_CONFIRMATION = "永久注销"
DELETE_GRANT_TTL_MINUTES = 10

LEGAL_DOCUMENTS = {
    "terms": {
        "version": TERMS_VERSION,
        "effective_date": LEGAL_EFFECTIVE_DATE,
        "path": "/legal/terms",
    },
    "privacy": {
        "version": PRIVACY_VERSION,
        "effective_date": PRIVACY_EFFECTIVE_DATE,
        "path": "/legal/privacy",
    },
    "platform_limits": {
        "version": "2026-08-28",
        "effective_date": LEGAL_EFFECTIVE_DATE,
        "path": "/platform-limits",
    },
    "support": {
        "version": "2026-08-28",
        "effective_date": LEGAL_EFFECTIVE_DATE,
        "path": "/support",
    },
}

_CLIENT_TYPES = {"web", "windows", "android", "ios"}
_SENSITIVE_KEYS = {
    "hashed_password",
    "password",
    "encrypted_api_key",
    "api_key",
    "token",
    "token_hash",
    "secret",
    "cookie",
    "cookies",
    "session_scope",
    "download_url",
    "media_url",
    "play_url",
    "audio_url",
    "local_path",
    "media_path",
    "server_path",
    "source_path",
    "client_ip",
    "remote_ip",
    "ip_address",
    "traceback",
    "stack_trace",
    "stacktrace",
    "exception_trace",
    "error_trace",
    "trace_id",
    "request_id",
    "correlation_id",
}


class AccountPasswordError(ValueError):
    pass


class AccountGrantError(ValueError):
    pass


class LastActiveAdminError(ValueError):
    """Raised when deleting an account would leave production unadministrable."""


def _ensure_not_last_active_admin(
    db: Session,
    user: User,
    *,
    lock: bool = False,
) -> None:
    if not bool(user.is_admin and user.is_active):
        return
    active_admin_query = select(User.id).where(
        User.is_admin.is_(True),
        User.is_active.is_(True),
    )
    if lock:
        active_admin_query = active_admin_query.with_for_update()
    active_admin_ids = db.execute(active_admin_query).scalars().all()
    if len(active_admin_ids) <= 1:
        raise LastActiveAdminError(
            "当前账号是最后一个启用的管理员。请先创建或提升另一名启用管理员，再注销此账号"
        )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_client_type(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in _CLIENT_TYPES else "web"


def legal_document_summary() -> dict[str, Any]:
    return {
        "documents": LEGAL_DOCUMENTS,
        "current": {
            "terms_version": TERMS_VERSION,
            "privacy_version": PRIVACY_VERSION,
        },
    }


def validate_registration_consent(
    *,
    accepted_terms: bool,
    accepted_privacy: bool,
    terms_version: str,
    privacy_version: str,
) -> str | None:
    if not accepted_terms or not accepted_privacy:
        return "请先阅读并同意《用户协议》和《隐私政策》"
    if terms_version != TERMS_VERSION or privacy_version != PRIVACY_VERSION:
        return "协议版本已更新，请重新阅读并确认同意"
    return None


def add_registration_consents(
    db: Session,
    *,
    user_id: str,
    client_type: str,
) -> list[UserLegalConsent]:
    """Add current consent rows without committing the surrounding registration."""
    accepted_at = utcnow()
    rows = [
        UserLegalConsent(
            user_id=user_id,
            document_type="terms",
            document_version=TERMS_VERSION,
            client_type=normalize_client_type(client_type),
            accepted_at=accepted_at,
        ),
        UserLegalConsent(
            user_id=user_id,
            document_type="privacy",
            document_version=PRIVACY_VERSION,
            client_type=normalize_client_type(client_type),
            accepted_at=accepted_at,
        ),
    ]
    db.add_all(rows)
    return rows


def register_with_consent(
    db: Session,
    *,
    email: str,
    password: str,
    username: str,
    accepted_terms: bool,
    accepted_privacy: bool,
    terms_version: str,
    privacy_version: str,
    client_type: str,
) -> tuple[User | None, str | None]:
    """Create the user and both consent rows in one database transaction."""
    consent_error = validate_registration_consent(
        accepted_terms=accepted_terms,
        accepted_privacy=accepted_privacy,
        terms_version=terms_version,
        privacy_version=privacy_version,
    )
    if consent_error:
        return None, consent_error

    normalized_email = email.strip().lower()
    normalized_username = username.strip()
    if not normalized_email or "@" not in normalized_email:
        return None, "请输入有效的邮箱地址"
    if len(password) < 6:
        return None, "密码至少需要 6 位字符"
    if len(normalized_username) < 2:
        return None, "请输入用户名（至少 2 个字符）"
    if get_user_by_email(db, normalized_email):
        return None, "该邮箱已注册，请直接登录"
    if get_user_by_username(db, normalized_username):
        return None, "该用户名已被使用"

    user = User(
        email=normalized_email,
        username=normalized_username,
        hashed_password=hash_password(password),
        is_admin=count_users(db) == 0,
    )
    try:
        db.add(user)
        db.flush()
        add_registration_consents(
            db,
            user_id=user.id,
            client_type=client_type,
        )
        db.commit()
        db.refresh(user)
    except Exception:
        db.rollback()
        raise
    return user, None


def list_consents(db: Session, user_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        select(UserLegalConsent)
        .where(UserLegalConsent.user_id == user_id)
        .order_by(UserLegalConsent.accepted_at.asc())
    ).scalars().all()
    return [row.to_dict() for row in rows]


def _subject_reference(user_id: str) -> str:
    return hmac.new(
        SECRET_KEY.encode("utf-8"),
        user_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _verify_current_password(user: User, password: str) -> None:
    if not password or not verify_password(password, user.hashed_password):
        raise AccountPasswordError("当前密码不正确，账号数据未发生变化")


def prepare_account_deletion(
    db: Session,
    *,
    user: User,
    password: str,
    client_type: str,
) -> dict[str, Any]:
    _verify_current_password(user, password)
    _ensure_not_last_active_admin(db, user)
    now = utcnow()
    db.execute(
        update(AccountActionGrant)
        .where(
            AccountActionGrant.user_id == user.id,
            AccountActionGrant.action == "delete_account",
            AccountActionGrant.used_at.is_(None),
        )
        .values(used_at=now)
    )
    token = secrets.token_urlsafe(36)
    expires_at = now + timedelta(minutes=DELETE_GRANT_TTL_MINUTES)
    db.add(AccountActionGrant(
        user_id=user.id,
        action="delete_account",
        token_hash=_token_hash(token),
        client_type=normalize_client_type(client_type),
        expires_at=expires_at,
    ))
    db.commit()
    return {
        "confirmation_token": token,
        "expires_at": expires_at.isoformat(),
        "confirmation_phrase": ACCOUNT_DELETE_CONFIRMATION,
        "impact": [
            "删除账号资料与登录状态",
            "删除视频资料、完整文稿、知识、AI 对话和行动计划",
            "解除抖音等平台账号绑定并删除相关授权信息",
            "此操作完成后无法撤销",
        ],
    }


def _is_sensitive_key(key: str) -> bool:
    normalized = key.strip().lower()
    if normalized in _SENSITIVE_KEYS:
        return True
    return any(marker in normalized for marker in (
        "password",
        "cookie",
        "secret",
        "token_hash",
        "encrypted_",
        "traceback",
        "stack_trace",
        "stacktrace",
    ))


def _sanitize_value(value: Any, key: str = "") -> Any:
    if _is_sensitive_key(key):
        return None
    if value is None or isinstance(value, (bool, int, float, str)):
        if isinstance(value, str):
            stripped = value.strip()
            if stripped[:1] in {"{", "["}:
                try:
                    return _sanitize_value(json.loads(stripped), key)
                except (json.JSONDecodeError, TypeError):
                    pass
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return "[binary omitted]"
    if isinstance(value, dict):
        return {
            str(item_key): _sanitize_value(item_value, str(item_key))
            for item_key, item_value in value.items()
            if not _is_sensitive_key(str(item_key))
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize_value(item) for item in value]
    return str(value)


def _safe_table_rows(db: Session, table_name: str, user_id: str) -> list[dict[str, Any]]:
    table = Base.metadata.tables.get(table_name)
    if (
        table is None
        or "user_id" not in table.c
        or not inspect(db.get_bind()).has_table(table.name)
    ):
        return []
    rows = db.execute(select(table).where(table.c.user_id == user_id)).mappings().all()
    return [
        {
            key: _sanitize_value(value, key)
            for key, value in dict(row).items()
            if key != "user_id" and not _is_sensitive_key(key)
        }
        for row in rows
    ]


_EXPORT_GROUPS: dict[str, tuple[str, ...]] = {
    "video_library": (
        "notes",
        "creator_sources",
        "creator_source_items",
        "douyin_local_library_items",
        "video_source_ledger",
        "library_hidden_items",
        "library_extraction_batches",
        "library_extraction_batch_items",
    ),
    "ai_conversations": (
        "agent_threads",
        "agent_messages",
        "agent_turns",
        "agent_events",
        "agent_turn_sources",
        "agent_memory_checkpoints",
    ),
    "knowledge": ("knowledge_entries",),
    "plans": ("plans", "agent_automations", "agent_automation_runs"),
    "account_settings": (
        "user_ai_provider_configs",
        "user_custom_chat_models",
        "user_vision_provider_configs",
        "user_chat_model_selections",
    ),
    "platform_and_analysis": (
        "douyin_account_bindings",
        "video_analyses",
        "video_analysis_runs",
        "video_analysis_items",
    ),
    "consents": ("user_legal_consents",),
}


# 财务/额度、错误与运维审计记录承担对账和安全审计职责，不能随着业务
# 内容一起删除；同时也不能继续保留可回溯到已注销账号的 UUID。这里采用
# 显式 allowlist，注销时只把身份列匿名化，其他带 user_id 的业务表仍删除。
_ANONYMIZE_ON_ACCOUNT_DELETION: dict[str, tuple[str, ...]] = {
    "admin_audit_logs": ("admin_user_id",),
    "analysis_credit_ledger": ("user_id", "admin_user_id"),
    "application_error_logs": ("user_id",),
    "llm_usage_logs": ("user_id",),
    "user_activity_logs": ("user_id",),
    "creator_catalog_quality_runs": ("requested_by_id",),
    "operational_alerts": ("acknowledged_by",),
}


def build_personal_data_archive(
    db: Session,
    *,
    user: User,
    password: str,
    client_type: str,
) -> tuple[bytes, str]:
    _verify_current_password(user, password)
    generated_at = utcnow()
    data: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": generated_at.isoformat(),
        "account": {
            "id": user.id,
            "email": user.email,
            "username": user.username,
            "email_verified": bool(user.email_verified),
            "created_at": user.created_at.isoformat() if user.created_at else None,
        },
    }
    for group, table_names in _EXPORT_GROUPS.items():
        grouped: dict[str, list[dict[str, Any]]] = {}
        for table_name in table_names:
            rows = _safe_table_rows(db, table_name, user.id)
            if rows:
                grouped[table_name] = rows
        data[group] = grouped

    db.add(AccountPrivacyAuditEvent(
        subject_reference=_subject_reference(user.id),
        action="personal_data_export",
        client_type=normalize_client_type(client_type),
        detail_json=json.dumps({"schema_version": 1}, ensure_ascii=False),
    ))
    db.commit()

    data_bytes = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    manifest = {
        "product": "知萃",
        "schema_version": 1,
        "generated_at": generated_at.isoformat(),
        "format": "JSON in ZIP",
        "excluded": [
            "密码哈希",
            "Cookie、令牌与 API 密钥",
            "临时媒体播放地址",
            "服务器文件路径与二进制文件",
        ],
        "data_sha256": hashlib.sha256(data_bytes).hexdigest(),
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("data.json", data_bytes)
    filename = f"zhicui-personal-data-{generated_at.strftime('%Y%m%d-%H%M%S')}.zip"
    return output.getvalue(), filename


def _delete_user_related_rows(db: Session, user_id: str) -> dict[str, int]:
    deleted_counts: dict[str, int] = {}
    db_inspector = inspect(db.get_bind())
    existing_tables = set(db_inspector.get_table_names())

    for table_name, identity_columns in _ANONYMIZE_ON_ACCOUNT_DELETION.items():
        table = Base.metadata.tables.get(table_name)
        if table is None or table_name not in existing_tables:
            continue
        existing_identity_columns = [
            column_name for column_name in identity_columns if column_name in table.c
        ]
        for column_name in existing_identity_columns:
            anonymized_values = {column_name: None}
            if table_name == "admin_audit_logs" and column_name == "admin_user_id":
                # IP and free-form detail can also identify the acting admin.
                # Preserve the immutable action/target/time audit skeleton.
                anonymized_values.update({"ip": None, "detail": None})
            result = db.execute(
                update(table)
                .where(table.c[column_name] == user_id)
                .values(anonymized_values)
            )
            if result.rowcount:
                key = f"anonymized:{table_name}"
                deleted_counts[key] = deleted_counts.get(key, 0) + int(result.rowcount)

    # Reverse dependency order protects databases where cascade constraints are
    # unavailable or have not yet been migrated onto legacy tables.
    for table in reversed(Base.metadata.sorted_tables):
        if (
            table.name in {"users", "account_privacy_audit_events"}
            or table.name in _ANONYMIZE_ON_ACCOUNT_DELETION
            or table.name not in existing_tables
        ):
            continue
        if "user_id" not in table.c:
            continue
        result = db.execute(delete(table).where(table.c.user_id == user_id))
        if result.rowcount:
            deleted_counts[table.name] = int(result.rowcount)

    # Remaining business records can refer to a user through a differently
    # named column. Immutable/audit records are listed above and anonymized;
    # only non-audit rows reach this deletion pass.
    for table in reversed(Base.metadata.sorted_tables):
        if (
            table.name not in existing_tables
            or table.name in _ANONYMIZE_ON_ACCOUNT_DELETION
        ):
            continue
        for column_name in ("admin_user_id", "created_by_user_id"):
            if table.name == "account_privacy_audit_events" or column_name not in table.c:
                continue
            result = db.execute(delete(table).where(table.c[column_name] == user_id))
            if result.rowcount:
                deleted_counts[table.name] = deleted_counts.get(table.name, 0) + int(result.rowcount)

    audit_table = Base.metadata.tables.get("admin_audit_logs")
    if (
        audit_table is not None
        and audit_table.name in existing_tables
        and "target_id" in audit_table.c
    ):
        db.execute(
            update(audit_table)
            .where(audit_table.c.target_type == "user", audit_table.c.target_id == user_id)
            .values(target_id=None, detail=None)
        )
    return deleted_counts


def confirm_account_deletion(
    db: Session,
    *,
    user: User,
    confirmation_token: str,
    confirmation_phrase: str,
) -> dict[str, Any]:
    if confirmation_phrase.strip() != ACCOUNT_DELETE_CONFIRMATION:
        raise AccountGrantError(f"请输入“{ACCOUNT_DELETE_CONFIRMATION}”确认不可逆操作")
    now = utcnow()
    grant = db.execute(
        select(AccountActionGrant)
        .where(
            AccountActionGrant.user_id == user.id,
            AccountActionGrant.action == "delete_account",
            AccountActionGrant.token_hash == _token_hash(confirmation_token),
            AccountActionGrant.used_at.is_(None),
        )
        .with_for_update()
    ).scalar_one_or_none()
    if grant is None:
        raise AccountGrantError("注销确认已失效，请重新验证密码")
    if _as_utc(grant.expires_at) <= now:
        grant.used_at = now
        db.commit()
        raise AccountGrantError("注销确认已过期，请重新验证密码")

    # Re-check inside the final transaction: another administrator may have
    # been disabled between password verification and irreversible deletion.
    _ensure_not_last_active_admin(db, user, lock=True)

    audit_event = AccountPrivacyAuditEvent(
        subject_reference=_subject_reference(user.id),
        action="account_deleted",
        client_type=grant.client_type,
        detail_json=json.dumps({"transactional": True}, ensure_ascii=False),
    )
    db.add(audit_event)
    try:
        deleted_counts = _delete_user_related_rows(db, user.id)
        db.execute(delete(User).where(User.id == user.id))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        "deleted": True,
        "audit_event_id": audit_event.id,
        "deleted_categories": sorted(deleted_counts),
    }
