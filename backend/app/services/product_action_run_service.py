"""Invocation, durable Run/event state, idempotency, confirmation and audit."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.agent_interface.contracts import (
    ActionEnvelope,
    EventRecord,
    ExecutionLocation,
    IdempotencyStrategy,
    RunRecord,
    RunStatus,
    TERMINAL_STATUSES,
    error_payload,
)
from app.models.agent_interface import (
    AgentCredential,
    ProductActionAudit,
    ProductActionConfirmation,
    ProductActionEvent,
    ProductActionIdempotency,
    ProductActionRateWindow,
    ProductActionRun,
)
from app.models.agent_runtime import AgentTurn
from app.models.user import User
from app.core.request_context import reset_request_context, set_request_context
from app.services import (
    agent_runtime_service,
    creator_sync_service,
    library_extraction_service,
    video_analysis_service,
)
from app.services.agent_credential_service import AgentPrincipal
from app.services.product_action_handlers import ActionHandlerError, get_handler
from app.services.product_action_registry import ProductActionDefinition, registry
from app.services.agent_rollout_service import action_is_enabled


class ProductActionError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
        http_status: int = 400,
    ):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details or {}
        self.http_status = http_status


@dataclass
class ActionContext:
    db: Session
    user: User
    credential: AgentCredential | None
    run: ProductActionRun
    request_id: str


RUN_LEASE_SECONDS = 45
_ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "waiting_for_user", "failed", "canceled"}),
    "running": frozenset({"waiting_for_user", "succeeded", "failed", "canceled"}),
    "waiting_for_user": frozenset({"queued", "running", "failed", "canceled"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "canceled": frozenset(),
}


_SECRET_KEYS = {
    "api_key", "apikey", "password", "cookie", "cookies", "jwt", "token",
    "access_token", "refresh_token", "authorization", "device_code",
    "confirmation_token", "download_url", "media_url", "play_url", "local_path",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalized_input_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def redact_secrets(value: Any, *, key: str = "") -> Any:
    normalized_key = key.lower().replace("-", "_")
    if normalized_key in _SECRET_KEYS or any(
        marker in normalized_key
        for marker in ("password", "cookie", "secret", "token_hash", "encrypted_api")
    ):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            str(item_key): redact_secrets(item_value, key=str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        return value[:200_000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:1000]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def serialize_run(run: ProductActionRun) -> RunRecord:
    return RunRecord(
        id=run.id,
        action_id=run.action_id,
        action_version=run.action_version,
        status=run.status,
        run_type=run.run_type,
        execution_location=run.execution_location,
        cancellation_requested=bool(run.cancellation_requested),
        last_event_sequence=max(0, run.next_sequence - 1),
        data=redact_secrets(run.output),
        error=run.error,
        created_at=_iso(run.created_at) or "",
        started_at=_iso(run.started_at),
        completed_at=_iso(run.completed_at),
        updated_at=_iso(run.updated_at) or "",
    )


def serialize_event(event: ProductActionEvent) -> EventRecord:
    return EventRecord(
        id=event.id,
        run_id=event.run_id,
        sequence=event.sequence,
        type=event.event_type,
        status=event.status,
        message=event.message,
        data=redact_secrets(event.data),
        terminal=bool(event.terminal),
        created_at=_iso(event.created_at) or "",
    )


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _schema_error(path: str, message: str) -> None:
    raise ProductActionError(
        "INVALID_INPUT", f"字段 {path} {message}", http_status=422
    )


def _validate_schema_value(schema: dict[str, Any], value: Any, path: str) -> None:
    """Validate the JSON-Schema subset published by the v1 Registry.

    Keeping this small subset in-tree avoids a production-only dependency,
    while still enforcing nested object/array constraints instead of trusting
    the advertised schema only at the top level.
    """
    expected = schema.get("type")
    allowed = set(expected if isinstance(expected, list) else [expected]) if expected else set()
    actual = _json_type(value)
    # JSON Schema's ``number`` includes integers.
    if allowed and actual not in allowed and not (actual == "integer" and "number" in allowed):
        _schema_error(path, "类型无效")
    if "enum" in schema and value not in schema["enum"]:
        _schema_error(path, "值无效")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            _schema_error(path, "过短")
        if "maxLength" in schema and len(value) > int(schema["maxLength"]):
            _schema_error(path, "过长")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            _schema_error(path, "格式无效")
        return

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            _schema_error(path, "小于允许值")
        if "maximum" in schema and value > schema["maximum"]:
            _schema_error(path, "大于允许值")
        return

    if isinstance(value, list):
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            _schema_error(path, "项目过少")
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            _schema_error(path, "项目过多")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                _validate_schema_value(item_schema, item, f"{path}[{index}]")
        return

    if isinstance(value, dict):
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        required = set(schema.get("required") or [])
        missing = sorted(key for key in required if key not in value)
        if missing:
            _schema_error(path, f"缺少必填字段：{', '.join(missing)}")
        if schema.get("additionalProperties") is False:
            extras = sorted(set(value) - set(properties))
            if extras:
                _schema_error(path, f"包含未知字段：{', '.join(extras[:5])}")
        for key, item in value.items():
            item_schema = properties.get(key)
            if isinstance(item_schema, dict):
                _validate_schema_value(item_schema, item, f"{path}.{key}")


def _validate_input(schema: dict[str, Any], payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProductActionError("INVALID_INPUT", "Action 输入必须是 JSON object", http_status=422)
    _validate_schema_value(schema, payload, "input")
    return payload


def _validate_output(schema: dict[str, Any], payload: Any) -> dict[str, Any]:
    """Enforce the published Action output contract before persistence."""
    if not isinstance(payload, dict):
        raise ActionHandlerError(
            "INVALID_OUTPUT",
            "Action 处理器返回了无效输出",
        )
    try:
        _validate_schema_value(schema, payload, "output")
    except ProductActionError as exc:
        raise ActionHandlerError(
            "INVALID_OUTPUT",
            "Action 处理器输出不符合已发布 Schema",
        ) from exc
    return payload


def require_scopes(principal: AgentPrincipal, definition: ProductActionDefinition) -> None:
    missing = sorted(set(definition.scopes) - set(principal.scopes))
    if missing:
        raise ProductActionError(
            "SCOPE_DENIED",
            "Agent 凭证缺少所需权限",
            details={"required_scopes": list(definition.scopes), "missing_scopes": missing},
            http_status=403,
        )


def consume_rate_limit(
    db: Session,
    *,
    principal: AgentPrincipal,
    definition: ProductActionDefinition,
) -> None:
    now = utcnow()
    window = now.replace(second=0, microsecond=0)
    credential_key = principal.credential_key
    row = db.query(ProductActionRateWindow).filter(
        ProductActionRateWindow.user_id == principal.user.id,
        ProductActionRateWindow.credential_key == credential_key,
        ProductActionRateWindow.action_id == definition.id,
        ProductActionRateWindow.window_started_at == window,
    ).with_for_update().first()
    if row is None:
        row = ProductActionRateWindow(
            user_id=principal.user.id,
            credential_key=credential_key,
            action_id=definition.id,
            window_started_at=window,
            request_count=1,
        )
        db.add(row)
    elif row.request_count >= definition.rate_limit_per_minute:
        raise ProductActionError(
            "RATE_LIMITED", "调用过于频繁，请稍后再试",
            retryable=True, details={"retry_after": 60}, http_status=429,
        )
    else:
        row.request_count += 1
        row.updated_at = now
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent first request created the row; retry once under lock.
        row = db.query(ProductActionRateWindow).filter(
            ProductActionRateWindow.user_id == principal.user.id,
            ProductActionRateWindow.credential_key == credential_key,
            ProductActionRateWindow.action_id == definition.id,
            ProductActionRateWindow.window_started_at == window,
        ).with_for_update().first()
        if row is None or row.request_count >= definition.rate_limit_per_minute:
            raise ProductActionError("RATE_LIMITED", "调用过于频繁，请稍后再试", retryable=True, http_status=429)
        row.request_count += 1
        db.commit()


def create_confirmation(
    db: Session,
    *,
    principal: AgentPrincipal,
    action_id: str,
    input_hash: str,
    confirmation_summary: dict[str, Any] | None = None,
    ttl_minutes: int = 10,
) -> ProductActionConfirmation:
    row = ProductActionConfirmation(
        user_id=principal.user.id,
        credential_id=principal.credential.id if principal.credential else None,
        action_id=action_id,
        input_hash=input_hash,
        confirmation_summary_json=_canonical(redact_secrets(confirmation_summary or {})),
        expires_at=utcnow() + timedelta(minutes=max(1, min(ttl_minutes, 30))),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


_CONFIRMATION_TARGET_LABELS = {
    "note_id": "视频资料",
    "source_id": "博主",
    "entry_id": "知识页",
    "plan_id": "计划",
    "task_id": "任务",
    "thread_id": "AI 会话",
    "automation_id": "自动摘要",
    "run_id": "运行记录",
    "preview_message_id": "调整预览",
    "model_id": "模型配置",
}


def confirmation_summary_for(
    definition: ProductActionDefinition,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Build a useful, non-secret target description for one approval."""
    targets: list[dict[str, str]] = []
    for key, label in _CONFIRMATION_TARGET_LABELS.items():
        value = payload.get(key)
        if not isinstance(value, (str, int)) or isinstance(value, bool):
            continue
        raw = str(value).strip()
        if not raw or len(raw) > 128 or not re.fullmatch(r"[A-Za-z0-9._:-]+", raw):
            continue
        targets.append({
            "label": label,
            "reference": raw if len(raw) <= 12 else f"…{raw[-10:]}",
        })
    for key, label in (("note_ids", "视频资料"), ("entry_ids", "知识页"), ("run_ids", "运行记录")):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        safe_values = [
            str(item).strip()
            for item in values
            if isinstance(item, (str, int)) and not isinstance(item, bool)
        ]
        safe_values = [item for item in safe_values if re.fullmatch(r"[A-Za-z0-9._:-]+", item)]
        if safe_values:
            targets.append({
                "label": f"{label}（{len(safe_values)} 项）",
                "reference": "、".join(
                    item if len(item) <= 8 else f"…{item[-6:]}"
                    for item in safe_values[:3]
                ),
            })
    return {
        "operation": definition.title,
        "targets": targets,
        "target_count": len(targets),
    }


