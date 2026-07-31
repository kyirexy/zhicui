"""Persistent video-grounded Agent conversations."""

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


def _json_list(raw: str | None) -> list[Any]:
    try:
        value = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    return value if isinstance(value, list) else []


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


class AgentThread(Base):
    __tablename__ = "agent_threads"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    scope_type: Mapped[str] = mapped_column(
        String(32), default="all", nullable=False
    )
    scope_label: Mapped[str] = mapped_column(String(128), nullable=False)
    source_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    source_available_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    source_selected_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    source_truncated: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(24), default="ready", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utcnow,
        onupdate=_utcnow,
        nullable=False,
        index=True,
    )

    @property
    def source_ids(self) -> list[str]:
        return [
            str(item)
            for item in _json_list(self.source_ids_json)
            if str(item).strip()
        ]

    def to_dict(self, *, include_source_ids: bool = True) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "scope_type": self.scope_type,
            "scope_label": self.scope_label,
            "source_available_count": self.source_available_count,
            "source_selected_count": self.source_selected_count,
            "source_truncated": bool(self.source_truncated),
            "status": self.status,
            "created_at": _iso_utc(self.created_at),
            "updated_at": _iso_utc(self.updated_at),
        }
        if include_source_ids:
            data["source_ids"] = self.source_ids
        return data


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    thread_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("agent_threads.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    turn_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False, index=True
    )

    @property
    def result(self) -> dict[str, Any]:
        return _json_dict(self.result_json)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "role": self.role,
            "content": self.content,
            "result": self.result,
            "created_at": _iso_utc(self.created_at),
        }
