"""Plan persistence service — CRUD + stats for dynamic video plans."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.plan import Plan

APP_TIMEZONE = ZoneInfo("Asia/Shanghai")
TASK_PRIORITIES = {"low", "medium", "high"}


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


def _normalize_priority(value: Any) -> str:
    return value if value in TASK_PRIORITIES else "medium"


def _normalize_schedule(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("任务排期格式无效")
    normalized = value.strip()
    try:
        if len(normalized) == 10:
            date.fromisoformat(normalized)
        elif len(normalized) == 16 and normalized[10] == "T":
            datetime.fromisoformat(normalized)
        else:
            raise ValueError
    except ValueError as exc:
        raise ValueError("任务排期必须为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM") from exc
    return normalized


def _normalize_duration(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("预计时长必须为分钟数")
    normalized = int(value)
    if normalized < 1 or normalized > 10080:
        raise ValueError("预计时长必须在 1 到 10080 分钟之间")
    return normalized


def _normalize_frequency(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if len(normalized) > 120:
        raise ValueError("执行频率不能超过 120 个字符")
    return normalized


def _task_state(plan: Plan) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return canonical tasks and days, recovering legacy day-only plans."""
    flat_tasks = _parse_tasks(plan)
    days = _parse_days(plan)
    day_by_task: dict[str, int] = {}
    day_task_by_id: dict[str, dict[str, Any]] = {}

    for day_item in days:
        day_number = day_item.get("day")
        if not isinstance(day_number, int) or day_number < 1:
            continue
        for raw_task in day_item.get("tasks", []):
            if not isinstance(raw_task, dict):
                continue
            task_id = raw_task.get("id")
            if not isinstance(task_id, str) or not task_id:
                continue
            day_by_task[task_id] = day_number
            day_task_by_id[task_id] = raw_task

    canonical: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_task in flat_tasks:
        if not isinstance(raw_task, dict):
            continue
        task_id = raw_task.get("id")
        if not isinstance(task_id, str) or not task_id:
            continue
        merged = {**day_task_by_id.get(task_id, {}), **raw_task}
        if task_id in day_by_task:
            merged["day"] = day_by_task[task_id]
        merged["priority"] = _normalize_priority(merged.get("priority"))
        canonical.append(merged)
        seen.add(task_id)

    for task_id, raw_task in day_task_by_id.items():
        if task_id in seen:
            continue
        recovered = dict(raw_task)
        recovered["day"] = day_by_task[task_id]
        recovered["priority"] = _normalize_priority(recovered.get("priority"))
        canonical.append(recovered)

    return canonical, days


def _sync_task_state(
    plan: Plan,
    tasks: list[dict[str, Any]],
    existing_days: list[dict[str, Any]],
) -> None:
    """Persist canonical tasks to flat and per-day JSON representations."""
    normalized_tasks = [dict(task) for task in tasks]
    for task in normalized_tasks:
        task["priority"] = _normalize_priority(task.get("priority"))

    needs_days = bool(existing_days) or any(
        isinstance(task.get("day"), int) and task["day"] > 0
        for task in normalized_tasks
    )
    if needs_days:
        day_metadata = {
            day_item.get("day"): {
                key: day_item.get(key)
                for key in ("label", "date", "focus")
                if day_item.get(key)
            }
            for day_item in existing_days
            if isinstance(day_item.get("day"), int)
        }
        default_day = max(day_metadata, default=1)
        for task in normalized_tasks:
            day_number = task.get("day")
            if not isinstance(day_number, int) or day_number < 1:
                task["day"] = default_day

        day_numbers = sorted({int(task["day"]) for task in normalized_tasks})
        rebuilt_days = []
        for day_number in day_numbers:
            metadata = day_metadata.get(day_number, {})
            rebuilt_days.append({
                "day": day_number,
                "label": metadata.get("label") or f"第{day_number}天",
                **({"date": metadata["date"]} if metadata.get("date") else {}),
                **({"focus": metadata["focus"]} if metadata.get("focus") else {}),
                "tasks": [
                    dict(task)
                    for task in normalized_tasks
                    if task.get("day") == day_number
                ],
            })
        plan.days_json = _dump_days(rebuilt_days)

    plan.tasks = _dump_tasks(normalized_tasks)


def _sync_completion_status(plan: Plan, tasks: list[dict[str, Any]]) -> None:
    if tasks and all(task.get("done", False) for task in tasks):
        plan.status = "done"
    elif plan.status == "done":
        plan.status = "active"


def _commit_plan(db: Session, plan: Plan) -> Plan:
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return plan


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
    """ISO date string for the product's primary China locale."""
    return datetime.now(APP_TIMEZONE).date().isoformat()


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
        schema_version=2,
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


def _normalized_task_title(value: Any) -> str:
    """Conservative task identity fallback used for Agent plan revisions."""
    return "".join(str(value or "").lower().split()).strip("，。！？、,.!?")