def approve_confirmation(db: Session, *, user_id: str, confirmation_id: str) -> ProductActionConfirmation:
    row = db.query(ProductActionConfirmation).filter(
        ProductActionConfirmation.id == confirmation_id,
        ProductActionConfirmation.user_id == user_id,
    ).with_for_update().first()
    if row is None:
        raise ProductActionError("CONFIRMATION_NOT_FOUND", "确认请求不存在", http_status=404)
    if (_aware(row.expires_at) or utcnow()) <= utcnow():
        row.status = "expired"
        db.commit()
        raise ProductActionError("CONFIRMATION_EXPIRED", "确认请求已失效", http_status=409)
    if row.status != "pending":
        raise ProductActionError("CONFIRMATION_EXPIRED", "确认请求已失效", http_status=409)
    row.status = "approved"
    row.approved_at = utcnow()
    db.commit()
    db.refresh(row)
    return row


def reject_confirmation(
    db: Session,
    *,
    user_id: str,
    confirmation_id: str,
) -> ProductActionConfirmation:
    row = db.query(ProductActionConfirmation).filter(
        ProductActionConfirmation.id == confirmation_id,
        ProductActionConfirmation.user_id == user_id,
    ).with_for_update().first()
    if row is None:
        raise ProductActionError("CONFIRMATION_NOT_FOUND", "确认请求不存在", http_status=404)
    if (_aware(row.expires_at) or utcnow()) <= utcnow():
        row.status = "expired"
        db.commit()
        raise ProductActionError("CONFIRMATION_EXPIRED", "确认请求已失效", http_status=409)
    if row.status != "pending":
        raise ProductActionError("CONFIRMATION_EXPIRED", "确认请求已失效", http_status=409)
    row.status = "denied"
    db.commit()
    db.refresh(row)
    return row


