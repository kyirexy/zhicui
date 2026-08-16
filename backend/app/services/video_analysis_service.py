"""按需视频详细解析的报价、确认、持久任务与结果编排。"""

from __future__ import annotations

import json
import math
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.note import Note
from app.models.user import User
from app.models.video_analysis import (
    VideoAnalysis,
    VideoAnalysisItem,
    VideoAnalysisOffering,
    VideoAnalysisOfferingVersion,
    VideoAnalysisRun,
    VisionProvider,
)
from app.services import video_analysis_billing_service as billing
from app.services import video_analysis_catalog_service as catalog
from app.services.video_analysis_engine import (
    assess_media_eligibility,
    build_source_fingerprint,
    merge_detailed_analysis_summary,
)


ACTIVE_RUN_STATUSES = {"queued", "running", "reauthorization_required"}
TERMINAL_ITEM_STATUSES = {
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "cached",
    "unsupported",
}
SUCCESS_ITEM_STATUSES = {"succeeded", "partial", "cached"}

_CLAIM_LOCK = threading.Lock()
_PREPARE_LOCK = threading.RLock()
_DURATION_PROBE: Callable[[Note], int] | None = None
_ENQUEUE_HOOK: Callable[[str], None] | None = None


class VideoAnalysisServiceError(ValueError):
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


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _lock(query: Any, db: Session, *, skip_locked: bool = False) -> Any:
    if db.bind is not None and db.bind.dialect.name != "sqlite":
        return query.with_for_update(skip_locked=skip_locked)
    return query


def register_duration_probe(probe: Callable[[Note], int] | None) -> None:
    global _DURATION_PROBE
    _DURATION_PROBE = probe


def register_enqueue_hook(hook: Callable[[str], None] | None) -> None:
    global _ENQUEUE_HOOK
    _ENQUEUE_HOOK = hook


def _notify_enqueued(item_id: str) -> None:
    if _ENQUEUE_HOOK is not None:
        _ENQUEUE_HOOK(item_id)
        return
    try:
        from app.services.video_analysis_worker import notify_item_enqueued

        notify_item_enqueued(item_id)
    except Exception:
        # 数据库 queued 状态是事实来源；worker poller 会在下一轮读取。
        return


def _note_summary(note: Note) -> dict[str, Any]:
    return _load_dict(note.ai_summary)


def _source_meta(note: Note) -> dict[str, Any]:
    value = _note_summary(note).get("source_meta")
    return dict(value) if isinstance(value, dict) else {}


def _source_context(note: Note) -> dict[str, Any]:
    meta = _source_meta(note)
    platform = str(meta.get("platform") or "").strip().lower()
    if not platform:
        try:
            from app.services.video_extractor import _detect_platform

            platform = str(_detect_platform(note.video_url) or "").strip().lower()
        except Exception:
            platform = ""
    media_type = str(meta.get("media_type") or "").strip().lower()
    if not media_type and platform in {"douyin", "bilibili"}:
        media_type = "video"
    return {
        "note": note,
        "platform": platform,
        "media_type": media_type,
        "source_duration_ms": _known_duration_ms(note),
    }


def _known_duration_ms(note: Note) -> int:
    meta = _source_meta(note)
    candidates = (
        (meta.get("duration_ms"), 1),
        (meta.get("duration_seconds"), 1000),
        (meta.get("duration"), 1000),
    )
    for value, multiplier in candidates:
        try:
            parsed = int(float(value) * multiplier)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    if _DURATION_PROBE is not None:
        try:
            return max(0, int(_DURATION_PROBE(note) or 0))
        except Exception:
            return 0
    return 0


def _persist_verified_duration(note: Note, duration_ms: int) -> None:
    verified_duration = max(0, int(duration_ms or 0))
    if not verified_duration:
        return
    summary = _note_summary(note)
    source_meta = summary.get("source_meta")
    source_meta = dict(source_meta) if isinstance(source_meta, dict) else {}
    old_duration = source_meta.get("duration_ms")
    if old_duration and old_duration != verified_duration:
        source_meta["reported_duration_ms"] = old_duration
    source_meta["duration_ms"] = verified_duration
    source_meta["duration_source"] = "server_media_probe"
    source_meta["duration_verified_at"] = _utcnow().isoformat()
    summary["source_meta"] = source_meta
    note.ai_summary = _dump(summary)


def _sanitize_agent_context(value: Mapping[str, Any] | None) -> dict[str, Any]:
    raw = dict(value or {})
    safe: dict[str, Any] = {}
    for key in (
        "question",
        "custom_instruction",
        "request_id",
        "source_snapshot_id",
        "approval_id",
    ):
        if key in raw and raw[key] is not None:
            limit = 1000 if key in {"question", "custom_instruction"} else 160
            safe[key] = str(raw[key]).strip()[:limit]
    research_mode = str(raw.get("research_mode") or "fast").strip()
    safe["research_mode"] = research_mode if research_mode in {"fast", "deep"} else "fast"
    output_style = str(raw.get("output_style") or "answer").strip()
    safe["output_style"] = output_style if output_style in {
        "answer", "summary", "comparison", "action_plan", "custom"
    } else "answer"
    web_scope = str(raw.get("web_scope") or "auto").strip()
    safe["web_scope"] = web_scope if web_scope in {"auto", "video_only"} else "auto"
    note_ids = raw.get("note_ids", raw.get("source_ids"))
    if isinstance(note_ids, list):
        safe["source_ids"] = [str(item)[:64] for item in note_ids[:100]]
    return safe


def _safe_result(value: Any, *, depth: int = 0) -> Any:
    """移除结果中的媒体地址、路径、base64、Cookie 与凭证。"""
    if depth > 8:
        return None
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:256]:
            key = str(raw_key)[:80]
            lowered = key.lower()
            if any(
                marker in lowered
                for marker in (
                    "url",
                    "path",
                    "base64",
                    "cookie",
                    "api_key",
                    "authorization",
                    "credential",
                    "jpeg_bytes",
                )
            ):
                continue
            result[key] = _safe_result(raw_value, depth=depth + 1)
        return result
    if isinstance(value, list):
        return [_safe_result(item, depth=depth + 1) for item in value[:1000]]
    if isinstance(value, str):
        if value.startswith(("data:", "http://", "https://", "file:")):
            return ""
        return value[:20_000]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:1000]


