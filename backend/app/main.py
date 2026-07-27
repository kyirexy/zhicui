"""
VideoCapsule FastAPI application entry point.
"""

import os
import time
import traceback

from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.database import Base, engine
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
from app.core.request_context import reset_request_context, set_request_context
from app.services import activity_service, auth_service, error_log_service


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
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True if allowed_origins != ["*"] else False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def request_log_context(request: Request) -> dict:
        route = request.scope.get("route")
        route_path = getattr(route, "path", request.url.path)
        return {
            "method": request.method,
            "path": route_path,
            "user_id": getattr(request.state, "observability_user_id", None),
            "ip": request.client.host if request.client else None,
        }

    @app.exception_handler(HTTPException)
    async def logged_http_exception(request: Request, exc: HTTPException):
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
        error_log_service.record_error_safely(
            source="validation",
            severity="warning",
            error_type=type(exc).__name__,
            message="请求参数校验失败: " + ", ".join(safe_issues),
            status_code=422,
            **request_log_context(request),
        )
        return await request_validation_exception_handler(request, exc)

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

    # Create database tables on startup
    @app.on_event("startup")
    def on_startup() -> None:
        Base.metadata.create_all(bind=engine)
        _migrate_db()

    return app


def _migrate_db() -> None:
    """Add username/is_admin columns to existing users table (SQLite ALTER TABLE)."""
    insp = inspect(engine)
    if not insp.has_table("users"):
        return
    cols = {c["name"] for c in insp.get_columns("users")}
    with engine.begin() as conn:
        if "username" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN username VARCHAR NULL"))
        if "is_admin" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE"))


app = create_app()
