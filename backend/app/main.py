"""
VideoCapsule FastAPI application entry point.
"""

import json
import os
import threading
import time
import traceback
import uuid
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import (
    http_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.api.desktop_login_routes import router as desktop_login_router
from app.api.agent_routes import router as agent_router
from app.api.video_analysis_routes import router as video_analysis_router
from app.api.ops_routes import router as ops_router
from app.api.privacy_account_routes import router as privacy_account_router
from app.api.catalog_quality_routes import router as catalog_quality_router
from app.api.agent_interface_routes import (
    router as agent_interface_router,
    mcp_router as agent_mcp_router,
)
from app.api.agent_secure_routes import router as agent_secure_router
from app.core.rate_limit import RateLimitMiddleware
from app.core.security_headers import SecurityHeadersMiddleware
from app.core.database import Base, SessionLocal, engine
from sqlalchemy import inspect, text

# Import all models so they are registered with Base.metadata before create_all.
from app.models.note import Note  # noqa: F401
from app.models.plan import Plan  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.system_setting import SystemSetting  # noqa: F401
from app.models.admin_audit_log import AdminAuditLog  # noqa: F401
from app.models.llm_usage_log import LlmUsageLog  # noqa: F401
from app.models.user_activity_log import UserActivityLog  # noqa: F401
from app.models.application_error_log import ApplicationErrorLog  # noqa: F401
from app.models.operational_alert import OperationalAlert  # noqa: F401
from app.models.privacy_account import (  # noqa: F401
    AccountActionGrant,
    AccountPrivacyAuditEvent,
    UserLegalConsent,
)
from app.models.client_download_daily import ClientDownloadDaily  # noqa: F401
from app.models.feedback import Feedback  # noqa: F401
from app.models.library_hidden_item import LibraryHiddenItem  # noqa: F401
from app.models.douyin_account_binding import DouyinAccountBinding  # noqa: F401
from app.models.douyin_local_library_item import DouyinLocalLibraryItem  # noqa: F401
from app.models.desktop_handoff import DesktopHandoff  # noqa: F401
from app.models.desktop_login_session import DesktopLoginSession  # noqa: F401
from app.models.video_source_ledger import VideoSourceLedger  # noqa: F401
from app.models.creator_sync import (  # noqa: F401
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
    CreatorCatalogQualityRun,
    CreatorCatalogQualityRunItem,
)
from app.models.agent_thread import AgentMessage, AgentThread  # noqa: F401
from app.models.agent_runtime import (  # noqa: F401
    AgentEvent,
    AgentMemoryCheckpoint,
    AgentTurn,
    AgentTurnSource,
)
from app.models.knowledge_entry import KnowledgeEntry  # noqa: F401
from app.models.user_ai_provider_config import UserAIProviderConfig  # noqa: F401
from app.models.user_custom_chat_model import UserCustomChatModel  # noqa: F401
from app.models.chat_model import (  # noqa: F401
    ChatModelChargeReservation,
    ChatModelFreeUsage,
    ChatModelOffering,
)
from app.models import video_analysis as video_analysis_models  # noqa: F401
from app.models.agent_automation import (  # noqa: F401
    AgentAutomation,
    AgentAutomationRun,
)
from app.models.agent_interface import (  # noqa: F401
    AgentCredential,
    AgentDeviceAuthorization,
    ProductActionAudit,
    ProductActionConfirmation,
    ProductActionEvent,
    ProductActionIdempotency,
    ProductActionRateWindow,
    ProductActionRun,
)
from app.models.library_extraction_batch import (  # noqa: F401
    LibraryExtractionBatch,
    LibraryExtractionBatchItem,
)
from app.core.request_context import reset_request_context, set_request_context
from app.services import (
    activity_service,
    agent_service,
    agent_runtime_worker,
    auth_service,
    automation_runner,
    creator_catalog_quality_migration,
    creator_catalog_quality_worker,
    creator_sync_worker,
    chat_model_catalog_service,
    error_log_service,
    note_service,
    library_extraction_service,
    ops_monitor_runner,
    product_action_run_service,
    video_analysis_catalog_service,
    video_analysis_service,
    video_analysis_worker,
)
from app.services.video_analysis_engine import probe_note_duration_ms
from app.agent_interface.contracts import ActionEnvelope, error_payload
from app.services.agent_credential_service import CredentialError
from app.services.product_action_run_service import ProductActionError


def create_app() -> FastAPI:
    """Application factory."""
    app = FastAPI(
        title="知萃 API",
        description="AI 视频知识萃取 API",
        version="0.1.0",
    )

    # CORS — permissive in dev, configurable in production via ALLOWED_ORIGINS.
    allowed_origins_raw = os.environ.get("ALLOWED_ORIGINS", "*")
    allowed_origins = (
        [o.strip() for o in allowed_origins_raw.split(",") if o.strip()]
        if allowed_origins_raw != "*"
        else ["*"]
    )
    # iOS Capacitor 从本机资源加载界面；只增加固定原生源，不放宽公网来源。
    if allowed_origins != ["*"] and "capacitor://localhost" not in allowed_origins:
        allowed_origins.append("capacitor://localhost")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True if allowed_origins != ["*"] else False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RateLimitMiddleware)

    def request_log_context(request: Request) -> dict:
        route = request.scope.get("route")
        route_path = getattr(route, "path", request.url.path)
        return {
            "method": request.method,
            "path": route_path,
            "user_id": getattr(request.state, "observability_user_id", None),
            "ip": request.client.host if request.client else None,
        }

    def agent_wire_action(request: Request) -> str:
        return request.url.path.removeprefix("/api/agent-interface/v1/") or "agent-interface"

    def agent_wire_request_id(request: Request) -> str:
        supplied = str(request.headers.get("x-request-id") or "").strip()[:64]
        return supplied or uuid.uuid4().hex

    @app.exception_handler(HTTPException)
    async def logged_http_exception(request: Request, exc: HTTPException):
        if request.url.path.startswith("/api/agent-interface/v1/"):
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            code = str(detail.get("code") or {
                401: "AUTHENTICATION_REQUIRED",
                403: "ACCESS_DENIED",
                404: "RESOURCE_NOT_FOUND",
            }.get(exc.status_code, "HTTP_ERROR"))
            message = str(detail.get("message") or exc.detail)
            return JSONResponse(
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store"},
                content=ActionEnvelope(
                    action=agent_wire_action(request),
                    request_id=agent_wire_request_id(request),
                    status="failed",
                    error=error_payload(code, message, retryable=exc.status_code >= 500),
                ).model_dump(mode="json"),
            )
        # Routine unauthenticated/forbidden/not-found responses are expected
        # control flow and would otherwise drown actionable failures.
        if exc.status_code not in {401, 403, 404}:
            error_log_service.record_error_safely(
                source="http",
                severity="error" if exc.status_code >= 500 else "warning",
                error_type=type(exc).__name__,
                message=str(exc.detail),
                status_code=exc.status_code,
                **request_log_context(request),
            )
        return await http_exception_handler(request, exc)

    @app.exception_handler(RequestValidationError)
    async def logged_validation_exception(
        request: Request,
        exc: RequestValidationError,
    ):
        safe_issues = [
            f"{'.'.join(map(str, issue.get('loc', [])))}:{issue.get('type', 'invalid')}"
            for issue in exc.errors()[:12]
        ]
        safe_details = [
            {
                "loc": list(issue.get("loc", [])),
                "msg": str(issue.get("msg") or "请求参数无效")[:240],
                "type": str(issue.get("type") or "invalid")[:120],
            }
            for issue in exc.errors()[:12]
        ]
        if request.url.path == "/mcp":
            return JSONResponse(
                status_code=400,
                content={
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32600,
                        "message": "Invalid Request",
                        "data": {"issues": safe_details},
                    },
                },
            )
        if request.url.path.startswith("/api/agent-interface/v1/"):
            return JSONResponse(
                status_code=422,
                headers={"Cache-Control": "no-store"},
                content=ActionEnvelope(
                    action=agent_wire_action(request),
                    request_id=agent_wire_request_id(request),
                    status="failed",
                    error=error_payload(
                        "INVALID_INPUT",
                        "请求参数校验失败",
                        details={"issues": safe_details},
                    ),
                ).model_dump(mode="json"),
            )
        error_log_service.record_error_safely(
            source="validation",
            severity="warning",
            error_type=type(exc).__name__,
            message="请求参数校验失败: " + ", ".join(safe_issues),
            status_code=422,
            **request_log_context(request),
        )
        # FastAPI's default 422 body includes each rejected field's raw
        # ``input``.  That can echo an invalid API key/password back through
        # the response.  Return only structural validation facts.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {
                        **issue,
                    }
                    for issue in safe_details
                ]
            },
        )

    @app.exception_handler(ProductActionError)
    @app.exception_handler(CredentialError)
    async def agent_interface_exception(request: Request, exc: Exception):
        """Keep authentication/feature-gate failures on the v1 wire contract."""
        code = str(getattr(exc, "code", "INTERNAL_ERROR"))
        status_code = int(getattr(exc, "http_status", 0) or {
            "AUTHENTICATION_REQUIRED": 401,
            "INVALID_CREDENTIAL": 401,
            "CREDENTIAL_REVOKED": 401,
            "CREDENTIAL_EXPIRED": 401,
            "SCOPE_DENIED": 403,
            "INTERFACE_DISABLED": 503,
        }.get(code, 400))
        if request.url.path == "/mcp":
            return JSONResponse(
                status_code=status_code,
                headers={"Cache-Control": "no-store"},
                content={
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32000,
                        "message": str(exc),
                        "data": {"code": code},
                    },
                },
            )
        return JSONResponse(
            status_code=status_code,
            headers={"Cache-Control": "no-store"},
            content=ActionEnvelope(
                action=agent_wire_action(request),
                request_id=agent_wire_request_id(request),
                status="failed",
                error=error_payload(
                    code,
                    str(exc),
                    retryable=bool(getattr(exc, "retryable", False)),
                    details=getattr(exc, "details", {}) or {},
                ),
            ).model_dump(mode="json"),
        )

    @app.exception_handler(Exception)
    async def logged_unhandled_exception(request: Request, exc: Exception):
        error_log_service.record_error_safely(
            source="backend",
            severity="critical",
            error_type=type(exc).__name__,
            message=str(exc) or type(exc).__name__,
            traceback=traceback.format_exc(),
            status_code=500,
            **request_log_context(request),
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal Server Error"},
        )

    @app.middleware("http")
    async def request_observability(request: Request, call_next):
        """Attribute nested LLM calls and log safe state-changing operations."""
        auth_header = request.headers.get("authorization", "")
        user_id: str | None = None
        if auth_header.lower().startswith("bearer "):
            payload = auth_service.decode_access_token(auth_header[7:].strip())
            if payload:
                user_id = payload.get("sub")
        request.state.observability_user_id = user_id

        context_tokens = set_request_context(user_id, request.url.path)
        started = time.perf_counter()
        response = None
        try:
            response = await call_next(request)
            return response
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000)
            route = request.scope.get("route")
            route_path = getattr(route, "path", request.url.path)
            if (
                user_id
                and request.method.upper() != "GET"
                and not route_path.startswith("/api/auth/")
                and route_path != "/api/client-errors"
                and not activity_service.is_explicit_activity_route(
                    request.method,
                    route_path,
                )
            ):
                activity_service.log_activity_safely(
                    user_id=user_id,
                    action=activity_service.classify_action(request.method, route_path),
                    method=request.method,
                    path=route_path,
                    status_code=response.status_code if response is not None else 500,
                    duration_ms=duration_ms,
                    ip=request.client.host if request.client else None,
                )
            reset_request_context(context_tokens)

    # Register routes
    app.include_router(router)
    app.include_router(desktop_login_router)
    app.include_router(agent_router)
    app.include_router(video_analysis_router)
    app.include_router(ops_router)
    app.include_router(privacy_account_router)
    app.include_router(catalog_quality_router)
    app.include_router(agent_interface_router)
    app.include_router(agent_secure_router)
    app.include_router(agent_mcp_router)

    # Create database tables on startup
    @app.on_event("startup")
    def on_startup() -> None:
        Base.metadata.create_all(bind=engine)
        _migrate_db()
        creator_catalog_quality_migration.ensure_schema(engine)
        with SessionLocal() as db:
            note_service.scrub_legacy_ephemeral_media(db)
            agent_service.mark_stale_threads(db)
            product_action_run_service.recover_stale_runs(db)
            product_action_run_service.repair_missing_terminal_events(db)
            video_analysis_catalog_service.ensure_default_drafts(db)
            chat_model_catalog_service.ensure_default_offering(db)
        video_analysis_service.register_duration_probe(probe_note_duration_ms)
        video_analysis_worker.register_completion_hook(
            agent_service.handle_video_analysis_completion
        )
        video_analysis_worker.runner.start()
        creator_sync_worker.runner.start()
        creator_catalog_quality_worker.runner.start()
        agent_runtime_worker.runner.start()
        library_extraction_service.resume_pending_jobs()
        threading.Thread(
            target=_reconcile_video_analysis_agent_runs,
            name="video-analysis-agent-reconcile",
            daemon=True,
        ).start()
        automation_runner.runner.start()
        ops_monitor_runner.runner.start()

    @app.on_event("shutdown")
    def on_shutdown() -> None:
        ops_monitor_runner.runner.stop()
        agent_runtime_worker.runner.stop()
        creator_catalog_quality_worker.runner.stop()
        creator_sync_worker.runner.stop()
        automation_runner.runner.stop()
        video_analysis_worker.runner.stop()
        video_analysis_worker.unregister_completion_hook(
            agent_service.handle_video_analysis_completion
        )
        video_analysis_service.register_duration_probe(None)

    return app


