"""Plan persistence service — CRUD + stats for dynamic video plans."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone, date
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.plan import Plan


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_tasks(plan: Plan) -> list[dict]:
    if not plan.tasks:
        return []
    try:
        return json.loads(plan.tasks)
    except (json.JSONDecodeError, TypeError):
        return []


def _dump_tasks(tasks: list[dict]) -> str:
    return json.dumps(tasks, ensure_ascii=False)


def _parse_days(plan: Plan) -> list[dict]:
    """Decode the per-day structure (the source of truth for rendering)."""
    if not plan.days_json:
        return []
    try:
        return json.loads(plan.days_json)
    except (json.JSONDecodeError, TypeError):
        return []


def _dump_days(days: list[dict]) -> str:
    return json.dumps(days, ensure_ascii=False)


def _current_day_for_plan(plan: Plan) -> int:
    """1-based "today is day N" derived from created_at.

    Mirrors the frontend ``getPlanCurrentDay`` in ``frontend/src/lib/types.ts``:
    ``max(1, floor((now - created_at) / 86400000) + 1)``. Timezone-agnostic
    because it works off absolute millisecond differences.
    """
    if not plan.created_at:
        return 1
    start = plan.created_at
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    diff_days = (now - start).days  # floored for positive deltas
    return max(1, diff_days + 1)


def _get_today() -> str:
    """ISO date string for today in local-ish UTC (midnight)."""
    return datetime.now(timezone.utc).date().isoformat()


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------

def create_plan(
    db: Session,
    note_id: str | None,
    title: str,
    fields: list[dict] | None = None,
    tasks: list[dict] | None = None,
    status: str = "active",
    total_days: int = 0,
    days: list[dict] | None = None,
    user_id: str = "",
) -> Plan:
    """Persist a new plan (called after AI extraction for plan-type videos)."""
    plan = Plan(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=note_id,
        title=title,
        schema_version=1,
        total_days=total_days,
        fields=json.dumps(fields or [], ensure_ascii=False) if fields else "[]",
        tasks=json.dumps(tasks or [], ensure_ascii=False) if tasks else "[]",
        days_json=json.dumps(days or [], ensure_ascii=False) if days else "[]",
        status=status,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return plan


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def get_plan(db: Session, plan_id: str, user_id: str = "") -> Plan | None:
    q = db.query(Plan).filter(Plan.id == plan_id)
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    return q.first()


def get_plan_by_note(db: Session, note_id: str, user_id: str = "") -> Plan | None:
    q = db.query(Plan).filter(Plan.note_id == note_id)
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    return q.first()


def list_plans(
    db: Session,
    page: int = 1,
    per_page: int = 20,
    user_id: str = "",
) -> tuple[list[Plan], int]:
    per_page = min(per_page, 100)
    offset = (max(page, 1) - 1) * per_page

    q_total = db.query(func.count(Plan.id))
    if user_id:
        q_total = q_total.filter(Plan.user_id == user_id)
    total: int = q_total.scalar() or 0

    q = db.query(Plan).order_by(Plan.created_at.desc())
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    plans = q.offset(offset).limit(per_page).all()
    return plans, total


# ---------------------------------------------------------------------------
# Stats (badge)
# ---------------------------------------------------------------------------

def get_plan_stats(db: Session, user_id: str = "") -> dict[str, int]:
    """Return {open_tasks, due_today} for the BottomTabBar badge."""
    q = db.query(Plan).filter(Plan.status != "done")
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    plans = q.all()

    open_tasks = 0
    due_today = 0

    for plan in plans:
        current_day = _current_day_for_plan(plan)
        days = _parse_days(plan)
        if days:
            for d in days:
                is_current = d.get("day") == current_day
                for t in d.get("tasks", []):
                    if t.get("done", False):
                        continue
                    open_tasks += 1
                    if is_current:
                        due_today += 1
                        continue
                    sched = t.get("scheduled_at")
                    if sched and sched[:10] == _get_today():
                        due_today += 1
        else:
            # Legacy plans with only a flat task list and no day structure.
            for t in _parse_tasks(plan):
                if t.get("done", False):
                    continue
                open_tasks += 1
                sched = t.get("scheduled_at")
                if sched and sched[:10] == _get_today():
                    due_today += 1

    return {"open_tasks": open_tasks, "due_today": due_today}


# ---------------------------------------------------------------------------
# Task mutations
# ---------------------------------------------------------------------------

def toggle_task(db: Session, plan_id: str, task_id: str, user_id: str = "") -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    tasks = _parse_tasks(plan)
    days = _parse_days(plan)

    toggled = False
    for t in tasks:
        if t.get("id") == task_id:
            t["done"] = not t.get("done", False)
            toggled = True
            break

    if not toggled:
        return None  # task not found

    # Keep the per-day structure in sync — it is what the UI renders.
    if days:
        for d in days:
            for t in d.get("tasks", []):
                if t.get("id") == task_id:
                    t["done"] = not t.get("done", False)
        plan.days_json = _dump_days(days)

    plan.tasks = _dump_tasks(tasks)
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return plan


def add_task(
    db: Session,
    plan_id: str,
    title: str,
    day: int | None = None,
    scheduled_at: str | None = None,
    reminder_at: str | None = None,
    user_id: str = "",
) -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    new_task: dict[str, Any] = {
        "id": f"t-{uuid.uuid4().hex[:8]}",
        "title": title,
        "done": False,
    }
    if scheduled_at:
        new_task["scheduled_at"] = scheduled_at
    if reminder_at:
        new_task["reminder_at"] = reminder_at

    # Append to the flat task list.
    tasks = _parse_tasks(plan)
    tasks.append(new_task)
    plan.tasks = _dump_tasks(tasks)

    # Attach to the requested day in the per-day structure (the render source).
    days = _parse_days(plan)
    if days:
        if day is None:
            day = days[-1].get("day", 1)
        target = next((d for d in days if d.get("day") == day), None)
        if target is None:
            target = {"day": day, "label": f"第{day}天", "tasks": []}
            days.append(target)
            days.sort(key=lambda d: d.get("day", 0))
        target.setdefault("tasks", []).append(new_task)
        plan.days_json = _dump_days(days)

    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return plan


def delete_task(db: Session, plan_id: str, task_id: str, user_id: str = "") -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    tasks = _parse_tasks(plan)
    new_tasks = [t for t in tasks if t.get("id") != task_id]
    if len(new_tasks) == len(tasks):
        return None  # nothing deleted

    days = _parse_days(plan)
    if days:
        for d in days:
            d["tasks"] = [t for t in d.get("tasks", []) if t.get("id") != task_id]
        plan.days_json = _dump_days(days)

    plan.tasks = _dump_tasks(new_tasks)
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return plan


def delete_plan(db: Session, plan_id: str) -> bool:
    """Delete a plan by ID. Returns True if deleted, False if not found."""
    plan = get_plan(db, plan_id)
    if plan is None:
        return False
    db.delete(plan)
    db.commit()
    return True
