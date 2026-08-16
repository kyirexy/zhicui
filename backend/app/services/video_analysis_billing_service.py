"""萃点、免费额度与平台成本的权威结算服务。"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Mapping
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.video_analysis import (
    POINTS_PER_CNY,
    AnalysisCreditLedger,
    UserAnalysisAccount,
    VideoAnalysisFreeUsage,
    VideoAnalysisItem,
    VideoAnalysisOfferingVersion,
)
from app.services import video_analysis_catalog_service as catalog


class VideoAnalysisBillingError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _load_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _lock(query: Any, db: Session) -> Any:
    if db.bind is not None and db.bind.dialect.name != "sqlite":
        return query.with_for_update()
    return query


def _locked_item(db: Session, item: VideoAnalysisItem) -> VideoAnalysisItem:
    query = db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item.id)
    # 强制刷新可避免 Session identity map 在等待行锁后仍返回旧 billing_status。
    # complete_item 在进入结算前已经 flush 时长/指纹，因此不会丢失同事务写入。
    locked = _lock(query, db).populate_existing().first()
    if locked is None:
        raise VideoAnalysisBillingError("item_not_found", "解析子任务不存在", status_code=404)
    return locked


def _ledger_entry(db: Session, idempotency_key: str) -> AnalysisCreditLedger | None:
    return (
        db.query(AnalysisCreditLedger)
        .filter(AnalysisCreditLedger.idempotency_key == idempotency_key)
        .first()
    )


def get_or_create_account(
    db: Session,
    user_id: str,
    *,
    lock: bool = False,
) -> UserAnalysisAccount:
    query = db.query(UserAnalysisAccount).filter(UserAnalysisAccount.user_id == user_id)
    if lock:
        query = _lock(query, db)
    account = query.first()
    if account is None:
        account = UserAnalysisAccount(user_id=user_id)
        db.add(account)
        db.flush()
    return account


def list_ledger(
    db: Session,
    *,
    user_id: str | None = None,
    run_id: str | None = None,
    limit: int = 50,
) -> list[AnalysisCreditLedger]:
    query = db.query(AnalysisCreditLedger)
    if user_id is not None:
        query = query.filter(AnalysisCreditLedger.user_id == user_id)
    if run_id is not None:
        query = query.filter(AnalysisCreditLedger.run_id == run_id)
    return (
        query.order_by(AnalysisCreditLedger.created_at.desc(), AnalysisCreditLedger.id.desc())
        .limit(max(1, min(int(limit), 500)))
        .all()
    )


def serialize_ledger_entry(row: AnalysisCreditLedger) -> dict[str, Any]:
    metadata = _load_dict(row.metadata_json)
    points = metadata.get("points")
    if points is None:
        if row.entry_type in {"reserve", "capture"}:
            points = abs(int(row.reserved_delta or 0))
        else:
            points = abs(int(row.available_delta or 0))
    return {
        "id": row.id,
        "kind": row.entry_type,
        "entry_type": row.entry_type,
        "points": _nonnegative_int(points),
        "available_delta": int(row.available_delta or 0),
        "reserved_delta": int(row.reserved_delta or 0),
        "balance_after": int(row.available_after or 0),
        "available_after": int(row.available_after or 0),
        "reserved_after": int(row.reserved_after or 0),
        "reason": row.reason,
        "run_id": row.run_id,
        "item_id": row.item_id,
        "admin_user_id": row.admin_user_id,
        "metadata": metadata,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def serialize_account(
    db: Session,
    account: UserAnalysisAccount,
    *,
    ledger_limit: int = 20,
) -> dict[str, Any]:
    ledger = list_ledger(db, user_id=account.user_id, limit=ledger_limit)
    return {
        "user_id": account.user_id,
        "available_points": int(account.available_points or 0),
        "reserved_points": int(account.reserved_points or 0),
        "total_points": int(account.available_points or 0)
        + int(account.reserved_points or 0),
        "points_per_cny": POINTS_PER_CNY,
        "agent_auto_paid_enabled": bool(account.agent_auto_paid_enabled),
        "agent_per_run_limit_points": int(account.agent_per_run_limit_points or 0),
        "agent_daily_limit_points": int(account.agent_daily_limit_points or 0),
        "agent_byok_enabled": bool(account.agent_byok_enabled),
        "recent_ledger": [serialize_ledger_entry(row) for row in ledger],
        "updated_at": account.updated_at.isoformat() if account.updated_at else None,
    }


def _append_ledger(
    db: Session,
    account: UserAnalysisAccount,
    *,
    entry_type: str,
    available_delta: int,
    reserved_delta: int,
    idempotency_key: str,
    reason: str,
    run_id: str | None = None,
    item_id: str | None = None,
    admin_user_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> AnalysisCreditLedger:
    existing = _ledger_entry(db, idempotency_key)
    if existing is not None:
        return existing
    row = AnalysisCreditLedger(
        user_id=account.user_id,
        run_id=run_id,
        item_id=item_id,
        entry_type=entry_type[:24],
        available_delta=int(available_delta),
        reserved_delta=int(reserved_delta),
        available_after=int(account.available_points or 0),
        reserved_after=int(account.reserved_points or 0),
        idempotency_key=str(idempotency_key)[:180],
        reason=str(reason or "")[:256],
        admin_user_id=admin_user_id,
        metadata_json=_dump(dict(metadata or {})),
    )
    db.add(row)
    db.flush()
    return row


def adjust_credits(
    db: Session,
    *,
    user_id: str,
    points_delta: int,
    reason: str,
    admin_user_id: str,
    idempotency_key: str,
    entry_type: str = "adjustment",
) -> UserAnalysisAccount:
    delta = int(points_delta)
    if delta == 0:
        raise VideoAnalysisBillingError("zero_adjustment", "萃点调整数量不能为 0")
    clean_reason = str(reason or "").strip()
    if not clean_reason:
        raise VideoAnalysisBillingError("reason_required", "萃点调整必须填写原因")
    if entry_type in {"grant", "purchase", "refund"} and delta < 0:
        raise VideoAnalysisBillingError(
            "invalid_credit_direction",
            "发放、购买或退款账本记录必须增加萃点",
        )
    existing = _ledger_entry(db, idempotency_key)
    if existing is not None:
        return get_or_create_account(db, user_id)
    account = get_or_create_account(db, user_id, lock=True)
    # 第一次查询与账户行锁之间，另一请求可能已经完成同一调整。
    if _ledger_entry(db, idempotency_key) is not None:
        return account
    if int(account.available_points or 0) + delta < 0:
        raise VideoAnalysisBillingError(
            "insufficient_points", "可用萃点不足，无法完成扣减", status_code=409
        )
    account.available_points = int(account.available_points or 0) + delta
    account.version = int(account.version or 0) + 1
    _append_ledger(
        db,
        account,
        entry_type=(
            entry_type
            if entry_type in {"grant", "purchase", "adjustment", "refund"}
            else "adjustment"
        ),
        available_delta=delta,
        reserved_delta=0,
        idempotency_key=idempotency_key,
        reason=clean_reason,
        admin_user_id=admin_user_id,
        metadata={"points": abs(delta)},
    )
    db.commit()
    db.refresh(account)
    return account


def _period_key(period: str, now: datetime | None = None) -> str:
    local = (now or _utcnow()).astimezone(ZoneInfo("Asia/Shanghai"))
    if period == "day":
        return local.strftime("%Y-%m-%d")
    if period == "month":
        return local.strftime("%Y-%m")
    return "lifetime"


def _quota_units(quota: Mapping[str, Any], duration_ms: int) -> int:
    if str(quota.get("unit") or "run") == "minute":
        return max(1, math.ceil(max(1, duration_ms) / 60_000))
    return 1


def _quota_row(
    db: Session,
    *,
    user_id: str,
    quota: Mapping[str, Any],
    lock: bool = False,
) -> VideoAnalysisFreeUsage | None:
    if not quota:
        return None
    scope = str(quota.get("scope") or "")[:64]
    period_key = str(quota.get("period_key") or _period_key(str(quota.get("period") or "month")))
    query = db.query(VideoAnalysisFreeUsage).filter(
        VideoAnalysisFreeUsage.user_id == user_id,
        VideoAnalysisFreeUsage.quota_scope == scope,
        VideoAnalysisFreeUsage.period_key == period_key,
    )
    if lock:
        query = _lock(query, db)
    row = query.first()
    if row is None and lock:
        row = VideoAnalysisFreeUsage(
            user_id=user_id,
            quota_scope=scope,
            period_key=period_key,
            unit_type=str(quota.get("unit") or "run")[:16],
        )
        db.add(row)
        db.flush()
    return row


def _formula_points(
    pricing: Mapping[str, Any],
    limits: Mapping[str, Any],
    *,
    duration_ms: int,
    frames: int,
    media_units: int,
    use_byok: bool,
) -> int:
    increment_ms = max(1, _nonnegative_int(pricing.get("billing_increment_seconds")) or 60) * 1000
    duration_units = max(1, math.ceil(max(1, duration_ms) / increment_ms))
    base = (
        _nonnegative_int(pricing.get("byok_processing_points"))
        if use_byok
        else _nonnegative_int(pricing.get("base_points"))
    )
    points = (
        base
        + duration_units * _nonnegative_int(pricing.get("per_minute_points"))
        + min(frames, _nonnegative_int(limits.get("max_frames")))
        * _nonnegative_int(pricing.get("per_frame_points"))
        + min(media_units, _nonnegative_int(limits.get("max_provider_calls")))
        * _nonnegative_int(pricing.get("per_media_unit_points"))
    )
    points = max(points, _nonnegative_int(pricing.get("min_points")))
    cap = _nonnegative_int(pricing.get("max_points"))
    if cap:
        points = min(points, cap)
    return max(0, int(points))


def quote_item(
    db: Session,
    *,
    user_id: str,
    version: VideoAnalysisOfferingVersion,
    duration_ms: int,
    use_byok: bool,
    effective_limits: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    pricing = catalog._normalize_pricing(version.pricing_json)
    limits = catalog._normalize_limits(effective_limits or version.limits_json)
    duration = max(0, int(duration_ms or 0))
    maximum_points = _formula_points(
        pricing,
        limits,
        duration_ms=duration,
        frames=limits["max_frames"],
        media_units=limits["max_provider_calls"],
        use_byok=use_byok,
    )
    quota = catalog._normalize_free_quota(version.free_quota_json, version.code)
    quota_snapshot: dict[str, Any] = {}
    free_units = 0
    if quota:
        required_units = _quota_units(quota, duration)
        period_key = _period_key(str(quota.get("period") or "month"))
        quota_for_lookup = {**quota, "period_key": period_key}
        row = _quota_row(db, user_id=user_id, quota=quota_for_lookup)
        used = int(row.used_units or 0) if row else 0
        reserved = int(row.reserved_units or 0) if row else 0
        remaining = max(0, int(quota.get("units") or 0) - used - reserved)
        eligible = remaining >= required_units
        free_units = required_units if eligible else 0
        quota_snapshot = {
            **quota,
            "period_key": period_key,
            "required_units": required_units,
            "remaining_units_at_quote": remaining,
            "eligible": eligible,
        }
    quoted_points = 0 if free_units else maximum_points
    duration_units = max(
        1,
        math.ceil(
            max(1, duration)
            / (max(1, int(pricing.get("billing_increment_seconds") or 60)) * 1000)
        ),
    )
    return {
        "billing_quantity": duration_units
        if pricing.get("billing_unit") == "minute"
        else 1,
        "quoted_points": quoted_points,
        "max_points": quoted_points,
        "formula_max_points": maximum_points,
        "free_units": free_units,
        "pricing_snapshot": {
            **pricing,
            "limits": limits,
            "duration_ms": duration,
            "quoted_max_frames": limits["max_frames"],
            "quoted_max_provider_calls": limits["max_provider_calls"],
        },
        "quota_snapshot": quota_snapshot,
    }


def reserve_item(
    db: Session,
    item: VideoAnalysisItem,
    *,
    account: UserAnalysisAccount | None = None,
) -> None:
    item = _locked_item(db, item)
    if item.billing_status in {"reserved", "captured", "not_billable"}:
        return
    account = account or get_or_create_account(db, item.user_id, lock=True)
    reserve_key = f"video-analysis:reserve:{item.id}"
    if _ledger_entry(db, reserve_key) is not None:
        return
    points = _nonnegative_int(item.quoted_points)
    free_units = _nonnegative_int(item.free_units_reserved)
    if free_units:
        quota = _load_dict(item.quota_snapshot_json)
        row = _quota_row(db, user_id=item.user_id, quota=quota, lock=True)
        if row is None:
            raise VideoAnalysisBillingError("free_quota_unavailable", "免费额度不可用", status_code=409)
        total = _nonnegative_int(quota.get("units"))
        if int(row.used_units or 0) + int(row.reserved_units or 0) + free_units > total:
            raise VideoAnalysisBillingError(
                "free_quota_exhausted", "免费额度已被其他任务占用，请重新报价", status_code=409
            )
        row.reserved_units = int(row.reserved_units or 0) + free_units
    if points:
        if int(account.available_points or 0) < points:
            raise VideoAnalysisBillingError(
                "insufficient_points", "可用萃点不足，请先联系管理员补充", status_code=409
            )
        account.available_points = int(account.available_points or 0) - points
        account.reserved_points = int(account.reserved_points or 0) + points
        account.version = int(account.version or 0) + 1
        _append_ledger(
            db,
            account,
            entry_type="reserve",
            available_delta=-points,
            reserved_delta=points,
            idempotency_key=reserve_key,
            reason="视频详细解析预留",
            run_id=item.run_id,
            item_id=item.id,
            metadata={"points": points},
        )
        item.reserved_points = points
        item.billing_status = "reserved"
    elif free_units:
        item.billing_status = "reserved"
    else:
        item.billing_status = "not_billable"
    db.flush()


def capture_item(
    db: Session,
    item: VideoAnalysisItem,
    *,
    actual_points: int,
    platform_cost_micros: int = 0,
) -> None:
    item = _locked_item(db, item)
    if item.billing_status == "captured":
        return
    account = get_or_create_account(db, item.user_id, lock=True)
    capture_key = f"video-analysis:capture:{item.id}"
    release_key = f"video-analysis:release-difference:{item.id}"
    if _ledger_entry(db, capture_key) is not None:
        return
    reserved = _nonnegative_int(item.reserved_points)
    actual = _nonnegative_int(actual_points)
    if actual > reserved:
        raise VideoAnalysisBillingError(
            "reauthorization_required", "实际用量超过已授权上限", status_code=409
        )
    if reserved:
        release = reserved - actual
        account.reserved_points = max(0, int(account.reserved_points or 0) - actual)
        account.version = int(account.version or 0) + 1
        _append_ledger(
            db,
            account,
            entry_type="capture",
            available_delta=0,
            reserved_delta=-actual,
            idempotency_key=capture_key,
            reason="视频详细解析结算",
            run_id=item.run_id,
            item_id=item.id,
            metadata={"points": actual},
        )
        if release:
            account.reserved_points = max(0, int(account.reserved_points or 0) - release)
            account.available_points = int(account.available_points or 0) + release
            _append_ledger(
                db,
                account,
                entry_type="release",
                available_delta=release,
                reserved_delta=-release,
                idempotency_key=release_key,
                reason="视频详细解析未使用预留释放",
                run_id=item.run_id,
                item_id=item.id,
                metadata={"points": release},
            )
    free_units = _nonnegative_int(item.free_units_reserved)
    if free_units:
        quota = _load_dict(item.quota_snapshot_json)
        row = _quota_row(db, user_id=item.user_id, quota=quota, lock=True)
        if row is not None:
            row.reserved_units = max(0, int(row.reserved_units or 0) - free_units)
            row.used_units = int(row.used_units or 0) + free_units
        item.free_units_captured = free_units
    item.captured_points = actual
    item.platform_cost_micros = 0 if item.use_byok else _nonnegative_int(platform_cost_micros)
    item.billing_status = "captured" if (reserved or free_units or actual) else "not_billable"
    db.flush()


def release_item(
    db: Session,
    item: VideoAnalysisItem,
    *,
    reason: str = "视频详细解析未执行，释放预留",
) -> None:
    item = _locked_item(db, item)
    if item.billing_status in {"released", "captured", "refunded", "not_billable"}:
        return
    account = get_or_create_account(db, item.user_id, lock=True)
    release_key = f"video-analysis:release:{item.id}"
    if _ledger_entry(db, release_key) is not None:
        return
    reserved = _nonnegative_int(item.reserved_points)
    if reserved:
        account.reserved_points = max(0, int(account.reserved_points or 0) - reserved)
        account.available_points = int(account.available_points or 0) + reserved
        account.version = int(account.version or 0) + 1
        _append_ledger(
            db,
            account,
            entry_type="release",
            available_delta=reserved,
            reserved_delta=-reserved,
            idempotency_key=release_key,
            reason=reason,
            run_id=item.run_id,
            item_id=item.id,
            metadata={"points": reserved},
        )
    free_units = _nonnegative_int(item.free_units_reserved)
    if free_units:
        quota = _load_dict(item.quota_snapshot_json)
        row = _quota_row(db, user_id=item.user_id, quota=quota, lock=True)
        if row is not None:
            row.reserved_units = max(0, int(row.reserved_units or 0) - free_units)
    item.billing_status = "released" if (reserved or free_units) else "not_billable"
    db.flush()


def refund_item(
    db: Session,
    item: VideoAnalysisItem,
    *,
    reason: str,
    points: int | None = None,
) -> None:
    item = _locked_item(db, item)
    if item.billing_status == "refunded":
        return
    refund = min(
        _nonnegative_int(item.captured_points),
        _nonnegative_int(item.captured_points if points is None else points),
    )
    if refund:
        account = get_or_create_account(db, item.user_id, lock=True)
        refund_key = f"video-analysis:refund:{item.id}"
        if _ledger_entry(db, refund_key) is not None:
            return
        account.available_points = int(account.available_points or 0) + refund
        account.version = int(account.version or 0) + 1
        _append_ledger(
            db,
            account,
            entry_type="refund",
            available_delta=refund,
            reserved_delta=0,
            idempotency_key=refund_key,
            reason=reason,
            run_id=item.run_id,
            item_id=item.id,
            metadata={"points": refund},
        )
    item.billing_status = "refunded"
    db.flush()


def calculate_actual_charge(
    db: Session,
    item: VideoAnalysisItem,
    *,
    result_usage: Mapping[str, Any] | None = None,
) -> dict[str, int]:
    usage = dict(result_usage or {})
    pricing_snapshot = _load_dict(item.pricing_snapshot_json)
    limits = _load_dict(pricing_snapshot.get("limits"))
    frames = _nonnegative_int(
        usage.get("frame_count") or usage.get("image_count")
    )
    media_units = _nonnegative_int(
        usage.get("provider_units")
        or usage.get("calls")
        or usage.get("model_calls")
    )
    duration_ms = _nonnegative_int(
        usage.get("billable_duration_ms", item.source_duration_ms)
    )
    computed_points = _formula_points(
        pricing_snapshot,
        limits,
        duration_ms=duration_ms,
        frames=frames,
        media_units=media_units,
        use_byok=bool(item.use_byok),
    )
    if item.free_units_reserved:
        computed_points = 0
    reserved_points = _nonnegative_int(item.reserved_points)
    if computed_points > reserved_points:
        from app.models.video_analysis import VideoAnalysisRun

        item.status = "reauthorization_required"
        item.error_code = "reauthorization_required"
        item.error_detail = "实际用量超过已授权萃点上限"
        run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
        if run is not None:
            run.status = "reauthorization_required"
            run.error_code = "reauthorization_required"
            run.error_detail = "实际用量超过已授权萃点上限"
        db.commit()
        raise VideoAnalysisBillingError(
            "reauthorization_required", "实际用量超过已授权上限", status_code=409
        )
    points = computed_points
    cost_micros = 0 if item.use_byok else _nonnegative_int(usage.get("platform_cost_micros"))
    return {"points": points, "cost_micros": cost_micros}


def captured_points_today(db: Session, user_id: str) -> int:
    local = _utcnow().astimezone(ZoneInfo("Asia/Shanghai"))
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start_local.astimezone(timezone.utc)
    return int(
        db.query(func.coalesce(func.sum(VideoAnalysisItem.captured_points), 0))
        .filter(
            VideoAnalysisItem.user_id == user_id,
            VideoAnalysisItem.finished_at >= start_utc,
        )
        .scalar()
        or 0
    )