def get_confirmation(
    db: Session,
    *,
    user_id: str,
    confirmation_id: str,
) -> ProductActionConfirmation | None:
    row = db.query(ProductActionConfirmation).filter(
        ProductActionConfirmation.id == confirmation_id,
        ProductActionConfirmation.user_id == user_id,
    ).first()
    if row is not None and row.status == "pending" and (
        (_aware(row.expires_at) or utcnow()) <= utcnow()
    ):
        row.status = "expired"
        db.commit()
        db.refresh(row)
    return row


def list_pending_confirmations(
    db: Session,
    *,
    user_id: str,
    limit: int = 20,
) -> list[ProductActionConfirmation]:
    now = utcnow()
    return db.query(ProductActionConfirmation).filter(
        ProductActionConfirmation.user_id == user_id,
        ProductActionConfirmation.status == "pending",
        ProductActionConfirmation.expires_at > now,
    ).order_by(ProductActionConfirmation.created_at.desc()).limit(
        max(1, min(limit, 100))
    ).all()


def serialize_confirmation(
    db: Session,
    row: ProductActionConfirmation,
) -> dict[str, Any]:
    definition = registry.get(row.action_id)
    credential = (
        db.query(AgentCredential).filter(
            AgentCredential.id == row.credential_id,
            AgentCredential.user_id == row.user_id,
        ).first()
        if row.credential_id
        else None
    )
    # Intentionally omit input_hash and all Action input/output.  The browser
    # only needs enough metadata to identify the requesting connection and
    # decide once.
    return {
        "id": row.id,
        "action_id": row.action_id,
        "action_title": definition.title if definition else row.action_id,
        "action_description": definition.description if definition else "",
        "risk": [item.value for item in definition.risk] if definition else [],
        "status": row.status,
        "expires_at": _iso(row.expires_at),
        "created_at": _iso(row.created_at),
        "credential_name": credential.name if credential else "当前网页会话",
        "credential_client_type": credential.client_type if credential else "browser_session",
        "credential_prefix": credential.token_prefix if credential else "browser-session",
        "confirmation_summary": row.confirmation_summary,
    }


def consume_confirmation(
    db: Session,
    *,
    principal: AgentPrincipal,
    confirmation_id: str,
    definition: ProductActionDefinition,
    input_hash: str,
) -> None:
    row = db.query(ProductActionConfirmation).filter(
        ProductActionConfirmation.id == confirmation_id,
        ProductActionConfirmation.user_id == principal.user.id,
    ).with_for_update().first()
    if row is None:
        raise ProductActionError("CONFIRMATION_NOT_FOUND", "确认请求不存在", http_status=404)
    expected_credential = principal.credential.id if principal.credential else None
    if row.credential_id != expected_credential or row.action_id != definition.id or row.input_hash != input_hash:
        raise ProductActionError("CONFIRMATION_MISMATCH", "确认请求与本次操作不匹配", http_status=409)
    if row.status != "approved" or row.used_at is not None:
        raise ProductActionError("CONFIRMATION_REPLAYED", "确认已使用或尚未批准", http_status=409)
    if (_aware(row.expires_at) or utcnow()) <= utcnow():
        row.status = "expired"
        db.commit()
        raise ProductActionError("CONFIRMATION_EXPIRED", "确认请求已过期", http_status=409)
    row.status = "used"
    row.used_at = utcnow()
    db.commit()


def require_secure_direct_confirmation(
    db: Session,
    *,
    principal: AgentPrincipal,
    definition: ProductActionDefinition,
    normalized_input: dict[str, Any],
    confirmation_id: str | None,
) -> str:
    """为安全直连请求签发或消费确认，但不创建 Product Action Run。

    密码和 API Key 不得进入 Registry 输入、Run 或审计，因此调用方只能传入
    用于绑定批准的规范化非敏感元数据。若未来误把已知秘密字段传入摘要，
    这里会直接拒绝。
    """
    if redact_secrets(normalized_input) != normalized_input:
        raise ProductActionError(
            "INVALID_INPUT",
            "确认参数不能包含密码、密钥或令牌",
            http_status=422,
        )
    input_hash = normalized_input_hash(normalized_input)
    clean_confirmation_id = str(confirmation_id or "").strip()
    if not clean_confirmation_id:
        confirmation = create_confirmation(
            db,
            principal=principal,
            action_id=definition.id,
            input_hash=input_hash,
            confirmation_summary=confirmation_summary_for(definition, normalized_input),
        )
        raise ProductActionError(
            "CONFIRMATION_REQUIRED",
            "该操作需要用户确认",
            details={
                "confirmation_id": confirmation.id,
                "expires_at": _iso(confirmation.expires_at),
            },
            http_status=409,
        )
    if len(clean_confirmation_id) > 32:
        raise ProductActionError(
            "CONFIRMATION_INVALID",
            "确认请求格式无效",
            http_status=409,
        )
    consume_confirmation(
        db,
        principal=principal,
        confirmation_id=clean_confirmation_id,
        definition=definition,
        input_hash=input_hash,
    )
    return input_hash