def _offering_and_version(
    db: Session,
    *,
    offering_id: str | None,
    trigger: str,
) -> tuple[VideoAnalysisOffering, VideoAnalysisOfferingVersion]:
    public = catalog.published_catalog(db, trigger=trigger)
    available_ids = {str(item.get("id")) for item in public.get("items", [])}
    if not available_ids:
        raise VideoAnalysisServiceError(
            "no_available_offering", "当前没有可用的视频详细解析方案", status_code=409
        )
    if offering_id:
        offering = catalog.get_offering(db, offering_id)
        if offering is None:
            raise VideoAnalysisServiceError("offering_not_found", "解析方案不存在", status_code=404)
        if offering.id not in available_ids:
            raise VideoAnalysisServiceError(
                "offering_unavailable", "解析方案当前不可用或不支持该触发方式", status_code=409
            )
    else:
        recommended_id = str(public.get("recommended_offering_id") or "")
        offering = catalog.get_offering(db, recommended_id)
        if offering is None:
            raise VideoAnalysisServiceError("offering_not_found", "解析方案不存在", status_code=404)
    version = catalog.current_version(db, offering)
    if version is None:
        raise VideoAnalysisServiceError("offering_version_missing", "解析方案尚未发布", status_code=409)
    return offering, version


def find_cached_analysis(
    db: Session,
    *,
    user_id: str,
    note_id: str,
    offering_version_id: str,
    source_fingerprint: str,
) -> VideoAnalysis | None:
    cached = (
        db.query(VideoAnalysis)
        .filter(
            VideoAnalysis.user_id == user_id,
            VideoAnalysis.note_id == note_id,
            VideoAnalysis.offering_version_id == offering_version_id,
            VideoAnalysis.source_fingerprint == source_fingerprint,
            VideoAnalysis.is_current.is_(True),
            VideoAnalysis.status.in_(["succeeded", "partial"]),
        )
        .order_by(VideoAnalysis.revision.desc())
        .first()
    )
    if cached is None or cached.status != "partial":
        return cached
    version = catalog.get_offering_version(db, offering_version_id)
    if version is None or version.method != "scene_frames_vlm":
        return cached
    payload = _load_dict(cached.result_json)
    quality = payload.get("quality") if isinstance(payload.get("quality"), dict) else {}
    observations = payload.get("visual_observations")
    has_visual_result = bool(
        (isinstance(observations, list) and observations)
        or int(quality.get("visual_batches") or 0) > 0
    )
    # 全批次失败得到的 local-only partial 保留为历史结果，但不能阻止
    # Provider 恢复后的重新视觉解析。
    return cached if has_visual_result else None


def _quota_exhausted_for_zero_price(line: Mapping[str, Any]) -> bool:
    quota = line.get("quota_snapshot")
    return bool(
        isinstance(quota, Mapping)
        and quota
        and not quota.get("eligible")
        and int(line.get("max_points") or 0) == 0
    )


