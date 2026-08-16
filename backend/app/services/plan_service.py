"""Plan persistence service — CRUD + stats for dynamic video plans."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.plan import Plan

APP_TIMEZONE = ZoneInfo("Asia/Shanghai")
TASK_PRIORITIES = {"low", "medium", "high"}


class PlanConflictError(ValueError):
    """Raised when a coaching preview targets a plan that has since changed."""


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


def _normalize_start_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        raise ValueError("计划开始日期格式无效")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError("计划开始日期必须为 YYYY-MM-DD") from exc


def _normalize_total_days(value: Any) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("计划周期必须为天数")
    normalized = int(value)
    if normalized < 0 or normalized > 3650:
        raise ValueError("计划周期必须在 0 到 3650 天之间")
    return normalized


def _normalize_task_fields(task: dict[str, Any], position: int) -> dict[str, Any]:
    normalized = dict(task)
    normalized["priority"] = _normalize_priority(normalized.get("priority"))
    normalized["position"] = position
    normalized["done"] = bool(normalized.get("done", False))
    if not normalized["done"]:
        normalized.pop("completed_at", None)
    focus_date = normalized.get("focus_date")
    focus_order = normalized.get("focus_order")
    try:
        valid_focus_date = bool(focus_date and date.fromisoformat(str(focus_date)))
    except ValueError:
        valid_focus_date = False
    if not valid_focus_date or not isinstance(focus_order, int) or focus_order < 1:
        normalized.pop("focus_date", None)
        normalized.pop("focus_order", None)
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

    canonical.sort(key=lambda task: (
        task.get("position") if isinstance(task.get("position"), int) else 10**9
    ))
    canonical = [
        _normalize_task_fields(task, index)
        for index, task in enumerate(canonical)
    ]
    return canonical, days


def _sync_task_state(
    plan: Plan,
    tasks: list[dict[str, Any]],
    existing_days: list[dict[str, Any]],
) -> None:
    """Persist canonical tasks to flat and per-day JSON representations."""
    normalized_tasks = [
        _normalize_task_fields(dict(task), index)
        for index, task in enumerate(tasks)
    ]

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
    plan.schema_version = 3


def _sync_completion_status(plan: Plan, tasks: list[dict[str, Any]]) -> None:
    if tasks and all(task.get("done", False) for task in tasks):
        plan.status = "done"
        plan.completed_at = plan.completed_at or datetime.now(timezone.utc)
    elif plan.status == "done":
        plan.status = "active"
        plan.completed_at = None


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
    if plan.start_date:
        return max(1, (datetime.now(APP_TIMEZONE).date() - plan.start_date).days + 1)
    if not plan.created_at:
        return 1
    start = plan.created_at
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    start_date = start.astimezone(APP_TIMEZONE).date()
    return max(1, (datetime.now(APP_TIMEZONE).date() - start_date).days + 1)


def _get_today() -> str:
    """ISO date string for the product's primary China locale."""
    return datetime.now(APP_TIMEZONE).date().isoformat()