def append_event(
    db: Session,
    *,
    run: ProductActionRun,
    event_type: str,
    status: str,
    message: str = "",
    data: dict[str, Any] | None = None,
    terminal: bool = False,
) -> ProductActionEvent:
    for attempt in range(4):
        locked = db.query(ProductActionRun).filter(
            ProductActionRun.id == run.id,
            ProductActionRun.user_id == run.user_id,
        ).with_for_update().populate_existing().first()
        if locked is None:
            raise ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404)
        if terminal:
            existing_terminal = db.query(ProductActionEvent).filter(
                ProductActionEvent.run_id == run.id,
                ProductActionEvent.terminal_key == "terminal",
            ).first()
            if existing_terminal is not None:
                return existing_terminal
        latest = db.query(func.max(ProductActionEvent.sequence)).filter(
            ProductActionEvent.run_id == run.id
        ).scalar()
        sequence = max(locked.next_sequence, int(latest or 0) + 1)
        row = ProductActionEvent(
            run_id=locked.id,
            user_id=locked.user_id,
            sequence=sequence,
            event_type=event_type[:80],
            status=status,
            message=message[:500],
            data_json=_canonical(redact_secrets(data or {})),
            terminal=terminal,
            terminal_key="terminal" if terminal else None,
        )
        locked.next_sequence = sequence + 1
        locked.updated_at = utcnow()
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if attempt == 3:
                raise
            continue
        db.refresh(row)
        db.refresh(run)
        return row
    raise RuntimeError("Action 事件序号分配失败")


def claim_run(db: Session, *, run_id: str) -> tuple[ProductActionRun, str] | None:
    """Claim one queued or expired-running long task with a DB-backed lease."""
    now = utcnow()
    token = uuid.uuid4().hex
    row = db.query(ProductActionRun).filter(
        ProductActionRun.id == run_id,
    ).with_for_update().first()
    if row is None or row.cancellation_requested or row.status in TERMINAL_STATUSES:
        db.rollback()
        return None
    lease_expired = row.lease_expires_at is None or (_aware(row.lease_expires_at) or now) <= now
    if row.status not in {"queued", "running"} or (row.status == "running" and not lease_expired):
        db.rollback()
        return None
    row.status = "running"
    row.lease_token = token
    row.lease_expires_at = now + timedelta(seconds=RUN_LEASE_SECONDS)
    row.started_at = row.started_at or now
    row.updated_at = now
    db.commit()
    db.refresh(row)
    append_event(db, run=row, event_type="run.claimed", status="running", message="运行已由工作进程接管")
    return row, token


def heartbeat_run(db: Session, *, run_id: str, lease_token: str) -> bool:
    now = utcnow()
    updated = db.query(ProductActionRun).filter(
        ProductActionRun.id == run_id,
        ProductActionRun.status == "running",
        ProductActionRun.lease_token == lease_token,
        ProductActionRun.cancellation_requested.is_(False),
    ).update({
        ProductActionRun.lease_expires_at: now + timedelta(seconds=RUN_LEASE_SECONDS),
        ProductActionRun.updated_at: now,
    }, synchronize_session=False)
    db.commit()
    return updated == 1


def transition_run(
    db: Session,
    *,
    run: ProductActionRun,
    status: str,
    message: str,
    data: Any = None,
    error: dict[str, Any] | None = None,
    lease_token: str | None = None,
) -> ProductActionRun:
    """Apply one legal state transition and append exactly one matching event."""
    locked = db.query(ProductActionRun).filter(
        ProductActionRun.id == run.id,
        ProductActionRun.user_id == run.user_id,
    ).with_for_update().populate_existing().first()
    if locked is None:
        raise ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404)
    if lease_token is not None and locked.lease_token != lease_token:
        raise ProductActionError("RUN_LEASE_LOST", "运行租约已转移", http_status=409)
    if status == locked.status:
        return locked
    if status not in _ALLOWED_TRANSITIONS.get(locked.status, frozenset()):
        raise ProductActionError(
            "INVALID_RUN_TRANSITION",
            f"运行不能从 {locked.status} 进入 {status}",
            http_status=409,
        )
    now = utcnow()
    locked.status = status
    locked.updated_at = now
    if status == "running":
        locked.started_at = locked.started_at or now
    if data is not None:
        locked.output_json = _canonical(redact_secrets(data))
    if error is not None:
        locked.error_json = _canonical(redact_secrets(error))
    terminal = status in TERMINAL_STATUSES
    if terminal:
        locked.completed_at = now
        locked.lease_token = None
        locked.lease_expires_at = None
    db.commit()
    db.refresh(locked)
    append_event(
        db,
        run=locked,
        event_type=f"run.{status}",
        status=status,
        message=message,
        data={"result": redact_secrets(data)} if data is not None else ({"error": error} if error else {}),
        terminal=terminal,
    )
    return locked


def get_run(db: Session, *, run_id: str, user_id: str) -> ProductActionRun | None:
    run = db.query(ProductActionRun).filter(
        ProductActionRun.id == run_id,
        ProductActionRun.user_id == user_id,
    ).first()
    if run is not None:
        reconcile_external_run(db, run)
    return run


def recover_stale_runs(db: Session, *, older_than_seconds: int = 300) -> int:
    """Close crash-orphaned generic Runs while preserving durable adapters.

    Generic Product Action handlers execute in the request process.  A process
    death after ``run.started`` cannot be safely replayed because the handler
    may already have performed an external write.  Durable subsystems expose an
    ``external_type/external_id`` and are reconciled instead; unbound queued or
    running rows older than the cutoff become one terminal, retryable failure.
    """
    now = utcnow()
    cutoff = now - timedelta(seconds=max(30, int(older_than_seconds)))
    candidates = (
        db.query(ProductActionRun)
        .filter(
            ProductActionRun.status.in_({RunStatus.QUEUED.value, RunStatus.RUNNING.value}),
            ProductActionRun.updated_at < cutoff,
        )
        .order_by(ProductActionRun.updated_at.asc())
        .limit(500)
        .all()
    )
    recovered = 0
    for row in candidates:
        if row.external_type and row.external_id:
            reconcile_external_run(db, row)
            continue
        locked = (
            db.query(ProductActionRun)
            .filter(ProductActionRun.id == row.id)
            .with_for_update()
            .populate_existing()
            .first()
        )
        if (
            locked is None
            or locked.status in TERMINAL_STATUSES
            or (_aware(locked.updated_at) or now) >= cutoff
            or (locked.external_type and locked.external_id)
        ):
            db.rollback()
            continue
        error = {
            "code": "RUN_INTERRUPTED",
            "message": "服务进程在 Action 完成前重启；为避免重复写入，本次运行已安全终止，请使用新的幂等键重试",
            "retryable": True,
        }
        locked.status = RunStatus.FAILED.value
        locked.error_json = _canonical(error)
        locked.completed_at = now
        locked.updated_at = now
        locked.lease_token = None
        locked.lease_expires_at = None
        db.commit()
        append_event(
            db,
            run=locked,
            event_type="run.failed",
            status=RunStatus.FAILED.value,
            message="Action 因服务重启安全终止",
            data={"error": error},
            terminal=True,
        )
        recovered += 1
    return recovered