def _reconcile_video_analysis_agent_runs() -> None:
    """修复 Agent 报价卡、运行卡和完成后续答的进程崩溃窗口。"""
    from app.models.video_analysis import VideoAnalysisRun

    try:
        with SessionLocal() as db:
            rows = (
                db.query(VideoAnalysisRun)
                .filter(
                    VideoAnalysisRun.trigger == "agent",
                    VideoAnalysisRun.status.in_(
                        [
                            "prepared",
                            "reserved",
                            "queued",
                            "running",
                            "succeeded",
                            "partial",
                            "failed",
                            "cancelled",
                            "reauthorization_required",
                        ]
                    ),
                    VideoAnalysisRun.agent_thread_id.is_not(None),
                )
                .order_by(VideoAnalysisRun.updated_at.desc())
                .limit(500)
                .all()
            )
            events = [
                SimpleNamespace(
                    run_id=row.id,
                    user_id=row.user_id,
                    item_id="",
                    note_id="",
                    status=row.status,
                    recovery=True,
                )
                for row in rows
            ]
        for event in events:
            agent_service.reconcile_video_analysis_agent_run(event)
    except Exception:
        error_log_service.record_error_safely(
            source="backend",
            severity="warning",
            error_type="VideoAnalysisAgentReconcileError",
            message="视频解析完成事件启动补偿失败",
            status_code=500,
            metadata={"operation": "video_analysis_agent_reconcile"},
        )