def _parse_task_completed_at(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _plan_updated_at_value(plan: Plan) -> str:
    value = plan.updated_at
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _timestamps_match(current: str, submitted: str) -> bool:
    try:
        left = datetime.fromisoformat(current.replace("Z", "+00:00"))
        right = datetime.fromisoformat(submitted.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if left.tzinfo is None:
        left = left.replace(tzinfo=timezone.utc)
    if right.tzinfo is None:
        right = right.replace(tzinfo=timezone.utc)
    return left.astimezone(timezone.utc) == right.astimezone(timezone.utc)


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
    start_date: date | str | None = None,
) -> Plan:
    """Persist an owned manual or AI-generated plan."""
    clean_title = str(title or "").strip()[:256]
    if not clean_title:
        raise ValueError("计划标题不能为空")
    normalized_days = _normalize_total_days(total_days)
    normalized_start = _normalize_start_date(start_date) or datetime.now(APP_TIMEZONE).date()
    plan = Plan(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=note_id,
        title=clean_title,
        schema_version=3,
        total_days=normalized_days,
        fields=json.dumps(fields or [], ensure_ascii=False) if fields else "[]",
        tasks="[]",
        days_json="[]",
        status=status,
        start_date=normalized_start,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    _sync_task_state(plan, tasks or [], days or [])
    _sync_completion_status(plan, tasks or [])
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
            schema_version=3,
            total_days=max(0, int(total_days or 0)),
            fields=json.dumps(fields or [], ensure_ascii=False),
            tasks="[]",
            days_json="[]",
            status="active",
            start_date=datetime.now(APP_TIMEZONE).date(),
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(plan)
        created = True
    else:
        plan = existing
        plan.title = clean_title
        plan.schema_version = 3
        plan.total_days = max(0, int(total_days or 0))
        plan.fields = json.dumps(fields or [], ensure_ascii=False)
        plan.start_date = plan.start_date or datetime.now(APP_TIMEZONE).date()
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

def _focus_sort_key(item: dict[str, Any]) -> tuple[int, str, int, str]:
    priority_order = {"high": 0, "medium": 1, "low": 2}
    return (
        priority_order.get(item.get("priority"), 1),
        item.get("scheduled_at") or "9999-12-31",
        int(item.get("position") or 0),
        item.get("title") or "",
    )


def get_plan_overview(
    db: Session,
    user_id: str = "",
    focus_limit: int = 24,
    for_date: str | None = None,
) -> dict[str, Any]:
    """Aggregate one user's workload and explicit focus for a local date."""
    q = db.query(Plan).filter(Plan.status != "done")
    if user_id:
        q = q.filter(Plan.user_id == user_id)
    plans = q.all()

    today_value = for_date or _get_today()
    try:
        date.fromisoformat(today_value)
    except ValueError as exc:
        raise ValueError("概览日期必须为 YYYY-MM-DD") from exc
    focus: list[dict[str, Any]] = []
    today: list[dict[str, Any]] = []
    overdue: list[dict[str, Any]] = []
    upcoming: list[dict[str, Any]] = []
    unscheduled: list[dict[str, Any]] = []

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
                "position": task.get("position", 0),
                "focus_date": task.get("focus_date"),
                "focus_order": task.get("focus_order"),
                "note_id": plan.note_id,
            }
            if task.get("focus_date") == today_value:
                focus.append(item)
            if scheduled_date and scheduled_date_value < today_value:
                overdue.append(item)
            elif scheduled_date_value == today_value or (
                not scheduled_date and task.get("day") == current_day
            ):
                today.append(item)
            elif scheduled_date:
                upcoming.append(item)
            else:
                unscheduled.append(item)

    focus.sort(key=lambda item: (int(item.get("focus_order") or 99), *_focus_sort_key(item)))
    today.sort(key=_focus_sort_key)
    overdue.sort(key=_focus_sort_key)
    upcoming.sort(key=_focus_sort_key)
    unscheduled.sort(key=_focus_sort_key)
    ranked = [
        *({**item, "recommendation_reason": "已逾期"} for item in overdue),
        *({**item, "recommendation_reason": "今天安排"} for item in today),
        *({**item, "recommendation_reason": "即将开始"} for item in upcoming),
        *({**item, "recommendation_reason": "尚未排期"} for item in unscheduled),
    ]
    selected_ids = {(item["plan_id"], item["task_id"]) for item in focus}
    suggestions = [
        item
        for item in ranked
        if (item["plan_id"], item["task_id"]) not in selected_ids
    ]
    open_tasks = len(today) + len(overdue) + len(upcoming) + len(unscheduled)
    sliced = (lambda items: items[:focus_limit] if focus_limit else [])
    return {
        "summary": {
            "active_plans": len(plans),
            "open_tasks": open_tasks,
            "due_today": len(today),
            "overdue_tasks": len(overdue),
            "focus_tasks": len(focus),
            "unscheduled_tasks": len(unscheduled),
        },
        "date": today_value,
        "focus": focus[:3],
        "suggestions": suggestions[:6],
        "today": sliced(today),
        "overdue": sliced(overdue),
        "upcoming": sliced(upcoming),
        "unscheduled": sliced(unscheduled),
    }


def get_plan_stats(db: Session, user_id: str = "") -> dict[str, int]:
    """Return compact badge-compatible statistics."""
    return get_plan_overview(db, user_id=user_id, focus_limit=0)["summary"]


def replace_daily_focus(
    db: Session,
    *,
    user_id: str,
    focus_date: str,
    selections: list[dict[str, str]],
) -> dict[str, Any]:
    """Atomically replace one user's ordered focus selection for a date."""
    try:
        date.fromisoformat(focus_date)
    except ValueError as exc:
        raise ValueError("焦点日期必须为 YYYY-MM-DD") from exc
    if len(selections) > 3:
        raise ValueError("每天最多安排三项重点")

    normalized: list[tuple[str, str]] = []
    for selection in selections:
        plan_id = str(selection.get("plan_id") or "").strip()
        task_id = str(selection.get("task_id") or "").strip()
        if not plan_id or not task_id:
            raise ValueError("焦点任务信息不完整")
        normalized.append((plan_id, task_id))
    if len(set(normalized)) != len(normalized):
        raise ValueError("焦点任务不能重复")

    plans = db.query(Plan).filter(Plan.user_id == user_id).all()
    states: dict[str, tuple[Plan, list[dict[str, Any]], list[dict[str, Any]]]] = {}
    task_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for plan in plans:
        tasks, days = _task_state(plan)
        states[plan.id] = (plan, tasks, days)
        for task in tasks:
            task_lookup[(plan.id, str(task.get("id") or ""))] = task

    for key in normalized:
        task = task_lookup.get(key)
        if task is None or task.get("done", False):
            raise ValueError("只能安排当前账号中尚未完成的任务")

    changed_plan_ids: set[str] = set()
    for plan_id, (_, tasks, _) in states.items():
        for task in tasks:
            if task.get("focus_date") == focus_date:
                task.pop("focus_date", None)
                task.pop("focus_order", None)
                changed_plan_ids.add(plan_id)

    for order, key in enumerate(normalized, start=1):
        task = task_lookup[key]
        task["focus_date"] = focus_date
        task["focus_order"] = order
        changed_plan_ids.add(key[0])

    now = datetime.now(timezone.utc)
    for plan_id in changed_plan_ids:
        plan, tasks, days = states[plan_id]
        _sync_task_state(plan, tasks, days)
        plan.updated_at = now
    db.commit()
    return get_plan_overview(db, user_id=user_id, for_date=focus_date)


def get_weekly_review(
    db: Session,
    *,
    user_id: str,
    week_start: str | None = None,
) -> dict[str, Any]:
    """Build a truthful China-local Monday-to-Sunday execution review."""
    if week_start:
        try:
            start = date.fromisoformat(week_start)
        except ValueError as exc:
            raise ValueError("周起始日期必须为 YYYY-MM-DD") from exc
        if start.weekday() != 0:
            raise ValueError("周起始日期必须是星期一")
    else:
        today = datetime.now(APP_TIMEZONE).date()
        start = today - timedelta(days=today.weekday())
    end = start + timedelta(days=6)
    today_local = datetime.now(APP_TIMEZONE).date()

    plans = db.query(Plan).filter(Plan.user_id == user_id).all()
    completed_tasks = 0
    scheduled_tasks = 0
    carried_over_tasks = 0
    overdue_tasks = 0
    completed_plans = 0
    partial_history = False
    first_recorded_completion: date | None = None
    per_plan: list[dict[str, Any]] = []

    for plan in plans:
        tasks, _ = _task_state(plan)
        row = {
            "plan_id": plan.id,
            "plan_title": plan.title,
            "completed": 0,
            "scheduled": 0,
            "carried_over": 0,
            "overdue": 0,
            "open": 0,
        }
        for task in tasks:
            done = bool(task.get("done", False))
            completed_at = _parse_task_completed_at(task.get("completed_at"))
            completed_date = (
                completed_at.astimezone(APP_TIMEZONE).date()
                if completed_at
                else None
            )
            scheduled_raw = task.get("scheduled_at")
            try:
                scheduled_date = (
                    date.fromisoformat(str(scheduled_raw)[:10])
                    if scheduled_raw
                    else None
                )
            except ValueError:
                scheduled_date = None

            if done and completed_at is None:
                partial_history = True
            if completed_date:
                if first_recorded_completion is None or completed_date < first_recorded_completion:
                    first_recorded_completion = completed_date
                if start <= completed_date <= end:
                    completed_tasks += 1
                    row["completed"] += 1
            if scheduled_date and start <= scheduled_date <= end:
                scheduled_tasks += 1
                row["scheduled"] += 1

            carried = bool(
                scheduled_date
                and (
                    (scheduled_date < start and completed_date and start <= completed_date <= end)
                    or (
                        start <= scheduled_date <= end
                        and (
                            (not done and scheduled_date < min(today_local, end + timedelta(days=1)))
                            or (completed_date and completed_date > scheduled_date)
                        )
                    )
                )
            )
            if carried:
                carried_over_tasks += 1
                row["carried_over"] += 1

            is_overdue = bool(
                not done
                and scheduled_date
                and scheduled_date < today_local
                and scheduled_date <= end
            )
            if is_overdue:
                overdue_tasks += 1
                row["overdue"] += 1
            if not done:
                row["open"] += 1

        if plan.completed_at:
            completed_plan_at = plan.completed_at
            if completed_plan_at.tzinfo is None:
                completed_plan_at = completed_plan_at.replace(tzinfo=timezone.utc)
            completed_plan_date = completed_plan_at.astimezone(APP_TIMEZONE).date()
            if start <= completed_plan_date <= end:
                completed_plans += 1
        if any(row[key] for key in ("completed", "scheduled", "carried_over", "overdue", "open")):
            per_plan.append(row)

    per_plan.sort(
        key=lambda row: (
            -int(row["completed"]),
            -int(row["overdue"]),
            str(row["plan_title"]),
        )
    )
    boundary = first_recorded_completion.isoformat() if first_recorded_completion else None
    return {
        "week_start": start.isoformat(),
        "week_end": end.isoformat(),
        "summary": {
            "completed_tasks": completed_tasks,
            "scheduled_tasks": scheduled_tasks,
            "carried_over_tasks": carried_over_tasks,
            "overdue_tasks": overdue_tasks,
            "completed_plans": completed_plans,
        },
        "plans": per_plan,
        "partial_history": partial_history,
        "history_started_at": boundary,
        "history_note": (
            "早期完成记录没有时间戳，周数据从系统开始记录完成时间后才完整。"
            if partial_history
            else "本周数据仅依据真实排期与完成时间计算。"
        ),
    }


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
            if task["done"]:
                task["completed_at"] = datetime.now(timezone.utc).isoformat()
                task.pop("focus_date", None)
                task.pop("focus_order", None)
            else:
                task.pop("completed_at", None)
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
        "position": 0,
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
    new_task["position"] = len(tasks)
    tasks.append(new_task)

    _sync_task_state(plan, tasks, days)
    if plan.status == "done":
        plan.status = "active"
        plan.completed_at = None
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
        plan.completed_at = datetime.now(timezone.utc) if status == "done" else None
    if "start_date" in updates:
        plan.start_date = _normalize_start_date(updates["start_date"])
    if "total_days" in updates:
        plan.total_days = _normalize_total_days(updates["total_days"])
    return _commit_plan(db, plan)


def reorder_tasks(
    db: Session,
    plan_id: str,
    task_ids: list[str],
    user_id: str = "",
) -> Plan | None:
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None
    tasks, days = _task_state(plan)
    existing_ids = [str(task.get("id") or "") for task in tasks]
    if (
        len(task_ids) != len(existing_ids)
        or len(set(task_ids)) != len(task_ids)
        or set(task_ids) != set(existing_ids)
    ):
        raise ValueError("任务顺序必须包含当前计划的全部任务且不能重复")
    by_id = {str(task["id"]): task for task in tasks}
    ordered = [by_id[task_id] for task_id in task_ids]
    _sync_task_state(plan, ordered, days)
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
    _sync_completion_status(plan, new_tasks)
    if not new_tasks:
        plan.status = "active"
        plan.completed_at = None
    return _commit_plan(db, plan)


def delete_plan(db: Session, plan_id: str, user_id: str = "") -> bool:
    """Delete a plan by ID. Returns True if deleted, False if not found."""
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return False
    db.delete(plan)
    db.commit()
    return True


# ---------------------------------------------------------------------------
# AI coaching preview and safe apply
# ---------------------------------------------------------------------------

def _build_days_from_tasks(
    tasks: list[dict[str, Any]],
    source_days: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    metadata = {
        int(item["day"]): item
        for item in (source_days or [])
        if isinstance(item, dict) and isinstance(item.get("day"), int)
    }
    grouped: dict[int, list[dict[str, Any]]] = {}
    for task in tasks:
        day_number = task.get("day") if isinstance(task.get("day"), int) else 1
        grouped.setdefault(max(1, int(day_number)), []).append(dict(task))
    return [
        {
            "day": day_number,
            "label": str(metadata.get(day_number, {}).get("label") or f"第{day_number}天"),
            **(
                {"date": metadata[day_number]["date"]}
                if metadata.get(day_number, {}).get("date")
                else {}
            ),
            **(
                {"focus": metadata[day_number]["focus"]}
                if metadata.get(day_number, {}).get("focus")
                else {}
            ),
            "tasks": grouped[day_number],
        }
        for day_number in sorted(grouped)
    ]


def _coaching_task_title(value: Any) -> str:
    return "".join(str(value or "").lower().split()).strip("，。！？、,.!?")


def build_coaching_preview(
    plan: Plan,
    *,
    proposed_title: str,
    proposed_fields: list[dict[str, Any]],
    proposed_tasks: list[dict[str, Any]],
    proposed_days: list[dict[str, Any]],
    proposed_total_days: int,
    change_summary: str,
) -> dict[str, Any]:
    """Create a serializable no-write preview while retaining completed work."""
    current_tasks, current_days = _task_state(plan)
    completed = [dict(task) for task in current_tasks if task.get("done", False)]
    open_tasks = [dict(task) for task in current_tasks if not task.get("done", False)]
    open_by_id = {str(task.get("id") or ""): task for task in open_tasks}
    open_by_title = {
        _coaching_task_title(task.get("title")): task
        for task in open_tasks
        if _coaching_task_title(task.get("title"))
    }
    completed_ids = {str(task.get("id") or "") for task in completed}
    used_ids = set(completed_ids)
    matched_open_ids: set[str] = set()
    target_open: list[dict[str, Any]] = []
    additions: list[dict[str, Any]] = []
    modifications: list[dict[str, Any]] = []

    for index, raw_task in enumerate(proposed_tasks):
        if not isinstance(raw_task, dict):
            continue
        title = str(raw_task.get("title") or "").strip()[:256]
        if not title:
            continue
        requested_id = str(raw_task.get("id") or "").strip()[:80]
        existing = open_by_id.get(requested_id)
        if existing is None:
            existing = open_by_title.get(_coaching_task_title(title))
        if existing is not None and str(existing.get("id") or "") in matched_open_ids:
            existing = None

        task = dict(raw_task)
        if existing is not None:
            task_id = str(existing.get("id") or "")
            matched_open_ids.add(task_id)
            for key in ("focus_date", "focus_order"):
                if existing.get(key) is not None:
                    task[key] = existing[key]
        else:
            task_id = requested_id
            if not task_id or task_id in used_ids:
                task_id = f"t-{uuid.uuid4().hex[:8]}"
        used_ids.add(task_id)
        task.update({
            "id": task_id,
            "title": title,
            "done": False,
            "position": index,
            "priority": _normalize_priority(task.get("priority")),
        })
        task.pop("completed_at", None)
        target_open.append(task)

        if existing is None:
            additions.append({"task_id": task_id, "title": title})
        else:
            comparable_before = {
                key: existing.get(key)
                for key in (
                    "title", "day", "scheduled_at", "duration_minutes",
                    "frequency", "priority",
                )
            }
            comparable_after = {key: task.get(key) for key in comparable_before}
            if comparable_before != comparable_after:
                modifications.append({
                    "task_id": task_id,
                    "before": comparable_before,
                    "after": comparable_after,
                })

    removals = [
        {"task_id": str(task.get("id") or ""), "title": str(task.get("title") or "")}
        for task in open_tasks
        if str(task.get("id") or "") not in matched_open_ids
    ]
    completed = [
        _normalize_task_fields(task, len(target_open) + index)
        for index, task in enumerate(completed)
    ]
    all_tasks = [
        _normalize_task_fields(task, index)
        for index, task in enumerate([*target_open, *completed])
    ]
    preview_days = _build_days_from_tasks(
        all_tasks,
        proposed_days or current_days,
    )
    clean_title = str(proposed_title or plan.title).strip()[:256] or plan.title
    total_days = _normalize_total_days(proposed_total_days)
    operation = {
        "type": "replace_open_tasks",
        "title": clean_title,
        "fields": proposed_fields if isinstance(proposed_fields, list) else [],
        "total_days": total_days,
        "tasks": target_open,
        "days": proposed_days if isinstance(proposed_days, list) else [],
    }
    preview_plan = {
        **plan.to_dict(),
        "title": clean_title,
        "fields": operation["fields"],
        "tasks": all_tasks,
        "days": preview_days,
        "total_days": total_days,
        "status": "active" if target_open else plan.status,
    }
    return {
        "plan_id": plan.id,
        "base_updated_at": _plan_updated_at_value(plan),
        "change_summary": str(change_summary or "已生成一份可确认的调整方案")[:240],
        "diff": {
            "additions": additions,
            "modifications": modifications,
            "removals": removals,
            "completed_tasks_preserved": len(completed),
        },
        "operations": [operation],
        "preview_plan": preview_plan,
    }


def apply_coaching_preview(
    db: Session,
    *,
    plan_id: str,
    user_id: str,
    base_updated_at: str,
    operations: list[dict[str, Any]],
) -> Plan | None:
    """Apply one validated coaching target if the plan version is unchanged."""
    plan = get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        return None
    if not _timestamps_match(_plan_updated_at_value(plan), base_updated_at):
        raise PlanConflictError("计划刚刚发生了变化，请重新生成调整预览")
    if len(operations) != 1 or operations[0].get("type") != "replace_open_tasks":
        raise ValueError("计划调整内容无效")

    operation = operations[0]
    submitted_tasks = operation.get("tasks")
    if not isinstance(submitted_tasks, list):
        raise ValueError("计划调整缺少任务内容")
    current_tasks, current_days = _task_state(plan)
    completed = [dict(task) for task in current_tasks if task.get("done", False)]
    completed_ids = {str(task.get("id") or "") for task in completed}
    target_open: list[dict[str, Any]] = []
    used_ids = set(completed_ids)
    for index, raw_task in enumerate(submitted_tasks):
        if not isinstance(raw_task, dict):
            raise ValueError("计划调整任务格式无效")
        title = str(raw_task.get("title") or "").strip()[:256]
        if not title:
            raise ValueError("计划调整中存在空任务")
        task_id = str(raw_task.get("id") or "").strip()[:80]
        if not task_id or task_id in used_ids:
            raise ValueError("计划调整包含重复或受保护的任务")
        used_ids.add(task_id)
        task = dict(raw_task)
        task.update({
            "id": task_id,
            "title": title,
            "done": False,
            "priority": _normalize_priority(task.get("priority")),
            "position": index,
        })
        task.pop("completed_at", None)
        target_open.append(task)

    title = str(operation.get("title") or plan.title).strip()[:256]
    if not title:
        raise ValueError("计划标题不能为空")
    fields = operation.get("fields")
    if not isinstance(fields, list):
        raise ValueError("计划字段格式无效")
    total_days = _normalize_total_days(operation.get("total_days", plan.total_days))
    completed = [
        _normalize_task_fields(task, len(target_open) + index)
        for index, task in enumerate(completed)
    ]

    plan.title = title
    plan.fields = json.dumps(fields, ensure_ascii=False)
    plan.total_days = total_days
    proposed_days = operation.get("days")
    _sync_task_state(
        plan,
        [*target_open, *completed],
        proposed_days if isinstance(proposed_days, list) else current_days,
    )
    _sync_completion_status(plan, [*target_open, *completed])
    return _commit_plan(db, plan)
