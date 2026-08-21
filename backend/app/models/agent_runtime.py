"""Durable execution records for the video research Agent."""

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


def _uuid() -> str:
    return str(uuid.uuid4())


def _json(raw: str | None, fallback: Any) -> Any:
    try:
        return json.loads(raw or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class AgentTurn(Base):
    __tablename__ = "agent_turns"
    __table_args__ = (
        UniqueConstraint(
            "thread_id", "client_turn_id", name="uq_agent_turn_client_id"
        ),
        Index("ix_agent_turn_due", "status", "lease_expires_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    thread_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_threads.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    client_turn_id: Mapped[str] = mapped_column(String(80), nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    requested_mode: Mapped[str] = mapped_column(String(16), default="auto", nullable=False)
    resolved_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    output_style: Mapped[str] = mapped_column(String(24), default="answer", nullable=False)
    custom_instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    web_scope: Mapped[str] = mapped_column(String(24), default="video_only", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="queued", nullable=False)
    phase: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_event_seq: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source_total_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    scanned_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    mapped_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    deep_read_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_source_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    claim_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    user_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assistant_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow,
        nullable=False, index=True,
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "thread_id": self.thread_id,
            "client_turn_id": self.client_turn_id,
            "status": self.status,
            "phase": self.phase,
            "requested_mode": self.requested_mode,
            "resolved_mode": self.resolved_mode,
            "output_style": self.output_style,
            "web_scope": self.web_scope,
            "attempt_count": self.attempt_count,
            "cancellation_requested": bool(self.cancellation_requested),
            "source_total_count": self.source_total_count,
            "scanned_count": self.scanned_count,
            "mapped_count": self.mapped_count,
            "deep_read_count": self.deep_read_count,
            "failed_source_count": self.failed_source_count,
            "claim_count": self.claim_count,
            "evidence_count": self.evidence_count,
            "user_message_id": self.user_message_id,
            "assistant_message_id": self.assistant_message_id,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "last_event_seq": max(0, self.next_event_seq - 1),
            "created_at": _iso(self.created_at),
            "started_at": _iso(self.started_at),
            "completed_at": _iso(self.completed_at),
            "updated_at": _iso(self.updated_at),
        }


class AgentEvent(Base):
    __tablename__ = "agent_events"
    __table_args__ = (
        UniqueConstraint("turn_id", "seq", name="uq_agent_event_turn_seq"),
        Index("ix_agent_event_thread_seq", "thread_id", "turn_id", "seq"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    turn_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    thread_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_threads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    phase: Mapped[str] = mapped_column(String(32), nullable=False)
    message: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    @property
    def payload(self) -> dict[str, Any]:
        value = _json(self.payload_json, {})
        return value if isinstance(value, dict) else {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "turn_id": self.turn_id,
            "seq": self.seq,
            "type": self.event_type,
            "phase": self.phase,
            "message": self.message,
            "payload": self.payload,
            "created_at": _iso(self.created_at),
        }


class AgentTurnSource(Base):
    __tablename__ = "agent_turn_sources"
    __table_args__ = (
        UniqueConstraint("turn_id", "note_id", name="uq_agent_turn_source_note"),
        Index("ix_agent_turn_source_order", "turn_id", "position"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    turn_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_turns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    note_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title_snapshot: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    transcript_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    scanned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    mapped: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deep_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    failed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    failure_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class AgentMemoryCheckpoint(Base):
    __tablename__ = "agent_memory_checkpoints"
    __table_args__ = (
        Index("ix_agent_memory_thread_created", "thread_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    thread_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("agent_threads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    through_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    summary_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    estimated_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    @property
    def summary(self) -> dict[str, Any]:
        value = _json(self.summary_json, {})
        return value if isinstance(value, dict) else {}