def repair_missing_terminal_events(db: Session, *, limit: int = 1000) -> int:
    """Repair the narrow crash window between terminal state and final event."""
    rows = (
        db.query(ProductActionRun)
        .filter(ProductActionRun.status.in_(set(TERMINAL_STATUSES)))
        .order_by(ProductActionRun.updated_at.asc())
        .limit(max(1, min(int(limit), 5000)))
        .all()
    )
    repaired = 0
    for row in rows:
        exists = db.query(ProductActionEvent.id).filter(
            ProductActionEvent.run_id == row.id,
            ProductActionEvent.terminal_key == "terminal",
        ).first()
        if exists is not None:
            continue
        payload = {"result": redact_secrets(row.output)} if row.status == RunStatus.SUCCEEDED.value else {
            "error": redact_secrets(row.error or {
                "code": "RUN_TERMINATED",
                "message": "运行已结束",
            })
        }
        append_event(
            db,
            run=row,
            event_type=f"run.{row.status}",
            status=row.status,
            message={
                RunStatus.SUCCEEDED.value: "Action 执行完成",
                RunStatus.CANCELED.value: "运行已取消",
                RunStatus.FAILED.value: "Action 执行失败",
            }.get(row.status, "运行已结束"),
            data=payload,
            terminal=True,
        )
        repaired += 1
    return repaired


def list_events(
    db: Session,
    *,
    run: ProductActionRun,
    after: int = 0,
    limit: int = 500,
) -> list[ProductActionEvent]:
    reconcile_external_run(db, run)
    return db.query(ProductActionEvent).filter(
        ProductActionEvent.run_id == run.id,
        ProductActionEvent.user_id == run.user_id,
        ProductActionEvent.sequence > max(0, after),
    ).order_by(ProductActionEvent.sequence.asc()).limit(max(1, min(limit, 500))).all()


def request_cancel(db: Session, *, run: ProductActionRun) -> ProductActionRun:
    if run.status in TERMINAL_STATUSES:
        return run
    run.cancellation_requested = True
    if run.external_type == "agent_turn" and run.external_id:
        turn = agent_runtime_service.get_turn(db, run.external_id, run.user_id)
        if turn is not None:
            agent_runtime_service.request_cancel(db, turn)
    elif run.external_type == "creator_sync" and run.external_id:
        creator_sync_service.request_cancel(
            db, user_id=run.user_id, run_id=run.external_id
        )
    elif run.external_type == "video_analysis" and run.external_id:
        video_analysis_service.cancel_run(
            db, user_id=run.user_id, run_id=run.external_id
        )
    elif run.external_type == "library_transcript_batch" and run.external_id:
        library_extraction_service.cancel_batch_job(run.external_id, run.user_id)
    if run.status in {"queued", "waiting_for_user"}:
        run.status = RunStatus.CANCELED.value
        run.completed_at = utcnow()
        run.updated_at = utcnow()
        db.commit()
        append_event(db, run=run, event_type="run.canceled", status=run.status, message="运行已取消", terminal=True)
    else:
        db.commit()
        append_event(db, run=run, event_type="run.cancel_requested", status=run.status, message="正在停止运行")
    db.refresh(run)
    return run


def reconcile_external_run(db: Session, run: ProductActionRun) -> None:
    """Project an existing durable subsystem into the public v1 Run model."""
    if run.external_type == "creator_sync" and run.external_id:
        _reconcile_creator_sync_run(db, run)
        return
    if run.external_type == "video_analysis" and run.external_id:
        _reconcile_video_analysis_run(db, run)
        return
    if run.external_type == "library_transcript_batch" and run.external_id:
        _reconcile_library_transcript_batch(db, run)
        return
    if run.external_type != "agent_turn" or not run.external_id or run.status in TERMINAL_STATUSES:
        return
    turn = agent_runtime_service.get_turn(db, run.external_id, run.user_id)
    if turn is None:
        return
    for event in agent_runtime_service.list_events(db, turn=turn, after_seq=run.external_event_cursor, limit=500):
        append_event(
            db,
            run=run,
            event_type=f"external.{event.event_type}",
            status=run.status,
            message=event.message,
            data={"source": "agent_turn", "source_sequence": event.seq, **event.payload},
        )
        run.external_event_cursor = event.seq
        db.commit()
    mapped = {
        "queued": "queued", "retry_wait": "queued", "running": "running",
        "completed": "succeeded", "failed": "failed", "cancelled": "canceled",
    }.get(turn.status, run.status)
    if mapped != run.status:
        run.status = mapped
        run.updated_at = utcnow()
        terminal_payload: dict[str, Any] | None = None
        if mapped in TERMINAL_STATUSES:
            run.completed_at = utcnow()
            terminal_payload = {"turn": turn.to_dict()}
            run.output_json = _canonical(redact_secrets(terminal_payload))
            if mapped == "failed":
                run.error_json = _canonical({
                    "code": turn.error_code or "EXTERNAL_RUN_FAILED",
                    "message": turn.error_message or "知萃 AI 运行失败",
                    "retryable": True,
                    "details": {},
                })
        db.commit()
        append_event(
            db, run=run, event_type=f"run.{mapped}", status=mapped,
            message="运行完成" if mapped == "succeeded" else "运行状态已更新",
            data=terminal_payload,
            terminal=mapped in TERMINAL_STATUSES,
        )


