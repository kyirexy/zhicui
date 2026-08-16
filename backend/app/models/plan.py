"""Plan ORM model — dynamic plans generated from plan-type video cards."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, Integer, String, Text, ForeignKey
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

    # China-local calendar start. Nullable keeps legacy rows compatible; the
    # service falls back to the created_at date when absent.
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # UTC completion time for truthful weekly review. Reopening clears it.
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

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

        # Old plans may only have per-day tasks, and old task JSON has no
        # stable position. Normalize the response without mutating the row so
        # legacy data remains immediately usable by the rebuilt workspace.
        day_tasks: dict[str, tuple[int, dict]] = {}
        for day in days_data:
            if not isinstance(day, dict) or not isinstance(day.get("day"), int):
                continue
            for task in day.get("tasks", []):
                if isinstance(task, dict) and task.get("id"):
                    day_tasks[str(task["id"])] = (int(day["day"]), task)
        normalized_tasks: list[dict] = []
        seen: set[str] = set()
        for task in tasks_data:
            if not isinstance(task, dict) or not task.get("id"):
                continue
            task_id = str(task["id"])
            day_number, day_task = day_tasks.get(task_id, (None, {}))
            merged = {**day_task, **task}
            if day_number is not None:
                merged["day"] = day_number
            normalized_tasks.append(merged)
            seen.add(task_id)
        for task_id, (day_number, task) in day_tasks.items():
            if task_id not in seen:
                normalized_tasks.append({**task, "day": day_number})
        normalized_tasks.sort(
            key=lambda task: task.get("position")
            if isinstance(task.get("position"), int)
            else 10**9
        )
        for position, task in enumerate(normalized_tasks):
            task["position"] = position
            task["done"] = bool(task.get("done", False))
            task["priority"] = (
                task.get("priority")
                if task.get("priority") in {"low", "medium", "high"}
                else "medium"
            )
            if not task["done"]:
                task.pop("completed_at", None)
        if days_data or any(isinstance(task.get("day"), int) for task in normalized_tasks):
            day_meta = {
                int(day["day"]): day
                for day in days_data
                if isinstance(day, dict) and isinstance(day.get("day"), int)
            }
            grouped: dict[int, list[dict]] = {}
            for task in normalized_tasks:
                day_number = task.get("day") if isinstance(task.get("day"), int) else 1
                grouped.setdefault(max(1, int(day_number)), []).append(dict(task))
            days_data = [
                {
                    "day": day_number,
                    "label": day_meta.get(day_number, {}).get("label") or f"第{day_number}天",
                    **(
                        {"date": day_meta[day_number]["date"]}
                        if day_meta.get(day_number, {}).get("date")
                        else {}
                    ),
                    **(
                        {"focus": day_meta[day_number]["focus"]}
                        if day_meta.get(day_number, {}).get("focus")
                        else {}
                    ),
                    "tasks": grouped[day_number],
                }
                for day_number in sorted(grouped)
            ]
        tasks_data = normalized_tasks

        return {
            "id": self.id,
            "note_id": self.note_id,
            "title": self.title,
            "schema_version": self.schema_version,
            "fields": fields_data,
            "tasks": tasks_data,
            "days": days_data,
            "status": self.status,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "total_days": self.total_days,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
