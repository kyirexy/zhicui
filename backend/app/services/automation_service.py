"""Persistent daily digest rules, runs and execution."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, time as time_value, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.agent_automation import AgentAutomation, AgentAutomationRun
from app.models.user import User
from app.services import activity_service, agent_service, email_delivery


_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,128}@[^@\s]{1,190}\.[^@\s]{2,}$")
DEFAULT_INSTRUCTION = (
    "请总结昨天新整理进知萃的视频：先归纳共同主题和最值得保留的观点，"
    "再列出 3 条今天可以执行的建议；明确区分视频原文与补充建议，语言简洁。"
)
LEASE_MINUTES = 10
MAX_AUTOMATIONS_PER_USER = 5
MAX_MANUAL_RUNS_PER_TEN_MINUTES = 5
MAX_ACTIVE_MANUAL_RUNS_PER_USER = 2
SOURCE_MODE_LABELS = {
    "collect": "收藏",
    "like": "喜欢",
    "post": "我的作品",
    "all": "视频",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _log_scheduled_run(run: AgentAutomationRun) -> None:
    if run.trigger != "scheduled":
        return
    outcome = (
        "success"
        if run.status == "completed"
        else "cancelled"
        if run.status == "cancelled"
        else "failed"
    )
    activity_service.log_activity_safely(
        user_id=run.user_id,
        action="automation_run",
        method="SYSTEM",
        path="/system/agent-automations/run",
        status_code=200 if run.status in {"completed", "cancelled"} else 500,
        detail={
            "outcome": outcome,
            "source_count": run.source_count,
            "delivery_status": run.delivery_status,
            "trigger": run.trigger,
        },
        event_key=f"agent-automation-run:{run.id}",
    )


def _aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("请选择有效的时区") from exc


def _validate_schedule_time(value: str) -> str:
    clean = value.strip()
    if not _TIME_RE.fullmatch(clean):
        raise ValueError("执行时间格式应为 HH:MM")
    return clean


def _validate_email(value: str) -> str:
    clean = value.strip().lower()
    if len(clean) > 256 or not _EMAIL_RE.fullmatch(clean):
        raise ValueError("请输入有效的收件邮箱")
    return clean


def calculate_next_run(
    *,
    schedule_time: str,
    timezone_name: str,
    after: datetime | None = None,
) -> datetime:
    safe_time = _validate_schedule_time(schedule_time)
    local_tz = _timezone(timezone_name)
    now_utc = _aware_utc(after) or _utcnow()
    local_now = now_utc.astimezone(local_tz)
    hour, minute = (int(part) for part in safe_time.split(":"))
    candidate = datetime.combine(
        local_now.date(),
        time_value(hour=hour, minute=minute),
        tzinfo=local_tz,
    )
    if candidate <= local_now:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def calculate_most_recent_run(
    *,
    schedule_time: str,
    timezone_name: str,
    at: datetime | None = None,
) -> datetime:
    """Return the latest scheduled occurrence at or before ``at``."""
    safe_time = _validate_schedule_time(schedule_time)
    local_tz = _timezone(timezone_name)
    now_utc = _aware_utc(at) or _utcnow()
    local_now = now_utc.astimezone(local_tz)
    hour, minute = (int(part) for part in safe_time.split(":"))
    candidate = datetime.combine(
        local_now.date(),
        time_value(hour=hour, minute=minute),
        tzinfo=local_tz,
    )
    if candidate > local_now:
        candidate -= timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def list_automations(db: Session, user_id: str) -> list[AgentAutomation]:
    return (
        db.query(AgentAutomation)
        .filter(
            AgentAutomation.user_id == user_id,
            AgentAutomation.deleted_at.is_(None),
        )
        .order_by(AgentAutomation.created_at.desc())
        .all()
    )


def get_automation(
    db: Session,
    automation_id: str,
    user_id: str,
    *,
    include_deleted: bool = False,
) -> AgentAutomation | None:
    query = db.query(AgentAutomation).filter(
        AgentAutomation.id == automation_id,
        AgentAutomation.user_id == user_id,
    )
    if not include_deleted:
        query = query.filter(AgentAutomation.deleted_at.is_(None))
    return query.first()


def create_automation(
    db: Session,
    *,
    user: User,
    name: str = "昨日视频摘要",
    enabled: bool = True,
    schedule_time: str = "08:00",
    timezone_name: str = "Asia/Shanghai",
    source_scope: str = "yesterday_new",
    source_mode: str = "collect",
    instruction: str = DEFAULT_INSTRUCTION,
    recipient_email: str = "",
) -> AgentAutomation:
    db.query(User.id).filter(User.id == user.id).with_for_update().first()
    if (
        db.query(AgentAutomation)
        .filter(
            AgentAutomation.user_id == user.id,
            AgentAutomation.deleted_at.is_(None),
        )
        .count()
        >= MAX_AUTOMATIONS_PER_USER
    ):
        raise ValueError(f"每个账号最多创建 {MAX_AUTOMATIONS_PER_USER} 个自动摘要")
    clean_email = _validate_email(recipient_email or user.email)
    if clean_email != user.email.strip().lower():
        raise ValueError("首版只发送到当前知萃账号邮箱")
    if source_scope not in {"yesterday", "yesterday_new"}:
        raise ValueError("每日摘要目前只支持昨天新整理的视频")
    if source_mode not in {"all", "collect", "like", "post"}:
        raise ValueError("请选择有效的视频来源")
    clean_instruction = instruction.strip()
    if not clean_instruction:
        raise ValueError("摘要要求不能为空")
    automation = AgentAutomation(
        user_id=user.id,
        name=name.strip()[:160] or "昨日视频摘要",
        enabled=bool(enabled),
        schedule_time=_validate_schedule_time(schedule_time),
        timezone=timezone_name,
        source_scope="yesterday_new",
        source_mode=source_mode,
        instruction=clean_instruction[:2000],
        recipient_email=clean_email,
        next_run_at=calculate_next_run(
            schedule_time=schedule_time,
            timezone_name=timezone_name,
        )
        if enabled
        else None,
    )
    # Validate timezone even when disabled.
    _timezone(timezone_name)
    db.add(automation)
    db.commit()
    db.refresh(automation)
    return automation


def update_automation(
    db: Session,
    automation: AgentAutomation,
    *,
    user: User,
    changes: dict[str, Any],
) -> AgentAutomation:
    if "name" in changes and changes["name"] is not None:
        clean_name = str(changes["name"]).strip()
        if not clean_name:
            raise ValueError("自动摘要名称不能为空")
        automation.name = clean_name[:160]
    if "schedule_time" in changes and changes["schedule_time"] is not None:
        automation.schedule_time = _validate_schedule_time(
            str(changes["schedule_time"])
        )
    if "timezone" in changes and changes["timezone"] is not None:
        timezone_name = str(changes["timezone"]).strip()
        _timezone(timezone_name)
        automation.timezone = timezone_name
    if "instruction" in changes and changes["instruction"] is not None:
        instruction = str(changes["instruction"]).strip()
        if not instruction:
            raise ValueError("摘要要求不能为空")
        automation.instruction = instruction[:2000]
    if "recipient_email" in changes and changes["recipient_email"] is not None:
        email = _validate_email(str(changes["recipient_email"]))
        if email != user.email.strip().lower():
            raise ValueError("首版只发送到当前知萃账号邮箱")
        automation.recipient_email = email
    if "source_scope" in changes and changes["source_scope"] is not None:
        if str(changes["source_scope"]) not in {"yesterday", "yesterday_new"}:
            raise ValueError("每日摘要目前只支持昨天新整理的视频")
        automation.source_scope = "yesterday_new"
    if "source_mode" in changes and changes["source_mode"] is not None:
        source_mode = str(changes["source_mode"])
        if source_mode not in {"all", "collect", "like", "post"}:
            raise ValueError("请选择有效的视频来源")
        automation.source_mode = source_mode
    if "enabled" in changes and changes["enabled"] is not None:
        automation.enabled = bool(changes["enabled"])

    automation.version += 1
    automation.lease_token = None
    automation.lease_until = None
    automation.next_run_at = (
        calculate_next_run(
            schedule_time=automation.schedule_time,
            timezone_name=automation.timezone,
        )
        if automation.enabled
        else None
    )
    db.commit()
    db.refresh(automation)
    return automation


def delete_automation(db: Session, automation: AgentAutomation) -> None:
    """Soft-delete first so an in-flight worker observes the cancellation.

    Run history is intentionally retained for diagnostics and delivery audit.
    """
    now = _utcnow()
    automation.enabled = False
    automation.deleted_at = now
    automation.version += 1
    automation.next_run_at = None
    automation.lease_token = None
    automation.lease_until = None
    running = db.query(AgentAutomationRun).filter(
        AgentAutomationRun.automation_id == automation.id,
        AgentAutomationRun.user_id == automation.user_id,
        AgentAutomationRun.status == "running",
        AgentAutomationRun.delivery_status != "delivering",
    ).all()
    for run in running:
        run.status = "cancelled"
        run.delivery_status = "skipped"
        run.delivery_error = "自动摘要已删除，本次运行已取消。"
        run.finished_at = now
    db.commit()


def list_runs(
    db: Session,
    *,
    automation_id: str,
    user_id: str,
    limit: int = 30,
) -> list[AgentAutomationRun]:
    return (
        db.query(AgentAutomationRun)
        .filter(
            AgentAutomationRun.automation_id == automation_id,
            AgentAutomationRun.user_id == user_id,
        )
        .order_by(AgentAutomationRun.created_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )


def create_manual_run(
    db: Session,
    *,
    automation: AgentAutomation,
) -> AgentAutomationRun:
    db.query(User.id).filter(
        User.id == automation.user_id
    ).with_for_update().first()
    now = _utcnow()
    recent_count = (
        db.query(AgentAutomationRun)
        .filter(
            AgentAutomationRun.user_id == automation.user_id,
            AgentAutomationRun.trigger == "manual",
            AgentAutomationRun.created_at >= now - timedelta(minutes=10),
        )
        .count()
    )
    active_count = (
        db.query(AgentAutomationRun)
        .filter(
            AgentAutomationRun.user_id == automation.user_id,
            AgentAutomationRun.trigger == "manual",
            AgentAutomationRun.status == "running",
        )
        .count()
    )
    if recent_count >= MAX_MANUAL_RUNS_PER_TEN_MINUTES:
        db.rollback()
        raise ValueError("十分钟内最多生成 5 次摘要预览，请稍后再试")
    if active_count >= MAX_ACTIVE_MANUAL_RUNS_PER_USER:
        db.rollback()
        raise ValueError("已有两个摘要预览正在生成，请稍候")
    run = AgentAutomationRun(
        automation_id=automation.id,
        user_id=automation.user_id,
        trigger="manual",
        idempotency_key=f"manual:{automation.id}:{uuid.uuid4().hex}",
        automation_version=automation.version,
        status="running",
        delivery_status="skipped",
        scheduled_for=_utcnow(),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def claim_due_runs(db: Session, *, limit: int = 4) -> list[str]:
    now = _utcnow()
    candidates = (
        db.query(AgentAutomation)
        .filter(
            AgentAutomation.enabled.is_(True),
            AgentAutomation.deleted_at.is_(None),
            AgentAutomation.next_run_at.is_not(None),
            AgentAutomation.next_run_at <= now,
            or_(
                AgentAutomation.lease_until.is_(None),
                AgentAutomation.lease_until < now,
            ),
        )
        .order_by(AgentAutomation.next_run_at.asc())
        .limit(max(1, min(limit, 10)))
        .all()
    )
    run_ids: list[str] = []
    for candidate in candidates:
        # Collapse multiple missed days to the most recent occurrence. This
        # produces one useful catch-up digest instead of sending an old queue.
        scheduled_for = calculate_most_recent_run(
            schedule_time=candidate.schedule_time,
            timezone_name=candidate.timezone,
            at=now,
        )
        idempotency_key = (
            f"scheduled:{candidate.id}:{candidate.version}:"
            f"{scheduled_for.replace(microsecond=0).isoformat()}"
        )
        existing = (
            db.query(AgentAutomationRun)
            .filter(AgentAutomationRun.idempotency_key == idempotency_key)
            .first()
        )
        next_run = calculate_next_run(
            schedule_time=candidate.schedule_time,
            timezone_name=candidate.timezone,
            after=max(now, scheduled_for),
        )
        if existing is not None:
            # Another worker already owns this exact scheduled occurrence.
            # Advancing a still-stale next_run is safe, but never mutate the
            # other worker's lease from this candidate snapshot.
            db.query(AgentAutomation).filter(
                AgentAutomation.id == candidate.id,
                AgentAutomation.next_run_at <= now,
            ).update(
                {AgentAutomation.next_run_at: next_run},
                synchronize_session=False,
            )
            db.commit()
            continue

        token = uuid.uuid4().hex
        claimed = (
            db.query(AgentAutomation)
            .filter(
                AgentAutomation.id == candidate.id,
                AgentAutomation.enabled.is_(True),
                AgentAutomation.deleted_at.is_(None),
                AgentAutomation.next_run_at <= now,
                or_(
                    AgentAutomation.lease_until.is_(None),
                    AgentAutomation.lease_until < now,
                ),
            )
            .update(
                {
                    AgentAutomation.lease_token: token,
                    AgentAutomation.lease_until: now
                    + timedelta(minutes=LEASE_MINUTES),
                    AgentAutomation.next_run_at: next_run,
                },
                synchronize_session=False,
            )
        )
        if claimed != 1:
            db.rollback()
            continue
        run = AgentAutomationRun(
            automation_id=candidate.id,
            user_id=candidate.user_id,
            trigger="scheduled",
            idempotency_key=idempotency_key,
            automation_version=candidate.version,
            lease_token=token,
            status="running",
            delivery_status="skipped",
            scheduled_for=scheduled_for,
        )
        db.add(run)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        db.refresh(run)
        run_ids.append(run.id)
    return run_ids


def execute_run(
    db: Session,
    *,
    run_id: str,
    deliver: bool,
) -> AgentAutomationRun | None:
    run = db.query(AgentAutomationRun).filter(
        AgentAutomationRun.id == run_id
    ).first()
    if run is None:
        return None
    automation = (
        db.query(AgentAutomation)
        .filter(
            AgentAutomation.id == run.automation_id,
            AgentAutomation.user_id == run.user_id,
        )
        .first()
    )
    user = db.query(User).filter(User.id == run.user_id).first()
    if automation is None or user is None or not user.is_active:
        run.status = "failed"
        run.delivery_status = "skipped"
        run.delivery_error = "账号或自动摘要已不可用"
        run.finished_at = _utcnow()
        db.commit()
        _log_scheduled_run(run)
        return run
    rule_changed = (
        automation.deleted_at is not None
        or automation.version != run.automation_version
        or (
            run.trigger == "scheduled"
            and (
                not automation.enabled
                or automation.lease_token != run.lease_token
            )
        )
    )
    if rule_changed:
        run.status = "cancelled"
        run.delivery_status = "skipped"
        run.delivery_error = "规则已暂停或更新，本次旧版本不再执行。"
        run.finished_at = _utcnow()
        if automation.lease_token == run.lease_token:
            automation.lease_token = None
            automation.lease_until = None
        db.commit()
        _log_scheduled_run(run)
        return run

    local_tz = _timezone(automation.timezone)
    reference_at = (
        _aware_utc(run.scheduled_for)
        if run.trigger == "scheduled"
        else _utcnow()
    ) or _utcnow()
    target_label = (
        reference_at.astimezone(local_tz).date() - timedelta(days=1)
    ).strftime("%m月%d日")
    source_mode_label = SOURCE_MODE_LABELS.get(
        automation.source_mode,
        "视频",
    )
    try:
        notes, _, truncated, _ = agent_service.resolve_source_snapshot(
            db,
            user_id=automation.user_id,
            scope="yesterday_new",
            timezone_name=automation.timezone,
            reference_at=reference_at,
            source_mode_filter=(
                None
                if automation.source_mode == "all"
                else automation.source_mode
            ),
            not_before=(
                _aware_utc(automation.created_at)
                if run.trigger == "scheduled"
                else None
            ),
        )
        run.source_count = len(notes)
        if not notes:
            run.result_text = (
                f"{target_label}没有新整理进知萃且文案已就绪的{source_mode_label}，"
                "本次没有生成摘要。"
            )
            run.result_json = json.dumps(
                {
                    "automation_version": automation.version,
                    "instruction": automation.instruction,
                    "source_scope": automation.source_scope,
                    "source_mode": automation.source_mode,
                    "note_ids": [],
                },
                ensure_ascii=False,
            )
            # Save the result while retaining the running state, then refresh
            # the rule. A concurrent update/delete must win over this worker.
            run.status = "running"
            run.delivery_status = "skipped"
            db.commit()
            db.expire_all()
            run = (
                db.query(AgentAutomationRun)
                .filter(AgentAutomationRun.id == run_id)
                .first()
            )
            automation = (
                db.query(AgentAutomation)
                .filter(AgentAutomation.id == automation.id)
                .first()
            )
            if run is None or automation is None:
                return run
            if (
                automation.deleted_at is not None
                or automation.version != run.automation_version
                or (
                    run.trigger == "scheduled"
                    and (
                        not automation.enabled
                        or automation.lease_token != run.lease_token
                    )
                )
            ):
                run.status = "cancelled"
                run.delivery_error = "规则已删除或更新，本次旧版本已取消。"
            else:
                run.status = "completed"
                automation.last_run_at = _utcnow()
            run.finished_at = _utcnow()
            if (
                run.trigger == "scheduled"
                and automation.lease_token == run.lease_token
            ):
                automation.lease_token = None
                automation.lease_until = None
            db.commit()
            _log_scheduled_run(run)
            return run

        thread = agent_service.create_thread_from_notes(
            db,
            user_id=automation.user_id,
            notes=notes,
            title=f"{target_label}视频摘要",
            scope_label=f"{target_label}新整理的{source_mode_label}",
            scope_type="yesterday_new",
        )
        _, assistant_message = agent_service.ask_thread(
            db,
            thread=thread,
            content=(
                f"请总结 {target_label} 新整理进知萃的"
                f"{source_mode_label}。具体要求：{automation.instruction}"
            ),
            research_mode="fast",
            output_style="summary",
            custom_instruction=(
                "这是定时摘要。区分视频原文事实和你的补充建议；不要夸大，"
                "最后给出可以继续追问的方向。"
            ),
            web_scope="video_only",
            allow_video_analysis=False,
        )
        digest_body = assistant_message.content
        digest_thread_id = thread.id
        run.agent_thread_id = digest_thread_id
        run.result_text = digest_body
        persisted_result = assistant_message.result
        persisted_result.update({
            "automation_version": automation.version,
            "instruction": automation.instruction,
            "source_scope": automation.source_scope,
            "source_mode": automation.source_mode,
        })
        if truncated:
            persisted_result["source_truncated"] = True
        run.result_json = json.dumps(persisted_result, ensure_ascii=False)
        run.status = "running"
        db.commit()

        # A user can delete or revise the rule while the LLM is working.
        # Refresh after persisting the generated result and before any
        # external side effect.
        automation_id = run.automation_id
        db.expire_all()
        run = (
            db.query(AgentAutomationRun)
            .filter(AgentAutomationRun.id == run_id)
            .first()
        )
        automation = (
            db.query(AgentAutomation)
            .filter(
                AgentAutomation.id == automation_id,
                AgentAutomation.user_id == user.id,
            )
            .populate_existing()
            .first()
        )
        if run is None or automation is None:
            return run
        if (
            automation.deleted_at is not None
            or automation.version != run.automation_version
            or (
                run.trigger == "scheduled"
                and (
                    not automation.enabled
                    or automation.lease_token != run.lease_token
                )
            )
        ):
            run.status = "cancelled"
            run.delivery_status = "skipped"
            run.delivery_error = "规则已删除、暂停或更新，摘要已保存但没有发送邮件。"
            run.finished_at = _utcnow()
            if (
                run.trigger == "scheduled"
                and automation.lease_token == run.lease_token
            ):
                automation.lease_token = None
                automation.lease_until = None
            db.commit()
            _log_scheduled_run(run)
            return run

        if deliver:
            db.refresh(user)
            if not bool(user.email_verified):
                delivery = {
                    "status": "verification_required",
                    "error": "注册邮箱尚未验证，摘要已保存在知萃中。",
                }
            elif automation.recipient_email != user.email.strip().lower():
                delivery = {
                    "status": "failed",
                    "error": "账号邮箱已变更，请先更新自动摘要。",
                }
            else:
                # Persist the uncertain boundary before SMTP. If the process
                # exits after submission, recovery marks it unknown and never
                # blindly sends a duplicate.
                run.status = "running"
                run.delivery_status = "delivering"
                run.delivery_error = None
                db.commit()
                delivery = email_delivery.send_digest(
                    recipient=automation.recipient_email,
                    title=f"知萃 · {target_label}新增{source_mode_label}摘要",
                    body=digest_body,
                    source_count=len(notes),
                    thread_id=digest_thread_id,
                    idempotency_key=run.idempotency_key,
                )
            run.status = "completed"
            run.delivery_status = delivery["status"]
            run.delivery_error = delivery.get("error") or None
        else:
            run.delivery_status = "skipped"
            run.delivery_error = None
        run.finished_at = _utcnow()
        automation.last_run_at = run.finished_at
        if (
            run.trigger == "scheduled"
            and automation.lease_token == run.lease_token
        ):
            automation.lease_token = None
            automation.lease_until = None
        db.commit()
        db.refresh(run)
        _log_scheduled_run(run)
        return run
    except Exception as exc:
        db.rollback()
        recovered_run = (
            db.query(AgentAutomationRun)
            .filter(AgentAutomationRun.id == run_id)
            .first()
        )
        if recovered_run is None:
            return None
        recovered_automation = (
            db.query(AgentAutomation)
            .filter(AgentAutomation.id == recovered_run.automation_id)
            .first()
        )
        if recovered_run.delivery_status == "delivering":
            recovered_run.status = "completed"
            recovered_run.delivery_status = "unknown"
            recovered_run.delivery_error = (
                "邮件提交后服务状态未确认；为避免重复发送，系统不会自动重发。"
            )
        else:
            recovered_run.status = "failed"
            recovered_run.delivery_status = "failed" if deliver else "skipped"
            recovered_run.delivery_error = (
                f"{type(exc).__name__}: {str(exc)[:300]}"
            )
        recovered_run.finished_at = _utcnow()
        if recovered_automation is not None:
            recovered_automation.last_run_at = recovered_run.finished_at
            if (
                not recovered_run.lease_token
                or recovered_automation.lease_token
                == recovered_run.lease_token
            ):
                recovered_automation.lease_token = None
                recovered_automation.lease_until = None
        try:
            db.commit()
            db.refresh(recovered_run)
        except Exception:
            db.rollback()
            return recovered_run
        _log_scheduled_run(recovered_run)
        return recovered_run


def heartbeat_run(db: Session, run_id: str) -> bool:
    """Renew one active run and its owning scheduled-rule lease."""
    now = _utcnow()
    run = (
        db.query(AgentAutomationRun)
        .filter(
            AgentAutomationRun.id == run_id,
            AgentAutomationRun.status == "running",
        )
        .first()
    )
    if run is None:
        return False
    run.heartbeat_at = now
    if run.trigger == "scheduled" and run.lease_token:
        db.query(AgentAutomation).filter(
            AgentAutomation.id == run.automation_id,
            AgentAutomation.deleted_at.is_(None),
            AgentAutomation.lease_token == run.lease_token,
        ).update(
            {
                AgentAutomation.lease_until: now
                + timedelta(minutes=LEASE_MINUTES),
            },
            synchronize_session=False,
        )
    db.commit()
    return True


def mark_stale_runs(db: Session) -> int:
    cutoff = _utcnow() - timedelta(minutes=LEASE_MINUTES)
    stale = (
        db.query(AgentAutomationRun)
        .filter(
            AgentAutomationRun.status == "running",
            func.coalesce(
                AgentAutomationRun.heartbeat_at,
                AgentAutomationRun.started_at,
            ) < cutoff,
        )
        .all()
    )
    for run in stale:
        if run.delivery_status == "delivering":
            run.status = "completed"
            run.delivery_status = "unknown"
            run.delivery_error = (
                "服务中断时邮件提交状态未确认；为避免重复发送，系统不会自动重发。"
            )
        else:
            run.status = "failed"
            run.delivery_status = "failed"
            run.delivery_error = "服务重启前任务未完成，可在运行记录中重新生成。"
        run.finished_at = _utcnow()
        automation = (
            db.query(AgentAutomation)
            .filter(AgentAutomation.id == run.automation_id)
            .first()
        )
        if automation and (
            not run.lease_token
            or automation.lease_token == run.lease_token
        ):
            automation.lease_token = None
            automation.lease_until = None
    if stale:
        db.commit()
    return len(stale)
