"""
VideoCapsule FastAPI application entry point.
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.database import Base, engine
from sqlalchemy import inspect, text

# Import all models so they are registered with Base.metadata before create_all.
from app.models.note import Note  # noqa: F401
from app.models.plan import Plan  # noqa: F401
from app.models.user import User  # noqa: F401


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
