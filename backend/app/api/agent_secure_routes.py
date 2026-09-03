"""Direct-only transports for secrets that must never enter Agent Runs/MCP.

These endpoints are intentionally excluded from OpenAPI.  Their corresponding
Product Actions remain discoverable with ``secure_direct=true`` and an input
schema that contains only non-secret routing fields.
"""

from __future__ import annotations

import io
import json
import time
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.agent_interface import ProductActionAudit
from app.services import (
    privacy_account_service,
    user_ai_provider_service,
    video_analysis_catalog_service,
)
from app.services.agent_credential_service import AgentPrincipal
from app.services.agent_rollout_service import action_is_enabled
from app.services.product_action_registry import registry
from app.services.product_action_run_service import (
    ProductActionError,
    consume_rate_limit,
    require_secure_direct_confirmation,
)
from app.api.agent_interface_routes import (
    _envelope,
    _ensure_enabled,
    _error_response,
    _request_id,
    get_agent_principal,
)


router = APIRouter(
    prefix="/api/agent-interface/v1/secure",
    tags=["agent-secure-direct"],
)

_MAX_SECRET_BODY_BYTES = 16 * 1024


async def _secret_json(request: Request) -> dict[str, Any]:
    content_type = str(request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise ProductActionError("INVALID_INPUT", "安全请求必须使用 application/json", http_status=415)
    body = await request.body()
    if not body or len(body) > _MAX_SECRET_BODY_BYTES:
        raise ProductActionError("INVALID_INPUT", "安全请求内容为空或超过上限", http_status=422)
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProductActionError("INVALID_INPUT", "安全请求格式无效", http_status=422) from exc
    if not isinstance(value, dict):
        raise ProductActionError("INVALID_INPUT", "安全请求必须是 JSON object", http_status=422)
    return value


def _definition(principal: AgentPrincipal, action_id: str, db: Session):
    definition = registry.get(action_id)
    if (
        definition is None
        or not action_is_enabled(action_id)
        or not definition.secure_direct
        or definition.mcp_exposed
    ):
        raise ProductActionError("ACTION_NOT_FOUND", "安全 Action 不存在", http_status=404)
    if not set(definition.scopes).issubset(principal.scopes):
        raise ProductActionError("SCOPE_DENIED", "当前凭证没有调用该能力的权限", http_status=403)
    consume_rate_limit(db, principal=principal, definition=definition)
    return definition


def _secret(value: Any, label: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str):
        raise ProductActionError("INVALID_INPUT", f"{label}格式无效", http_status=422)
    result = value
    if not result or len(result) > maximum or "\x00" in result:
        raise ProductActionError("INVALID_INPUT", f"{label}为空或格式无效", http_status=422)
    return result


def _only_fields(body: dict[str, Any], allowed: set[str]) -> None:
    unexpected = sorted(set(body) - allowed)
    if unexpected:
        raise ProductActionError(
            "INVALID_INPUT", "安全请求包含未声明字段", http_status=422,
        )


def _public_api_base(value: Any) -> str:
    try:
        return video_analysis_catalog_service._validate_public_user_api_base(
            _secret(value, "API Base", maximum=512),
        )
    except video_analysis_catalog_service.VideoAnalysisCatalogError as exc:
        raise ProductActionError("UNSAFE_API_BASE", str(exc), http_status=422) from exc


def _require_encrypted_secret_storage() -> None:
    try:
        video_analysis_catalog_service._require_secret_encryption()
    except video_analysis_catalog_service.VideoAnalysisCatalogError as exc:
        raise ProductActionError(
            "ENCRYPTION_KEY_REQUIRED",
            "服务端安全密钥存储尚未配置，当前不能保存 API Key",
            http_status=503,
        ) from exc


def _required_metadata_text(value: Any, label: str, *, maximum: int) -> str:
    result = _secret(value, label, maximum=maximum).strip()
    if not result:
        raise ProductActionError("INVALID_INPUT", f"{label}不能为空", http_status=422)
    return result


def _custom_model_confirmation_input(body: dict[str, Any]) -> dict[str, Any]:
    enabled = body.get("enabled", True)
    select = body.get("select", False)
    if not isinstance(enabled, bool) or not isinstance(select, bool):
        raise ProductActionError(
            "INVALID_INPUT", "enabled 和 select 必须是布尔值", http_status=422,
        )
    return {
        "name": _required_metadata_text(body.get("name"), "配置名称", maximum=80),
        "provider_name": _required_metadata_text(
            body.get("provider_name"), "供应商名称", maximum=80,
        ),
        "model": _required_metadata_text(body.get("model"), "模型名称", maximum=160),
        "api_base": _public_api_base(body.get("api_base")),
        "enabled": enabled,
        "select": select,
    }


def _model_secret_confirmation_input(body: dict[str, Any]) -> dict[str, Any]:
    target = str(body.get("target") or "").strip().lower()
    if target == "chat":
        model_id = str(body.get("model_id") or "").strip()
        if not model_id or len(model_id) > 64:
            raise ProductActionError(
                "INVALID_INPUT", "chat 密钥更新需要 model_id", http_status=422,
            )
        return {"target": target, "model_id": model_id}
    if target == "vision":
        if body.get("model_id") not in (None, ""):
            raise ProductActionError(
                "INVALID_INPUT", "vision 密钥更新不接受 model_id", http_status=422,
            )
        return {"target": target}
    raise ProductActionError("INVALID_INPUT", "target 只支持 chat 或 vision", http_status=422)


def _model_secret_confirmation_id(body: dict[str, Any]) -> str | None:
    raw = body.get("confirmation_id")
    has_api_key = "api_key" in body
    if raw is None:
        if has_api_key:
            raise ProductActionError(
                "INVALID_INPUT",
                "首次请求只能提交非敏感模型信息，批准后再通过无回显输入提交 API Key",
                http_status=422,
            )
        return None
    if not isinstance(raw, str) or not raw.strip() or len(raw.strip()) > 32:
        raise ProductActionError("CONFIRMATION_INVALID", "确认请求格式无效", http_status=409)
    if not has_api_key:
        raise ProductActionError(
            "INVALID_INPUT", "已确认的安全请求缺少 API Key", http_status=422,
        )
    return raw.strip()


def _audit_secret_action(
    db: Session,
    *,
    principal: AgentPrincipal,
    action_id: str,
    status: str,
    started: float,
    error_code: str = "",
) -> None:
    """Record content-free evidence only; never accept arbitrary metadata."""
    db.add(ProductActionAudit(
        user_id=principal.user.id,
        credential_id=principal.credential.id if principal.credential else None,
        run_id=None,
        action_id=action_id,
        status=status[:24],
        error_code=error_code[:80],
        duration_ms=max(0, round((time.perf_counter() - started) * 1000)),
        metadata_json=json.dumps({
            "auth_type": principal.auth_type,
            "transport": "secure_direct",
            "secret_fields_in_audit": False,
            "plaintext_secret_persisted": False,
        }, separators=(",", ":")),
    ))
    db.commit()


@router.post("/account/data-export", include_in_schema=False)
async def secure_account_export(
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    try:
        _ensure_enabled()
        _definition(principal, "account.data.export", db)
        body = await _secret_json(request)
        _only_fields(body, {"password"})
        archive, filename = privacy_account_service.build_personal_data_archive(
            db,
            user=principal.user,
            password=_secret(body.get("password"), "当前密码", maximum=128),
            client_type="windows" if principal.auth_type in {"pat", "access"} else "web",
        )
        return StreamingResponse(
            io.BytesIO(archive),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "X-Zhicui-Action": "account.data.export",
                "X-Request-Id": request_id,
            },
        )
    except privacy_account_service.AccountPasswordError as exc:
        return _error_response(
            "account.data.export", request_id,
            ProductActionError("PASSWORD_INVALID", str(exc), http_status=403),
        )
    except Exception as exc:
        return _error_response("account.data.export", request_id, exc)


@router.post("/account/delete/prepare", include_in_schema=False)
async def secure_account_delete_prepare(
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    try:
        _ensure_enabled()
        _definition(principal, "account.delete", db)
        body = await _secret_json(request)
        _only_fields(body, {"password"})
        data = privacy_account_service.prepare_account_deletion(
            db,
            user=principal.user,
            password=_secret(body.get("password"), "当前密码", maximum=128),
            client_type="windows" if principal.auth_type in {"pat", "access"} else "web",
        )
        return _envelope(action="account.delete.prepare", request_id=request_id, data=data)
    except privacy_account_service.AccountPasswordError as exc:
        return _error_response(
            "account.delete.prepare", request_id,
            ProductActionError("PASSWORD_INVALID", str(exc), http_status=403),
        )
    except privacy_account_service.LastActiveAdminError as exc:
        return _error_response(
            "account.delete.prepare", request_id,
            ProductActionError("LAST_ADMIN", str(exc), http_status=409),
        )
    except Exception as exc:
        return _error_response("account.delete.prepare", request_id, exc)


@router.post("/account/delete/confirm", include_in_schema=False)
async def secure_account_delete_confirm(
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    try:
        _ensure_enabled()
        _definition(principal, "account.delete", db)
        body = await _secret_json(request)
        _only_fields(body, {"confirmation_token", "confirmation_phrase"})
        data = privacy_account_service.confirm_account_deletion(
            db,
            user=principal.user,
            confirmation_token=_secret(body.get("confirmation_token"), "注销确认令牌", maximum=160),
            confirmation_phrase=_secret(body.get("confirmation_phrase"), "注销确认短语", maximum=24),
        )
        return _envelope(action="account.delete", request_id=request_id, data=data)
    except (privacy_account_service.AccountGrantError, privacy_account_service.LastActiveAdminError) as exc:
        return _error_response(
            "account.delete", request_id,
            ProductActionError("CONFIRMATION_INVALID", str(exc), http_status=409),
        )
    except Exception as exc:
        return _error_response("account.delete", request_id, exc)


@router.post("/models/custom", include_in_schema=False)
async def secure_custom_model_create(
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    started = time.perf_counter()
    try:
        _ensure_enabled()
        definition = _definition(principal, "models.custom.create", db)
        body = await _secret_json(request)
        _only_fields(body, {
            "name", "provider_name", "model", "api_base", "api_key",
            "enabled", "select", "confirmation_id",
        })
        metadata = _custom_model_confirmation_input(body)
        confirmation_id = _model_secret_confirmation_id(body)
        _require_encrypted_secret_storage()
        require_secure_direct_confirmation(
            db,
            principal=principal,
            definition=definition,
            normalized_input=metadata,
            confirmation_id=confirmation_id,
        )
        # 只有绑定输入的批准被消费一次后，才读取无回显输入中的密钥。
        api_key = _secret(body.get("api_key"), "API Key")
        try:
            result = user_ai_provider_service.create_custom_model(
                db,
                principal.user.id,
                name=metadata["name"],
                provider_name=metadata["provider_name"],
                model=metadata["model"],
                api_base=metadata["api_base"],
                api_key=api_key,
                enabled=metadata["enabled"],
                select=metadata["select"],
            )
        except ProductActionError:
            raise
        except ValueError as exc:
            raise ProductActionError("INVALID_INPUT", str(exc), http_status=422) from exc
        _audit_secret_action(
            db, principal=principal, action_id="models.custom.create",
            status="succeeded", started=started,
        )
        return _envelope(
            action="models.custom.create", request_id=request_id,
            data={"configuration": result, "plaintext_secret_persisted": False},
        )
    except Exception as exc:
        try:
            _audit_secret_action(
                db, principal=principal, action_id="models.custom.create",
                status="failed", started=started,
                error_code=getattr(exc, "code", type(exc).__name__),
            )
        except Exception:
            db.rollback()
        return _error_response("models.custom.create", request_id, exc)


@router.post("/models/secret", include_in_schema=False)
async def secure_model_secret_update(
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    started = time.perf_counter()
    try:
        _ensure_enabled()
        definition = _definition(principal, "models.secret.update", db)
        body = await _secret_json(request)
        _only_fields(body, {"target", "model_id", "api_key", "confirmation_id"})
        metadata = _model_secret_confirmation_input(body)
        confirmation_id = _model_secret_confirmation_id(body)
        target = metadata["target"]
        _require_encrypted_secret_storage()
        require_secure_direct_confirmation(
            db,
            principal=principal,
            definition=definition,
            normalized_input=metadata,
            confirmation_id=confirmation_id,
        )
        # 原始 API Key 不参与确认摘要；确认记录原子标记为已用后才读取它。
        api_key = _secret(body.get("api_key"), "API Key")
        if target == "chat":
            model_id = metadata["model_id"]
            try:
                result = user_ai_provider_service.update_custom_model(
                    db, principal.user.id, model_id, api_key=api_key,
                )
            except KeyError as exc:
                raise ProductActionError("RESOURCE_NOT_FOUND", "自定义回答模型不存在", http_status=404) from exc
        elif target == "vision":
            current = video_analysis_catalog_service.serialize_user_vision_config(
                db, principal.user.id,
            )
            if not current.get("configured"):
                raise ProductActionError("RESOURCE_NOT_FOUND", "请先在安全网页表单创建视觉模型配置", http_status=404)
            result = video_analysis_catalog_service.save_user_vision_config(
                db,
                principal.user.id,
                provider_name=str(current.get("provider_name") or ""),
                driver=str(current.get("driver") or "openai_compatible"),
                model=str(current.get("model") or ""),
                api_base=str(current.get("api_base") or ""),
                api_key=api_key,
                enabled=bool(current.get("enabled", True)),
            )
        _audit_secret_action(
            db, principal=principal, action_id="models.secret.update",
            status="succeeded", started=started,
        )
        return _envelope(
            action="models.secret.update", request_id=request_id,
            data={
                "target": target,
                "configuration": result,
                "plaintext_secret_persisted": False,
            },
        )
    except Exception as exc:
        try:
            _audit_secret_action(
                db, principal=principal, action_id="models.secret.update",
                status="failed", started=started,
                error_code=getattr(exc, "code", type(exc).__name__),
            )
        except Exception:
            db.rollback()
        return _error_response("models.secret.update", request_id, exc)
