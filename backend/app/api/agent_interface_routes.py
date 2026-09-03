"""HTTP, device authorization and remote MCP transport for Product Actions."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.agent_interface.contracts import (
    ALL_SCOPE_IDS,
    API_VERSION,
    ActionEnvelope,
    ExecutionLocation,
    IdempotencyStrategy,
    RunStatus,
    SCOPES,
    error_payload,
)
from app.core.auth import bearer_scheme, get_current_user
from app.core.config import settings
from app.core.database import SessionLocal, get_db
from app.core.agent_identity import agent_user_hash
from app.models.agent_interface import AgentCredential, ProductActionRun
from app.models.user import User, get_user_by_id
from app.services import auth_service
from app.services.agent_credential_service import (
    AgentPrincipal,
    CredentialError,
    approve_device_authorization,
    authenticate_access_token,
    create_device_authorization,
    issue_pat,
    list_credentials,
    poll_device_authorization,
    preview_device_authorization,
    require_active_credential,
    revoke_credential,
    rotate_refresh_token,
)
from app.services.agent_rollout_service import action_is_enabled, user_is_enabled
from app.services.product_action_registry import registry
from app.services.product_action_run_service import (
    ProductActionError,
    approve_confirmation,
    get_confirmation,
    get_run,
    invoke,
    list_events,
    list_pending_confirmations,
    recent_calls,
    reject_confirmation,
    require_scopes,
    request_cancel,
    serialize_confirmation,
    serialize_event,
    serialize_run,
)


router = APIRouter(prefix="/api/agent-interface/v1", tags=["agent-interface"])
mcp_router = APIRouter(tags=["agent-mcp"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PatCreateRequest(StrictModel):
    name: str = Field(default="知萃 PAT", min_length=1, max_length=120)
    scopes: list[str] = Field(..., min_length=1, max_length=32)
    expires_in_days: int = Field(default=90, ge=1, le=90)


class DeviceStartRequest(StrictModel):
    client_name: str = Field(default="知萃 CLI", min_length=1, max_length=120)
    client_type: str = Field(default="cli", min_length=1, max_length=32)
    scopes: list[str] = Field(..., min_length=1, max_length=32)


class DeviceApproveRequest(StrictModel):
    user_code: str = Field(..., min_length=8, max_length=16)
    approve: bool = True


class DevicePollRequest(StrictModel):
    device_code: str = Field(..., min_length=32, max_length=256)


class RefreshRequest(StrictModel):
    refresh_token: str = Field(..., min_length=32, max_length=512)


class InvokeRequest(StrictModel):
    input: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=160)
    confirmation_id: str | None = Field(default=None, max_length=32)


class ConfirmationApproveRequest(StrictModel):
    approve: bool = True


class McpRequest(StrictModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


_MCP_RUN_TOOLS: dict[str, dict[str, Any]] = {
    "run.get": {
        "name": "run.get",
        "title": "读取运行状态",
        "description": "读取一个归属于当前用户的知萃运行。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
            },
            "required": ["run_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    "run.events": {
        "name": "run.events",
        "title": "读取运行事件",
        "description": "按序读取一个归属于当前用户的知萃运行事件。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
                "after": {"type": "integer", "minimum": 0},
            },
            "required": ["run_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    "run.cancel": {
        "name": "run.cancel",
        "title": "取消运行",
        "description": "请求取消一个归属于当前用户的知萃运行。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
            },
            "required": ["run_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
}


def _ensure_enabled() -> None:
    if not settings.AGENT_INTERFACE_ENABLED:
        raise ProductActionError(
            "INTERFACE_DISABLED",
            "Agent 接口尚未启用",
            http_status=503,
        )


def _ensure_user_enabled(user_id: str) -> None:
    if not user_is_enabled(str(user_id)):
        raise ProductActionError(
            "ROLLOUT_RESTRICTED",
            "Agent 接口尚未向当前账号开放",
            http_status=403,
        )


def get_agent_browser_user(
    current_user: User = Depends(get_current_user),
) -> User:
    """Browser-session dependency that also enforces the rollout account gate."""

    _ensure_enabled()
    _ensure_user_enabled(current_user.id)
    return current_user


def _require_run_access(
    principal: AgentPrincipal,
    row: ProductActionRun,
) -> None:
    """Bind a Run to both its user and the credential that created it.

    A browser session may supervise all runs owned by that user. Agent
    credentials are deliberately narrower: even two PATs owned by the same
    account cannot inspect or cancel each other's runs. The credential must
    also still carry every scope required by the source Action.
    """
    if principal.credential is not None and row.credential_id != principal.credential.id:
        raise ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404)
    definition = registry.get(row.action_id)
    if definition is not None and not set(definition.scopes).issubset(principal.scopes):
        raise ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404)


def _principal_can_cancel_runs(principal: AgentPrincipal) -> bool:
    """Expose MCP run.cancel only when the token can start cancellable work."""
    return any(
        definition.available
        and definition.execution_location == ExecutionLocation.CLOUD
        and definition.run_type.value in {"stream", "long_task"}
        and set(definition.scopes).issubset(principal.scopes)
        and action_is_enabled(definition.id)
        for definition in registry.all()
    )


def _request_id(request: Request) -> str:
    value = str(request.headers.get("x-request-id") or "").strip()
    return value[:64] if value else uuid.uuid4().hex


def _envelope(
    *, action: str, request_id: str, status: str = "succeeded",
    data: Any = None, run_id: str | None = None,
) -> dict[str, Any]:
    return ActionEnvelope(
        action=action, request_id=request_id, run_id=run_id,
        status=status, data=data,
    ).model_dump(mode="json")


def _error_response(action: str, request_id: str, exc: Exception) -> JSONResponse:
    if isinstance(exc, ProductActionError):
        code = exc.code
        retryable = exc.retryable
        details = exc.details
        status_code = exc.http_status
    elif isinstance(exc, CredentialError):
        code = exc.code
        retryable = exc.retryable
        details = {}
        status_code = {
            "AUTHORIZATION_PENDING": 428,
            "ACCESS_DENIED": 403,
            "CREDENTIAL_REVOKED": 401,
            "CREDENTIAL_EXPIRED": 401,
            "INVALID_CREDENTIAL": 401,
            "ROLLOUT_RESTRICTED": 403,
        }.get(code, 400)
    else:
        code, retryable, details, status_code = "INTERNAL_ERROR", True, {}, 500
    envelope = ActionEnvelope(
        action=action,
        request_id=request_id,
        run_id=str(details.get("run_id") or "") or None,
        status="failed",
        error=error_payload(code, str(exc), retryable=retryable, details=details),
    )
    headers = {"Cache-Control": "no-store"}
    if code == "RATE_LIMITED":
        headers["Retry-After"] = str(details.get("retry_after") or 60)
    return JSONResponse(status_code=status_code, content=envelope.model_dump(mode="json"), headers=headers)


def _principal_from_credentials(
    credentials: HTTPAuthorizationCredentials | None,
    db: Session,
    *,
    required: bool = True,
    allow_browser_session: bool = False,
) -> AgentPrincipal | None:
    if credentials is None:
        if required:
            raise CredentialError("AUTHENTICATION_REQUIRED", "请先授权知萃 Agent")
        return None
    token = credentials.credentials
    if token.startswith("zhc_"):
        row = authenticate_access_token(db, token)
        user = get_user_by_id(db, row.user_id)
        if user is None or not user.is_active:
            raise CredentialError("INVALID_CREDENTIAL", "账号不存在或已被禁用")
        _ensure_user_enabled(user.id)
        return AgentPrincipal(
            user=user,
            credential=row,
            scopes=frozenset(row.scopes),
            auth_type=row.kind,
        )
    if not allow_browser_session:
        raise CredentialError(
            "INVALID_CREDENTIAL",
            "Action 调用必须使用知萃 Agent 专用凭证",
        )
    payload = auth_service.decode_access_token(token)
    user_id = str((payload or {}).get("sub") or "")
    user = get_user_by_id(db, user_id) if user_id else None
    if user is None or not user.is_active:
        raise CredentialError("INVALID_CREDENTIAL", "登录已过期，请重新登录")
    _ensure_user_enabled(user.id)
    # Browser JWT may manage all ordinary-user scopes. is_admin is never
    # inspected here and therefore cannot add an admin Action.
    return AgentPrincipal(
        user=user,
        credential=None,
        scopes=frozenset(ALL_SCOPE_IDS),
        auth_type="browser_session",
    )


def get_agent_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> AgentPrincipal:
    _ensure_enabled()
    try:
        principal = _principal_from_credentials(credentials, db)
    except CredentialError as exc:
        status_code = {
            "AUTHENTICATION_REQUIRED": 401,
            "INVALID_CREDENTIAL": 401,
            "CREDENTIAL_REVOKED": 401,
            "CREDENTIAL_EXPIRED": 401,
            "ROLLOUT_RESTRICTED": 403,
        }.get(exc.code, 401)
        raise HTTPException(
            status_code=status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from None
    assert principal is not None
    return principal


@router.get("/capabilities")
def capabilities(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    request_id = _request_id(request)
    try:
        principal = _principal_from_credentials(
            credentials,
            db,
            required=False,
            allow_browser_session=True,
        )
        scopes = principal.scopes if principal is not None else None
        actions = [
            item for item in registry.capabilities(scopes=scopes)
            if action_is_enabled(item.id)
        ]
        return _envelope(
            action="capabilities.list", request_id=request_id,
            data={
                "interface_version": API_VERSION,
                "feature_enabled": True,
                "user_hash": agent_user_hash(principal.user.id) if principal is not None else None,
                "actions": [item.model_dump(mode="json") for item in actions],
                "scopes": list(SCOPES),
                "transports": {
                    "http": f"{str(request.base_url).rstrip('/')}/api/agent-interface/v1",
                    "mcp": f"{str(request.base_url).rstrip('/')}/mcp",
                },
            },
        )
    except Exception as exc:
        return _error_response("capabilities.list", request_id, exc)


@router.get("/actions/{action_id}")
def action_detail(action_id: str, request: Request):
    _ensure_enabled()
    definition = registry.get(action_id)
    if definition is None or not action_is_enabled(action_id):
        return _error_response(
            "actions.get", _request_id(request),
            ProductActionError("ACTION_NOT_FOUND", "Action 不存在", http_status=404),
        )
    return _envelope(
        action="actions.get", request_id=_request_id(request),
        data={"action": definition.descriptor().model_dump(mode="json")},
    )


@router.post("/actions/{action_id}/invoke")
def invoke_action(
    action_id: str,
    body: InvokeRequest,
    request: Request,
    idempotency_header: str | None = Header(default=None, alias="Idempotency-Key"),
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    request_id = _request_id(request)
    try:
        envelope, _run, _replayed = invoke(
            db,
            principal=principal,
            action_id=action_id,
            raw_input=body.input,
            request_id=request_id,
            idempotency_key=idempotency_header or body.idempotency_key,
            confirmation_id=body.confirmation_id,
        )
        return envelope.model_dump(mode="json")
    except Exception as exc:
        return _error_response(action_id, request_id, exc)


@router.get("/runs/{run_id}")
def get_action_run(
    run_id: str,
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    row = get_run(db, run_id=run_id, user_id=principal.user.id)
    if row is None:
        return _error_response("run.get", _request_id(request), ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404))
    try:
        _require_run_access(principal, row)
    except Exception as exc:
        return _error_response("run.get", _request_id(request), exc)
    return _envelope(
        action="run.get", request_id=_request_id(request), run_id=row.id,
        status=row.status, data={"run": serialize_run(row).model_dump(mode="json")},
    )


def _sse_frame(event: dict[str, Any], *, event_id: int | None = None, event_type: str | None = None) -> str:
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    if event_type:
        lines.append(f"event: {event_type}")
    lines.append(f"data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}")
    return "\n".join(lines) + "\n\n"


@router.get("/runs/{run_id}/events")
def get_action_events(
    run_id: str,
    request: Request,
    after: int = 0,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    row = get_run(db, run_id=run_id, user_id=principal.user.id)
    if row is None:
        return _error_response("run.events", _request_id(request), ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404))
    try:
        _require_run_access(principal, row)
    except Exception as exc:
        return _error_response("run.events", _request_id(request), exc)
    raw_last = request.headers.get("last-event-id", "")
    try:
        cursor = max(after, int(raw_last or 0))
    except ValueError:
        cursor = max(0, after)
    if "text/event-stream" not in request.headers.get("accept", ""):
        items = list_events(db, run=row, after=cursor)
        return _envelope(
            action="run.events", request_id=_request_id(request), run_id=row.id,
            status=row.status,
            data={
                "run": serialize_run(row).model_dump(mode="json"),
                "items": [serialize_event(item).model_dump(mode="json") for item in items],
            },
        )

    user_id = principal.user.id

    def stream():
        current = cursor
        last_heartbeat = time.monotonic()
        while True:
            with SessionLocal() as stream_db:
                stream_principal = principal
                if principal.credential is not None:
                    try:
                        active_credential = require_active_credential(
                            stream_db,
                            credential_id=principal.credential.id,
                            user_id=user_id,
                        )
                    except CredentialError as exc:
                        yield _sse_frame(
                            {"error": {"code": exc.code, "message": str(exc)}},
                            event_type="error",
                        )
                        return
                    stream_principal = AgentPrincipal(
                        user=principal.user,
                        credential=active_credential,
                        scopes=frozenset(active_credential.scopes),
                        auth_type=active_credential.kind,
                    )
                stream_run = get_run(stream_db, run_id=run_id, user_id=user_id)
                if stream_run is None:
                    yield _sse_frame({"error": {"code": "RUN_NOT_FOUND", "message": "运行不存在"}}, event_type="error")
                    return
                try:
                    _require_run_access(stream_principal, stream_run)
                except ProductActionError:
                    yield _sse_frame({"error": {"code": "RUN_NOT_FOUND", "message": "运行不存在"}}, event_type="error")
                    return
                events = list_events(stream_db, run=stream_run, after=current)
                terminal_sent = False
                for item in events:
                    current = item.sequence
                    payload = serialize_event(item).model_dump(mode="json")
                    yield _sse_frame(payload, event_id=item.sequence, event_type=item.event_type)
                    terminal_sent = terminal_sent or bool(item.terminal)
                last_sequence = max(0, int(stream_run.next_sequence or 1) - 1)
                if terminal_sent or (
                    stream_run.status in {"succeeded", "failed", "canceled"}
                    and current >= last_sequence
                ):
                    return
            if time.monotonic() - last_heartbeat >= 10:
                yield ": heartbeat\n\n"
                last_heartbeat = time.monotonic()
            time.sleep(0.1)

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/runs/{run_id}/cancel")
def cancel_action_run(
    run_id: str,
    request: Request,
    principal: AgentPrincipal = Depends(get_agent_principal),
    db: Session = Depends(get_db),
):
    row = get_run(db, run_id=run_id, user_id=principal.user.id)
    if row is None:
        return _error_response("run.cancel", _request_id(request), ProductActionError("RUN_NOT_FOUND", "运行不存在", http_status=404))
    try:
        _require_run_access(principal, row)
    except Exception as exc:
        return _error_response("run.cancel", _request_id(request), exc)
    row = request_cancel(db, run=row)
    return _envelope(
        action="run.cancel", request_id=_request_id(request), run_id=row.id,
        status=row.status, data={"run": serialize_run(row).model_dump(mode="json")},
    )


@router.get("/credentials")
def get_credentials(
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    # PATs and browser-authorized devices have separate public resources.
    # Returning access credentials here as well as from /devices made one
    # device appear twice in the settings UI and mislabeled it as a PAT.
    rows = [row for row in list_credentials(db, current_user.id) if row.kind == "pat"]
    return _envelope(action="credentials.list", request_id=_request_id(request), data={"items": [row.to_public_dict() for row in rows]})


@router.post("/credentials/pat")
def create_pat(
    body: PatCreateRequest,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    try:
        row, token = issue_pat(
            db, user_id=current_user.id, name=body.name,
            scopes=body.scopes, expires_in_days=body.expires_in_days,
        )
        return _envelope(
            action="credentials.pat.create", request_id=_request_id(request),
            data={"credential": row.to_public_dict(), "token": token},
        )
    except Exception as exc:
        return _error_response("credentials.pat.create", _request_id(request), exc)


@router.post("/credentials/{credential_id}/revoke")
def revoke_agent_credential(
    credential_id: str,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    try:
        row = revoke_credential(db, user_id=current_user.id, credential_id=credential_id)
        return _envelope(action="credentials.revoke", request_id=_request_id(request), data={"credential": row.to_public_dict()})
    except Exception as exc:
        return _error_response("credentials.revoke", _request_id(request), exc)


@router.get("/devices")
def get_devices(
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    rows = [row for row in list_credentials(db, current_user.id) if row.kind == "access"]
    return _envelope(action="devices.list", request_id=_request_id(request), data={"items": [row.to_public_dict() for row in rows]})


@router.post("/devices/{credential_id}/revoke")
def revoke_device(
    credential_id: str,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    return revoke_agent_credential(credential_id, request, current_user, db)


@router.get("/recent-calls")
def get_recent_calls(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    return _envelope(
        action="audit.recent",
        request_id=_request_id(request),
        data=recent_calls(db, user_id=current_user.id, limit=limit),
    )


@router.post("/auth/device")
def start_device_auth(body: DeviceStartRequest, request: Request, db: Session = Depends(get_db)):
    _ensure_enabled()
    try:
        row, device_code, user_code = create_device_authorization(
            db, client_name=body.client_name, client_type=body.client_type, scopes=body.scopes
        )
        verify = f"{settings.PUBLIC_APP_URL.rstrip('/')}/settings?section=agent"
        return _envelope(
            action="auth.device.start", request_id=_request_id(request),
            data={
                "device_code": device_code,
                "user_code": user_code,
                "verification_uri": verify,
                "verification_uri_complete": f"{verify}&user_code={user_code}",
                "expires_in": max(1, int((row.expires_at - row.created_at).total_seconds())),
                "interval": row.interval_seconds,
            },
        )
    except Exception as exc:
        return _error_response("auth.device.start", _request_id(request), exc)


@router.post("/auth/device/approve")
def approve_device(
    body: DeviceApproveRequest,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    try:
        row = approve_device_authorization(
            db, user_id=current_user.id, user_code=body.user_code, approve=body.approve
        )
        return _envelope(
            action="auth.device.approve", request_id=_request_id(request),
            data={"status": row.status, "client_name": row.client_name, "scopes": row.requested_scopes},
        )
    except Exception as exc:
        return _error_response("auth.device.approve", _request_id(request), exc)


@router.get("/auth/device/request")
def get_device_request(
    request: Request,
    user_code: str = Query(..., min_length=8, max_length=16),
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    del current_user  # Login is required, but previewing does not bind approval.
    _ensure_enabled()
    try:
        row = preview_device_authorization(db, user_code=user_code)
        return _envelope(
            action="auth.device.request",
            request_id=_request_id(request),
            data={
                "status": row.status,
                "client_name": row.client_name,
                "client_type": row.client_type,
                "scopes": row.requested_scopes,
                "expires_at": row.expires_at.isoformat(),
            },
        )
    except Exception as exc:
        return _error_response("auth.device.request", _request_id(request), exc)


@router.post("/auth/device/token")
def poll_device(body: DevicePollRequest, request: Request, db: Session = Depends(get_db)):
    _ensure_enabled()
    try:
        return _envelope(
            action="auth.device.token", request_id=_request_id(request),
            data=poll_device_authorization(db, device_code=body.device_code),
        )
    except Exception as exc:
        return _error_response("auth.device.token", _request_id(request), exc)


@router.post("/auth/refresh")
def refresh_device(body: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    _ensure_enabled()
    try:
        return _envelope(
            action="auth.refresh", request_id=_request_id(request),
            data=rotate_refresh_token(db, body.refresh_token),
        )
    except Exception as exc:
        return _error_response("auth.refresh", _request_id(request), exc)


@router.get("/confirmations")
def get_pending_action_confirmations(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    """List only this user's live, pending destructive-action approvals.

    Confirmation payloads intentionally contain no Action input or input hash.
    The browser receives only the requesting connection and Action metadata it
    needs to make the one-time approval decision.
    """
    _ensure_enabled()
    rows = list_pending_confirmations(db, user_id=current_user.id, limit=limit)
    items = [serialize_confirmation(db, row) for row in rows]
    return _envelope(
        action="confirmation.list",
        request_id=_request_id(request),
        data={"items": items, "total": len(items)},
    )


@router.get("/confirmations/{confirmation_id}")
def get_action_confirmation(
    confirmation_id: str,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    row = get_confirmation(
        db, user_id=current_user.id, confirmation_id=confirmation_id,
    )
    if row is None:
        return _error_response(
            "confirmation.get",
            _request_id(request),
            ProductActionError(
                "CONFIRMATION_NOT_FOUND", "确认请求不存在", http_status=404,
            ),
        )
    return _envelope(
        action="confirmation.get",
        request_id=_request_id(request),
        data={"confirmation": serialize_confirmation(db, row)},
    )


@router.post("/confirmations/{confirmation_id}/approve")
def approve_action_confirmation(
    confirmation_id: str,
    body: ConfirmationApproveRequest,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    if not body.approve:
        try:
            row = reject_confirmation(
                db, user_id=current_user.id, confirmation_id=confirmation_id,
            )
            return _envelope(
                action="confirmation.reject", request_id=_request_id(request),
                data={
                    "confirmation": serialize_confirmation(db, row),
                    "confirmation_id": row.id,
                    "status": row.status,
                    "expires_at": row.expires_at.isoformat(),
                },
            )
        except Exception as exc:
            return _error_response("confirmation.reject", _request_id(request), exc)
    try:
        row = approve_confirmation(db, user_id=current_user.id, confirmation_id=confirmation_id)
        return _envelope(
            action="confirmation.approve", request_id=_request_id(request),
            data={
                "confirmation": serialize_confirmation(db, row),
                "confirmation_id": row.id,
                "status": row.status,
                "expires_at": row.expires_at.isoformat(),
            },
        )
    except Exception as exc:
        return _error_response("confirmation.approve", _request_id(request), exc)


@router.post("/confirmations/{confirmation_id}/reject")
def reject_action_confirmation(
    confirmation_id: str,
    request: Request,
    current_user: User = Depends(get_agent_browser_user),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    try:
        row = reject_confirmation(
            db, user_id=current_user.id, confirmation_id=confirmation_id,
        )
        return _envelope(
            action="confirmation.reject", request_id=_request_id(request),
            data={
                "confirmation": serialize_confirmation(db, row),
                "confirmation_id": row.id,
                "status": row.status,
                "expires_at": row.expires_at.isoformat(),
            },
        )
    except Exception as exc:
        return _error_response("confirmation.reject", _request_id(request), exc)


def _mcp_error(request_id: str | int | None, code: int, message: str, data: Any = None) -> JSONResponse:
    return JSONResponse(content={"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message, "data": data}})


def _mcp_tool_result(
    request_id: str | int | None,
    structured: dict[str, Any],
    *,
    is_error: bool,
) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(structured, ensure_ascii=False),
                }
            ],
            "structuredContent": structured,
            "isError": is_error,
        },
    }


def _mcp_registry_action(principal: AgentPrincipal, action_id: str):
    """Resolve only Actions that the remote MCP server actually publishes."""
    definition = registry.get(action_id)
    if (
        definition is None
        or not definition.available
        or not action_is_enabled(action_id)
        or definition.execution_location != ExecutionLocation.CLOUD
        or not definition.mcp_exposed
        or definition.secure_direct
    ):
        # Do not disclose whether a guessed name belongs to a hidden, local or
        # secure-direct capability.
        raise ProductActionError(
            "ACTION_NOT_FOUND", "MCP 工具不存在", http_status=404,
        )
    require_scopes(principal, definition)
    return definition


def _mcp_idempotency_key(request_id: str | int | None) -> str | None:
    if request_id is None:
        return None
    encoded = json.dumps(
        {"jsonrpc_id": request_id},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"mcp:{hashlib.sha256(encoded).hexdigest()}"


def _mcp_run_id(arguments: dict[str, Any], *, allow_after: bool) -> tuple[str, int]:
    allowed = {"run_id", "after"} if allow_after else {"run_id"}
    if set(arguments) - allowed:
        raise ProductActionError(
            "INVALID_INPUT", "运行工具包含未声明字段", http_status=422,
        )
    run_id = arguments.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip() or len(run_id) > 64:
        raise ProductActionError(
            "INVALID_INPUT", "run_id 格式无效", http_status=422,
        )
    after = arguments.get("after", 0)
    if (
        not allow_after and "after" in arguments
        or isinstance(after, bool)
        or not isinstance(after, int)
        or after < 0
    ):
        raise ProductActionError(
            "INVALID_INPUT", "after 必须是非负整数", http_status=422,
        )
    return run_id.strip(), after


def _mcp_call_run_tool(
    db: Session,
    *,
    principal: AgentPrincipal,
    action_id: str,
    arguments: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    run_id, after = _mcp_run_id(
        arguments, allow_after=action_id == "run.events",
    )
    row = get_run(db, run_id=run_id, user_id=principal.user.id)
    if row is None:
        raise ProductActionError(
            "RUN_NOT_FOUND", "运行不存在", http_status=404,
        )
    _require_run_access(principal, row)
    if action_id == "run.get":
        return _envelope(
            action=action_id,
            request_id=request_id,
            run_id=row.id,
            status=row.status,
            data={"run": serialize_run(row).model_dump(mode="json")},
        )
    if action_id == "run.events":
        events = list_events(db, run=row, after=after)
        return _envelope(
            action=action_id,
            request_id=request_id,
            run_id=row.id,
            status=row.status,
            data={
                "run": serialize_run(row).model_dump(mode="json"),
                "items": [
                    serialize_event(item).model_dump(mode="json")
                    for item in events
                ],
            },
        )
    if action_id == "run.cancel":
        row = request_cancel(db, run=row)
        return _envelope(
            action=action_id,
            request_id=request_id,
            run_id=row.id,
            status=row.status,
            data={"run": serialize_run(row).model_dump(mode="json")},
        )
    raise ProductActionError(
        "ACTION_NOT_FOUND", "MCP 工具不存在", http_status=404,
    )


@mcp_router.post("/mcp")
def remote_mcp(
    body: McpRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    _ensure_enabled()
    if body.jsonrpc != "2.0":
        return _mcp_error(body.id, -32600, "Invalid Request")
    if body.method == "initialize":
        return {
            "jsonrpc": "2.0", "id": body.id,
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "zhicui", "version": "1.0.0"},
            },
        }
    if body.method == "notifications/initialized":
        # JSON-RPC notifications never receive a response object.  Streamable
        # HTTP acknowledges them with an empty 202 response.
        return Response(status_code=202)
    try:
        principal = _principal_from_credentials(credentials, db, required=True)
        assert principal is not None
    except Exception as exc:
        return _mcp_error(body.id, -32001, "Authentication required", {"message": str(exc)})
    if body.method == "tools/list":
        actions = [
            item
            for item in registry.capabilities(
                scopes=principal.scopes,
                execution_location=ExecutionLocation.CLOUD,
            )
            if action_is_enabled(item.id)
        ]
        published_actions = [
            {
                "name": item.id,
                "title": item.title,
                "description": item.description,
                "inputSchema": item.input_schema,
                "annotations": {
                    "readOnlyHint": all(risk.value == "read" for risk in item.risk),
                    "destructiveHint": any(risk.value == "destructive" for risk in item.risk),
                },
            }
            for item in actions
            if (
                item.available
                and item.execution_location == ExecutionLocation.CLOUD
                and item.mcp_exposed
                and not item.secure_direct
            )
        ]
        run_tools = [
            tool for name, tool in _MCP_RUN_TOOLS.items()
            if name != "run.cancel" or _principal_can_cancel_runs(principal)
        ]
        return {
            "jsonrpc": "2.0", "id": body.id,
            "result": {
                "tools": [*published_actions, *run_tools]
            },
        }
    if body.method == "tools/call":
        name = str(body.params.get("name") or "")
        arguments = body.params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _mcp_error(body.id, -32602, "Tool arguments must be an object")
        call_meta = body.params.get("_meta") or {}
        if not isinstance(call_meta, dict):
            return _mcp_error(body.id, -32602, "Tool metadata must be an object")
        confirmation_id = str(
            call_meta.get("zhicui/confirmationId") or ""
        ).strip()[:32] or None
        try:
            http_request_id = _request_id(request)
            if name in _MCP_RUN_TOOLS:
                structured = _mcp_call_run_tool(
                    db,
                    principal=principal,
                    action_id=name,
                    arguments=arguments,
                    request_id=http_request_id,
                )
                return _mcp_tool_result(body.id, structured, is_error=False)
            definition = _mcp_registry_action(principal, name)
            idempotency_key = str(
                request.headers.get("idempotency-key") or ""
            ).strip()[:160] or None
            if (
                definition.idempotency == IdempotencyStrategy.REQUIRED
                and idempotency_key is None
            ):
                idempotency_key = _mcp_idempotency_key(body.id)
                if idempotency_key is None:
                    raise ProductActionError(
                        "IDEMPOTENCY_KEY_REQUIRED",
                        "需要 JSON-RPC 请求 id 才能安全调用此工具",
                        http_status=422,
                    )
            envelope, _run, _replayed = invoke(
                db, principal=principal, action_id=name, raw_input=arguments,
                request_id=http_request_id,
                idempotency_key=idempotency_key,
                confirmation_id=confirmation_id,
            )
            structured = envelope.model_dump(mode="json")
            return _mcp_tool_result(body.id, structured, is_error=False)
        except Exception as exc:
            response = _error_response(name or "tools.call", _request_id(request), exc)
            structured = json.loads(response.body)
            return _mcp_tool_result(body.id, structured, is_error=True)
    if body.method == "ping":
        return {"jsonrpc": "2.0", "id": body.id, "result": {}}
    return _mcp_error(body.id, -32601, "Method not found")