def prepare_run(
    db: Session,
    *,
    user_id: str,
    note_ids: list[str],
    offering_id: str | None = None,
    use_byok: bool = False,
    trigger: str = "manual",
    agent_thread_id: str | None = None,
    agent_turn_id: str | None = None,
    agent_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with _PREPARE_LOCK:
        return _prepare_run_impl(
            db,
            user_id=user_id,
            note_ids=note_ids,
            offering_id=offering_id,
            use_byok=use_byok,
            trigger=trigger,
            agent_thread_id=agent_thread_id,
            agent_turn_id=agent_turn_id,
            agent_context=agent_context,
        )


def _prepare_run_impl(
    db: Session,
    *,
    user_id: str,
    note_ids: list[str],
    offering_id: str | None = None,
    use_byok: bool = False,
    trigger: str = "manual",
    agent_thread_id: str | None = None,
    agent_turn_id: str | None = None,
    agent_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    owner_query = db.query(User.id).filter(User.id == user_id)
    if _lock(owner_query, db).first() is None:
        raise VideoAnalysisServiceError("user_not_found", "用户不存在", status_code=404)
    runtime = catalog.get_runtime_settings(db)
    if not runtime["enabled"]:
        raise VideoAnalysisServiceError("feature_disabled", "视频详细解析暂未开放", status_code=409)
    if trigger not in catalog.ALLOWED_TRIGGERS:
        raise VideoAnalysisServiceError("invalid_trigger", "解析触发方式无效")
    clean_ids = list(dict.fromkeys(str(item).strip() for item in note_ids if str(item).strip()))
    if not clean_ids or len(clean_ids) > 50:
        raise VideoAnalysisServiceError("invalid_note_count", "请选择 1–50 条视频")
    if trigger == "agent" and len(clean_ids) > int(runtime["agent_max_candidates"]):
        raise VideoAnalysisServiceError(
            "agent_candidate_limit", "Agent 单次候选视频数量超过管理员上限", status_code=409
        )
    offering, version = _offering_and_version(
        db, offering_id=offering_id, trigger=trigger
    )
    if use_byok:
        if not version.byok_allowed:
            raise VideoAnalysisServiceError("byok_not_allowed", "该解析方案不支持自有视觉模型")
        byok = catalog.serialize_user_vision_config(db, user_id)
        if not byok.get("configured") or not byok.get("enabled") or byok.get("health_status") != "healthy":
            raise VideoAnalysisServiceError(
                "byok_not_ready", "自有视觉模型尚未配置或未通过真实图片测试", status_code=409
            )
    reusable_query = (
        db.query(VideoAnalysisRun)
        .filter(
            VideoAnalysisRun.user_id == user_id,
            VideoAnalysisRun.trigger == trigger,
            VideoAnalysisRun.offering_version_id == version.id,
            VideoAnalysisRun.use_byok.is_(bool(use_byok)),
            VideoAnalysisRun.status.in_(["prepared", "queued", "running"]),
            VideoAnalysisRun.created_at >= _utcnow() - timedelta(hours=24),
        )
    )
    # Agent runs carry the question-resume ownership.  Reusing another
    # thread's run merely because it selected the same Notes would leave the
    # second question waiting forever and could expose the wrong approval
    # state.  Retries may only reuse the exact persisted Agent turn.
    if trigger == "agent":
        reusable_query = reusable_query.filter(
            VideoAnalysisRun.agent_thread_id == agent_thread_id,
            VideoAnalysisRun.agent_turn_id == (str(agent_turn_id or "")[:64] or None),
        )
    reusable_runs = (
        reusable_query
        .order_by(VideoAnalysisRun.created_at.desc())
        .limit(20)
        .all()
    )
    requested_set = set(clean_ids)
    for existing_run in reusable_runs:
        existing_items = _run_items(db, existing_run.id)
        if {str(item.note_id) for item in existing_items if item.note_id} != requested_set:
            continue
        if (
            existing_run.status == "prepared"
            and (_aware(existing_run.quote_expires_at) or _utcnow()) <= _utcnow()
        ):
            continue
        existing_quote = _load_dict(existing_run.quote_json)
        existing_process_count = int(existing_quote.get("process_count") or 0)
        needs_confirmation = bool(
            existing_run.status == "prepared"
            and existing_process_count > 0
            and (
                existing_run.use_byok
                or trigger == "batch"
                or len(clean_ids) > 1
                or int(existing_run.quoted_points or 0) > 0
            )
        )
        can_start = bool(
            existing_process_count > 0
            and (existing_run.status in {"queued", "running"} or not needs_confirmation)
        )
        return {
            "run": serialize_run(existing_run, items=existing_items),
            "quote": existing_quote,
            "items": [serialize_item(item) for item in existing_items],
            "requires_confirmation": needs_confirmation,
            "can_start": can_start,
            "can_auto_start": can_start,
            "reused": True,
        }
    notes = (
        db.query(Note)
        .filter(Note.user_id == user_id, Note.id.in_(clean_ids))
        .all()
    )
    note_by_id = {note.id: note for note in notes}
    missing = [note_id for note_id in clean_ids if note_id not in note_by_id]
    if missing:
        raise VideoAnalysisServiceError(
            "note_not_found", "部分资料不存在或不属于当前用户", status_code=404
        )

    now = _utcnow()
    run = VideoAnalysisRun(
        user_id=user_id,
        trigger=trigger,
        status="prepared",
        billing_status="quoted",
        offering_id=offering.id,
        offering_version_id=version.id,
        provider_id=version.provider_id,
        use_byok=bool(use_byok),
        credential_owner="user" if use_byok else "platform",
        funding_source="byok_processing" if use_byok else "analysis_points",
        agent_thread_id=agent_thread_id,
        agent_turn_id=str(agent_turn_id or "")[:64] or None,
        agent_context_json=(
            _dump(_sanitize_agent_context(agent_context)) if agent_context else None
        ),
        source_count=len(clean_ids),
        quote_expires_at=None,
    )
    db.add(run)
    db.flush()

    items: list[VideoAnalysisItem] = []
    line_items: list[dict[str, Any]] = []
    cached_count = 0
    unsupported_count = 0
    process_count = 0
    total_points = 0
    total_free_units = 0
    total_duration_ms = 0
    quoted_quota_units: dict[tuple[str, str], int] = {}
    platform_provider = (
        catalog.get_provider(db, version.provider_id) if version.provider_id else None
    )
    run_limits = catalog.effective_limits(
        version.limits,
        None if use_byok else platform_provider,
    )
    max_frames = int(run_limits.get("max_frames") or 0)
    max_calls = int(
        run_limits.get("max_provider_calls")
        or run_limits.get("max_model_calls")
        or 0
    )
    for position, note_id in enumerate(clean_ids):
        note = note_by_id[note_id]
        source = _source_context(note)
        eligibility = assess_media_eligibility(source)
        known_duration = int(source["source_duration_ms"] or 0)
        quote_duration = known_duration or int(run_limits.get("max_duration_seconds") or 0) * 1000
        fingerprint = build_source_fingerprint(source, duration_ms=known_duration)
        item = VideoAnalysisItem(
            run_id=run.id,
            user_id=user_id,
            note_id=note.id,
            offering_version_id=version.id,
            provider_id=version.provider_id,
            use_byok=bool(use_byok),
            position=position,
            source_duration_ms=known_duration,
            source_fingerprint=fingerprint,
        )
        duration_too_long = known_duration > int(run_limits["max_duration_seconds"]) * 1000
        if not eligibility.eligible or known_duration <= 0 or duration_too_long:
            item.status = "unsupported"
            item.stage = "completed"
            item.billing_status = "not_billable"
            item.progress_percent = 100
            item.error_code = (
                eligibility.reason_code
                if not eligibility.eligible
                else (
                    "duration_limit_exceeded"
                    if duration_too_long
                    else "duration_unknown"
                )
            ) or "media_not_eligible"
            item.error_detail = (
                "视频时长超过该解析方案上限"
                if duration_too_long
                else "当前资料缺少服务端可验证的视频时长"
                if eligibility.eligible
                else "当前资料不是可详细解析的视频"
            )
            item.finished_at = now
            unsupported_count += 1
            line_items.append({
                "note_id": note.id,
                "label": note.video_title[:120],
                "status": "unsupported",
                "points": 0,
            })
        else:
            cached = find_cached_analysis(
                db,
                user_id=user_id,
                note_id=note.id,
                offering_version_id=version.id,
                source_fingerprint=fingerprint,
            )
            if cached is not None:
                item.status = "cached"
                item.stage = "completed"
                item.billing_status = "not_billable"
                item.progress_percent = 100
                item.analysis_id = cached.id
                item.finished_at = now
                cached_count += 1
                line_items.append({
                    "note_id": note.id,
                    "label": note.video_title[:120],
                    "status": "cached",
                    "points": 0,
                })
            else:
                quote_line = billing.quote_item(
                    db,
                    user_id=user_id,
                    version=version,
                    duration_ms=quote_duration,
                    use_byok=bool(use_byok),
                    effective_limits=run_limits,
                )
                quota_snapshot = quote_line.get("quota_snapshot") or {}
                if quote_line.get("free_units") and quota_snapshot:
                    quota_key = (
                        str(quota_snapshot.get("scope") or ""),
                        str(quota_snapshot.get("period_key") or ""),
                    )
                    already_quoted = quoted_quota_units.get(quota_key, 0)
                    remaining = int(
                        quota_snapshot.get("remaining_units_at_quote") or 0
                    )
                    required = int(quota_snapshot.get("required_units") or 0)
                    if remaining - already_quoted < required:
                        quote_line["free_units"] = 0
                        quote_line["quoted_points"] = int(
                            quote_line.get("formula_max_points") or 0
                        )
                        quote_line["max_points"] = quote_line["quoted_points"]
                        quota_snapshot["eligible"] = False
                        quote_line["quota_snapshot"] = quota_snapshot
                    else:
                        quoted_quota_units[quota_key] = already_quoted + required
                if _quota_exhausted_for_zero_price(quote_line):
                    db.rollback()
                    raise VideoAnalysisServiceError(
                        "free_quota_exhausted",
                        "该免费解析方案的当前额度已用完",
                        status_code=409,
                    )
                item.billing_quantity = int(quote_line["billing_quantity"])
                item.quoted_points = int(quote_line["quoted_points"])
                item.free_units_reserved = int(quote_line["free_units"])
                item.pricing_snapshot_json = _dump(quote_line["pricing_snapshot"])
                item.quota_snapshot_json = _dump(quote_line["quota_snapshot"])
                item.platform_cost_reserved_micros = (
                    0
                    if use_byok
                    else catalog.estimate_provider_cost_micros(
                        platform_provider, run_limits
                    )
                )
                total_points += item.quoted_points
                total_free_units += item.free_units_reserved
                total_duration_ms += known_duration
                process_count += 1
                line_items.append({
                    "note_id": note.id,
                    "label": note.video_title[:120],
                    "status": "quoted",
                    "points": item.quoted_points,
                    "quantity": item.billing_quantity,
                    "unit": version.pricing.get("billing_unit") or "run",
                    "free_units": item.free_units_reserved,
                })
        db.add(item)
        items.append(item)

    if int(runtime["run_points_limit"]) > 0 and total_points > int(runtime["run_points_limit"]):
        db.rollback()
        raise VideoAnalysisServiceError(
            "run_points_limit", "本次报价超过管理员设置的单次萃点上限", status_code=409
        )
    daily_limit = int(runtime["user_daily_points_limit"])
    account_for_limit = billing.get_or_create_account(db, user_id)
    if (
        daily_limit > 0
        and billing.captured_points_today(db, user_id)
        + int(account_for_limit.reserved_points or 0)
        + total_points
        > daily_limit
    ):
        db.rollback()
        raise VideoAnalysisServiceError(
            "daily_points_limit", "今日视频解析萃点额度不足", status_code=409
        )

    run.cached_count = cached_count
    run.unsupported_count = unsupported_count
    run.completed_count = cached_count + unsupported_count
    run.quoted_points = total_points
    run.max_reserved_points = total_points
    run.free_units_reserved = total_free_units
    run.quote_expires_at = _utcnow() + timedelta(
        seconds=int(runtime["quote_ttl_seconds"])
    )
    quote = {
        "id": run.id,
        "quote_id": run.id,
        "offering_id": offering.id,
        "offering_name": version.name,
        "offering_version": version.version_number,
        "offering_version_id": version.id,
        "estimated_points": total_points,
        "max_points": total_points,
        "expires_at": run.quote_expires_at.isoformat(),
        "max_frames": max_frames,
        "max_model_calls": max_calls,
        "cached_count": cached_count,
        "process_count": process_count,
        "unsupported_count": unsupported_count,
        "estimated_seconds_min": (
            max(5, math.ceil(total_duration_ms / 1000 * 0.05) + process_count * 3)
            if process_count
            else 0
        ),
        "estimated_seconds_max": (
            max(15, math.ceil(total_duration_ms / 1000 * 0.25) + process_count * 60)
            if process_count
            else 0
        ),
        "line_items": line_items,
        "points_per_cny": 1000,
    }
    run.quote_json = _dump(quote)
    if process_count == 0:
        db.flush()
        _finalize_run(db, run)
    db.commit()
    db.refresh(run)
    for item in items:
        db.refresh(item)
    requires_confirmation = bool(
        process_count > 0
        and (use_byok or trigger == "batch" or len(clean_ids) > 1 or total_points > 0)
    )
    can_start = bool(process_count > 0 and not requires_confirmation)
    return {
        "run": serialize_run(run, items=items),
        "quote": quote,
        "items": [serialize_item(item) for item in items],
        "requires_confirmation": requires_confirmation,
        "can_start": can_start,
        "can_auto_start": can_start,
    }


def get_run(
    db: Session,
    *,
    user_id: str,
    run_id: str,
) -> VideoAnalysisRun | None:
    return (
        db.query(VideoAnalysisRun)
        .filter(VideoAnalysisRun.id == run_id, VideoAnalysisRun.user_id == user_id)
        .first()
    )


def _run_items(
    db: Session,
    run_id: str,
    *,
    lock: bool = False,
) -> list[VideoAnalysisItem]:
    query = db.query(VideoAnalysisItem).filter(VideoAnalysisItem.run_id == run_id)
    if lock:
        query = _lock(query, db)
    return query.order_by(
        VideoAnalysisItem.position.asc(), VideoAnalysisItem.created_at.asc()
    ).all()


def confirm_run(
    db: Session,
    *,
    user_id: str,
    run_id: str,
    idempotency_key: str,
    before_commit: Callable[[VideoAnalysisRun, list[VideoAnalysisItem]], None]
    | None = None,
) -> dict[str, Any]:
    clean_key = str(idempotency_key or "").strip()[:160]
    if len(clean_key) < 8:
        raise VideoAnalysisServiceError("invalid_idempotency_key", "幂等键无效")
    query = db.query(VideoAnalysisRun).filter(
        VideoAnalysisRun.id == run_id,
        VideoAnalysisRun.user_id == user_id,
    )
    run = _lock(query, db).first()
    if run is None:
        raise VideoAnalysisServiceError("run_not_found", "解析任务不存在", status_code=404)
    if run.confirm_idempotency_key:
        # A second browser tab may confirm the same server-side quote with a
        # different request key.  The run itself is already the idempotency
        # boundary, so return its current state without reserving again.
        items = _run_items(db, run.id)
        return {"run": serialize_run(run, items=items), "items": [serialize_item(i) for i in items]}
    key_owner = (
        db.query(VideoAnalysisRun)
        .filter(
            VideoAnalysisRun.user_id == user_id,
            VideoAnalysisRun.confirm_idempotency_key == clean_key,
            VideoAnalysisRun.id != run.id,
        )
        .first()
    )
    if key_owner is not None:
        raise VideoAnalysisServiceError(
            "idempotency_key_conflict", "幂等键已用于其他解析任务", status_code=409
        )
    if run.status != "prepared":
        raise VideoAnalysisServiceError("run_not_prepared", "解析任务当前无法确认", status_code=409)
    expires = _aware(run.quote_expires_at)
    if expires is None or expires <= _utcnow():
        # Agent 可能在同一事务中先 flush 审批卡状态；失败路径必须整体回滚，
        # 不能留下“已开始但永远没有 worker”的线程。
        db.rollback()
        raise VideoAnalysisServiceError("quote_expired", "报价已过期，请重新报价", status_code=409)
    offering = catalog.get_offering(db, run.offering_id)
    version = catalog.get_offering_version(db, run.offering_version_id)
    if offering is None or version is None:
        db.rollback()
        raise VideoAnalysisServiceError(
            "offering_version_unavailable", "报价绑定的解析方案版本已不可用", status_code=409
        )
    runtime = catalog.get_runtime_settings(db)
    if not runtime["enabled"]:
        raise VideoAnalysisServiceError("feature_disabled", "视频详细解析暂未开放", status_code=409)
    if int(runtime["run_points_limit"]) > 0 and run.max_reserved_points > int(runtime["run_points_limit"]):
        raise VideoAnalysisServiceError("run_points_limit", "报价超过单次萃点上限", status_code=409)
    daily_limit = int(runtime["user_daily_points_limit"])
    account_for_limit = billing.get_or_create_account(db, user_id, lock=True)
    if (
        daily_limit > 0
        and billing.captured_points_today(db, user_id)
        + int(account_for_limit.reserved_points or 0)
        + int(run.max_reserved_points)
        > daily_limit
    ):
        raise VideoAnalysisServiceError("daily_points_limit", "今日视频解析萃点额度不足", status_code=409)

    items = _run_items(db, run.id, lock=True)
    account = billing.get_or_create_account(db, user_id, lock=True)
    queued: list[VideoAnalysisItem] = []
    try:
        for item in items:
            if item.status != "prepared":
                continue
            billing.reserve_item(db, item, account=account)
            item.status = "queued"
            item.stage = "prepared"
            item.progress_percent = 0
            queued.append(item)
        run.confirm_idempotency_key = clean_key
        run.confirmed_at = _utcnow()
        if queued:
            run.status = "queued"
            run.billing_status = (
                "reserved"
                if any(item.billing_status == "reserved" for item in queued)
                else "not_billable"
            )
            run.reserved_points = sum(int(item.reserved_points or 0) for item in items)
        else:
            _finalize_run(db, run)
        if before_commit is not None:
            before_commit(run, items)
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(run)
    items = _run_items(db, run.id)
    for item in queued:
        _notify_enqueued(item.id)
    return {"run": serialize_run(run, items=items), "items": [serialize_item(i) for i in items]}


def list_runs(
    db: Session,
    *,
    user_id: str | None = None,
    status: str = "active",
    limit: int = 20,
) -> list[VideoAnalysisRun]:
    query = db.query(VideoAnalysisRun)
    if user_id is not None:
        query = query.filter(VideoAnalysisRun.user_id == user_id)
    if status == "active":
        query = query.filter(VideoAnalysisRun.status.in_(ACTIVE_RUN_STATUSES))
    elif status == "recent":
        query = query.filter(~VideoAnalysisRun.status.in_(["prepared"]))
    elif status and status != "all":
        query = query.filter(VideoAnalysisRun.status == status)
    return (
        query.order_by(VideoAnalysisRun.created_at.desc())
        .limit(max(1, min(int(limit), 200)))
        .all()
    )


def serialize_item(
    item: VideoAnalysisItem,
    *,
    internal: bool = False,
) -> dict[str, Any]:
    released = max(0, int(item.reserved_points or 0) - int(item.captured_points or 0))
    payload = {
        "id": item.id,
        "run_id": item.run_id,
        "note_id": item.note_id,
        "status": item.status,
        "billing_status": item.billing_status,
        "progress": int(item.progress_percent or 0),
        "progress_percent": int(item.progress_percent or 0),
        "stage": item.stage,
        "error": item.error_detail or None,
        "error_code": item.error_code or None,
        "cached": item.status == "cached",
        "supported": item.status != "unsupported",
        "actual_points": int(item.captured_points or 0),
        "quoted_points": int(item.quoted_points or 0),
        "reserved_points": int(item.reserved_points or 0),
        "released_points": released,
        "free_units_reserved": int(item.free_units_reserved or 0),
        "free_units_captured": int(item.free_units_captured or 0),
        "analysis_id": item.analysis_id,
        "attempt_count": int(item.attempt_count or 0),
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        "finished_at": item.finished_at.isoformat() if item.finished_at else None,
    }
    if internal:
        payload["platform_cost_micros"] = int(item.platform_cost_micros or 0)
        payload["provider_cost_micros"] = int(item.platform_cost_micros or 0)
        payload["failure_cost_micros"] = int(item.failure_cost_micros or 0)
    return payload


def serialize_run(
    run: VideoAnalysisRun,
    *,
    items: list[VideoAnalysisItem] | None = None,
    internal: bool = False,
) -> dict[str, Any]:
    item_rows = items or []
    quote = _load_dict(run.quote_json)
    released = max(0, int(run.reserved_points or 0) - int(run.captured_points or 0))
    progress = (
        int(sum(int(item.progress_percent or 0) for item in item_rows) / len(item_rows))
        if item_rows
        else (100 if run.status not in ACTIVE_RUN_STATUSES else 0)
    )
    stages = [item.stage for item in item_rows if item.status in {"queued", "running"}]
    payload = {
        "id": run.id,
        "user_id": run.user_id,
        "status": run.status,
        "billing_status": run.billing_status,
        "trigger": run.trigger,
        "agent_thread_id": run.agent_thread_id,
        "agent_turn_id": run.agent_turn_id,
        "offering_id": run.offering_id,
        "offering_name": quote.get("offering_name") or quote.get("name"),
        "offering_version": quote.get("offering_version"),
        "offering_version_id": run.offering_version_id,
        "use_byok": bool(run.use_byok),
        "note_ids": [str(item.note_id) for item in item_rows if item.note_id],
        "item_count": int(run.source_count or len(item_rows)),
        "cached_count": int(run.cached_count or 0),
        "unsupported_count": int(run.unsupported_count or 0),
        "completed_count": int(run.completed_count or 0),
        "failed_count": int(run.failed_count or 0),
        "progress": progress,
        "current_stage": stages[0] if stages else "",
        "estimated_points": int(run.quoted_points or 0),
        "max_reserved_points": int(run.max_reserved_points or 0),
        "reserved_points": int(run.reserved_points or 0),
        "actual_points": int(run.captured_points or 0),
        "released_points": released,
        "error": run.error_detail or None,
        "error_code": run.error_code or None,
        "quote": quote or None,
        "items": [serialize_item(item, internal=internal) for item in item_rows],
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
        "confirmed_at": run.confirmed_at.isoformat() if run.confirmed_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
    if internal:
        payload["platform_cost_micros"] = int(run.platform_cost_micros or 0)
        payload["provider_cost_micros"] = int(run.platform_cost_micros or 0)
        payload["failure_cost_micros"] = sum(
            int(item.failure_cost_micros or 0) for item in item_rows
        )
    return payload


def _finalize_run(db: Session, run: VideoAnalysisRun) -> None:
    items = _run_items(db, run.id)
    if not items or any(item.status not in TERMINAL_ITEM_STATUSES for item in items):
        return
    succeeded = sum(item.status in SUCCESS_ITEM_STATUSES for item in items)
    failed = sum(item.status in {"failed", "cancelled"} for item in items)
    unsupported = sum(item.status == "unsupported" for item in items)
    if succeeded and not (failed or unsupported):
        run.status = "succeeded"
    elif succeeded:
        run.status = "partial"
    elif all(item.status == "cancelled" for item in items):
        run.status = "cancelled"
    else:
        run.status = "failed"
    run.completed_count = len(items)
    run.failed_count = failed
    run.cached_count = sum(item.status == "cached" for item in items)
    run.unsupported_count = unsupported
    run.reserved_points = sum(int(item.reserved_points or 0) for item in items)
    run.captured_points = sum(int(item.captured_points or 0) for item in items)
    run.free_units_captured = sum(int(item.free_units_captured or 0) for item in items)
    run.platform_cost_micros = sum(int(item.platform_cost_micros or 0) for item in items)
    billing_states = {item.billing_status for item in items}
    if "reconciliation_pending" in billing_states:
        run.billing_status = "reconciliation_pending"
    elif "captured" in billing_states:
        run.billing_status = "captured"
    elif "released" in billing_states:
        run.billing_status = "released"
    else:
        run.billing_status = "not_billable"
    run.finished_at = _utcnow()
    db.flush()


def cancel_run(db: Session, *, user_id: str, run_id: str) -> dict[str, Any]:
    run_probe = (
        db.query(VideoAnalysisRun)
        .filter(
            VideoAnalysisRun.id == run_id,
            VideoAnalysisRun.user_id == user_id,
        )
        .first()
    )
    if run_probe is None:
        raise VideoAnalysisServiceError("run_not_found", "解析任务不存在", status_code=404)
    # Worker 的顺序是 Item -> Run；取消使用同一锁顺序，避免 PostgreSQL
    # 在完成结算与取消同时发生时形成 Run/Item 交叉死锁。
    items = _run_items(db, run_id, lock=True)
    run = _lock(
        db.query(VideoAnalysisRun).filter(
            VideoAnalysisRun.id == run_id,
            VideoAnalysisRun.user_id == user_id,
        ),
        db,
    ).populate_existing().first()
    if run is None:
        raise VideoAnalysisServiceError("run_not_found", "解析任务不存在", status_code=404)
    if run.status not in ({"prepared"} | ACTIVE_RUN_STATUSES):
        return {"run": serialize_run(run, items=items), "items": [serialize_item(i) for i in items]}
    now = _utcnow()
    run.cancel_requested = True
    for item in items:
        if item.status in {"prepared", "queued", "reauthorization_required"}:
            if item.status == "prepared":
                # 报价阶段只计算 eligible/free_units，并未增加免费额度预留。
                # 调用 release_item 会错误扣减同周期内其他已确认任务的预留。
                item.billing_status = "not_billable"
            else:
                billing.release_item(db, item, reason="用户取消视频详细解析")
            item.status = "cancelled"
            item.stage = "completed"
            item.progress_percent = 100
            item.error_code = "user_cancelled"
            item.error_detail = "用户已取消"
            item.finished_at = now
        elif item.status == "running":
            item.cancel_requested = True
            item.cancel_requested_at = now
    _finalize_run(db, run)
    if any(item.status == "running" for item in items):
        run.status = "running"
    db.commit()
    db.refresh(run)
    items = _run_items(db, run.id)
    return {"run": serialize_run(run, items=items), "items": [serialize_item(i) for i in items]}


def claim_next_item(db: Session, worker_id: str) -> VideoAnalysisItem | None:
    with _CLAIM_LOCK:
        query = (
            db.query(VideoAnalysisItem)
            .filter(VideoAnalysisItem.status == "queued")
            .order_by(VideoAnalysisItem.created_at.asc(), VideoAnalysisItem.position.asc())
        )
        candidates = _lock(query.limit(50), db, skip_locked=True).all()
        item: VideoAnalysisItem | None = None
        for candidate in candidates:
            version = catalog.get_offering_version(db, candidate.offering_version_id)
            if version is None:
                continue
            # Scene/Vision 上限由 worker 在 detecting_scenes/analyzing_visuals
            # 阶段分别取得租约；在这里按整个 Item 分类会让 VLM 的场景检测
            # 绕过 scene_concurrency，也会无谓占用 vision_concurrency。
            if candidate.provider_id and not candidate.use_byok:
                provider = (
                    db.query(VisionProvider)
                    .filter(VisionProvider.id == candidate.provider_id)
                    .first()
                )
                provider_limit = int(provider.max_concurrency or 1) if provider else 1
                provider_running = int(
                    db.query(func.count(VideoAnalysisItem.id))
                    .filter(
                        VideoAnalysisItem.status == "running",
                        VideoAnalysisItem.provider_id == candidate.provider_id,
                    )
                    .scalar()
                    or 0
                )
                if provider_running >= provider_limit:
                    continue
            item = candidate
            break
        if item is None:
            return None
        now = _utcnow()
        item.status = "running"
        item.worker_id = str(worker_id or "")[:96]
        item.claimed_at = now
        item.heartbeat_at = now
        item.started_at = item.started_at or now
        item.attempt_count = int(item.attempt_count or 0) + 1
        run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
        if run is not None:
            run.status = "running"
            run.started_at = run.started_at or now
        db.commit()
        db.refresh(item)
        return item


def heartbeat_item(
    db: Session,
    item_id: str,
    worker_id: str,
    *,
    stage: str = "running",
) -> bool:
    item = _lock(
        db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id), db
    ).first()
    if item is None or item.status != "running" or item.worker_id != worker_id:
        return False
    item.heartbeat_at = _utcnow()
    if stage:
        item.stage = str(stage)[:32]
        stage_progress = {
            "downloading": 10,
            "detecting_scenes": 30,
            "sampling_frames": 50,
            "analyzing_visuals": 70,
            "persisting": 90,
        }
        item.progress_percent = max(item.progress_percent, stage_progress.get(item.stage, 0))
    db.commit()
    return True


def get_execution_context(db: Session, item_id: str) -> dict[str, Any]:
    item = _lock(
        db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id), db
    ).first()
    if item is None:
        raise VideoAnalysisServiceError("item_not_found", "解析子任务不存在", status_code=404)
    note = (
        db.query(Note)
        .filter(Note.id == item.note_id, Note.user_id == item.user_id)
        .first()
    )
    version = catalog.get_offering_version(db, item.offering_version_id)
    if note is None or version is None:
        raise VideoAnalysisServiceError("execution_source_missing", "解析来源或方案版本不存在", status_code=409)
    runtime_provider = catalog.resolve_runtime_provider(db, item)
    source = _source_context(note)
    billing_snapshot = _load_dict(item.pricing_snapshot_json)
    execution_limits = (
        _load_dict(billing_snapshot.get("limits"))
        or dict(runtime_provider.get("limits") or version.limits)
    )
    runtime_provider["limits"] = execution_limits
    return {
        "item_id": item.id,
        "run_id": item.run_id,
        "user_id": item.user_id,
        "note_id": note.id,
        "note": note,
        "platform": source["platform"],
        "media_type": source["media_type"],
        "source_duration_ms": int(item.source_duration_ms or 0),
        "source_fingerprint": item.source_fingerprint,
        "video_title": note.video_title,
        "transcript": note.transcript_raw or "",
        "method": version.method,
        "analysis_method": version.method,
        "use_byok": bool(item.use_byok),
        "offering_version": catalog.serialize_offering(
            catalog.get_offering(db, version.offering_id), version=version, public=True
        ),
        "limits": execution_limits,
        "offering_limits": execution_limits,
        "runtime_provider_config": runtime_provider,
        "byok_provider_config": runtime_provider if item.use_byok else {},
        "platform_provider_config": runtime_provider if not item.use_byok else {},
        "billing_snapshot": billing_snapshot,
        "quota_snapshot": _load_dict(item.quota_snapshot_json),
    }


def calculate_actual_charge(
    db: Session,
    item: VideoAnalysisItem,
    *,
    result_usage: Mapping[str, Any] | None = None,
) -> dict[str, int]:
    return billing.calculate_actual_charge(db, item, result_usage=result_usage)


def _next_revision(
    db: Session,
    *,
    user_id: str,
    note_id: str,
    offering_version_id: str,
    source_fingerprint: str,
) -> int:
    return int(
        db.query(func.coalesce(func.max(VideoAnalysis.revision), 0))
        .filter(
            VideoAnalysis.user_id == user_id,
            VideoAnalysis.note_id == note_id,
            VideoAnalysis.offering_version_id == offering_version_id,
            VideoAnalysis.source_fingerprint == source_fingerprint,
        )
        .scalar()
        or 0
    ) + 1


def complete_item(
    db: Session,
    item_id: str,
    *,
    result_payload: Mapping[str, Any],
    status: str = "succeeded",
    scene_count: int = 0,
    frame_count: int = 0,
    duration_ms: int = 0,
    actual_points: int = 0,
    platform_cost_micros: int = 0,
    degraded_reason: str = "",
    result_usage: Mapping[str, Any] | None = None,
) -> VideoAnalysisItem:
    query = db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id)
    item = _lock(query, db).first()
    if item is None:
        raise VideoAnalysisServiceError("item_not_found", "解析子任务不存在", status_code=404)
    if item.status in TERMINAL_ITEM_STATUSES and item.analysis_id:
        return item
    if status == "cached":
        cached = find_cached_analysis(
            db,
            user_id=item.user_id,
            note_id=str(item.note_id),
            offering_version_id=item.offering_version_id,
            source_fingerprint=item.source_fingerprint,
        )
        if cached is not None:
            billing.release_item(db, item, reason="命中已有解析缓存，释放预留")
            item.analysis_id = cached.id
            item.status = "cached"
            item.stage = "completed"
            item.progress_percent = 100
            item.finished_at = _utcnow()
            run = (
                db.query(VideoAnalysisRun)
                .filter(VideoAnalysisRun.id == item.run_id)
                .first()
            )
            if run is not None:
                _finalize_run(db, run)
            db.commit()
            db.refresh(item)
            return item
    safe_payload = _safe_result(dict(result_payload or {}))
    result_status = "partial" if status == "partial" else "succeeded"
    note = (
        db.query(Note)
        .filter(Note.id == item.note_id, Note.user_id == item.user_id)
        .first()
    )
    if duration_ms and note is not None:
        verified_duration = max(0, int(duration_ms))
        _persist_verified_duration(note, verified_duration)
        item.source_duration_ms = verified_duration
        item.source_fingerprint = build_source_fingerprint(
            _source_context(note),
            duration_ms=verified_duration,
        )
    db.query(VideoAnalysis).filter(
        VideoAnalysis.user_id == item.user_id,
        VideoAnalysis.note_id == item.note_id,
        VideoAnalysis.offering_version_id == item.offering_version_id,
        VideoAnalysis.is_current.is_(True),
    ).update({VideoAnalysis.is_current: False}, synchronize_session=False)
    analysis = VideoAnalysis(
        user_id=item.user_id,
        note_id=item.note_id,
        offering_version_id=item.offering_version_id,
        provider_id=item.provider_id,
        source_fingerprint=item.source_fingerprint,
        revision=_next_revision(
            db,
            user_id=item.user_id,
            note_id=str(item.note_id),
            offering_version_id=item.offering_version_id,
            source_fingerprint=item.source_fingerprint,
        ),
        status=result_status,
        result_json=_dump(safe_payload),
        scene_count=max(0, int(scene_count or 0)),
        frame_count=max(0, int(frame_count or 0)),
        duration_ms=max(0, int(duration_ms or 0)),
        degraded_reason=str(degraded_reason or "")[:128],
    )
    db.add(analysis)
    db.flush()
    billing.capture_item(
        db,
        item,
        actual_points=max(0, int(actual_points or 0)),
        platform_cost_micros=max(0, int(platform_cost_micros or 0)),
    )
    item.analysis_id = analysis.id
    item.status = result_status
    item.stage = "completed"
    item.progress_percent = 100
    item.finished_at = _utcnow()
    item.heartbeat_at = item.finished_at
    item.error_code = ""
    item.error_detail = ""
    usage = dict(result_usage or {})
    item.failure_cost_micros = (
        0
        if item.use_byok
        else max(0, int(usage.get("failure_cost_micros") or 0))
    )
    if (
        not item.use_byok
        and item.provider_id
        and int(usage.get("calls") or usage.get("provider_units") or 0) > 0
    ):
        observations = (
            safe_payload.get("visual_observations")
            if isinstance(safe_payload, dict)
            else []
        )
        provider_succeeded = result_status == "succeeded" or bool(observations)
        catalog.record_provider_outcome(
            db,
            item.provider_id,
            succeeded=provider_succeeded,
            message=("视觉调用部分或全部失败" if not provider_succeeded else ""),
        )
    if note is not None:
        note.ai_summary = merge_detailed_analysis_summary(
            note.ai_summary,
            safe_payload,
            analysis_id=analysis.id,
            offering_version_id=item.offering_version_id,
            source_fingerprint=item.source_fingerprint,
            status=result_status,
        )
    run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
    if run is not None:
        _finalize_run(db, run)
    db.commit()
    db.refresh(item)
    return item