def _migrate_knowledge_entries(conn, insp, dialect_name: str) -> None:
    """Add curated-page fields without replacing historical knowledge rows."""
    if not insp.has_table("knowledge_entries"):
        return

    entry_cols = {column["name"] for column in insp.get_columns("knowledge_entries")}
    additions = (
        ("summary", "TEXT NOT NULL DEFAULT ''"),
        ("status", "VARCHAR(32) NOT NULL DEFAULT 'canonical'"),
        ("origin", "VARCHAR(32) NOT NULL DEFAULT 'manual'"),
        ("source_note_id", "VARCHAR(36) NULL"),
    )
    for column_name, definition in additions:
        if column_name not in entry_cols:
            conn.execute(text(
                f"ALTER TABLE knowledge_entries ADD COLUMN {column_name} {definition}"
            ))

    # Defaults make old rows immediately readable as user-authored canonical
    # pages. The UPDATE also repairs nullable columns from experimental builds.
    conn.execute(text(
        "UPDATE knowledge_entries SET "
        "summary = COALESCE(summary, ''), "
        "status = CASE WHEN status IS NULL OR status = '' "
        "THEN 'canonical' ELSE status END, "
        "origin = CASE WHEN origin IS NULL OR origin = '' "
        "THEN 'manual' ELSE origin END"
    ))
    if insp.has_table("notes"):
        # An application foreign key cannot express same-user ownership. Clear
        # orphaned or cross-user links left by any experimental build before
        # adding the unique index / PostgreSQL constraint.
        conn.execute(text(
            "UPDATE knowledge_entries SET source_note_id = NULL "
            "WHERE source_note_id IS NOT NULL AND NOT EXISTS ("
            "SELECT 1 FROM notes WHERE notes.id = knowledge_entries.source_note_id "
            "AND notes.user_id = knowledge_entries.user_id)"
        ))
        conn.execute(text(
            "UPDATE knowledge_entries SET source_note_id = NULL WHERE id IN ("
            "SELECT id FROM (SELECT id, ROW_NUMBER() OVER ("
            "PARTITION BY user_id, source_note_id ORDER BY updated_at DESC, id DESC"
            ") AS source_rank FROM knowledge_entries "
            "WHERE source_note_id IS NOT NULL) AS ranked_sources "
            "WHERE source_rank > 1)"
        ))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_entries_user_status_updated "
        "ON knowledge_entries (user_id, status, updated_at)"
    ))
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_knowledge_entries_user_source_note "
        "ON knowledge_entries (user_id, source_note_id)"
    ))

    if dialect_name == "sqlite" and insp.has_table("notes"):
        # SQLite cannot add a foreign key with ALTER TABLE. Mirror the only
        # delete-side behavior this optional link needs so upgraded databases
        # do not retain dangling source IDs when a Note is removed.
        conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS "
            "trg_knowledge_entries_source_note_delete "
            "AFTER DELETE ON notes BEGIN "
            "UPDATE knowledge_entries SET source_note_id = NULL "
            "WHERE source_note_id = OLD.id; END"
        ))
    elif dialect_name == "postgresql" and insp.has_table("notes"):
        # SQLite cannot add a foreign-key constraint with ALTER TABLE. Fresh
        # SQLite databases still receive it from SQLAlchemy metadata; existing
        # SQLite rows receive equivalent delete cleanup through the trigger.
        conn.execute(text(
            "DO $$ BEGIN "
            "IF NOT EXISTS ("
            "SELECT 1 FROM pg_constraint AS source_constraint "
            "JOIN pg_attribute AS source_column "
            "ON source_column.attrelid = source_constraint.conrelid "
            "AND source_column.attnum = ANY(source_constraint.conkey) "
            "WHERE source_constraint.conrelid = 'knowledge_entries'::regclass "
            "AND source_constraint.contype = 'f' "
            "AND source_column.attname = 'source_note_id'"
            ") THEN "
            "ALTER TABLE knowledge_entries ADD CONSTRAINT "
            "fk_knowledge_entries_source_note_id_notes "
            "FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE SET NULL; "
            "END IF; END $$"
        ))