def _reconcile_agent_tasks(
    generated_tasks: list[dict[str, Any]],
    existing_tasks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    done_by_id = {
        str(task.get("id")): True
        for task in existing_tasks
        if task.get("id") and task.get("done") is True
    }
    done_by_title = {
        _normalized_task_title(task.get("title")): True
        for task in existing_tasks
        if task.get("done") is True and _normalized_task_title(task.get("title"))
    }
    reconciled: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, source in enumerate(generated_tasks, start=1):
        task = dict(source)
        task_id = str(task.get("id") or "").strip()[:80] or f"t-{index:03d}"
        if task_id in seen_ids:
            task_id = f"t-{uuid.uuid4().hex[:8]}"
        seen_ids.add(task_id)
        task["id"] = task_id
        normalized_title = _normalized_task_title(task.get("title"))
        task["done"] = bool(
            done_by_id.get(task_id)
            or (normalized_title and done_by_title.get(normalized_title))
        )
        task["priority"] = _normalize_priority(task.get("priority"))
        reconciled.append(task)
    return reconciled


def upsert_agent_plan(
    db: Session,
    *,
    note_id: str,
    title: str,
    fields: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    days: list[dict[str, Any]],
    total_days: int,
    user_id: str,
) -> tuple[Plan, bool]:
    """Create or replace one note-linked plan with safe progress reconciliation."""
    if not tasks:
        raise ValueError("计划至少需要一个可执行任务")
    clean_title = title.strip()[:256]
    if not clean_title:
        raise ValueError("计划标题不能为空")

    existing = get_plan_by_note(db, note_id, user_id=user_id)
    existing_tasks = _task_state(existing)[0] if existing else []
    reconciled = _reconcile_agent_tasks(tasks, existing_tasks)

    if existing is None:
        plan = Plan(
            id=str(uuid.uuid4()),
            user_id=user_id,
            note_id=note_id,
            title=clean_title,
            schema_version=2,
            total_days=max(0, int(total_days or 0)),
            fields=json.dumps(fields or [], ensure_ascii=False),
            tasks="[]",
            days_json="[]",
            status="active",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(plan)
        created = True
    else:
        plan = existing
        plan.title = clean_title
        plan.schema_version = 2
        plan.total_days = max(0, int(total_days or 0))
        plan.fields = json.dumps(fields or [], ensure_ascii=False)
        created = False

    _sync_task_state(plan, reconciled, days or [])
    _sync_completion_status(plan, reconciled)
    return _commit_plan(db, plan), created


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
# Stats and execution overview
# ---------------------------------------------------------------------------

def _focus_sort_key(item: dict[str, Any]) -> tuple[int, str, str]:
    priority_order = {"high": 0, "medium": 1, "low": 2}
    return (
        priority_order.get(item.get("priority"), 1),
        item.get("scheduled_at") or "9999-12-31",
        item.get("title") or "",
    )


def get_plan_overview(
    db: Session,
    user_id: str = "",
    focus_limit: int = 8,
) -> dict[str, Any]:
    """Aggregate the current user's active execution workload."""
    q = db.query(Plan).filter(Plan.status != "done")
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    plans = q.all()

    today_value = _get_today()
    today: list[dict[str, Any]] = []
    overdue: list[dict[str, Any]] = []
    upcoming: list[dict[str, Any]] = []

    for plan in plans:
        current_day = _current_day_for_plan(plan)
        tasks, _ = _task_state(plan)
        for task in tasks:
            if task.get("done", False):
                continue

            scheduled_raw = task.get("scheduled_at")
            scheduled_at = scheduled_raw.strip() if isinstance(scheduled_raw, str) else None
            scheduled_date_value = scheduled_at[:10] if scheduled_at else None
            try:
                scheduled_date = date.fromisoformat(scheduled_date_value) if scheduled_date_value else None
            except ValueError:
                scheduled_date = None

            item = {
                "plan_id": plan.id,
                "plan_title": plan.title,
                "task_id": task.get("id"),
                "title": task.get("title") or "未命名任务",
                "day": task.get("day"),
                "scheduled_at": scheduled_at,
                "duration_minutes": task.get("duration_minutes"),
                "frequency": task.get("frequency"),
                "priority": _normalize_priority(task.get("priority")),
            }
            if scheduled_date and scheduled_date_value < today_value:
                overdue.append(item)
            elif scheduled_date_value == today_value or (
                not scheduled_date and task.get("day") == current_day
            ):
                today.append(item)
            else:
                upcoming.append(item)

    today.sort(key=_focus_sort_key)
    overdue.sort(key=_focus_sort_key)
    upcoming.sort(key=_focus_sort_key)
    open_tasks = len(today) + len(overdue) + len(upcoming)
    return {
        "summary": {
            "active_plans": len(plans),
            "open_tasks": open_tasks,
            "due_today": len(today),
            "overdue_tasks": len(overdue),
        },
        "today": today[:focus_limit],
        "overdue": overdue[:focus_limit],
        "upcoming": upcoming[:focus_limit],
    }


def get_plan_stats(db: Session, user_id: str = "") -> dict[str, int]:
    """Return compact badge-compatible statistics."""
    return get_plan_overview(db, user_id=user_id, focus_limit=0)["summary"]


# ---------------------------------------------------------------------------
# Task mutations
# ---------------------------------------------------------------------------

def toggle_task(db: Session, plan_id: str, task_id: str, user_id: str = "") -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    tasks, days = _task_state(plan)
    for task in tasks:
        if task.get("id") == task_id:
            task["done"] = not task.get("done", False)
            break
    else:
        return None  # task not found

    _sync_task_state(plan, tasks, days)
    _sync_completion_status(plan, tasks)
    return _commit_plan(db, plan)


def add_task(
    db: Session,
    plan_id: str,
    title: str,
    day: int | None = None,
    scheduled_at: str | None = None,
    reminder_at: str | None = None,
    duration_minutes: int | None = None,
    frequency: str | None = None,
    priority: str = "medium",
    user_id: str = "",
) -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    new_task: dict[str, Any] = {
        "id": f"t-{uuid.uuid4().hex[:8]}",
        "title": title,
        "done": False,
        "priority": _normalize_priority(priority),
    }
    if day is not None:
        new_task["day"] = day
    if scheduled_at:
        new_task["scheduled_at"] = _normalize_schedule(scheduled_at)
    if reminder_at:
        new_task["reminder_at"] = reminder_at
    normalized_duration = _normalize_duration(duration_minutes)
    if normalized_duration is not None:
        new_task["duration_minutes"] = normalized_duration
    normalized_frequency = _normalize_frequency(frequency)
    if normalized_frequency:
        new_task["frequency"] = normalized_frequency

    tasks, days = _task_state(plan)
    tasks.append(new_task)

    _sync_task_state(plan, tasks, days)
    if plan.status == "done":
        plan.status = "active"
    return _commit_plan(db, plan)


def update_plan(
    db: Session,
    plan_id: str,
    updates: dict[str, Any],
    user_id: str = "",
) -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    if "title" in updates:
        title = str(updates["title"]).strip()
        if not title:
            raise ValueError("计划标题不能为空")
        plan.title = title
    if "status" in updates:
        status = updates["status"]
        if status not in {"active", "done"}:
            raise ValueError("计划状态无效")
        plan.status = status
    return _commit_plan(db, plan)


def update_task(
    db: Session,
    plan_id: str,
    task_id: str,
    updates: dict[str, Any],
    user_id: str = "",
) -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    tasks, days = _task_state(plan)
    task = next((item for item in tasks if item.get("id") == task_id), None)
    if task is None:
        return None

    if "title" in updates:
        title = str(updates["title"]).strip()
        if not title:
            raise ValueError("任务标题不能为空")
        task["title"] = title
    if "day" in updates:
        day_number = updates["day"]
        if not isinstance(day_number, int) or day_number < 1:
            raise ValueError("任务天数必须为正整数")
        task["day"] = day_number
    if "scheduled_at" in updates:
        scheduled_at = _normalize_schedule(updates["scheduled_at"])
        if scheduled_at:
            task["scheduled_at"] = scheduled_at
        else:
            task.pop("scheduled_at", None)
    if "reminder_at" in updates:
        reminder_at = updates["reminder_at"]
        if reminder_at:
            task["reminder_at"] = str(reminder_at)
        else:
            task.pop("reminder_at", None)
    if "duration_minutes" in updates:
        duration_minutes = _normalize_duration(updates["duration_minutes"])
        if duration_minutes is not None:
            task["duration_minutes"] = duration_minutes
        else:
            task.pop("duration_minutes", None)
    if "frequency" in updates:
        frequency = _normalize_frequency(updates["frequency"])
        if frequency:
            task["frequency"] = frequency
        else:
            task.pop("frequency", None)
    if "priority" in updates:
        priority = updates["priority"]
        if priority not in TASK_PRIORITIES:
            raise ValueError("任务优先级无效")
        task["priority"] = priority

    _sync_task_state(plan, tasks, days)
    return _commit_plan(db, plan)


def delete_task(db: Session, plan_id: str, task_id: str, user_id: str = "") -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None

    tasks, days = _task_state(plan)
    new_tasks = [t for t in tasks if t.get("id") != task_id]
    if len(new_tasks) == len(tasks):
        return None  # nothing deleted

    _sync_task_state(plan, new_tasks, days)
    if not new_tasks and plan.status == "done":
        plan.status = "active"
    return _commit_plan(db, plan)


def delete_plan(db: Session, plan_id: str, user_id: str = "") -> bool:
    """Delete a plan by ID. Returns True if deleted, False if not found."""
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return False
    db.delete(plan)
    db.commit()
    return True