def fail_item(
    db: Session,
    item_id: str,
    *,
    error_code: str,
    error_detail: str,
    partial_result: Mapping[str, Any] | None = None,
    actual_points: int = 0,
    platform_cost_micros: int = 0,
    result_usage: Mapping[str, Any] | None = None,
    verified_duration_ms: int = 0,
) -> VideoAnalysisItem:
    if partial_result:
        return complete_item(
            db,
            item_id,
            result_payload=partial_result,
            status="partial",
            actual_points=actual_points,
            platform_cost_micros=platform_cost_micros,
            degraded_reason=error_code,
            result_usage=result_usage,
        )
    item = _lock(
        db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id), db
    ).first()
    if item is None:
        raise VideoAnalysisServiceError("item_not_found", "解析子任务不存在", status_code=404)
    if item.status == "reauthorization_required":
        return item
    if item.status in TERMINAL_ITEM_STATUSES:
        return item
    if str(error_code or "") == "reauthorization_required":
        verified_duration = max(0, int(verified_duration_ms or 0))
        if verified_duration:
            item.source_duration_ms = verified_duration
            note = (
                db.query(Note)
                .filter(Note.id == item.note_id, Note.user_id == item.user_id)
                .first()
            )
            if note is not None:
                _persist_verified_duration(note, verified_duration)
        item.status = "reauthorization_required"
        item.error_code = "reauthorization_required"
        item.error_detail = "视频实际时长超过报价授权范围，需要重新确认"
        item.worker_id = ""
        run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
        if run is not None:
            run.status = "reauthorization_required"
            run.error_code = "reauthorization_required"
            run.error_detail = item.error_detail
        db.commit()
        db.refresh(item)
        return item
    if (
        not item.use_byok
        and item.provider_id
        and (
            str(error_code or "").startswith("provider_")
            or str(error_code or "")
            in {
                "vision_provider_failed",
                "vision_driver_unavailable",
                "native_video_failed",
            }
        )
    ):
        catalog.record_provider_outcome(
            db,
            item.provider_id,
            succeeded=False,
            message=str(error_code or "provider_call_failed"),
        )
    if actual_points or platform_cost_micros:
        billing.capture_item(
            db,
            item,
            actual_points=actual_points,
            platform_cost_micros=platform_cost_micros,
        )
    else:
        billing.release_item(db, item, reason="视频详细解析失败，释放未使用预留")
    item.status = "failed"
    item.stage = "completed"
    item.progress_percent = 100
    item.error_code = str(error_code or "analysis_failed")[:64]
    item.error_detail = str(error_detail or "视频详细解析失败")[:256]
    item.finished_at = _utcnow()
    run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
    if run is not None:
        _finalize_run(db, run)
    db.commit()
    db.refresh(item)
    return item