def _promote_legacy_custom_provider(conn) -> None:
    """把旧单行 custom 配置提升为该用户第一条自定义模型并设为当前。

    仅当用户还没有任何自定义模型时才提升，保证幂等且绝不覆盖用户
    之后新建的选择。
    """
    from app.models.user_custom_chat_model import UserCustomChatModel

    legacy_rows = conn.execute(text(
        "SELECT id, user_id, provider_name, model, api_base, encrypted_api_key "
        "FROM user_ai_provider_configs "
        "WHERE mode = 'custom' AND enabled"
    )).mappings().all()
    if not legacy_rows:
        return
    for row in legacy_rows:
        if not (row["model"] and row["api_base"] and row["encrypted_api_key"]):
            continue
        exists = conn.execute(text(
            "SELECT 1 FROM user_custom_chat_models WHERE user_id = :user_id LIMIT 1"
        ), {"user_id": row["user_id"]}).first()
        if exists is not None:
            continue
        import uuid

        conn.execute(
            UserCustomChatModel.__table__.insert(),
            {
                "id": str(uuid.uuid4()),
                "user_id": row["user_id"],
                "name": (row["provider_name"] or "").strip()[:80] or "OpenAI Compatible",
                "provider_name": (row["provider_name"] or "").strip()[:80] or "OpenAI Compatible",
                "model": row["model"],
                "api_base": row["api_base"],
                "encrypted_api_key": row["encrypted_api_key"],
                "enabled": True,
                "is_selected": True,
            },
        )


