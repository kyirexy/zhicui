"""Persistence for the public Agent Action interface.

The public Agent protocol deliberately has its own records instead of
overloading the private video-research Agent tables.  Every row is scoped to a
user and every secret is stored as a one-way digest.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


def _json(raw: str | None, fallback: Any) -> Any:
    try:
        return json.loads(raw or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


class AgentCredential(Base):
    __tablename__ = "agent_credentials"
    __table_args__ = (
        Index("ix_agent_credentials_user_kind", "user_id", "kind", "created_at"),
        Index("ix_agent_credentials_expiry", "expires_at", "revoked_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="知萃 Agent")
    client_type: Mapped[str] = mapped_column(String(32), nullable=False, default="cli")
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    token_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    refresh_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    # Keep only the immediately previous one-way digest so a real refresh
    # replay can revoke the credential family without letting an arbitrary
    # malformed token revoke a credential whose public id is known.
    previous_refresh_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refresh_generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    scopes_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    refresh_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    @property
    def scopes(self) -> list[str]:
        value = _json(self.scopes_json, [])
        return sorted({str(item) for item in value}) if isinstance(value, list) else []

    def to_public_dict(self) -> dict[str, Any]:
        def iso(value: datetime | None) -> str | None:
            return value.isoformat() if value else None

        return {
            "id": self.id,
            "type": self.kind,
            "name": self.name,
            "client_type": self.client_type,
            "token_prefix": self.token_prefix,
            "scopes": self.scopes,
            "expires_at": iso(self.expires_at),
            "created_at": iso(self.created_at),
            "updated_at": iso(self.updated_at),
            "last_used_at": iso(self.last_used_at),
            "revoked_at": iso(self.revoked_at),
        }


class AgentDeviceAuthorization(Base):
    __tablename__ = "agent_device_authorizations"
    __table_args__ = (
        Index("ix_agent_device_authorizations_expiry", "status", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    device_code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    user_code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    user_code_hint: Mapped[str] = mapped_column(String(16), nullable=False)
    requested_scopes_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    client_name: Mapped[str] = mapped_column(String(120), nullable=False, default="知萃 CLI")
    client_type: Mapped[str] = mapped_column(String(32), nullable=False, default="cli")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    approved_user_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    credential_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("agent_credentials.id", ondelete="SET NULL"), index=True
    )
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)

    @property
    def requested_scopes(self) -> list[str]:
        value = _json(self.requested_scopes_json, [])
        return sorted({str(item) for item in value}) if isinstance(value, list) else []


class ProductActionRun(Base):
    __tablename__ = "product_action_runs"
    __table_args__ = (
        Index("ix_product_action_runs_user_updated", "user_id", "updated_at"),
        Index("ix_product_action_runs_action_status", "action_id", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    credential_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("agent_credentials.id", ondelete="SET NULL"), index=True
    )
    action_id: Mapped[str] = mapped_column(String(120), nullable=False)
    action_version: Mapped[str] = mapped_column(String(24), nullable=False, default="1.0.0")
    run_type: Mapped[str] = mapped_column(String(24), nullable=False)
    execution_location: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    input_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    output_json: Mapped[str | None] = mapped_column(Text)
    error_json: Mapped[str | None] = mapped_column(Text)
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    next_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    idempotency_key: Mapped[str | None] = mapped_column(String(160), index=True)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    external_type: Mapped[str | None] = mapped_column(String(40), index=True)
    external_id: Mapped[str | None] = mapped_column(String(64), index=True)
    external_event_cursor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lease_token: Mapped[str | None] = mapped_column(String(32), index=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow, index=True
    )

    @property
    def output(self) -> Any:
        return _json(self.output_json, None)

    @property
    def error(self) -> dict[str, Any] | None:
        value = _json(self.error_json, None)
        return value if isinstance(value, dict) else None


class ProductActionEvent(Base):
    __tablename__ = "product_action_events"
    __table_args__ = (
        UniqueConstraint("run_id", "sequence", name="uq_product_action_event_sequence"),
        # NULL permits progress rows; the literal 'terminal' may occur once.
        UniqueConstraint("run_id", "terminal_key", name="uq_product_action_event_terminal"),
        Index("ix_product_action_events_user_run_seq", "user_id", "run_id", "sequence"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("product_action_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    data_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    terminal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    terminal_key: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)

    @property
    def data(self) -> dict[str, Any]:
        value = _json(self.data_json, {})
        return value if isinstance(value, dict) else {}


class ProductActionIdempotency(Base):
    __tablename__ = "product_action_idempotency"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "credential_key", "action_id", "idempotency_key",
            name="uq_product_action_idempotency_key",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    credential_key: Mapped[str] = mapped_column(String(40), nullable=False)
    action_id: Mapped[str] = mapped_column(String(120), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("product_action_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)


class ProductActionConfirmation(Base):
    __tablename__ = "product_action_confirmations"
    __table_args__ = (
        Index("ix_product_action_confirmations_user_status", "user_id", "status", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    credential_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("agent_credentials.id", ondelete="CASCADE"))
    action_id: Mapped[str] = mapped_column(String(120), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    confirmation_summary_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)

    @property
    def confirmation_summary(self) -> dict[str, Any]:
        value = _json(self.confirmation_summary_json, {})
        return value if isinstance(value, dict) else {}


class ProductActionAudit(Base):
    __tablename__ = "product_action_audits"
    __table_args__ = (
        Index("ix_product_action_audits_user_created", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    credential_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("agent_credentials.id", ondelete="SET NULL"))
    run_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("product_action_runs.id", ondelete="SET NULL"))
    action_id: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    error_code: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    metadata_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow)


class ProductActionRateWindow(Base):
    __tablename__ = "product_action_rate_windows"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "credential_key", "action_id", "window_started_at",
            name="uq_product_action_rate_window",
        ),
        Index("ix_product_action_rate_window_expiry", "window_started_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    credential_key: Mapped[str] = mapped_column(String(40), nullable=False)
    action_id: Mapped[str] = mapped_column(String(120), nullable=False)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow)