def _reconcile_creator_sync_run(db: Session, run: ProductActionRun) -> None:
    if run.status in TERMINAL_STATUSES or not run.external_id:
        return
    external = creator_sync_service.get_run(
        db, user_id=run.user_id, run_id=run.external_id
    )
    if external is None:
        return
    progress = max(int(external.processed_count or 0), int(external.checked_count or 0))
    if progress > int(run.external_event_cursor or 0):
        run.external_event_cursor = progress
        run.updated_at = utcnow()
        db.commit()
        append_event(
            db,
            run=run,
            event_type="external.creator.progress",
            status=run.status,
            message=f"已处理 {progress} 条博主作品",
            data={
                "source": "creator_sync",
                "processed_count": external.processed_count,
                "checked_count": external.checked_count,
                "new_count": external.new_count,
                "reused_count": external.reused_count,
                "failed_count": external.failed_count,
            },
        )
    if external.needs_action:
        mapped = "waiting_for_user"
    else:
        mapped = {
            "queued": "queued",
            "resolving": "running",
            "discovering": "running",
            "importing": "running",
            "transcribing": "running",
            "succeeded": "succeeded",
            "partial": "succeeded",
            "failed": "failed",
            "cancelled": "canceled",
        }.get(external.status, run.status)
    if mapped == run.status:
        return
    run.status = mapped
    run.updated_at = utcnow()
    payload = external.to_dict()
    terminal = mapped in TERMINAL_STATUSES
    if terminal:
        run.completed_at = utcnow()
        run.output_json = _canonical(redact_secrets({"creator_run": payload}))
        if mapped == "failed":
            run.error_json = error_payload(
                str(external.error_code or "CREATOR_SYNC_FAILED").upper(),
                external.error_message or "博主同步失败",
                retryable=True,
            ).model_dump_json()
    db.commit()
    append_event(
        db,
        run=run,
        event_type=f"run.{mapped}",
        status=mapped,
        message=(
            external.needs_action_message
            if mapped == "waiting_for_user"
            else "博主同步已完成" if mapped == "succeeded" else "博主同步状态已更新"
        ),
        data={"creator_run": payload},
        terminal=terminal,
    )


def _reconcile_video_analysis_run(db: Session, run: ProductActionRun) -> None:
    """Project the existing billing-aware analysis worker into a v1 Run."""
    if run.status in TERMINAL_STATUSES or not run.external_id:
        return
    external = video_analysis_service.get_run(
        db, user_id=run.user_id, run_id=run.external_id
    )
    if external is None:
        return
    items = video_analysis_service._run_items(db, external.id)
    payload = {
        "run": video_analysis_service.serialize_run(external, items=items),
        "items": [video_analysis_service.serialize_item(item) for item in items],
    }
    progress = int(payload["run"].get("progress") or 0)
    completed = int(payload["run"].get("completed_count") or 0)
    marker = progress * 1_000 + completed
    if marker > int(run.external_event_cursor or 0):
        run.external_event_cursor = marker
        run.updated_at = utcnow()
        db.commit()
        append_event(
            db,
            run=run,
            event_type="external.video_analysis.progress",
            status=run.status,
            message=f"详细解析进度 {progress}%",
            data={
                "source": "video_analysis",
                "progress": progress,
                "current_stage": payload["run"].get("current_stage") or "",
                "completed_count": completed,
                "failed_count": int(payload["run"].get("failed_count") or 0),
            },
        )
    mapped = {
        "prepared": "waiting_for_user",
        "queued": "queued",
        "running": "running",
        "succeeded": "succeeded",
        "partial": "succeeded",
        "failed": "failed",
        "cancelled": "canceled",
    }.get(external.status, run.status)
    if mapped == run.status:
        return
    run.status = mapped
    run.updated_at = utcnow()
    terminal = mapped in TERMINAL_STATUSES
    if terminal:
        run.completed_at = utcnow()
        run.output_json = _canonical(redact_secrets(payload))
        if mapped == "failed":
            run.error_json = error_payload(
                str(external.error_code or "VIDEO_ANALYSIS_FAILED").upper(),
                external.error_detail or "视频详细解析失败",
                retryable=True,
            ).model_dump_json()
    db.commit()
    append_event(
        db,
        run=run,
        event_type=f"run.{mapped}",
        status=mapped,
        message=(
            "详细解析等待确认"
            if mapped == "waiting_for_user"
            else "详细解析已完成"
            if mapped == "succeeded"
            else "详细解析状态已更新"
        ),
        data=payload,
        terminal=terminal,
    )


def _reconcile_library_transcript_batch(db: Session, run: ProductActionRun) -> None:
    """Project durable transcript-batch progress into one public v1 Run."""
    if run.status in TERMINAL_STATUSES or not run.external_id:
        return
    payload = library_extraction_service.get_batch_job(run.external_id, run.user_id)
    if payload is None:
        return
    progress = int(payload.get("success") or 0) + int(payload.get("failed") or 0)
    if progress > int(run.external_event_cursor or 0):
        run.external_event_cursor = progress
        run.updated_at = utcnow()
        db.commit()
        append_event(
            db,
            run=run,
            event_type="external.library_transcript.progress",
            status=run.status,
            message=f"已处理 {progress}/{int(payload.get('total') or 0)} 条视频文稿",
            data={
                "source": "library_transcript_batch",
                "total": int(payload.get("total") or 0),
                "success": int(payload.get("success") or 0),
                "failed": int(payload.get("failed") or 0),
                "active": int(payload.get("active") or 0),
                "queued": int(payload.get("queued") or 0),
            },
        )
    mapped = {
        "queued": "queued",
        "running": "running",
        "success": "succeeded",
        "partial": "succeeded",
        "failed": "failed",
        "canceled": "canceled",
    }.get(str(payload.get("status") or ""), run.status)
    if mapped == run.status:
        return
    run.status = mapped
    run.updated_at = utcnow()
    terminal = mapped in TERMINAL_STATUSES
    if terminal:
        run.completed_at = utcnow()
        run.output_json = _canonical(redact_secrets({"batch": payload}))
        if mapped == "failed":
            run.error_json = error_payload(
                "TRANSCRIPT_BATCH_FAILED",
                "批量文稿任务没有成功完成任何视频",
                retryable=True,
            ).model_dump_json()
    db.commit()
    append_event(
        db,
        run=run,
        event_type=f"run.{mapped}",
        status=mapped,
        message=(
            "批量文稿任务已完成"
            if mapped == "succeeded"
            else "批量文稿任务已取消"
            if mapped == "canceled"
            else "批量文稿任务失败"
        ),
        data={"batch": payload},
        terminal=terminal,
    )