def cancel_item(
    db: Session,
    item_id: str,
    *,
    user_id: str | None = None,
    reason_code: str = "user_cancelled",
    partial_result: Mapping[str, Any] | None = None,
    actual_points: int = 0,
    platform_cost_micros: int = 0,
    result_usage: Mapping[str, Any] | None = None,
) -> VideoAnalysisItem | bool:
    item = _lock(
        db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id), db
    ).first()
    if item is None or (user_id and item.user_id != user_id):
        return False
    if item.status in TERMINAL_ITEM_STATUSES:
        return item
    if partial_result:
        return complete_item(
            db,
            item_id,
            result_payload=partial_result,
            status="partial",
            actual_points=actual_points,
            platform_cost_micros=platform_cost_micros,
            degraded_reason=reason_code,
            result_usage=result_usage,
        )
    if actual_points or platform_cost_micros:
        billing.capture_item(
            db,
            item,
            actual_points=actual_points,
            platform_cost_micros=platform_cost_micros,
        )
    else:
        billing.release_item(db, item, reason="视频详细解析已取消")
    item.status = "cancelled"
    item.stage = "completed"
    item.progress_percent = 100
    item.error_code = str(reason_code or "user_cancelled")[:64]
    item.error_detail = "视频详细解析已取消"
    item.finished_at = _utcnow()
    run = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == item.run_id).first()
    if run is not None:
        _finalize_run(db, run)
    db.commit()
    db.refresh(item)
    return item


