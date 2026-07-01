"""Plan ORM model — dynamic plans generated from plan-type video cards."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_uuid
    )

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    note_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True
    )

    title: Mapped[str] = mapped_column(String(256), nullable=False)

    # Integer version of the plan schema — bump when the shape changes.
    schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Estimated total days (derived from plan duration). 0 = unknown.
    total_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # JSON array of dynamic field definitions. Example:
    #   [{"name":"duration","label":"周期","type":"text"},
    #    {"name":"checkpoints","label":"里程碑","type":"checklist"}]
    fields: Mapped[str | None] = mapped_column(Text, nullable=True)

    # JSON array of day objects:
    #   [{"day":1,"label":"第一天","tasks":[...]}, {"day":2,...}]
    days_json: Mapped[str | None] = mapped_column(Text, nullable=True, default="[]")

    # JSON array of task objects (flat, for API operations).
    tasks: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default="active", nullable=False
    )  # draft | active | done

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        import json

        fields_data: list = []
        if self.fields:
            try:
                fields_data = json.loads(self.fields)
            except (json.JSONDecodeError, TypeError):
                fields_data = []

        days_data: list = []
        if self.days_json:
            try:
                days_data = json.loads(self.days_json)
            except (json.JSONDecodeError, TypeError):
                days_data = []

        tasks_data: list = []
        if self.tasks:
            try:
                tasks_data = json.loads(self.tasks)
            except (json.JSONDecodeError, TypeError):
                tasks_data = []

        return {
            "id": self.id,
            "note_id": self.note_id,
            "title": self.title,
            "schema_version": self.schema_version,
            "fields": fields_data,
            "tasks": tasks_data,
            "days": days_data,
            "status": self.status,
            "total_days": self.total_days,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
