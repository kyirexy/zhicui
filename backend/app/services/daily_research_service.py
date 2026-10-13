"""每日研究：云端调度、桌面采集接力、证据分级报告与可靠投递。"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.agent_automation import AgentAutomation, AgentAutomationRun
from app.models.chat_model import ChatModelChargeReservation, ChatModelFreeUsage
from app.models.daily_research import DailyResearchBatch, DailyResearchDevice, DailyResearchRecipient
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import automation_service, email_delivery

KIND = "daily_research"
ACTIVE = {"queued", "waiting_for_desktop", "syncing", "waiting_for_user", "preparing", "researching"}
DESKTOP = {"waiting_for_desktop", "syncing", "waiting_for_user"}
TERMINAL = {"completed", "partial", "failed", "cancelled"}
LEASE = timedelta(minutes=10)
LIMITS = {"max_subscriptions": 5, "max_manual_runs_per_ten_minutes": 5,
          "max_sync_limit": 500, "max_research_sources": 100, "transcript_sample_limit": 3}
DEFAULT_INSTRUCTION = "研究今天和昨天首次发现的视频：归纳主题，引用有文稿依据的开头钩子原文和可学习的句式；按平台点赞数据排序，推荐最值得参考创作的一条并解释理由；总结可学习点，提出下一条原创选题、开头和结构建议。视觉及剪辑只有原片证据足够才可分析，未看原片必须明确标注，不编造动作、镜头或字幕细节。"


class DailyResearchError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def iso(value):
    return aware(value).isoformat().replace("+00:00", "Z") if value else None


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load(value):
    try:
        result = json.loads(value or "{}")
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def _lock_user(db, user_id):
    user = db.query(User).filter(User.id == user_id).with_for_update().populate_existing().first()
    if user is None or not user.is_active:
        raise DailyResearchError("账号不可用", 401)
    return user


def config(rule):
    return {"platforms": ["douyin"], "source_modes": ["like", "collect"], "window_days": 2,
            "sync_limit": 500, "focus_topics": [], **load(rule.config_json)}


def subscription_dict(rule):
    data = rule.to_dict()
    data.pop("config", None)
    return {**data, **config(rule)}


def run_dict(run):
    state, result = run.state, run.result
    return {**run.to_dict(), "subscription_id": run.automation_id,
            "stage": state.get("stage", run.status), "stage_message": state.get("message", ""),
            "stats": state.get("stats", {}), "coverage": state.get("coverage", "partial"),
            "report": result.get("report", {}), "sync_sources": state.get("sources", [])}


def owned_subscription(db, user_id, subscription_id, *, deleted=False):
    query = db.query(AgentAutomation).filter(AgentAutomation.id == subscription_id,
        AgentAutomation.user_id == user_id, AgentAutomation.report_kind == KIND)
    if not deleted:
        query = query.filter(AgentAutomation.deleted_at.is_(None))
    rule = query.first()
    if rule is None:
        raise DailyResearchError("每日研究订阅不存在", 404)
    return rule


def owned_run(db, user_id, run_id):
    run = db.query(AgentAutomationRun).join(AgentAutomation,
        AgentAutomationRun.automation_id == AgentAutomation.id).filter(
        AgentAutomationRun.id == run_id, AgentAutomationRun.user_id == user_id,
        AgentAutomation.report_kind == KIND).populate_existing().first()
    if run is None:
        raise DailyResearchError("研究运行不存在", 404)
    return run


def list_subscriptions(db, user_id):
    return db.query(AgentAutomation).filter(AgentAutomation.user_id == user_id,
        AgentAutomation.report_kind == KIND, AgentAutomation.deleted_at.is_(None)).order_by(
        AgentAutomation.created_at.desc()).all()


def save_subscription(db, *, user, payload, subscription_id=None):
    _lock_user(db, user.id)
    existing = owned_subscription(db, user.id, subscription_id) if subscription_id else None
    if existing is None and len(list_subscriptions(db, user.id)) >= LIMITS["max_subscriptions"]:
        raise DailyResearchError("每个账号最多创建 5 个每日研究订阅")
    rule = existing or AgentAutomation(user_id=user.id, report_kind=KIND,
        name="每日视频研究", schedule_time="15:00", timezone="Asia/Shanghai", enabled=True,
        instruction=DEFAULT_INSTRUCTION, recipient_email="", source_scope="recent_two_days", source_mode="all")
    cfg = config(rule)
    for key in ("platforms", "source_modes", "window_days", "sync_limit", "focus_topics"):
        if key in payload:
            cfg[key] = payload[key]
    if cfg["platforms"] != ["douyin"]:
        raise DailyResearchError("当前每日研究支持抖音")
    if not cfg["source_modes"] or not set(cfg["source_modes"]) <= {"like", "collect"}:
        raise DailyResearchError("请选择喜欢或收藏")
    cfg["source_modes"] = list(dict.fromkeys(cfg["source_modes"]))
    if cfg["window_days"] != 2 or not 1 <= cfg["sync_limit"] <= 500:
        raise DailyResearchError("目前支持近两日、每个来源最多 500 条")
    cfg["focus_topics"] = list(dict.fromkeys(str(v).strip()[:80] for v in cfg["focus_topics"] if str(v).strip()))[:12]
    for key in ("name", "schedule_time", "timezone", "instruction", "enabled", "recipient_email"):
        if key in payload:
            setattr(rule, key, payload[key])
    rule.name = rule.name.strip() or "每日视频研究"
    rule.instruction = rule.instruction.strip() or DEFAULT_INSTRUCTION
    rule.recipient_email = automation_service._validate_email(rule.recipient_email) if rule.recipient_email.strip() else ""
    automation_service._validate_schedule_time(rule.schedule_time)
    automation_service._timezone(rule.timezone)
    rule.config_json = dump(cfg)
    rule.version = (rule.version or 1) + int(existing is not None)
    rule.lease_token = None
    rule.lease_until = None
    rule.next_run_at = automation_service.calculate_next_run(schedule_time=rule.schedule_time,
        timezone_name=rule.timezone) if rule.enabled else None
    db.add(rule)
    if existing:
        _cancel_active(db, rule, "订阅已更新，本次旧版本停止执行。")
    db.commit()
    db.refresh(rule)
    return rule


def _cancel_active(db, rule, message):
    for run in db.query(AgentAutomationRun).filter(AgentAutomationRun.automation_id == rule.id,
            AgentAutomationRun.status.in_(ACTIVE), AgentAutomationRun.delivery_status != "delivering").all():
        run.status = "cancelled"
        run.state_json = dump({**run.state, "stage": "cancelled", "message": message})
        run.finished_at = now()


def delete_subscription(db, user_id, subscription_id):
    _lock_user(db, user_id)
    rule = owned_subscription(db, user_id, subscription_id)
    _cancel_active(db, rule, "订阅已删除。")
    rule.deleted_at = now()
    rule.enabled = False
    rule.version += 1
    rule.next_run_at = None
    rule.lease_token = None
    rule.lease_until = None
    db.commit()


def enqueue_manual(db, user_id, subscription_id):
    _lock_user(db, user_id)
    rule = owned_subscription(db, user_id, subscription_id)
    count = db.query(AgentAutomationRun).filter(AgentAutomationRun.user_id == user_id,
        AgentAutomationRun.trigger == "manual", AgentAutomationRun.created_at >= now() - timedelta(minutes=10)).count()
    if count >= 5:
        raise DailyResearchError("十分钟内最多运行 5 次，请稍后再试", 429)
    active = db.query(AgentAutomationRun).filter(AgentAutomationRun.automation_id == rule.id,
        AgentAutomationRun.status.in_(ACTIVE)).first()
    if active:
        return active
    run = AgentAutomationRun(automation_id=rule.id, user_id=user_id, trigger="manual",
        idempotency_key=f"research-manual:{uuid.uuid4()}", automation_version=rule.version,
        status="queued", scheduled_for=now(), state_json=dump({"stage": "queued", "message": "已排队，等待桌面接力采集。"}))
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def list_runs(db, user_id, subscription_id=None, limit=30):
    query = db.query(AgentAutomationRun).join(AgentAutomation, AgentAutomation.id == AgentAutomationRun.automation_id).filter(
        AgentAutomationRun.user_id == user_id, AgentAutomation.report_kind == KIND)
    if subscription_id:
        owned_subscription(db, user_id, subscription_id, deleted=True)
        query = query.filter(AgentAutomationRun.automation_id == subscription_id)
    return query.order_by(AgentAutomationRun.created_at.desc()).limit(min(100, max(1, limit))).all()


def _rule_valid(db, run):
    rule = db.query(AgentAutomation).filter(AgentAutomation.id == run.automation_id,
        AgentAutomation.user_id == run.user_id, AgentAutomation.report_kind == KIND).populate_existing().first()
    user = db.get(User, run.user_id, populate_existing=True)
    if (rule is None or rule.deleted_at or rule.version != run.automation_version
            or (run.trigger == "scheduled" and not rule.enabled) or not user or not user.is_active):
        raise DailyResearchError("订阅或账号已变更，本次运行已取消", 409)
    return rule


def poll(db, *, limit=2, user_id=None):
    """推进待机状态；只将可研究任务交给线程池，不占用离线等待线程。"""
    timestamp = now()
    query = db.query(AgentAutomationRun).join(AgentAutomation,
        AgentAutomation.id == AgentAutomationRun.automation_id).filter(
        AgentAutomation.report_kind == KIND, AgentAutomationRun.status.in_(ACTIVE))
    if user_id:
        query = query.filter(AgentAutomationRun.user_id == user_id)
    rows = query.all()
    ready = []
    for run in rows:
        previous_status, previous_state, previous_heartbeat = run.status, run.state_json, run.heartbeat_at
        next_status, message = None, ""
        delivery_status, delivery_error = run.delivery_status, run.delivery_error
        try:
            _rule_valid(db, run)
        except DailyResearchError:
            if run.delivery_status != "delivering":
                next_status, message = "cancelled", "订阅或账号已变更。"
        if next_status:
            pass
        elif run.status == "queued":
            next_status, message = "waiting_for_desktop", "等待桌面端上线，采集喜欢和收藏。"
        elif run.status == "preparing" and len(ready) < limit:
            ready.append(run.id)
        elif run.status == "researching" and aware(run.heartbeat_at) < timestamp - LEASE:
            next_status = "partial" if run.delivery_status == "delivering" else "failed"
            delivery_status = "unknown" if run.delivery_status == "delivering" else "skipped"
            delivery_error = "服务中断；邮件状态不确定时不会自动重发。"
            message = "运行已中断，请查看已保存报告。"
        if next_status:
            db.query(AgentAutomationRun).filter(AgentAutomationRun.id == run.id,
                AgentAutomationRun.status == previous_status, AgentAutomationRun.state_json == previous_state,
                AgentAutomationRun.heartbeat_at == previous_heartbeat).update({
                    AgentAutomationRun.status: next_status,
                    AgentAutomationRun.state_json: dump({**load(previous_state), "stage": next_status, "message": message}),
                    AgentAutomationRun.delivery_status: delivery_status, AgentAutomationRun.delivery_error: delivery_error,
                    AgentAutomationRun.finished_at: timestamp if next_status in TERMINAL else None}, synchronize_session=False)
    db.commit()
    _recover_charges(db, user_id=user_id)
    return ready


def _touch_device(db, user_id, device_id, version=1):
    row = db.query(DailyResearchDevice).filter_by(device_id=device_id).first()
    if row is None:
        row = DailyResearchDevice(user_id=user_id, device_id=device_id)
        db.add(row)
    row.user_id = user_id
    row.capabilities_version = version
    row.last_seen_at = now()


def claim_desktop(db, *, user_id, device_id, capabilities_version):
    _lock_user(db, user_id)
    _touch_device(db, user_id, device_id, capabilities_version)
    db.commit()
    poll(db, limit=0, user_id=user_id)
    # 同账号一次只采集一项；同设备重启可续原租约，其他设备须等待过期。
    runs = db.query(AgentAutomationRun).join(AgentAutomation,
        AgentAutomation.id == AgentAutomationRun.automation_id).filter(
        AgentAutomationRun.user_id == user_id, AgentAutomation.report_kind == KIND,
        AgentAutomationRun.status.in_(DESKTOP)).order_by(AgentAutomationRun.created_at.asc()).all()
    for run in runs:
        state = run.state
        expiry = datetime.fromisoformat(state["lease_until"]) if state.get("lease_until") else None
        if expiry and aware(expiry) > now() and state.get("device_id") != device_id:
            return None
        rule = _rule_valid(db, run)
        token = state.get("desktop_token") if state.get("device_id") == device_id and expiry and aware(expiry) > now() else secrets.token_hex(24)
        next_state = {**state, "device_id": device_id, "desktop_token": token,
            "lease_until": iso(now() + LEASE), "stage": "syncing", "message": "桌面端正在同步平台清单。"}
        claimed = db.query(AgentAutomationRun).filter(AgentAutomationRun.id == run.id,
            AgentAutomationRun.status == run.status, AgentAutomationRun.state_json == run.state_json).update({
                AgentAutomationRun.status: "syncing", AgentAutomationRun.state_json: dump(next_state),
                AgentAutomationRun.heartbeat_at: now()}, synchronize_session=False)
        db.commit()
        if claimed:
            cfg = config(rule)
            return {"run_id": run.id, "lease_token": token, "request": {
                "platforms": cfg["platforms"], "source_modes": cfg["source_modes"],
                "limit": cfg["sync_limit"], "task_id": run.id}}
    return None


def check_desktop(db, *, user_id, run_id, device_id, lease_token):
    # 所有桌面写入先锁用户，再锁运行；与订阅修改采用相同顺序。
    _lock_user(db, user_id)
    run = owned_run(db, user_id, run_id)
    run = db.query(AgentAutomationRun).filter_by(id=run.id, user_id=user_id).with_for_update().populate_existing().one()
    _rule_valid(db, run)
    state = run.state
    expires = datetime.fromisoformat(state["lease_until"]) if state.get("lease_until") else None
    device = db.query(DailyResearchDevice).filter_by(device_id=device_id, user_id=user_id).first()
    if (run.status not in {"syncing", "waiting_for_user"} or state.get("device_id") != device_id
            or device is None
            or not hmac.compare_digest(str(state.get("desktop_token") or ""), lease_token)
            or not expires or aware(expires) <= now()):
        raise DailyResearchError("桌面任务租约已失效，请重新领取", 409)
    return run


def desktop_progress(db, *, user_id, payload):
    run = check_desktop(db, user_id=user_id, **{k: payload[k] for k in ("run_id", "device_id", "lease_token")})
    state = run.state
    stats = {**state.get("stats", {}), **{k: payload[k] for k in ("read", "saved", "created", "reused", "skipped", "failed") if payload.get(k) is not None}}
    stage = payload.get("stage", "syncing")
    next_state = {**state, "stage": stage, "message": payload.get("message") or ("请在桌面端完成平台验证。" if stage == "waiting_for_user" else "桌面端正在同步平台清单。"),
        "stats": stats, "lease_until": iso(now() + LEASE)}
    _touch_device(db, user_id, payload["device_id"])
    _commit_desktop_transition(db, run, next_state, stage)
    return run_dict(run)


def _commit_desktop_transition(db, run, state, status, *, finished_at=None):
    """PostgreSQL 行锁之外保留 CAS，SQLite 或迟到回包也不能覆盖新租约。"""
    changed = db.query(AgentAutomationRun).filter(AgentAutomationRun.id == run.id,
        AgentAutomationRun.user_id == run.user_id, AgentAutomationRun.status == run.status,
        AgentAutomationRun.state_json == run.state_json).update({
            AgentAutomationRun.state_json: dump(state), AgentAutomationRun.status: status,
            AgentAutomationRun.heartbeat_at: now(), AgentAutomationRun.finished_at: finished_at}, synchronize_session=False)
    if not changed:
        db.rollback()
        raise DailyResearchError("桌面任务状态已变更，请重新领取", 409)
    db.commit()
    db.refresh(run)


def desktop_batch(db, *, user_id, payload):
    identity = {k: payload[k] for k in ("run_id", "device_id", "lease_token")}
    run = check_desktop(db, user_id=user_id, **identity)
    cfg = config(_rule_valid(db, run))
    if payload["platform"] not in cfg["platforms"] or payload["source_mode"] not in cfg["source_modes"]:
        raise DailyResearchError("批次来源不在订阅范围内")
    if payload.get("source_rank_offset", 0) + len(payload["items"]) > cfg["sync_limit"]:
        raise DailyResearchError("批次超过本次采集数量上限")
    content = {k: payload[k] for k in ("platform", "source_mode", "items", "source_rank_offset", "coverage", "order_reliable") if k in payload}
    fingerprint = hashlib.sha256(dump(content).encode()).hexdigest()
    receipt = db.query(DailyResearchBatch).filter_by(run_id=run.id, batch_id=payload["batch_id"]).with_for_update().populate_existing().first()
    attempt = now()
    if receipt:
        if receipt.payload_hash != fingerprint:
            raise DailyResearchError("同一批次标识不能用于不同内容", 409)
        if receipt.status == "completed":
            return load(receipt.result_json)
        if receipt.status == "processing" and aware(receipt.updated_at) > now() - LEASE:
            raise DailyResearchError("该批次正在保存，请稍后使用相同批次标识重试", 409)
        attempt = max(attempt, aware(receipt.updated_at) + timedelta(microseconds=1))
        changed = db.query(DailyResearchBatch).filter(DailyResearchBatch.id == receipt.id,
            DailyResearchBatch.status == receipt.status, DailyResearchBatch.updated_at == receipt.updated_at).update({
                DailyResearchBatch.status: "processing", DailyResearchBatch.updated_at: attempt}, synchronize_session=False)
        if not changed:
            db.rollback()
            raise DailyResearchError("批次已由其他执行器接管，请重新查询", 409)
    else:
        previous = db.query(DailyResearchBatch).filter_by(run_id=run.id, platform=payload["platform"],
            source_mode=payload["source_mode"]).all()
        offset, count = payload.get("source_rank_offset", 0), len(payload["items"])
        if sum(batch.item_count for batch in previous) + count > cfg["sync_limit"]:
            raise DailyResearchError("该来源已达到本次采集数量上限")
        if any(offset < batch.source_rank_offset + batch.item_count and offset + count > batch.source_rank_offset for batch in previous):
            raise DailyResearchError("该来源范围已经提交，请重放原批次标识", 409)
        receipt = DailyResearchBatch(run_id=run.id, user_id=user_id, batch_id=payload["batch_id"], payload_hash=fingerprint,
            platform=payload["platform"], source_mode=payload["source_mode"], item_count=count, source_rank_offset=offset,
            created_at=attempt, updated_at=attempt)
        db.add(receipt)
    try:
        db.commit()
        db.refresh(receipt)
    except IntegrityError:
        db.rollback()
        raise DailyResearchError("该批次已被接收，请使用相同标识查询结果", 409) from None
    from app.services import agent_activity_service
    ctx = SimpleNamespace(db=db, user=db.get(User, user_id), run=run)
    receipt_id = receipt.id
    def active():
        db.expire_all()
        check_desktop(db, user_id=user_id, **identity)
        current = db.query(DailyResearchBatch).filter_by(id=receipt_id).with_for_update().populate_existing().first()
        if not current or current.status != "processing" or aware(current.updated_at) != aware(attempt):
            raise DailyResearchError("批次执行代次已变更，请停止旧任务", 409)
    try:
        result = agent_activity_service.record_snapshot(ctx, {
            "platform": payload["platform"], "mode": payload["source_mode"], "items": payload["items"],
            "source_rank_offset": payload.get("source_rank_offset", 0), "coverage": payload.get("coverage", "partial"),
            "order_reliable": payload.get("order_reliable", False),
        }, check_active=active, on_progress=lambda progress: active(), observed_at=now())
        active()
        saved_result = {**result, "batch_id": payload["batch_id"]}
        changed = db.query(DailyResearchBatch).filter(DailyResearchBatch.id == receipt.id,
            DailyResearchBatch.status == "processing", DailyResearchBatch.updated_at == attempt).update({
                DailyResearchBatch.status: "completed", DailyResearchBatch.result_json: dump(saved_result),
                DailyResearchBatch.updated_at: now()}, synchronize_session=False)
        if not changed:
            raise DailyResearchError("批次执行代次已变更，请重新查询", 409)
        db.commit()
        return saved_result
    except Exception:
        db.rollback()
        db.query(DailyResearchBatch).filter(DailyResearchBatch.id == receipt.id,
            DailyResearchBatch.status == "processing", DailyResearchBatch.updated_at == attempt).update({
                DailyResearchBatch.status: "failed", DailyResearchBatch.updated_at: now()}, synchronize_session=False)
        db.commit()
        raise


def desktop_complete(db, *, user_id, payload):
    run = check_desktop(db, user_id=user_id, **{k: payload[k] for k in ("run_id", "device_id", "lease_token")})
    cfg = config(_rule_valid(db, run))
    sources = payload["sources"]
    expected = {(platform, mode) for platform in cfg["platforms"] for mode in cfg["source_modes"]}
    if {(s["platform"], s["source_mode"]) for s in sources} != expected or len(sources) != len(expected):
        raise DailyResearchError("请报告订阅中每个来源的实际同步结果")
    batches = db.query(DailyResearchBatch).filter_by(run_id=run.id).all()
    if any(batch.status == "processing" for batch in batches):
        raise DailyResearchError("还有批次未完成保存", 409)
    successful = [load(batch.result_json) for batch in batches if batch.status == "completed"]
    stats = {name: sum(int(result.get(field) or 0) for result in successful)
             for name, field in (("saved", "accepted"), ("created", "created"), ("reused", "reused"), ("skipped", "skipped"), ("failed", "failed"))}
    stats["read"] = sum(int(source.get("read") or 0) for source in sources)
    stats["failed"] = max(stats["failed"], sum(int(source.get("failed") or 0) for source in sources))
    for source in sources:
        results = [load(batch.result_json) for batch in batches if batch.status == "completed"
            and batch.platform == source["platform"] and batch.source_mode == source["source_mode"]]
        accounted = sum(int(result.get("accepted") or 0) + int(result.get("skipped") or 0) for result in results)
        failed = max(int(source.get("failed") or 0), sum(int(result.get("failed") or 0) for result in results))
        if int(source.get("read") or 0) > accounted + failed:
            raise DailyResearchError("采集结果尚未全部保存，请续传原批次", 409)
    timestamp = now()
    local_end = timestamp.astimezone(automation_service._timezone(_rule_valid(db, run).timezone))
    window_start = (local_end - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    all_failed = all(s.get("error") or s["coverage"] == "partial" for s in sources) and not stats["saved"]
    coverage = "partial" if any(s.get("error") or s["coverage"] == "partial" or s.get("failed") for s in sources) else "limited" if any(s["coverage"] == "limited" for s in sources) else "complete"
    next_status = "failed" if all_failed else "preparing"
    next_state = {**run.state, "stage": next_status,
        "message": "所有来源同步失败，本次未生成研究报告。" if all_failed else "采集已结束，正在整理研究资料。",
        "sources": sources, "coverage": coverage, "stats": stats,
        "window_end": iso(timestamp), "window_start": iso(window_start),
        "desktop_token": None, "lease_until": None}
    _commit_desktop_transition(db, run, next_state, next_status, finished_at=timestamp if all_failed else None)
    return run_dict(run)


def verified_recipient(db, user_id, email):
    return bool(email and db.query(DailyResearchRecipient).filter_by(user_id=user_id, email=email).filter(
        DailyResearchRecipient.verified_at.is_not(None)).first())


def _code_hash(user_id, email, code):
    return hmac.new(settings.JWT_SECRET.encode(), f"daily-research:{user_id}:{email}:{code}".encode(), hashlib.sha256).hexdigest()


def send_recipient_code(db, *, user_id, email):
    email = automation_service._validate_email(email)
    _lock_user(db, user_id)
    row = db.query(DailyResearchRecipient).filter_by(user_id=user_id, email=email).first()
    if row and row.verified_at:
        return {"email": email, "status": "already_verified", "verified": True, "message": "收件邮箱已验证。"}
    if not email_delivery.is_configured():
        return {"email": email, "status": "not_configured", "verified": False, "message": "邮件服务尚未配置，研究报告仍会保存在站内。"}
    timestamp = now()
    recent = db.query(DailyResearchRecipient).filter(DailyResearchRecipient.user_id == user_id,
        DailyResearchRecipient.sent_at > timestamp - timedelta(seconds=60)).first()
    hourly = db.query(DailyResearchRecipient).filter(DailyResearchRecipient.user_id == user_id,
        DailyResearchRecipient.send_window_at > timestamp - timedelta(hours=1)).all()
    if recent or sum(r.sent_count for r in hourly) >= 5:
        raise DailyResearchError("验证码发送过于频繁，请稍后再试", 429)
    if row is None:
        row = DailyResearchRecipient(user_id=user_id, email=email)
        db.add(row)
    if not row.send_window_at or aware(row.send_window_at) < timestamp - timedelta(hours=1):
        row.send_window_at, row.sent_count = timestamp, 0
    code = f"{secrets.randbelow(1_000_000):06d}"
    row.code_hash = _code_hash(user_id, email, code)
    row.sent_at, row.expires_at, row.attempts = timestamp, timestamp + timedelta(minutes=10), 0
    row.sent_count = (row.sent_count or 0) + 1
    db.commit()
    delivery = email_delivery.send_daily_research_verification(recipient=email, code=code, message_key=uuid.uuid4().hex)
    return {"email": email, "status": delivery["status"], "verified": False,
            "message": "验证码已发送，10 分钟内有效。" if delivery["status"] == "sent" else "验证码未能发送，请稍后再试。"}


def confirm_recipient_code(db, *, user_id, email, code):
    email = automation_service._validate_email(email)
    _lock_user(db, user_id)
    row = db.query(DailyResearchRecipient).filter_by(user_id=user_id, email=email).with_for_update().first()
    if row and row.verified_at:
        return {"email": email, "verified": True}
    if not row or not row.expires_at or aware(row.expires_at) <= now() or row.attempts >= 5:
        raise DailyResearchError("验证码无效或已过期，请重新发送")
    row.attempts += 1
    matched = hmac.compare_digest(row.code_hash or "", _code_hash(user_id, email, code))
    if matched:
        row.verified_at, row.code_hash, row.expires_at = now(), None, None
    db.commit()
    if not matched:
        raise DailyResearchError("验证码不正确")
    return {"email": email, "verified": True}


def status(db, user):
    from app.services.automation_runner import runner
    runtime = runner.status()
    latest = db.query(DailyResearchDevice).filter_by(user_id=user.id).order_by(DailyResearchDevice.last_seen_at.desc()).first()
    recipients = db.query(DailyResearchRecipient).filter_by(user_id=user.id).all()
    return {"scheduler": {"enabled": runtime["enabled"], "running": runtime["running"]},
        "email": email_delivery.public_status(), "desktop": {"online": bool(latest and aware(latest.last_seen_at) > now() - timedelta(seconds=90)),
        "last_seen_at": iso(latest.last_seen_at) if latest else None}, "limits": LIMITS,
        "recipients": [{"email": row.email, "verified": bool(row.verified_at)} for row in recipients], "account_email": user.email}


def snapshot_sources(db, run, rule):
    state, cfg = run.state, config(rule)
    start, end = datetime.fromisoformat(state["window_start"]), datetime.fromisoformat(state["window_end"])
    hidden = select(LibraryHiddenItem.aweme_id).where(LibraryHiddenItem.user_id == run.user_id)
    rows = db.query(VideoSourceLedger, Note).join(Note, Note.id == VideoSourceLedger.note_id).filter(
        VideoSourceLedger.user_id == run.user_id, Note.user_id == run.user_id,
        VideoSourceLedger.source_mode.in_(cfg["source_modes"]), VideoSourceLedger.first_seen_at >= start,
        VideoSourceLedger.first_seen_at <= end, VideoSourceLedger.video_id.not_in(hidden)).all()
    merged = {}
    for ledger, note in rows:
        meta = load(note.ai_summary).get("source_meta", {})
        platform = "bilibili" if note.video_id.startswith("BV") else "douyin"
        if platform not in cfg["platforms"]:
            continue
        source = merged.setdefault(note.video_id, {"video_id": note.video_id, "note_id": note.id,
            "title": note.video_title, "url": f"https://www.douyin.com/video/{note.video_id}",
            "author_name": meta.get("author_name", ""), "caption": meta.get("caption", ""),
            "modes": [], "engagement": meta.get("engagement") or {}, "first_seen_at": iso(ledger.first_seen_at),
            "evidence_level": "transcript" if (note.transcript_raw or "").strip() else "metadata"})
        source["modes"].append(ledger.source_mode)
    topics = cfg["focus_topics"]
    for source in merged.values():
        text = f"{source['title']} {source['caption']}".casefold()
        matches = [topic for topic in topics if topic.casefold() in text]
        engagement = source["engagement"]
        hot = sum(math.log1p(max(0, float(engagement.get(key) or 0))) * weight
                  for key, weight in (("likes", 1), ("comments", 2), ("shares", 3), ("collects", 3)))
        source["score"] = round(len(matches) * 100 + hot + int(source["evidence_level"] == "transcript") * 2, 2)
        source["recommendation_reason"] = ("匹配关注方向：" + "、".join(matches)) if matches else "结合本批公开互动数据优先初筛" if engagement else "缺少互动数据，按新增资料纳入待研究清单"
    return sorted(merged.values(), key=lambda row: (row["engagement"].get("likes") is None,
        -int(row["engagement"].get("likes") or 0), -row["score"], row["video_id"]))


def _active_research(db, run_id, token):
    db.expire_all()
    run = db.get(AgentAutomationRun, run_id)
    if not run or run.status != "researching" or run.execution_token != token:
        raise DailyResearchError("研究任务已停止", 409)
    _rule_valid(db, run)
    return run


def _reserve_report_charge(db, user_id, run_id):
    from app.services import chat_credit_billing_service, chat_model_catalog_service, user_ai_provider_service
    if user_ai_provider_service.uses_custom_provider(db, user_id):
        return None
    offering = chat_model_catalog_service.selected_offering(db, user_id)
    return chat_credit_billing_service.reserve(db, user_id=user_id, offering=offering, request_id=f"daily-research:{run_id}")


def _settle_charge(db, charge, *, completed):
    from app.services import chat_credit_billing_service as billing
    reservation = db.query(ChatModelChargeReservation).filter_by(request_id=charge.request_id).with_for_update().populate_existing().first()
    if reservation is not None and reservation.state != "reserved":
        return
    if reservation is not None and reservation.kind == "free":
        # 崩溃恢复可能跨过午夜，必须归还预留当天的额度，不能修改今天的计数。
        day = aware(reservation.created_at).astimezone(automation_service._timezone("Asia/Shanghai")).date()
        usage = db.query(ChatModelFreeUsage).filter_by(user_id=reservation.user_id,
            offering_id=reservation.offering_id, period_date=day).with_for_update().populate_existing().first()
        if usage and usage.reserved_count > 0:
            usage.reserved_count -= 1
            usage.used_count += int(completed)
        reservation.state = "captured" if completed else "released"
        db.commit()
        return
    (billing.capture if completed else billing.release)(db, charge)


def _recover_charges(db, *, user_id=None):
    from app.services.chat_credit_billing_service import ChatCharge
    query = db.query(ChatModelChargeReservation).filter(ChatModelChargeReservation.state == "reserved",
        ChatModelChargeReservation.request_id.like("daily-research:%"))
    if user_id:
        query = query.filter(ChatModelChargeReservation.user_id == user_id)
    for reservation in query.limit(100).all():
        run_id = reservation.request_id.removeprefix("daily-research:")
        run = db.get(AgentAutomationRun, run_id, populate_existing=True)
        if run is None or run.status not in TERMINAL:
            continue
        charge = ChatCharge(reservation.request_id, reservation.offering_id, reservation.user_id,
            reservation.kind, int(reservation.points or 0))
        _settle_charge(db, charge, completed=bool(run.state.get("model_completed")))


def execute_research(db, *, run_id):
    """每个运行只领取一次研究权；报告先落库，再跨越 SMTP 不确定边界。"""
    run = db.get(AgentAutomationRun, run_id)
    if run is None or run.status != "preparing":
        return run
    rule = _rule_valid(db, run)
    token = secrets.token_hex(24)
    claimed = db.query(AgentAutomationRun).filter(AgentAutomationRun.id == run_id,
        AgentAutomationRun.status == "preparing").update({AgentAutomationRun.status: "researching",
        AgentAutomationRun.execution_token: token, AgentAutomationRun.heartbeat_at: now(),
        AgentAutomationRun.state_json: dump({**run.state, "stage": "researching", "message": "正在整理主题、依据和研究建议。"})}, synchronize_session=False)
    db.commit()
    if not claimed:
        return db.get(AgentAutomationRun, run_id, populate_existing=True)
    from app.services import agent_service, agent_video_link_service, chat_credit_billing_service
    charge = None
    try:
        run = _active_research(db, run_id, token)
        sources = snapshot_sources(db, run, rule)
        limitations = ["新增依据知萃首次发现时间，并非真实点赞或收藏日期。", "本报告未核验原片画面；公开文案初筛与完整文稿证据分别标注。"]
        if run.state.get("coverage") != "complete":
            limitations.append("平台清单覆盖有限或部分失败，本报告不代表全部喜欢和收藏。")
        if not sources:
            run.source_count = 0
            run.result_text = "近两日没有新发现的资料，本次未调用模型，也没有发送邮件。"
            run.result_json = dump({"report": {"title": "每日视频研究", "markdown": run.result_text,
                "source_count": 0, "sources": [], "limitations": limitations,
                "window_start": run.state["window_start"], "window_end": run.state["window_end"]}})
            run.status = "completed"
            run.state_json = dump({**run.state, "stage": "completed", "message": "近两日无新增资料。"})
            run.finished_at = now()
            rule.last_run_at = run.finished_at
            db.commit()
            return run
        # 使用现有文稿提取入口，限制代表样本数量；不调用视觉解析或绕过其收费流程。
        # 聊天额度先预留，额度不足时不产生新的 ASR/模型工作。
        charge = _reserve_report_charge(db, run.user_id, run_id)
        attempts = []
        for source in [row for row in sources if row["evidence_level"] == "metadata"][:LIMITS["transcript_sample_limit"]]:
            _active_research(db, run_id, token)
            try:
                result = agent_video_link_service.transcribe_note(db, user_id=run.user_id, note_id=source["note_id"],
                    check_active=lambda: _active_research(db, run_id, token))
                ready = bool((result.get("transcript_raw") or "").strip())
                source["evidence_level"] = "transcript" if ready else "metadata"
                attempts.append({"note_id": source["note_id"], "status": "ready" if ready else "no_audio"})
            except DailyResearchError:
                raise
            except Exception:
                db.rollback()
                attempts.append({"note_id": source["note_id"], "status": "unavailable"})
        run = _active_research(db, run_id, token)
        note_ids = [source["note_id"] for source in sources if source["evidence_level"] == "transcript"][:LIMITS["max_research_sources"]]
        notes = db.query(Note).filter(Note.user_id == run.user_id, Note.id.in_(note_ids)).all() if note_ids else []
        note_map = {note.id: note for note in notes}
        notes = [note_map[note_id] for note_id in note_ids if note_id in note_map]
        research = ""
        if notes:
            thread = agent_service.create_thread_from_notes(db, user_id=run.user_id, notes=notes,
                title="每日视频研究", scope_label="近两日首次发现的完整文稿", scope_type="selected")
            run.agent_thread_id = thread.id
            db.commit()
            popularity = "\n".join(f"{source['title'][:100]}：点赞 {source['engagement'].get('likes') if source['engagement'].get('likes') is not None else '未知'}"
                for source in sources if source["note_id"] in note_ids)
            _, answer = agent_service.ask_thread(db, thread=thread,
                content=f"{rule.instruction} 关注方向：{'、'.join(config(rule)['focus_topics']) or '综合价值'}。保留来源引用，引用开头原文需与文稿精确匹配。以下为按点赞数排列的公开数据，热度不等于内容真实性：\n{popularity}",
                research_mode="deep", output_style="custom", web_scope="video_only", allow_video_analysis=False,
                custom_instruction="仅对给定完整文稿做有据研究；不得声称看过原片，不把标题、热度或模型推断当作已证实结论。",
                progress_callback=lambda event: _research_progress(db, run_id, token, event))
            research = answer.content
            run = _active_research(db, run_id, token)
            run.state_json = dump({**run.state, "model_completed": True})
            run.result_text = research
            db.commit()
        if not notes:
            limitations.append("本次没有可读取的完整文稿，以下仅为公开标题、发布文案和互动数据初筛。")
        missing = sum(source["evidence_level"] != "transcript" for source in sources)
        if missing:
            limitations.append(f"{missing} 条资料尚无完整文稿；本次最多尝试提取 3 条代表样本，其余没有逐条观看。")
        if len(note_ids) < sum(source["evidence_level"] == "transcript" for source in sources):
            limitations.append("完整文稿研究最多纳入 100 条，完整新增清单仍保存在报告中。")
        title = f"每日视频研究 · {now().astimezone(automation_service._timezone(rule.timezone)).strftime('%m月%d日')}"
        lines = [f"# {title}", f"近两日首次发现 {len(sources)} 部视频，{len(notes)} 部完整文稿参与研究。", research,
                 "## 按已知点赞数排序的研究清单（点赞数未知的排在末尾）"]
        for index, source in enumerate(sources[:12], 1):
            basis = "完整文稿" if source["evidence_level"] == "transcript" else "公开元数据，待核实"
            likes = source["engagement"].get("likes")
            lines.extend([f"{index}. [{source['title']}]({source['url']})", f"   点赞：{likes if likes is not None else '未知'}；{source['recommendation_reason']}；依据：{basis}。"])
        lines.extend(["## 覆盖范围与限制", *[f"- {item}" for item in limitations]])
        markdown = "\n\n".join(line for line in lines if line)
        run = _active_research(db, run_id, token)
        report = {"title": title, "markdown": markdown, "sources": sources, "source_count": len(sources),
            "transcript_count": len(notes), "window_start": run.state["window_start"], "window_end": run.state["window_end"],
            "coverage": run.state.get("coverage", "partial"), "sync_sources": run.state.get("sources", []),
            "limitations": limitations, "transcript_attempts": attempts}
        run.source_count = len(sources)
        run.result_text = markdown
        run.result_json = dump({"report": report})
        db.commit()
        if charge:
            _settle_charge(db, charge, completed=bool(notes))
            charge = None
        run = _active_research(db, run_id, token)
        rule = _rule_valid(db, run)
        if not rule.recipient_email:
            delivery = {"status": "skipped", "error": "未设置收件邮箱，报告已保存在站内。"}
        elif not email_delivery.is_configured():
            delivery = {"status": "not_configured", "error": "邮件服务尚未配置，报告已保存在站内。"}
        elif not verified_recipient(db, run.user_id, rule.recipient_email):
            delivery = {"status": "verification_required", "error": "收件邮箱尚未验证，报告已保存在站内。"}
        else:
            run.delivery_status = "delivering"
            db.commit()
            # 领取投递边界后再次核验版本；之后SMTP的不确定结果绝不自动重发。
            db.query(AgentAutomation).filter(AgentAutomation.id == rule.id).with_for_update().populate_existing().first()
            try:
                rule = _rule_valid(db, run)
            except DailyResearchError:
                run.delivery_status = "skipped"
                db.commit()
                raise
            delivery = email_delivery.send_digest(recipient=rule.recipient_email, title=title, body=markdown,
                source_count=len(sources), thread_id=run.agent_thread_id, idempotency_key=run.idempotency_key,
                report_url=f"{settings.PUBLIC_APP_URL.rstrip('/')}/daily-research?run={run.id}", research_report=True)
        run.delivery_status, run.delivery_error = delivery["status"], delivery.get("error") or None
        run.status = "partial" if missing or run.state.get("coverage") == "partial" else "completed"
        run.state_json = dump({**run.state, "stage": run.status, "message": "研究报告已保存。"})
        run.finished_at = now()
        rule.last_run_at = run.finished_at
        db.commit()
        return run
    except Exception as exc:
        db.rollback()
        if charge:
            try:
                saved = db.get(AgentAutomationRun, run_id, populate_existing=True)
                _settle_charge(db, charge, completed=bool(saved and saved.state.get("model_completed")))
            except Exception:
                db.rollback()
        run = db.get(AgentAutomationRun, run_id, populate_existing=True)
        if run and run.status not in TERMINAL:
            uncertain = run.delivery_status == "delivering"
            run.status = "partial" if uncertain or run.result_text else "cancelled" if isinstance(exc, DailyResearchError) and exc.status == 409 else "failed"
            run.delivery_status = "unknown" if uncertain else "skipped"
            run.delivery_error = "邮件提交状态未确认，为避免重复发送不会自动重发。" if uncertain else "研究暂未完成，请检查额度、模型服务或订阅状态。"
            run.state_json = dump({**run.state, "stage": run.status, "message": run.delivery_error})
            run.finished_at = now()
            db.commit()
        return run


def _research_progress(db, run_id, token, event):
    run = _active_research(db, run_id, token)
    run.state_json = dump({**run.state, "stage": "researching", "message": str(event.get("message") or "正在研究完整文稿。")[:400]})
    run.heartbeat_at = now()
    db.commit()