def _migrate_creator_sync(conn, insp) -> None:
    """Add catalog/run-progress fields without rebuilding legacy tables.

    In particular, the historic requested_limit and status CHECK constraints
    stay untouched. Retry waiting is represented by queued + next_retry_at and
    user intervention by failed + needs_action.
    """
    if insp.has_table("creator_source_items"):
        item_cols = {c["name"] for c in insp.get_columns("creator_source_items")}
        item_additions = {
            "title": "VARCHAR(512) NOT NULL DEFAULT ''",
            "cover_url": "VARCHAR(2048) NOT NULL DEFAULT ''",
            "description": "TEXT NOT NULL DEFAULT ''",
            "author_name": "VARCHAR(160) NOT NULL DEFAULT ''",
            "published_at": "TIMESTAMP NULL",
            "duration_seconds": "INTEGER NULL",
            "order_index": "INTEGER NOT NULL DEFAULT 0",
            "parts_json": "TEXT NOT NULL DEFAULT '[]'",
            "last_seen_run_id": "VARCHAR(48) NULL",
            "is_available": "BOOLEAN NOT NULL DEFAULT TRUE",
            "unavailable_at": "TIMESTAMP NULL",
        }
        for column_name, definition in item_additions.items():
            if column_name not in item_cols:
                conn.execute(text(
                    f"ALTER TABLE creator_source_items ADD COLUMN "
                    f"{column_name} {definition}"
                ))
        conn.execute(text(
            "UPDATE creator_source_items SET is_available = FALSE, "
            "unavailable_at = COALESCE(unavailable_at, removed_at) "
            "WHERE state = 'removed' OR removed_at IS NOT NULL"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_creator_items_source_catalog "
            "ON creator_source_items "
            "(source_id, is_available, published_at, external_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_creator_items_source_state "
            "ON creator_source_items (source_id, state, note_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_creator_source_items_last_seen_run_id "
            "ON creator_source_items (last_seen_run_id)"
        ))

    if insp.has_table("creator_sync_runs"):
        run_cols = {c["name"] for c in insp.get_columns("creator_sync_runs")}
        run_additions = {
            "operation": "VARCHAR(32) NOT NULL DEFAULT 'recent_transcript'",
            "target_count": "INTEGER NOT NULL DEFAULT 0",
            "discovery_cursor_json": "TEXT NOT NULL DEFAULT '{}'",
            "discovery_complete": "BOOLEAN NOT NULL DEFAULT FALSE",
            "discovered_count": "INTEGER NOT NULL DEFAULT 0",
            "processed_count": "INTEGER NOT NULL DEFAULT 0",
            "total_count": "INTEGER NULL",
            "attempt_count": "INTEGER NOT NULL DEFAULT 0",
            "next_retry_at": "TIMESTAMP NULL",
            "needs_action": "BOOLEAN NOT NULL DEFAULT FALSE",
            "needs_action_code": "VARCHAR(80) NOT NULL DEFAULT ''",
            "needs_action_message": "VARCHAR(240) NOT NULL DEFAULT ''",
            "source_snapshot_json": "TEXT NOT NULL DEFAULT '{}'",
        }
        for column_name, definition in run_additions.items():
            if column_name not in run_cols:
                conn.execute(text(
                    f"ALTER TABLE creator_sync_runs ADD COLUMN "
                    f"{column_name} {definition}"
                ))
        conn.execute(text(
            "UPDATE creator_sync_runs SET "
            "operation = COALESCE(NULLIF(operation, ''), 'recent_transcript'), "
            "target_count = CASE WHEN target_count = 0 THEN requested_limit "
            "ELSE target_count END, "
            "discovered_count = CASE WHEN discovered_count = 0 THEN checked_count "
            "ELSE discovered_count END, "
            "processed_count = CASE WHEN processed_count = 0 THEN checked_count "
            "ELSE processed_count END"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_creator_sync_runs_operation "
            "ON creator_sync_runs (operation)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_creator_sync_runs_next_retry_at "
            "ON creator_sync_runs (next_retry_at)"
        ))
        legacy_snapshots = conn.execute(text(
            "SELECT r.id, s.id AS source_id, s.platform, s.creator_id, "
            "s.profile_url, s.display_name, s.avatar_url "
            "FROM creator_sync_runs r "
            "JOIN creator_sources s ON s.id = r.source_id "
            "WHERE r.source_snapshot_json IS NULL "
            "OR r.source_snapshot_json = '' OR r.source_snapshot_json = '{}'"
        )).mappings().all()
        for row in legacy_snapshots:
            snapshot = {
                "id": row["source_id"],
                "platform": row["platform"],
                "creator_id": row["creator_id"],
                "profile_url": row["profile_url"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
            }
            conn.execute(text(
                "UPDATE creator_sync_runs SET source_snapshot_json = :snapshot "
                "WHERE id = :run_id"
            ), {
                "snapshot": json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
                "run_id": row["id"],
            })


def _migrate_admin_audit_logs(conn, insp, dialect_name: str) -> None:
    if not insp.has_table("admin_audit_logs"):
        return
    audit_columns = {
        column["name"]: column
        for column in insp.get_columns("admin_audit_logs")
    }
    admin_subject = audit_columns.get("admin_user_id")
    if not admin_subject or admin_subject.get("nullable", True):
        return
    if dialect_name == "postgresql":
        conn.execute(text(
            "ALTER TABLE admin_audit_logs "
            "ALTER COLUMN admin_user_id DROP NOT NULL"
        ))
        return
    if dialect_name != "sqlite":
        raise RuntimeError(
            "admin_audit_logs.admin_user_id 仍为 NOT NULL，"
            f"尚未实现 {dialect_name} 的安全迁移"
        )

    # SQLite cannot drop NOT NULL in place. Rebuild this small, append-only
    # table before account deletion can anonymize an administrator without
    # erasing the audit history.
    legacy_name = "admin_audit_logs_pre_nullable"
    conn.execute(text(f"DROP TABLE IF EXISTS {legacy_name}"))
    conn.execute(text(
        f"ALTER TABLE admin_audit_logs RENAME TO {legacy_name}"
    ))
    AdminAuditLog.__table__.create(bind=conn)
    column_names = (
        "id, admin_user_id, action, target_type, target_id, "
        "detail, ip, created_at"
    )
    conn.execute(text(
        f"INSERT INTO admin_audit_logs ({column_names}) "
        f"SELECT {column_names} FROM {legacy_name}"
    ))
    conn.execute(text(f"DROP TABLE {legacy_name}"))


def _migrate_db() -> None:
    """Apply small cross-dialect additive migrations without Alembic."""
    insp = inspect(engine)
    with engine.begin() as conn:
        _migrate_admin_audit_logs(conn, insp, engine.dialect.name)
        _migrate_knowledge_entries(conn, insp, engine.dialect.name)
        _migrate_creator_sync(conn, insp)
        # Older local SQLite builds ran with foreign_keys disabled. Remove
        # only orphan rows from the newly introduced Agent tables before
        # relying on cascade behavior going forward.
        for table_name in (
            "agent_messages",
            "agent_automation_runs",
            "agent_automations",
            "agent_threads",
            "video_source_ledgers",
        ):
            if insp.has_table(table_name) and insp.has_table("users"):
                conn.execute(text(
                    f"DELETE FROM {table_name} "
                    "WHERE user_id NOT IN (SELECT id FROM users)"
                ))
        if insp.has_table("agent_messages") and insp.has_table("agent_threads"):
            conn.execute(text(
                "DELETE FROM agent_messages "
                "WHERE thread_id NOT IN (SELECT id FROM agent_threads)"
            ))
        if (
            insp.has_table("agent_automation_runs")
            and insp.has_table("agent_automations")
        ):
            conn.execute(text(
                "DELETE FROM agent_automation_runs "
                "WHERE automation_id NOT IN "
                "(SELECT id FROM agent_automations)"
            ))
        if (
            insp.has_table("agent_automation_runs")
            and insp.has_table("agent_threads")
        ):
            conn.execute(text(
                "UPDATE agent_automation_runs SET agent_thread_id = NULL "
                "WHERE agent_thread_id IS NOT NULL AND agent_thread_id "
                "NOT IN (SELECT id FROM agent_threads)"
            ))
        if insp.has_table("users"):
            user_cols = {c["name"] for c in insp.get_columns("users")}
            if "username" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN username VARCHAR NULL"))
            if "is_admin" not in user_cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE"))
            if "email_verified" not in user_cols:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN "
                    "email_verified BOOLEAN NOT NULL DEFAULT FALSE"
                ))
            if "email_verification_nonce" not in user_cols:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN "
                    "email_verification_nonce VARCHAR(96) NULL"
                ))
            if "email_verification_sent_at" not in user_cols:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN "
                    "email_verification_sent_at TIMESTAMP NULL"
                ))
        if insp.has_table("notes"):
            note_cols = {c["name"] for c in insp.get_columns("notes")}
            if "ai_initialized" not in note_cols:
                conn.execute(text(
                    "ALTER TABLE notes ADD COLUMN "
                    "ai_initialized BOOLEAN NOT NULL DEFAULT TRUE"
                ))
        if insp.has_table("plans"):
            plan_cols = {c["name"] for c in insp.get_columns("plans")}
            if "start_date" not in plan_cols:
                conn.execute(text(
                    "ALTER TABLE plans ADD COLUMN start_date DATE NULL"
                ))
            if "completed_at" not in plan_cols:
                conn.execute(text(
                    "ALTER TABLE plans ADD COLUMN completed_at TIMESTAMP NULL"
                ))
        if insp.has_table("agent_threads"):
            thread_cols = {c["name"] for c in insp.get_columns("agent_threads")}
            if "context_type" not in thread_cols:
                conn.execute(text(
                    "ALTER TABLE agent_threads ADD COLUMN "
                    "context_type VARCHAR(24) NOT NULL DEFAULT 'video'"
                ))
            if "context_id" not in thread_cols:
                conn.execute(text(
                    "ALTER TABLE agent_threads ADD COLUMN context_id VARCHAR(36) NULL"
                ))
            conn.execute(text(
                "UPDATE agent_threads SET context_type = 'video' "
                "WHERE context_type IS NULL OR context_type = ''"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_agent_threads_context_id "
                "ON agent_threads (context_id)"
            ))
        if insp.has_table("video_source_ledgers"):
            ledger_cols = {
                c["name"] for c in insp.get_columns("video_source_ledgers")
            }
            # This table is new, but keep startup tolerant of an earlier
            # experimental build that did not yet track all observation times.
            if "source_rank" not in ledger_cols:
                conn.execute(text(
                    "ALTER TABLE video_source_ledgers ADD COLUMN "
                    "source_rank INTEGER NULL"
                ))
            if "first_seen_at" not in ledger_cols:
                conn.execute(text(
                    "ALTER TABLE video_source_ledgers ADD COLUMN "
                    "first_seen_at TIMESTAMP NULL"
                ))
            if "last_seen_at" not in ledger_cols:
                conn.execute(text(
                    "ALTER TABLE video_source_ledgers ADD COLUMN "
                    "last_seen_at TIMESTAMP NULL"
                ))
            if "source_synced_at" not in ledger_cols:
                conn.execute(text(
                    "ALTER TABLE video_source_ledgers ADD COLUMN "
                    "source_synced_at TIMESTAMP NULL"
                ))
            conn.execute(text(
                "UPDATE video_source_ledgers "
                "SET first_seen_at = COALESCE(first_seen_at, CURRENT_TIMESTAMP), "
                "last_seen_at = COALESCE(last_seen_at, first_seen_at, CURRENT_TIMESTAMP), "
                "source_synced_at = COALESCE(source_synced_at, last_seen_at, "
                "first_seen_at, CURRENT_TIMESTAMP)"
            ))
            if insp.has_table("notes"):
                conn.execute(text(
                    "UPDATE video_source_ledgers SET note_id = NULL "
                    "WHERE note_id IS NOT NULL AND ("
                    "note_id NOT IN (SELECT id FROM notes) OR "
                    "NOT EXISTS ("
                    "SELECT 1 FROM notes "
                    "WHERE notes.id = video_source_ledgers.note_id "
                    "AND notes.user_id = video_source_ledgers.user_id"
                    "))"
                ))
        if insp.has_table("agent_credentials"):
            credential_cols = {
                c["name"] for c in insp.get_columns("agent_credentials")
            }
            # Beta databases created before refresh replay hardening only had
            # the current digest.  Keep the migration additive and nullable
            # so SQLite and PostgreSQL can both upgrade without downtime.
            if "previous_refresh_hash" not in credential_cols:
                conn.execute(text(
                    "ALTER TABLE agent_credentials ADD COLUMN "
                    "previous_refresh_hash VARCHAR(64) NULL"
                ))
        if insp.has_table("product_action_confirmations"):
            confirmation_cols = {
                c["name"] for c in insp.get_columns("product_action_confirmations")
            }
            if "confirmation_summary_json" not in confirmation_cols:
                conn.execute(text(
                    "ALTER TABLE product_action_confirmations ADD COLUMN "
                    "confirmation_summary_json TEXT NOT NULL DEFAULT '{}'"
                ))
        if insp.has_table("library_hidden_items"):
            hidden_cols = {
                c["name"] for c in insp.get_columns("library_hidden_items")
            }
            if "hide_mode" not in hidden_cols:
                conn.execute(text(
                    "ALTER TABLE library_hidden_items ADD COLUMN "
                    "hide_mode VARCHAR(16) NOT NULL DEFAULT 'permanent'"
                ))
        if insp.has_table("user_activity_logs"):
            activity_cols = {
                c["name"] for c in insp.get_columns("user_activity_logs")
            }
            if "detail_json" not in activity_cols:
                conn.execute(text(
                    "ALTER TABLE user_activity_logs ADD COLUMN detail_json TEXT NULL"
                ))
            if "event_key" not in activity_cols:
                conn.execute(text(
                    "ALTER TABLE user_activity_logs "
                    "ADD COLUMN event_key VARCHAR(180) NULL"
                ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ux_user_activity_event_key "
                "ON user_activity_logs (event_key)"
            ))
        if insp.has_table("agent_automations"):
            automation_cols = {
                c["name"] for c in insp.get_columns("agent_automations")
            }
            if "source_mode" not in automation_cols:
                conn.execute(text(
                    "ALTER TABLE agent_automations ADD COLUMN "
                    "source_mode VARCHAR(16) NOT NULL DEFAULT 'collect'"
                ))
            if "deleted_at" not in automation_cols:
                conn.execute(text(
                    "ALTER TABLE agent_automations ADD COLUMN "
                    "deleted_at TIMESTAMP NULL"
                ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_agent_automations_deleted_at "
                "ON agent_automations (deleted_at)"
            ))
        if insp.has_table("agent_messages"):
            message_cols = {
                c["name"] for c in insp.get_columns("agent_messages")
            }
            if "turn_id" not in message_cols:
                conn.execute(text(
                    "ALTER TABLE agent_messages ADD COLUMN "
                    "turn_id VARCHAR(36) NULL"
                ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_agent_messages_turn_id "
                "ON agent_messages (turn_id)"
            ))
        if insp.has_table("agent_automation_runs"):
            run_cols = {
                c["name"] for c in insp.get_columns("agent_automation_runs")
            }
            if "automation_version" not in run_cols:
                conn.execute(text(
                    "ALTER TABLE agent_automation_runs ADD COLUMN "
                    "automation_version INTEGER NOT NULL DEFAULT 1"
                ))
            if "lease_token" not in run_cols:
                conn.execute(text(
                    "ALTER TABLE agent_automation_runs ADD COLUMN "
                    "lease_token VARCHAR(64) NULL"
                ))
            if "heartbeat_at" not in run_cols:
                conn.execute(text(
                    "ALTER TABLE agent_automation_runs ADD COLUMN "
                    "heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_agent_automation_runs_heartbeat_at "
                "ON agent_automation_runs (heartbeat_at)"
            ))
        if insp.has_table("user_custom_chat_models"):
            custom_model_cols = {
                c["name"] for c in insp.get_columns("user_custom_chat_models")
            }
            if "is_selected" not in custom_model_cols:
                conn.execute(text(
                    "ALTER TABLE user_custom_chat_models ADD COLUMN "
                    "is_selected BOOLEAN NOT NULL DEFAULT FALSE"
                ))
            # 部分唯一索引：每个用户最多一条选中行；其他行不受约束。
            dialect_name = engine.dialect.name
            where_clause = "is_selected" if dialect_name in {"sqlite", "postgresql"} else "TRUE"
            conn.execute(text(
                f"CREATE UNIQUE INDEX IF NOT EXISTS "
                f"uq_user_custom_chat_model_selected "
                f"ON user_custom_chat_models (user_id) WHERE {where_clause}"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_custom_chat_model_user "
                "ON user_custom_chat_models (user_id, created_at)"
            ))
            _promote_legacy_custom_provider(conn)
        if insp.has_table("vision_providers"):
            provider_cols = {
                c["name"] for c in insp.get_columns("vision_providers")
            }
            if "default_model" not in provider_cols:
                conn.execute(text(
                    "ALTER TABLE vision_providers ADD COLUMN "
                    "default_model VARCHAR(160) NOT NULL DEFAULT ''"
                ))
        if insp.has_table("video_analysis_items"):
            item_cols = {
                c["name"] for c in insp.get_columns("video_analysis_items")
            }
            if "cancel_requested" not in item_cols:
                conn.execute(text(
                    "ALTER TABLE video_analysis_items ADD COLUMN "
                    "cancel_requested BOOLEAN NOT NULL DEFAULT FALSE"
                ))
            if "cancel_requested_at" not in item_cols:
                conn.execute(text(
                    "ALTER TABLE video_analysis_items ADD COLUMN "
                    "cancel_requested_at TIMESTAMP NULL"
                ))
            if "failure_cost_micros" not in item_cols:
                conn.execute(text(
                    "ALTER TABLE video_analysis_items ADD COLUMN "
                    "failure_cost_micros BIGINT NOT NULL DEFAULT 0"
                ))


app = create_app()