def requeue_or_release_stale_items(db: Session) -> dict[str, Any]:
    runtime = catalog.get_runtime_settings(db)
    cutoff = _utcnow() - timedelta(minutes=int(runtime["stale_run_minutes"]))
    stale = _lock(
        db.query(VideoAnalysisItem).filter(
            VideoAnalysisItem.status == "running",
            func.coalesce(VideoAnalysisItem.heartbeat_at, VideoAnalysisItem.claimed_at) < cutoff,
        ),
        db,
        skip_locked=True,
    ).all()
    expired_reauthorizations = _lock(
        db.query(VideoAnalysisItem).filter(
            VideoAnalysisItem.status == "reauthorization_required",
            VideoAnalysisItem.updated_at < cutoff,
        ),
        db,
        skip_locked=True,
    ).all()
    expired_prepared_runs = _lock(
        db.query(VideoAnalysisRun).filter(
            VideoAnalysisRun.status == "prepared",
            VideoAnalysisRun.quote_expires_at.is_not(None),
            VideoAnalysisRun.quote_expires_at < _utcnow(),
        ),
        db,
        skip_locked=True,
    ).all()
    requeued = 0
    failed = 0
    terminal_item_ids: list[str] = []
    for item in stale:
        unsafe_to_retry = item.stage in {"analyzing_visuals", "persisting"}
        if (
            not unsafe_to_retry
            and int(item.attempt_count or 0) <= int(runtime["retry_count"])
        ):
            item.status = "queued"
            item.stage = "prepared"
            item.worker_id = ""
            item.claimed_at = None
            item.heartbeat_at = None
            requeued += 1
        else:
            billing.release_item(db, item, reason="视频详细解析任务超时，释放预留")
            if unsafe_to_retry and not item.use_byok:
                provisional_cost = max(
                    int(item.platform_cost_micros or 0),
                    int(item.platform_cost_reserved_micros or 0),
                )
                item.platform_cost_micros = provisional_cost
                item.failure_cost_micros = max(
                    int(item.failure_cost_micros or 0), provisional_cost
                )
                item.billing_status = "reconciliation_pending"
            item.status = "failed"
            item.stage = "completed"
            item.progress_percent = 100
            item.error_code = (
                "worker_stale_after_provider_call"
                if unsafe_to_retry
                else "worker_stale"
            )
            item.error_detail = (
                "解析任务在上游调用后失联，为避免重复计费不自动重试"
                if unsafe_to_retry
                else "解析任务超时且已超过重试次数"
            )
            item.finished_at = _utcnow()
            failed += 1
            terminal_item_ids.append(item.id)
    for item in expired_reauthorizations:
        billing.release_item(
            db,
            item,
            reason="视频实际用量重新授权超时，释放预留",
        )
        item.status = "cancelled"
        item.stage = "completed"
        item.progress_percent = 100
        item.error_code = "reauthorization_expired"
        item.error_detail = "重新报价长期未确认，任务已取消并释放预留"
        item.finished_at = _utcnow()
        failed += 1
        terminal_item_ids.append(item.id)

    for run in expired_prepared_runs:
        prepared_items = _run_items(db, run.id, lock=True)
        for item in prepared_items:
            if item.status != "prepared":
                continue
            # prepared 尚未真正占用余额/免费额度，不能调用 release_item。
            item.status = "cancelled"
            item.stage = "completed"
            item.progress_percent = 100
            item.error_code = "quote_expired"
            item.error_detail = "报价已过期，任务已关闭"
            item.finished_at = _utcnow()
            terminal_item_ids.append(item.id)
        _finalize_run(db, run)
        if run.status not in {"succeeded", "partial", "failed", "cancelled"}:
            run.status = "cancelled"
            run.error_code = "quote_expired"
            run.error_detail = "报价已过期，任务已关闭"
            run.finished_at = _utcnow()

    affected = [*stale, *expired_reauthorizations]
    run_ids = {item.run_id for item in affected}
    for run_id in run_ids:
        run = _lock(
            db.query(VideoAnalysisRun).filter(VideoAnalysisRun.id == run_id), db
        ).first()
        if run is not None:
            _finalize_run(db, run)
            if run.status not in {"succeeded", "partial", "failed", "cancelled"}:
                remaining = _run_items(db, run_id)
                if any(item.status == "reauthorization_required" for item in remaining):
                    run.status = "reauthorization_required"
                elif any(item.status == "running" for item in remaining):
                    run.status = "running"
                elif any(item.status == "queued" for item in remaining):
                    run.status = "queued"
    db.commit()
    for item in stale:
        if item.status == "queued":
            _notify_enqueued(item.id)
    return {
        "requeued": requeued,
        "failed": failed,
        "reauthorization_released": len(expired_reauthorizations),
        "prepared_expired": len(expired_prepared_runs),
        "terminal_item_ids": terminal_item_ids,
    }