def _audit(
    db: Session,
    *,
    principal: AgentPrincipal,
    definition: ProductActionDefinition,
    run: ProductActionRun | None,
    status: str,
    started: float,
    error_code: str = "",
) -> None:
    db.add(ProductActionAudit(
        user_id=principal.user.id,
        credential_id=principal.credential.id if principal.credential else None,
        run_id=run.id if run else None,
        action_id=definition.id,
        status=status[:24],
        error_code=error_code[:80],
        duration_ms=max(0, round((time.perf_counter() - started) * 1000)),
        # Content-free by design.  Never add Action input/output here.
        metadata_json=_canonical({"auth_type": principal.auth_type, "version": definition.version}),
    ))
    db.commit()


def recent_calls(db: Session, *, user_id: str, limit: int = 50) -> dict[str, Any]:
    query = db.query(ProductActionAudit).filter(ProductActionAudit.user_id == user_id)
    total = query.count()
    rows = query.order_by(ProductActionAudit.created_at.desc()).limit(max(1, min(limit, 100))).all()
    credential_ids = {row.credential_id for row in rows if row.credential_id}
    credential_prefixes = {
        row.id: row.token_prefix
        for row in db.query(AgentCredential).filter(
            AgentCredential.user_id == user_id,
            AgentCredential.id.in_(credential_ids),
        ).all()
    } if credential_ids else {}
    return {
        "items": [
            {
                "id": row.id,
                "action_id": row.action_id,
                "credential_id": row.credential_id,
                "credential_prefix": credential_prefixes.get(row.credential_id, "browser-session"),
                "run_id": row.run_id,
                "status": row.status,
                "error_code": row.error_code,
                "duration_ms": row.duration_ms,
                "created_at": _iso(row.created_at),
            }
            for row in rows
        ],
        "total": total,
    }


