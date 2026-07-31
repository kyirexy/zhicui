"""Daily video digest automations and immutable run records."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


def _json_dict(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return aware.isoformat().replace("+00:00", "Z")


class AgentAutomation(Base):
    __tablename__ = "agent_automations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(
        String(160), default="昨日视频摘要", nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    schedule_time: Mapped[str] = mapped_column(
        String(5), default="08:00", nullable=False
    )
    timezone: Mapped[str] = mapped_column(
        String(64), default="Asia/Shanghai", nullable=False
    )
    source_scope: Mapped[str] = mapped_column(
        String(32), default="yesterday", nullable=False
    )
    source_mode: Mapped[str] = mapped_column(
        String(16), default="collect", nullable=False
    )
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    recipient_email: Mapped[str] = mapped_column(String(256), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    lease_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": bool(self.enabled),
            "schedule_time": self.schedule_time,
            "timezone": self.timezone,
            "source_scope": self.source_scope,
            "source_mode": self.source_mode,
            "instruction": self.instruction,
            "recipient_email": self.recipient_email,
            "version": self.version,
            "next_run_at": _iso_utc(self.next_run_at),
            "last_run_at": _iso_utc(self.last_run_at),
            "created_at": _iso_utc(self.created_at),
            "updated_at": _iso_utc(self.updated_at),
        }


class AgentAutomationRun(Base):
    __tablename__ = "agent_automation_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    automation_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("agent_automations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    trigger: Mapped[str] = mapped_column(
        String(16), default="scheduled", nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(
        String(180), unique=True, nullable=False, index=True
    )
    automation_version: Mapped[int] = mapped_column(
        Integer, default=1, nullable=False
    )
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(
        String(24), default="running", nullable=False, index=True
    )
    source_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    result_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivery_status: Mapped[str] = mapped_column(
        String(24), default="skipped", nullable=False
    )
    delivery_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    agent_thread_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("agent_threads.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    scheduled_for: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False, index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False, index=True
    )

    @property
    def result(self) -> dict[str, Any]:
        return _json_dict(self.result_json)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "automation_id": self.automation_id,
            "trigger": self.trigger,
            "idempotency_key": self.idempotency_key,
            "automation_version": self.automation_version,
            "status": self.status,
            "source_count": self.source_count,
            "result_text": self.result_text,
            "result": self.result,
            "delivery_status": self.delivery_status,
            "delivery_error": self.delivery_error or "",
            "agent_thread_id": self.agent_thread_id,
            "scheduled_for": _iso_utc(self.scheduled_for),
            "started_at": _iso_utc(self.started_at),
            "heartbeat_at": _iso_utc(self.heartbeat_at),
            "finished_at": _iso_utc(self.finished_at),
            "created_at": _iso_utc(self.created_at),
        }