def invoke(
    db: Session,
    *,
    principal: AgentPrincipal,
    action_id: str,
    raw_input: Any,
    request_id: str | None,
    idempotency_key: str | None,
    confirmation_id: str | None,
) -> tuple[ActionEnvelope, ProductActionRun, bool]:
    started = time.perf_counter()
    definition = registry.get(action_id)
    if definition is None or not action_is_enabled(action_id):
        raise ProductActionError("ACTION_NOT_FOUND", "Action 不存在", http_status=404)
    if definition.secure_direct:
        raise ProductActionError(
            "SECURE_TRANSPORT_REQUIRED",
            "该能力包含密码或密钥，只能通过知萃 CLI 的无回显安全输入或网页安全表单调用",
            details={"action_id": definition.id, "mcp_exposed": False},
            http_status=409,
        )
    if definition.execution_location != ExecutionLocation.CLOUD:
        raise ProductActionError("LOCAL_CAPABILITY_UNAVAILABLE", "该 Action 只能由受信 Windows 客户端执行", http_status=409)
    if not definition.available:
        raise ProductActionError(
            "ACTION_UNAVAILABLE", definition.unavailable_reason or "Action 暂未开放",
            details={"action_id": definition.id}, http_status=409,
        )
    require_scopes(principal, definition)
    payload = _validate_input(dict(definition.input_schema), raw_input)
    payload_hash = normalized_input_hash(payload)
    clean_idempotency = str(idempotency_key or "").strip()[:160] or None
    if definition.idempotency == IdempotencyStrategy.REQUIRED and not clean_idempotency:
        raise ProductActionError("IDEMPOTENCY_KEY_REQUIRED", "该 Action 必须提供幂等键", http_status=422)
    consume_rate_limit(db, principal=principal, definition=definition)

    credential_key = principal.credential_key
    if clean_idempotency:
        record = db.query(ProductActionIdempotency).filter(
            ProductActionIdempotency.user_id == principal.user.id,
            ProductActionIdempotency.credential_key == credential_key,
            ProductActionIdempotency.action_id == definition.id,
            ProductActionIdempotency.idempotency_key == clean_idempotency,
        ).first()
        if record is not None:
            if record.input_hash != payload_hash:
                raise ProductActionError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同输入", http_status=409)
            existing = get_run(db, run_id=record.run_id, user_id=principal.user.id)
            if existing is None:
                raise ProductActionError("RUN_NOT_FOUND", "幂等运行不存在", http_status=409)
            return ActionEnvelope(
                action=definition.id,
                request_id=existing.request_id,
                run_id=existing.id,
                status=existing.status,
                data={"run": serialize_run(existing).model_dump(mode="json")},
                meta={"idempotent_replay": True},
            ), existing, True

    if definition.confirmation_required:
        if not confirmation_id:
            confirmation = create_confirmation(
                db,
                principal=principal,
                action_id=definition.id,
                input_hash=payload_hash,
                confirmation_summary=confirmation_summary_for(definition, payload),
            )
            raise ProductActionError(
                "CONFIRMATION_REQUIRED", "该操作需要用户确认",
                details={"confirmation_id": confirmation.id, "expires_at": _iso(confirmation.expires_at)},
                http_status=409,
            )
        consume_confirmation(
            db, principal=principal, confirmation_id=confirmation_id,
            definition=definition, input_hash=payload_hash,
        )

    run = ProductActionRun(
        request_id=(request_id or uuid.uuid4().hex)[:64],
        user_id=principal.user.id,
        credential_id=principal.credential.id if principal.credential else None,
        action_id=definition.id,
        action_version=definition.version,
        run_type=definition.run_type.value,
        execution_location=definition.execution_location.value,
        input_json=_canonical(redact_secrets(payload)),
        input_hash=payload_hash,
        idempotency_key=clean_idempotency,
    )
    db.add(run)
    db.flush()
    if clean_idempotency:
        db.add(ProductActionIdempotency(
            user_id=principal.user.id,
            credential_key=credential_key,
            action_id=definition.id,
            idempotency_key=clean_idempotency,
            input_hash=payload_hash,
            run_id=run.id,
        ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if clean_idempotency:
            record = db.query(ProductActionIdempotency).filter(
                ProductActionIdempotency.user_id == principal.user.id,
                ProductActionIdempotency.credential_key == credential_key,
                ProductActionIdempotency.action_id == definition.id,
                ProductActionIdempotency.idempotency_key == clean_idempotency,
            ).first()
            if record is not None:
                if record.input_hash != payload_hash:
                    raise ProductActionError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同输入", http_status=409)
                existing = get_run(db, run_id=record.run_id, user_id=principal.user.id)
                if existing is not None:
                    return ActionEnvelope(
                        action=definition.id, request_id=existing.request_id,
                        run_id=existing.id, status=existing.status,
                        data={"run": serialize_run(existing).model_dump(mode="json")},
                        meta={"idempotent_replay": True},
                    ), existing, True
        raise
    db.refresh(run)
    append_event(db, run=run, event_type="run.queued", status="queued", message="Action 已进入运行队列")
    run.status = RunStatus.RUNNING.value
    run.started_at = utcnow()
    run.updated_at = utcnow()
    db.commit()
    append_event(db, run=run, event_type="run.started", status="running", message="Action 开始执行")

    try:
        context_tokens = set_request_context(
            principal.user.id,
            f"/api/agent-interface/v1/actions/{definition.id}/invoke",
        )
        try:
            result = get_handler(definition.handler_name or "")(
                ActionContext(
                    db=db,
                    user=principal.user,
                    credential=principal.credential,
                    run=run,
                    request_id=run.request_id,
                ),
                payload,
            )
            result = _validate_output(dict(definition.output_schema), result)
        finally:
            reset_request_context(context_tokens)
        if run.external_type and run.external_id:
            # Long-running adapters attach the public Run to an existing
            # durable subsystem.  Keep the Run non-terminal and let GET/events
            # project its persisted progress, billing outcome and cancellation.
            reconcile_external_run(db, run)
            _audit(
                db, principal=principal, definition=definition, run=run,
                status=run.status, started=started,
            )
            return ActionEnvelope(
                action=definition.id,
                request_id=run.request_id,
                run_id=run.id,
                status=run.status,
                data={
                    "result": redact_secrets(result),
                    "run": serialize_run(run).model_dump(mode="json"),
                },
                meta={"idempotent_replay": False, "deferred": True},
            ), run, False
        if run.cancellation_requested:
            raise ProductActionError("RUN_CANCELED", "运行已取消", http_status=409)
        run.status = RunStatus.SUCCEEDED.value
        run.output_json = _canonical(redact_secrets(result))
        run.completed_at = utcnow()
        run.updated_at = utcnow()
        db.commit()
        append_event(
            db, run=run, event_type="run.succeeded", status="succeeded",
            message="Action 执行完成", data={"result": redact_secrets(result)}, terminal=True,
        )
        _audit(db, principal=principal, definition=definition, run=run, status="succeeded", started=started)
        return ActionEnvelope(
            action=definition.id,
            request_id=run.request_id,
            run_id=run.id,
            status=run.status,
            data={"result": redact_secrets(result), "run": serialize_run(run).model_dump(mode="json")},
            meta={"idempotent_replay": False},
        ), run, False
    except (ActionHandlerError, ProductActionError, ValueError) as exc:
        code = getattr(exc, "code", "INVALID_INPUT")
        retryable = bool(getattr(exc, "retryable", False))
        run.status = RunStatus.CANCELED.value if code == "RUN_CANCELED" else RunStatus.FAILED.value
        error = error_payload(code, str(exc), retryable=retryable)
        run.error_json = error.model_dump_json()
        run.completed_at = utcnow()
        run.updated_at = utcnow()
        db.commit()
        append_event(
            db, run=run, event_type=f"run.{run.status}", status=run.status,
            message=str(exc), data={"error": error.model_dump(mode="json")}, terminal=True,
        )
        _audit(db, principal=principal, definition=definition, run=run, status=run.status, started=started, error_code=code)
        raise ProductActionError(
            code, str(exc), retryable=retryable,
            details={"run_id": run.id},
            http_status=getattr(exc, "http_status", 422),
        ) from exc
    except Exception as exc:
        db.rollback()
        error = error_payload("INTERNAL_ERROR", "Action 执行失败，请稍后重试", retryable=True)
        run = db.query(ProductActionRun).filter(ProductActionRun.id == run.id).first()
        if run is not None and run.status not in TERMINAL_STATUSES:
            run.status = RunStatus.FAILED.value
            run.error_json = error.model_dump_json()
            run.completed_at = utcnow()
            run.updated_at = utcnow()
            db.commit()
            append_event(db, run=run, event_type="run.failed", status="failed", message=error.message, terminal=True)
            _audit(db, principal=principal, definition=definition, run=run, status="failed", started=started, error_code=error.code)
        raise ProductActionError("INTERNAL_ERROR", "Action 执行失败，请稍后重试", retryable=True, http_status=500) from exc
