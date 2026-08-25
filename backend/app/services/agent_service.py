"""Persistent video-grounded Agent tasks and source selection."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.agent_runtime import AgentTurn
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import (
    agent_video_analysis_service,
    ai_juicer,
    plan_service,
    video_source_ledger_service,
)
from app.services.agent_tool_runtime import AgentToolExecutor


logger = logging.getLogger(__name__)


SOURCE_LIMIT = 100
SOURCE_SCAN_LIMIT = 2000
SMART_SOURCE_SCAN_LIMIT = 300
SMART_SOURCE_TOTAL_CHARS = 2_000_000
SMART_SOURCE_TRANSCRIPT_LIMIT = 80_000
MAX_ACTIVE_THREADS_PER_USER = 2
MAX_QUESTIONS_PER_MINUTE = 12
MAX_QUESTIONS_PER_DAY = 200
SOURCE_SCOPES = {
    "all": "全部已有文案",
    "all_ready": "全部已有文案",
    "yesterday": "昨天新整理",
    "yesterday_new": "昨天新整理",
    "collect": "抖音收藏",
    "like": "喜欢",
    "post": "我的作品",
    "selected": "手动选择",
}


class AgentThreadConflictError(ValueError):
    """Raised when a thread cannot accept another message yet."""


class AgentVideoAnalysisTerminal(Exception):
    """End one HTTP/SSE turn after persisting an approval or running card."""

    def __init__(self, event_type: str, payload: dict[str, Any]):
        super().__init__(event_type)
        self.event_type = event_type
        self.payload = payload


AgentProgressCallback = Callable[[dict[str, Any]], None]


def _emit_progress(
    callback: AgentProgressCallback | None,
    stage: str,
    message: str,
    **data: Any,
) -> None:
    if callback is None:
        return
    try:
        callback({"stage": stage, "message": message, **data})
    except Exception:
        return


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _safe_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("请选择有效的时区") from exc


def _legacy_source_meta(note: Note) -> dict[str, Any]:
    if not note.ai_summary:
        return {}
    try:
        payload = json.loads(note.ai_summary)
    except (json.JSONDecodeError, TypeError):
        return {}
    meta = payload.get("source_meta")
    return meta if isinstance(meta, dict) else {}


def _ledger_map(
    db: Session,
    notes: list[Note],
) -> dict[str, list[Any]]:
    return video_source_ledger_service.list_by_video_ids(
        db,
        user_id=notes[0].user_id if notes else "",
        video_ids=[note.video_id for note in notes],
    ) if notes else {}


def _source_meta(
    note: Note,
    ledger_map: dict[str, list[Any]] | None = None,
    *,
    preferred_mode: str | None = None,
) -> dict[str, Any]:
    meta = _legacy_source_meta(note)
    rows = (ledger_map or {}).get(note.video_id, [])
    if not rows:
        return meta
    ledger = next(
        (
            row
            for row in rows
            if preferred_mode and row.source_mode == preferred_mode
        ),
        None,
    )
    if ledger is None:
        # For "all sources", the newest membership is the honest source for
        # "newly organized yesterday", even if an older membership also exists.
        ledger = max(
            rows,
            key=lambda row: _aware_utc(row.first_seen_at)
            or datetime.min.replace(tzinfo=timezone.utc),
        )
    return {
        **meta,
        "source_mode": ledger.source_mode,
        "source_rank": ledger.source_rank,
        "first_seen_at": (
            _aware_utc(ledger.first_seen_at).isoformat()
            .replace("+00:00", "Z")
        ),
        "last_seen_at": (
            _aware_utc(ledger.last_seen_at).isoformat()
            .replace("+00:00", "Z")
        ),
        "source_synced_at": (
            _aware_utc(ledger.source_synced_at).isoformat()
            .replace("+00:00", "Z")
        ),
    }


def _source_mode(note: Note, meta: dict[str, Any]) -> str:
    mode = str(meta.get("source_mode") or "").strip().lower()
    return mode if mode in {"collect", "like", "post"} else "unknown"


def _channel_counts(
    notes: list[Note],
    ledger_map: dict[str, list[Any]],
) -> dict[str, int]:
    """Count the newest membership for each source channel per note.

    A note may carry several ``VideoSourceLedger`` rows (one per mode).  The
    newest observation within each channel is the honest "latest synced"
    figure, mirroring the collector buckets show in the library view.
    """
    counts: dict[str, int] = {"collect": 0, "like": 0, "post": 0}
    for note in notes:
        rows = ledger_map.get(note.video_id, [])
        if not rows:
            meta = _legacy_source_meta(note)
            mode = _source_mode(note, meta)
            if mode in counts:
                counts[mode] += 1
            continue
        for mode in counts:
            matched = next(
                (
                    row
                    for row in rows
                    if row.source_mode == mode
                ),
                None,
            )
            if matched is not None:
                counts[mode] += 1
    return counts


def source_mode(note: Note) -> str:
    """Return the reliable downloader mode, or ``unknown`` for legacy rows."""
    meta = _legacy_source_meta(note)
    return _source_mode(note, meta)


def _source_time(note: Note, meta: dict[str, Any]) -> datetime | None:
    for key in ("first_seen_at", "source_synced_at", "recorded_at"):
        raw = str(meta.get(key) or "").strip()
        if not raw:
            continue
        try:
            return _aware_utc(datetime.fromisoformat(raw.replace("Z", "+00:00")))
        except ValueError:
            continue
    return _aware_utc(note.created_at)


def source_timestamp(note: Note) -> datetime | None:
    """Return the first reliable Zhicui source timestamp for automation use."""
    return _source_time(note, _legacy_source_meta(note))


def _source_dict(
    note: Note,
    ledger_map: dict[str, list[Any]] | None = None,
    *,
    preferred_mode: str | None = None,
) -> dict[str, Any]:
    meta = _source_meta(
        note,
        ledger_map,
        preferred_mode=preferred_mode,
    )
    source_time = _source_time(note, meta)
    detailed: dict[str, Any] = {}
    if note.ai_summary:
        try:
            payload = json.loads(note.ai_summary)
            raw_detailed = payload.get("detailed_video_analysis") if isinstance(payload, dict) else None
            if isinstance(raw_detailed, dict):
                detailed = raw_detailed
        except (json.JSONDecodeError, TypeError):
            detailed = {}
    return {
        "note_id": note.id,
        "video_id": note.video_id,
        "platform": str(meta.get("platform") or "unknown"),
        "title": note.video_title,
        "cover_url": str(meta.get("cover_url") or ""),
        "source_url": str(meta.get("source_url") or note.video_url or ""),
        "author_name": str(meta.get("author_name") or ""),
        "source_mode": _source_mode(note, meta),
        "source_rank": meta.get("source_rank"),
        "source_synced_at": source_time.isoformat() if source_time else None,
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "transcript_chars": len(note.transcript_raw or ""),
        "ai_initialized": bool(note.ai_initialized),
        "visual_analysis": ({
            "status": str(detailed.get("status") or "succeeded"),
            "scene_count": _nonnegative_int(detailed.get("scene_count")),
            "frame_count": _nonnegative_int(detailed.get("frame_count")),
            "updated_at": detailed.get("updated_at"),
        } if detailed else None),
    }


def _eligible_notes(db: Session, user_id: str) -> list[Note]:
    return (
        db.query(Note)
        .filter(
            Note.user_id == user_id,
            Note.transcript_raw.is_not(None),
            Note.transcript_raw != "",
        )
        .order_by(Note.created_at.desc())
        .limit(SOURCE_SCAN_LIMIT)
        .all()
    )


def _source_order_key(
    note: Note,
    ledger_map: dict[str, list[Any]] | None,
    *,
    preferred_mode: str,
) -> tuple[int, int, float, float]:
    """Order a downloader source by its bounded sync snapshot.

    ``source_rank == 0`` is the newest item returned by the downloader.  Rows
    without a reliable rank follow ranked rows and fall back to the latest
    observation, then the Note creation time.  This keeps "recently
    collected" honest without inventing an exact Douyin favourite timestamp.
    """
    meta = _source_meta(
        note,
        ledger_map,
        preferred_mode=preferred_mode,
    )
    raw_rank = meta.get("source_rank")
    rank = (
        raw_rank
        if isinstance(raw_rank, int) and raw_rank >= 0
        else 2_147_483_647
    )
    stamp = _source_time(note, meta)
    observed = stamp.timestamp() if stamp is not None else 0.0
    created = (
        _aware_utc(note.created_at).timestamp()
        if note.created_at is not None
        else 0.0
    )
    return (
        0 if rank != 2_147_483_647 else 1,
        rank,
        -observed,
        -created,
    )


def _filter_notes(
    notes: list[Note],
    scope: str,
    *,
    timezone_name: str,
    search: str = "",
    reference_at: datetime | None = None,
    source_mode_filter: str | None = None,
    not_before: datetime | None = None,
    ledger_map: dict[str, list[Any]] | None = None,
) -> list[Note]:
    normalized_scope = scope if scope in SOURCE_SCOPES else "all_ready"
    query = search.strip().casefold()
    local_tz = _safe_timezone(timezone_name)
    anchor = (_aware_utc(reference_at) or _utcnow()).astimezone(local_tz)
    yesterday = anchor.date() - timedelta(days=1)
    normalized_mode = (
        source_mode_filter
        if source_mode_filter in {"collect", "like", "post"}
        else None
    )
    normalized_not_before = _aware_utc(not_before)
    filtered: list[Note] = []

    for note in notes:
        preferred_mode = (
            normalized_mode
            or (
                normalized_scope
                if normalized_scope in {"collect", "like", "post"}
                else None
            )
        )
        meta = _source_meta(
            note,
            ledger_map,
            preferred_mode=preferred_mode,
        )
        stamp = _source_time(note, meta)
        if (
            normalized_not_before is not None
            and (stamp is None or stamp < normalized_not_before)
        ):
            continue
        if normalized_mode and _source_mode(note, meta) != normalized_mode:
            continue
        if normalized_scope in {"yesterday", "yesterday_new"}:
            if stamp is None or stamp.astimezone(local_tz).date() != yesterday:
                continue
        elif normalized_scope in {"collect", "like", "post"}:
            if _source_mode(note, meta) != normalized_scope:
                continue
        if query:
            haystack = " ".join([
                note.video_title or "",
                str(meta.get("author_name") or ""),
            ]).casefold()
            if query not in haystack:
                continue
        filtered.append(note)
    ordering_mode = normalized_mode or (
        normalized_scope
        if normalized_scope in {"collect", "like", "post"}
        else None
    )
    if ordering_mode:
        filtered.sort(
            key=lambda note: _source_order_key(
                note,
                ledger_map,
                preferred_mode=ordering_mode,
            )
        )
    return filtered


def list_sources(
    db: Session,
    *,
    user_id: str,
    scope: str = "all_ready",
    search: str = "",
    timezone_name: str = "Asia/Shanghai",
    limit: int = 100,
    include_ids: list[str] | None = None,
) -> dict[str, Any]:
    normalized_scope = scope if scope in SOURCE_SCOPES else "all_ready"
    eligible = _eligible_notes(db, user_id)
    ledger_map = _ledger_map(db, eligible)
    notes = _filter_notes(
        eligible,
        normalized_scope,
        timezone_name=timezone_name,
        search=search,
        ledger_map=ledger_map,
    )
    safe_limit = max(1, min(limit, 1000))
    preferred_mode = (
        normalized_scope
        if normalized_scope in {"collect", "like", "post"}
        else None
    )
    clean_include_ids = list(dict.fromkeys(
        str(note_id or "").strip()
        for note_id in (include_ids or [])
        if str(note_id or "").strip()
    ))[:SOURCE_LIMIT]
    included_items: list[dict[str, Any]] = []
    if clean_include_ids:
        included_notes = (
            db.query(Note)
            .filter(
                Note.user_id == user_id,
                Note.id.in_(clean_include_ids),
                Note.transcript_raw.is_not(None),
                Note.transcript_raw != "",
            )
            .all()
        )
        included_by_id = {note.id: note for note in included_notes}
        included_ledger_map = _ledger_map(db, included_notes)
        included_items = [
            _source_dict(
                included_by_id[note_id],
                included_ledger_map,
                preferred_mode=preferred_mode,
            )
            for note_id in clean_include_ids
            if note_id in included_by_id
        ]
    return {
        "scope": normalized_scope,
        "scope_label": SOURCE_SCOPES[normalized_scope],
        "channel_counts": _channel_counts(notes, ledger_map),
        "items": [
            _source_dict(
                note,
                ledger_map,
                preferred_mode=preferred_mode,
            )
            for note in notes[:safe_limit]
        ],
        "included_items": included_items,
        "total": len(notes),
        "truncated": len(notes) > safe_limit,
        "database_stores_media": False,
    }


def smart_search_sources(
    db: Session,
    *,
    user_id: str,
    query: str,
    scope: str = "all_ready",
    timezone_name: str = "Asia/Shanghai",
    limit: int = 30,
) -> dict[str, Any]:
    """Find relevant user-owned videos without letting the model select them."""
    clean_query = str(query or "").strip()[:200]
    if len(clean_query) < 2:
        raise ValueError("请至少输入两个字，描述你想找的视频")
    normalized_scope = scope if scope in SOURCE_SCOPES else "all_ready"
    eligible = _eligible_notes(db, user_id)
    ledger_map = _ledger_map(db, eligible)
    scoped_notes = _filter_notes(
        eligible,
        normalized_scope,
        timezone_name=timezone_name,
        ledger_map=ledger_map,
    )

    scanned_notes: list[Note] = []
    scanned_chars = 0
    for note in scoped_notes:
        transcript = str(note.transcript_raw or "")
        bounded_length = min(len(transcript), SMART_SOURCE_TRANSCRIPT_LIMIT)
        if len(scanned_notes) >= SMART_SOURCE_SCAN_LIMIT:
            break
        if (
            scanned_notes
            and scanned_chars + bounded_length > SMART_SOURCE_TOTAL_CHARS
        ):
            break
        scanned_notes.append(note)
        scanned_chars += bounded_length

    preferred_mode = (
        normalized_scope
        if normalized_scope in {"collect", "like", "post"}
        else None
    )
    source_payloads: list[dict[str, Any]] = []
    notes_by_id: dict[str, Note] = {}
    for note in scanned_notes:
        source = _source_dict(
            note,
            ledger_map,
            preferred_mode=preferred_mode,
        )
        source_payloads.append({
            **source,
            "transcript": str(note.transcript_raw or "")[
                :SMART_SOURCE_TRANSCRIPT_LIMIT
            ],
            "ai_summary": note.ai_summary,
        })
        notes_by_id[note.id] = note

    ranked = ai_juicer.rank_library_sources_for_selection(
        source_payloads,
        clean_query,
        limit=max(1, min(limit, 50)),
    )
    items: list[dict[str, Any]] = []
    for match in ranked["items"]:
        note = notes_by_id.get(str(match.get("note_id") or ""))
        if note is None:
            continue
        item = _source_dict(
            note,
            ledger_map,
            preferred_mode=preferred_mode,
        )
        item["match"] = {
            "rank": int(match.get("rank") or 0),
            "score": int(match.get("score") or 0),
            "fields": list(match.get("fields") or []),
            "snippet": str(match.get("snippet") or "")[:240],
        }
        items.append(item)

    matched_count = int(ranked.get("matched_count") or len(items))
    return {
        "query": clean_query,
        "search_mode": ranked.get("search_mode") or "keyword_fallback",
        "expanded_queries": list(ranked.get("expanded_queries") or [clean_query]),
        "scope": normalized_scope,
        "scope_label": SOURCE_SCOPES[normalized_scope],
        "items": items,
        "total": matched_count,
        "ready_count": len(scoped_notes),
        "matched_count": matched_count,
        "scanned_count": len(scanned_notes),
        "truncated": (
            len(scoped_notes) > len(scanned_notes)
            or matched_count > len(items)
        ),
        "database_stores_media": False,
    }


def resolve_source_snapshot(
    db: Session,
    *,
    user_id: str,
    scope: str,
    source_ids: list[str] | None = None,
    timezone_name: str = "Asia/Shanghai",
    reference_at: datetime | None = None,
    source_mode_filter: str | None = None,
    not_before: datetime | None = None,
) -> tuple[list[Note], int, bool, str]:
    normalized_scope = scope if scope in SOURCE_SCOPES else "all_ready"
    if normalized_scope == "selected":
        clean_ids = list(dict.fromkeys(
            str(note_id or "").strip()
            for note_id in (source_ids or [])
            if str(note_id or "").strip()
        ))
        if not clean_ids:
            raise ValueError("请至少选择一个已有完整文案的视频")
        if len(clean_ids) > SOURCE_LIMIT:
            raise ValueError(f"一次最多选择 {SOURCE_LIMIT} 条视频")
        notes = (
            db.query(Note)
            .filter(
                Note.user_id == user_id,
                Note.id.in_(clean_ids),
                Note.transcript_raw.is_not(None),
                Note.transcript_raw != "",
            )
            .all()
        )
        by_id = {note.id: note for note in notes}
        if len(by_id) != len(clean_ids):
            raise ValueError("所选视频不存在或文案尚未就绪")
        ordered = [by_id[note_id] for note_id in clean_ids]
        return ordered, len(ordered), False, SOURCE_SCOPES[normalized_scope]

    eligible = _eligible_notes(db, user_id)
    ledger_map = _ledger_map(db, eligible)
    candidates = _filter_notes(
        eligible,
        normalized_scope,
        timezone_name=timezone_name,
        reference_at=reference_at,
        source_mode_filter=source_mode_filter,
        not_before=not_before,
        ledger_map=ledger_map,
    )
    selected = candidates[:SOURCE_LIMIT]
    return (
        selected,
        len(candidates),
        len(candidates) > SOURCE_LIMIT,
        SOURCE_SCOPES[normalized_scope],
    )


def suggest_starter_questions(
    db: Session,
    *,
    user_id: str,
    scope: str,
    source_ids: list[str] | None = None,
    timezone_name: str = "Asia/Shanghai",
) -> dict[str, Any]:
    """Generate starter questions from the caller's frozen transcript scope."""
    notes, available_count, truncated, scope_label = resolve_source_snapshot(
        db,
        user_id=user_id,
        scope=scope,
        source_ids=source_ids,
        timezone_name=timezone_name,
    )
    if not notes:
        raise ValueError(f"{scope_label}里还没有文案就绪的视频")
    questions = ai_juicer.suggest_library_questions([
        {
            "note_id": note.id,
            "title": note.video_title or "未命名视频",
            "transcript": str(note.transcript_raw or ""),
        }
        for note in notes
    ])
    return {
        "questions": questions,
        "source_count": len(notes),
        "available_count": available_count,
        "source_scope": scope if scope in SOURCE_SCOPES else "all_ready",
        "scope_label": scope_label,
        "truncated": truncated,
    }


def create_thread(
    db: Session,
    *,
    user_id: str,
    scope: str,
    source_ids: list[str] | None = None,
    title: str = "",
    timezone_name: str = "Asia/Shanghai",
    context_type: str = "video",
    context_id: str | None = None,
) -> AgentThread:
    normalized_context = "plan" if context_type == "plan" else "video"
    if normalized_context == "plan":
        clean_context_id = str(context_id or "").strip()
        plan = db.query(Plan).filter(
            Plan.id == clean_context_id,
            Plan.user_id == user_id,
        ).first()
        if plan is None:
            raise ValueError("计划不存在")
        clean_title = title.strip()[:256] or f"调整计划：{plan.title}"
        thread = AgentThread(
            user_id=user_id,
            title=clean_title,
            scope_type="selected",
            scope_label="当前计划",
            source_ids_json="[]",
            source_available_count=0,
            source_selected_count=0,
            source_truncated=False,
            context_type="plan",
            context_id=plan.id,
            status="ready",
        )
        db.add(thread)
        db.commit()
        db.refresh(thread)
        return thread

    notes, available_count, truncated, scope_label = resolve_source_snapshot(
        db,
        user_id=user_id,
        scope=scope,
        source_ids=source_ids,
        timezone_name=timezone_name,
    )
    if not notes:
        raise ValueError(f"{scope_label}里还没有文案就绪的视频")
    clean_title = title.strip()[:256] or f"{scope_label}研究"
    normalized_scope = scope if scope in SOURCE_SCOPES else "all_ready"
    thread = AgentThread(
        user_id=user_id,
        title=clean_title,
        scope_type=normalized_scope,
        scope_label=scope_label,
        source_ids_json=json.dumps([note.id for note in notes]),
        source_available_count=available_count,
        source_selected_count=len(notes),
        source_truncated=truncated,
        context_type="video",
        context_id=None,
        status="ready",
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return thread


def create_thread_from_notes(
    db: Session,
    *,
    user_id: str,
    notes: list[Note],
    title: str,
    scope_label: str,
    scope_type: str = "selected",
) -> AgentThread:
    owned = [
        note
        for note in notes
        if note.user_id == user_id and (note.transcript_raw or "").strip()
    ][:SOURCE_LIMIT]
    if not owned:
        raise ValueError("没有可用于创建 Agent 任务的完整文案")
    thread = AgentThread(
        user_id=user_id,
        title=title.strip()[:256] or "视频研究",
        scope_type=scope_type,
        scope_label=scope_label[:128],
        source_ids_json=json.dumps([note.id for note in owned]),
        source_available_count=len(notes),
        source_selected_count=len(owned),
        source_truncated=len(notes) > SOURCE_LIMIT,
        status="ready",
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return thread


def get_thread(db: Session, thread_id: str, user_id: str) -> AgentThread | None:
    return (
        db.query(AgentThread)
        .filter(AgentThread.id == thread_id, AgentThread.user_id == user_id)
        .first()
    )


def _message_count(db: Session, thread_id: str, user_id: str) -> int:
    return int(
        db.query(func.count(AgentMessage.id))
        .filter(
            AgentMessage.thread_id == thread_id,
            AgentMessage.user_id == user_id,
        )
        .scalar()
        or 0
    )


def _reconcile_terminal_durable_turn(
    db: Session,
    thread: AgentThread,
    *,
    active_turn: AgentTurn | None,
) -> bool:
    """Repair a thread left running after its durable Turn became terminal.

    A legacy, non-durable request may legitimately have ``thread.status`` set
    to ``running`` without an AgentTurn. We only repair when the latest durable
    Turn is terminal and is at least as new as the thread row. That timestamp
    ordering proves the terminal Turn superseded the visible running state.
    """
    if thread.status != "running" or active_turn is not None:
        return False
    latest_turn = (
        db.query(AgentTurn)
        .filter(
            AgentTurn.thread_id == thread.id,
            AgentTurn.user_id == thread.user_id,
        )
        .order_by(AgentTurn.updated_at.desc(), AgentTurn.created_at.desc())
        .first()
    )
    if latest_turn is None or latest_turn.status not in {
        "completed", "failed", "cancelled"
    }:
        return False
    latest_updated = _aware_utc(latest_turn.updated_at)
    thread_updated = _aware_utc(thread.updated_at)
    if (
        latest_updated is None
        or thread_updated is None
        or latest_updated < thread_updated
    ):
        return False

    repaired_status = "ready" if latest_turn.status == "completed" else "failed"
    logger.warning(
        "修复 Agent 幽灵运行状态: thread_id=%s turn_id=%s turn_status=%s",
        thread.id,
        latest_turn.id,
        latest_turn.status,
    )
    thread.status = repaired_status
    thread.updated_at = _utcnow()
    db.commit()
    db.refresh(thread)
    return True


def serialize_thread(
    db: Session,
    thread: AgentThread,
    *,
    include_messages: bool = False,
    include_sources: bool = False,
) -> dict[str, Any]:
    active_turn = (
        db.query(AgentTurn)
        .filter(
            AgentTurn.thread_id == thread.id,
            AgentTurn.user_id == thread.user_id,
            AgentTurn.status.in_(("queued", "running", "retry_wait")),
        )
        .order_by(AgentTurn.created_at.desc())
        .first()
    )
    _reconcile_terminal_durable_turn(db, thread, active_turn=active_turn)
    data = thread.to_dict()
    if thread.context_type == "plan" and thread.context_id:
        plan = db.query(Plan).filter(
            Plan.id == thread.context_id,
            Plan.user_id == thread.user_id,
        ).first()
        data["context"] = {
            "type": "plan",
            "id": thread.context_id,
            "title": plan.title if plan is not None else "计划已删除",
            "available": plan is not None,
            "plan": plan.to_dict() if plan is not None else None,
        }
    data["source_scope"] = thread.scope_type
    data["source_count"] = thread.source_selected_count
    data["message_count"] = _message_count(db, thread.id, thread.user_id)
    last_message = (
        db.query(AgentMessage)
        .filter(
            AgentMessage.thread_id == thread.id,
            AgentMessage.user_id == thread.user_id,
        )
        .order_by(AgentMessage.created_at.desc())
        .first()
    )
    data["last_message"] = (
        last_message.content[:160] if last_message is not None else ""
    )
    data["last_message_at"] = (
        (
            last_message.created_at.replace(tzinfo=timezone.utc)
            if last_message.created_at.tzinfo is None
            else last_message.created_at.astimezone(timezone.utc)
        ).isoformat().replace("+00:00", "Z")
        if last_message is not None and last_message.created_at
        else None
    )
    data["active_turn"] = active_turn.to_dict() if active_turn is not None else None
    if include_messages:
        messages = (
            db.query(AgentMessage)
            .filter(
                AgentMessage.thread_id == thread.id,
                AgentMessage.user_id == thread.user_id,
            )
            .order_by(AgentMessage.created_at.asc())
            .all()
        )
        data["messages"] = [message.to_dict() for message in messages]
    if include_sources:
        notes = (
            db.query(Note)
            .filter(
                Note.user_id == thread.user_id,
                Note.id.in_(thread.source_ids),
            )
            .all()
        )
        by_id = {note.id: note for note in notes}
        ledger_map = _ledger_map(db, notes)
        data["sources"] = [
            _source_dict(by_id[note_id], ledger_map)
            for note_id in thread.source_ids
            if note_id in by_id
        ]
    return data


def list_threads(
    db: Session,
    *,
    user_id: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    threads = (
        db.query(AgentThread)
        .filter(AgentThread.user_id == user_id)
        .order_by(AgentThread.updated_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    return [serialize_thread(db, thread, include_messages=False) for thread in threads]


def mark_stale_threads(db: Session) -> int:
    """Release tasks left running by an interrupted app/LLM process."""
    changed = (
        db.query(AgentThread)
        .filter(
            AgentThread.status == "running",
            AgentThread.updated_at < _utcnow() - timedelta(hours=1),
        )
        .update(
            {
                AgentThread.status: "failed",
                AgentThread.updated_at: _utcnow(),
            },
            synchronize_session=False,
        )
    )
    if changed:
        db.commit()
    return int(changed or 0)


def update_thread(
    db: Session,
    thread: AgentThread,
    *,
    title: str | None = None,
) -> AgentThread:
    if title is not None:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("任务标题不能为空")
        thread.title = clean_title[:256]
    thread.updated_at = _utcnow()
    db.commit()
    db.refresh(thread)
    return thread


def delete_thread(db: Session, thread: AgentThread) -> None:
    if thread.status in {"running", "awaiting_approval", "running_analysis"}:
        raise ValueError("这个任务仍有回答或详细解析待处理，完成或取消后即可删除")
    db.query(AgentMessage).filter(
        AgentMessage.thread_id == thread.id,
        AgentMessage.user_id == thread.user_id,
    ).delete(synchronize_session=False)
    db.delete(thread)
    db.commit()


def _thread_notes(db: Session, thread: AgentThread) -> list[Note]:
    notes = (
        db.query(Note)
        .filter(
            Note.user_id == thread.user_id,
            Note.id.in_(thread.source_ids),
            Note.transcript_raw.is_not(None),
            Note.transcript_raw != "",
        )
        .all()
    )
    by_id = {note.id: note for note in notes}
    return [by_id[note_id] for note_id in thread.source_ids if note_id in by_id]


def _safe_json_dict(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _history_before_turn(
    db: Session,
    *,
    thread: AgentThread,
    user_message: AgentMessage,
) -> list[dict[str, str]]:
    previous_messages = (
        db.query(AgentMessage)
        .filter(
            AgentMessage.thread_id == thread.id,
            AgentMessage.user_id == thread.user_id,
            AgentMessage.created_at < user_message.created_at,
        )
        .order_by(AgentMessage.created_at.desc())
        .limit(6)
        .all()
    )
    completed_turn_ids = {
        message.turn_id
        for message in previous_messages
        if message.role == "assistant" and message.turn_id
    }
    return [
        {"role": message.role, "content": message.content}
        for message in reversed(previous_messages)
        if (
            message.role == "assistant"
            or (
                message.role == "user"
                and (
                    not message.turn_id
                    or message.turn_id in completed_turn_ids
                )
            )
        )
    ]


def _summary_without_visual_evidence(raw_summary: str | None) -> str | None:
    payload = _safe_json_dict(raw_summary)
    if not payload:
        return raw_summary
    payload.pop("detailed_video_analysis", None)
    sections = payload.get("sections")
    if isinstance(sections, list):
        payload["sections"] = [
            section
            for section in sections
            if not (
                isinstance(section, dict)
                and str(section.get("source") or "") == "detailed_video_analysis"
            )
        ]
    return json.dumps(payload, ensure_ascii=False)


def _answer_sources(
    notes: list[Note],
    *,
    include_visual: bool = True,
) -> list[dict[str, Any]]:
    return [
        {
            "note_id": note.id,
            "title": note.video_title,
            "transcript": note.transcript_raw,
            "ai_summary": (
                note.ai_summary
                if include_visual
                else _summary_without_visual_evidence(note.ai_summary)
            ),
        }
        for note in notes
    ]


def _persist_answer_result(
    db: Session,
    *,
    thread: AgentThread,
    user_message: AgentMessage,
    notes: list[Note],
    result: dict[str, Any],
    replace_message: AgentMessage | None = None,
    extra_result: dict[str, Any] | None = None,
    limitation: str = "",
) -> AgentMessage:
    if limitation:
        limitations = [
            str(item).strip()
            for item in result.get("limitations", [])
            if str(item).strip()
        ]
        if limitation not in limitations:
            limitations.append(limitation)
        result["limitations"] = limitations

    source_context = result.get("source_context")
    valid_note_ids = {note.id for note in notes}
    researched_note_ids = (
        source_context.get("researched_note_ids")
        if isinstance(source_context, dict)
        else None
    )
    persisted_note_ids = [
        note_id
        for raw_note_id in (
            researched_note_ids
            if isinstance(researched_note_ids, list)
            else [note.id for note in notes]
        )
        if (note_id := str(raw_note_id).strip()) in valid_note_ids
    ]
    persisted_result = {
        **result,
        "note_ids": persisted_note_ids,
        **(extra_result or {}),
    }
    assistant_message = replace_message or AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        turn_id=user_message.turn_id,
        role="assistant",
        content="",
    )
    assistant_message.content = str(result.get("answer") or "").strip()
    assistant_message.result_json = json.dumps(
        persisted_result,
        ensure_ascii=False,
    )
    if replace_message is None:
        db.add(assistant_message)
    thread.status = "ready"
    thread.updated_at = _utcnow()
    db.commit()
    db.refresh(assistant_message)
    db.refresh(thread)
    return assistant_message


def _plan_preview_answer(preview: dict[str, Any]) -> str:
    diff = preview.get("diff") if isinstance(preview.get("diff"), dict) else {}
    additions = len(diff.get("additions") or [])
    modifications = len(diff.get("modifications") or [])
    removals = len(diff.get("removals") or [])
    preserved = int(diff.get("completed_tasks_preserved") or 0)
    summary = str(preview.get("change_summary") or "已生成计划调整预览").strip()
    return (
        f"{summary}\n\n"
        f"这份预览包含：新增 {additions} 项、调整 {modifications} 项、"
        f"移除 {removals} 项；保留 {preserved} 条已完成记录。\n\n"
        "我还没有修改计划。请检查下方变更，确认后才会应用。"
    )


def _ask_plan_thread(
    db: Session,
    *,
    thread: AgentThread,
    content: str,
    progress_callback: AgentProgressCallback | None,
    answer_delta: Callable[[str], None] | None,
    turn_id_override: str | None,
) -> tuple[AgentMessage, AgentMessage]:
    plan = plan_service.get_plan(
        db,
        str(thread.context_id or ""),
        user_id=thread.user_id,
    )
    if plan is None:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        db.commit()
        raise ValueError("当前计划已删除或无权访问")

    turn_id = turn_id_override or str(uuid.uuid4())
    user_message = AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        turn_id=turn_id,
        role="user",
        content=content[:600],
    )
    db.add(user_message)
    db.commit()
    db.refresh(user_message)
    _emit_progress(
        progress_callback,
        "reading",
        f"正在读取计划《{plan.title}》",
        context_type="plan",
        plan_id=plan.id,
    )

    note = (
        db.query(Note).filter(
            Note.id == plan.note_id,
            Note.user_id == thread.user_id,
        ).first()
        if plan.note_id
        else None
    )
    try:
        generated = ai_juicer.generate_or_revise_plan(
            title=note.video_title if note else plan.title,
            transcript=note.transcript_raw if note else None,
            ai_summary=note.ai_summary if note else None,
            instruction=content,
            existing_plan=plan.to_dict(),
        )
        proposed = generated["plan"]
        fields, tasks, total_days = ai_juicer.plan_to_storage(proposed)
        preview = plan_service.build_coaching_preview(
            plan,
            proposed_title=str(proposed.get("goal") or plan.title),
            proposed_fields=fields,
            proposed_tasks=tasks,
            proposed_days=(
                proposed.get("days")
                if isinstance(proposed.get("days"), list)
                else []
            ),
            proposed_total_days=total_days,
            change_summary=generated["change_summary"],
        )
        preview["source_context"] = generated.get("source_context") or {}
        answer = _plan_preview_answer(preview)
        if answer_delta is not None:
            for index in range(0, len(answer), 96):
                answer_delta(answer[index:index + 96])
        result = {
            "answer": answer,
            "type": "plan_change_preview",
            "plan_change": {
                **preview,
                "state": "pending",
            },
            "source_context": {
                "context_type": "plan",
                "plan_id": plan.id,
                "plan_title": plan.title,
            },
        }
        assistant_message = _persist_answer_result(
            db,
            thread=thread,
            user_message=user_message,
            notes=[],
            result=result,
        )
    except Exception:
        db.rollback()
        persisted = db.query(AgentMessage).filter(
            AgentMessage.id == user_message.id,
            AgentMessage.user_id == thread.user_id,
        ).first()
        if persisted is not None:
            db.delete(persisted)
        persisted_thread = db.query(AgentThread).filter(
            AgentThread.id == thread.id,
            AgentThread.user_id == thread.user_id,
        ).first()
        if persisted_thread is not None:
            persisted_thread.status = "failed"
            persisted_thread.updated_at = _utcnow()
        db.commit()
        raise

    if thread.title.startswith("调整计划："):
        thread.title = content[:40]
        db.commit()
        db.refresh(thread)
    _emit_progress(
        progress_callback,
        "completed",
        "计划调整预览已保存，等待你确认",
        assistant_message_id=assistant_message.id,
        context_type="plan",
        plan_id=plan.id,
    )
    return user_message, assistant_message


def apply_plan_change_message(
    db: Session,
    *,
    message_id: str,
    user_id: str,
) -> tuple[Plan, AgentMessage]:
    message = db.query(AgentMessage).filter(
        AgentMessage.id == message_id,
        AgentMessage.user_id == user_id,
        AgentMessage.role == "assistant",
    ).with_for_update().first()
    if message is None:
        raise ValueError("计划变更预览不存在")
    thread = db.query(AgentThread).filter(
        AgentThread.id == message.thread_id,
        AgentThread.user_id == user_id,
        AgentThread.context_type == "plan",
    ).first()
    if thread is None:
        raise ValueError("这条消息不属于计划会话")

    result = _safe_json_dict(message.result_json)
    change = result.get("plan_change")
    if (
        str(result.get("type") or "") != "plan_change_preview"
        or not isinstance(change, dict)
    ):
        raise ValueError("这条消息不包含可应用的计划预览")
    plan_id = str(change.get("plan_id") or "")
    if plan_id != str(thread.context_id or ""):
        raise ValueError("计划预览与当前会话不匹配")
    plan = plan_service.get_plan(db, plan_id, user_id=user_id)
    if plan is None:
        raise ValueError("计划不存在")
    if str(change.get("state") or "pending") == "applied":
        return plan, message

    operations = change.get("operations")
    if not isinstance(operations, list):
        raise ValueError("计划预览内容无效")
    applied = plan_service.apply_coaching_preview(
        db,
        plan_id=plan_id,
        user_id=user_id,
        base_updated_at=str(change.get("base_updated_at") or ""),
        operations=operations,
    )
    if applied is None:
        raise ValueError("计划不存在")
    change["state"] = "applied"
    change["applied_at"] = _utcnow().isoformat().replace("+00:00", "Z")
    change["applied_plan_updated_at"] = applied.to_dict().get("updated_at")
    result["plan_change"] = change
    message.result_json = json.dumps(result, ensure_ascii=False)
    db.commit()
    db.refresh(message)
    db.refresh(applied)
    return applied, message


def _video_analysis_terminal_payload(
    db: Session,
    *,
    thread: AgentThread,
    user_message: AgentMessage,
    assistant_message: AgentMessage,
    analysis: dict[str, Any],
    event_type: str,
) -> dict[str, Any]:
    return {
        "terminal": event_type,
        "thread": serialize_thread(
            db,
            thread,
            include_messages=True,
            include_sources=True,
        ),
        "user_message": user_message.to_dict(),
        "assistant_message": assistant_message.to_dict(),
        "video_analysis": analysis,
    }


def _persist_video_analysis_card(
    db: Session,
    *,
    thread: AgentThread,
    user_message: AgentMessage,
    prepared: dict[str, Any],
    state: str,
    commit: bool = True,
) -> AgentMessage:
    run = prepared.get("run") if isinstance(prepared.get("run"), dict) else {}
    quote = prepared.get("quote") if isinstance(prepared.get("quote"), dict) else {}
    source_count = max(1, int(run.get("source_count") or len(prepared.get("items") or [])))
    if state == "approval_required":
        content = (
            f"这个问题需要读取 {source_count} 条相关视频的画面。"
            "确认解析后，我会在后台完成分析并自动继续回答。"
        )
        thread.status = "awaiting_approval"
    else:
        content = (
            f"已开始读取 {source_count} 条相关视频的画面。"
            "你可以离开当前页面，解析完成后我会自动继续回答。"
        )
        thread.status = "running_analysis"
    result = {
        "type": f"video_analysis_{state}",
        "video_analysis": {
            "run": run,
            "quote": quote,
            "items": prepared.get("items") or [],
            "requires_confirmation": bool(prepared.get("requires_confirmation")),
            "can_start": bool(
                prepared.get("can_start", prepared.get("can_auto_start", False))
            ),
        },
    }
    message = AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        turn_id=user_message.turn_id,
        role="assistant",
        content=content,
        result_json=json.dumps(result, ensure_ascii=False),
    )
    thread.updated_at = _utcnow()
    db.add(message)
    if commit:
        db.commit()
        db.refresh(message)
        db.refresh(thread)
    else:
        # The Agent auto-start path commits this card in the same transaction
        # as the queue reservation.  A very fast local worker can therefore
        # never finish before the resumable card/thread state exists.
        db.flush()
    return message


def _prepare_agent_visual_analysis(
    db: Session,
    *,
    thread: AgentThread,
    user_message: AgentMessage,
    notes: list[Note],
    question: str,
    research_mode: str,
    output_style: str,
    custom_instruction: str,
    web_scope: str,
) -> str:
    """Prepare the controlled visual tool or return a text-answer limitation."""
    if not agent_video_analysis_service.requires_visual_analysis(question):
        return ""
    try:
        from app.services import (
            video_analysis_catalog_service,
            video_analysis_service,
        )

        runtime = video_analysis_catalog_service.get_runtime_settings(db)
        if not runtime.get("enabled"):
            return "本次未读取视频画面：详细解析功能当前未开放。"
        decision = agent_video_analysis_service.plan_tool_call(
            notes,
            question,
            limit=int(
                runtime.get("agent_max_candidates")
                or runtime.get("agent_candidate_limit")
                or 3
            ),
        )
        if not decision.needed:
            return "本次未读取视频画面：没有找到需要视觉解析的相关视频。"
        note_ids = agent_video_analysis_service.validate_tool_note_ids(
            decision.note_ids,
            thread.source_ids,
            maximum=int(
                runtime.get("agent_max_candidates")
                or runtime.get("agent_candidate_limit")
                or 3
            ),
        )
        prepared = video_analysis_service.prepare_run(
            db,
            user_id=thread.user_id,
            note_ids=note_ids,
            trigger="agent",
            agent_thread_id=thread.id,
            agent_turn_id=user_message.turn_id,
            agent_context={
                "question": question,
                "research_mode": research_mode,
                "output_style": output_style,
                "custom_instruction": custom_instruction,
                "web_scope": web_scope,
                "source_ids": list(thread.source_ids),
            },
        )
    except Exception as exc:
        # Catalog/eligibility failures must not convert a normal Agent turn
        # into a paid or stuck task. The text answer remains available.
        code = str(getattr(exc, "code", ""))
        if code in {
            "feature_disabled",
            "no_published_offering",
            "no_available_offering",
            "no_supported_items",
            "offering_not_available",
            "offering_unavailable",
            "free_quota_exhausted",
            "duration_unknown",
        }:
            return "本次未读取视频画面：当前没有可用的详细解析方案。"
        raise

    items = prepared.get("items") if isinstance(prepared.get("items"), list) else []
    actionable = [
        item
        for item in items
        if str(item.get("status") or "") not in {"cached", "unsupported"}
    ]
    if not actionable:
        if any(str(item.get("status") or "") == "cached" for item in items):
            return ""
        return "本次未读取视频画面：相关来源不支持详细视频解析。"

    can_start = bool(
        prepared.get("can_start", prepared.get("can_auto_start", False))
    )
    requires_confirmation = bool(prepared.get("requires_confirmation", True))
    event_type = "approval_required"
    if can_start and not requires_confirmation and len(note_ids) == 1:
        run = prepared.get("run") if isinstance(prepared.get("run"), dict) else {}
        event_type = "analysis_started"
        card_holder: dict[str, AgentMessage] = {}

        def persist_auto_started(
            confirmed_run: Any,
            confirmed_items: list[Any],
        ) -> None:
            preview = {
                **prepared,
                "run": video_analysis_service.serialize_run(
                    confirmed_run,
                    items=confirmed_items,
                ),
                "items": [
                    video_analysis_service.serialize_item(item)
                    for item in confirmed_items
                ],
                "requires_confirmation": False,
            }
            card_holder["card"] = _persist_video_analysis_card(
                db,
                thread=thread,
                user_message=user_message,
                prepared=preview,
                state=event_type,
                commit=False,
            )

        confirmed = video_analysis_service.confirm_run(
            db,
            user_id=thread.user_id,
            run_id=str(run.get("id") or ""),
            idempotency_key=f"agent-auto:{thread.id}:{user_message.turn_id}",
            before_commit=persist_auto_started,
        )
        prepared = {**prepared, **confirmed, "requires_confirmation": False}
        card = card_holder["card"]
        db.refresh(card)
        db.refresh(thread)
    else:
        card = _persist_video_analysis_card(
            db,
            thread=thread,
            user_message=user_message,
            prepared=prepared,
            state=event_type,
        )
    raise AgentVideoAnalysisTerminal(
        event_type,
        _video_analysis_terminal_payload(
            db,
            thread=thread,
            user_message=user_message,
            assistant_message=card,
            analysis=card.result.get("video_analysis", {}),
            event_type=event_type,
        ),
    )


def ask_thread(
    db: Session,
    *,
    thread: AgentThread,
    content: str,
    research_mode: str = "fast",
    output_style: str = "answer",
    custom_instruction: str = "",
    web_scope: str = "auto",
    progress_callback: AgentProgressCallback | None = None,
    answer_delta: Callable[[str], None] | None = None,
    allow_video_analysis: bool = True,
    turn_id_override: str | None = None,
    history_override: list[dict[str, str]] | None = None,
    tool_executor: AgentToolExecutor | None = None,
    validated_stream_only: bool = False,
) -> tuple[AgentMessage, AgentMessage]:
    clean_content = content.strip()
    if not clean_content:
        raise ValueError("问题不能为空")
    clear_orphaned_failed_turns = thread.status == "failed"

    # Serialize claims through the owning user row on PostgreSQL. The CAS on
    # thread.status remains the authoritative same-thread guard everywhere.
    db.query(User.id).filter(User.id == thread.user_id).with_for_update().first()
    now = _utcnow()
    minute_ago = now - timedelta(minutes=1)
    day_ago = now - timedelta(days=1)
    recent_count = (
        db.query(func.count(AgentMessage.id))
        .filter(
            AgentMessage.user_id == thread.user_id,
            AgentMessage.role == "user",
            AgentMessage.created_at >= minute_ago,
        )
        .scalar()
        or 0
    )
    daily_count = (
        db.query(func.count(AgentMessage.id))
        .filter(
            AgentMessage.user_id == thread.user_id,
            AgentMessage.role == "user",
            AgentMessage.created_at >= day_ago,
        )
        .scalar()
        or 0
    )
    if recent_count >= MAX_QUESTIONS_PER_MINUTE:
        db.rollback()
        raise ValueError("提问太快了，请稍等一分钟再继续")
    if daily_count >= MAX_QUESTIONS_PER_DAY:
        db.rollback()
        raise ValueError("今天的视频研究次数已达到上限，请明天继续")
    active_count = (
        db.query(func.count(AgentThread.id))
        .filter(
            AgentThread.user_id == thread.user_id,
            AgentThread.status.in_(("running", "running_analysis")),
            AgentThread.id != thread.id,
        )
        .scalar()
        or 0
    )
    if active_count >= MAX_ACTIVE_THREADS_PER_USER:
        db.rollback()
        raise ValueError("已有两个视频任务正在回答，请等其中一个完成")
    claimed = (
        db.query(AgentThread)
        .filter(
            AgentThread.id == thread.id,
            AgentThread.user_id == thread.user_id,
            or_(
                AgentThread.status.in_(("ready", "failed")),
                (
                    AgentThread.status == "running"
                ) & (
                    AgentThread.updated_at < now - timedelta(hours=1)
                ),
            ),
        )
        .update(
            {
                AgentThread.status: "running",
                AgentThread.updated_at: now,
            },
            synchronize_session=False,
        )
    )
    if claimed != 1:
        db.rollback()
        raise AgentThreadConflictError("这个任务正在回答上一条问题，请稍候")
    db.commit()
    db.refresh(thread)

    notes = _thread_notes(db, thread)
    if thread.context_type == "plan":
        return _ask_plan_thread(
            db,
            thread=thread,
            content=clean_content,
            progress_callback=progress_callback,
            answer_delta=answer_delta,
            turn_id_override=turn_id_override,
        )
    if not notes:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        db.commit()
        raise ValueError("这个任务的资料文案已不可用，请重新选择资料")

    if clear_orphaned_failed_turns:
        assistant_turn_ids = {
            str(turn_id)
            for (turn_id,) in (
                db.query(AgentMessage.turn_id)
                .filter(
                    AgentMessage.thread_id == thread.id,
                    AgentMessage.user_id == thread.user_id,
                    AgentMessage.role == "assistant",
                    AgentMessage.turn_id.is_not(None),
                )
                .all()
            )
            if turn_id
        }
        orphan_query = db.query(AgentMessage).filter(
            AgentMessage.thread_id == thread.id,
            AgentMessage.user_id == thread.user_id,
            AgentMessage.role == "user",
            AgentMessage.turn_id.is_not(None),
        )
        if assistant_turn_ids:
            orphan_query = orphan_query.filter(
                AgentMessage.turn_id.notin_(assistant_turn_ids)
            )
        orphan_query.delete(synchronize_session=False)
        db.commit()

    _emit_progress(
        progress_callback,
        "reading",
        f"已接收问题，准备读取 {len(notes)} 条视频资料",
        source_count=len(notes),
    )

    previous_messages = (
        db.query(AgentMessage)
        .filter(
            AgentMessage.thread_id == thread.id,
            AgentMessage.user_id == thread.user_id,
        )
        .order_by(AgentMessage.created_at.desc())
        .limit(6)
        .all()
    )
    completed_turn_ids = {
        message.turn_id
        for message in previous_messages
        if message.role == "assistant" and message.turn_id
    }
    history = [
        {"role": message.role, "content": message.content}
        for message in reversed(previous_messages)
        if (
            message.role == "assistant"
            or (
                message.role == "user"
                and (
                    not message.turn_id
                    or message.turn_id in completed_turn_ids
                )
            )
        )
    ]
    if history_override is not None:
        history = history_override
    turn_id = turn_id_override or str(uuid.uuid4())
    user_message = AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        turn_id=turn_id,
        role="user",
        content=clean_content[:600],
    )
    thread.updated_at = _utcnow()
    db.add(user_message)
    db.commit()
    db.refresh(user_message)

    visual_limitation = ""
    if allow_video_analysis:
        try:
            visual_limitation = _prepare_agent_visual_analysis(
                db,
                thread=thread,
                user_message=user_message,
                notes=notes,
                question=clean_content,
                research_mode=research_mode,
                output_style=output_style,
                custom_instruction=custom_instruction,
                web_scope=web_scope,
            )
        except AgentVideoAnalysisTerminal:
            raise
        except Exception:
            # Visual preflight runs after the user turn is persisted so an
            # approval card can own that turn.  Unexpected failures must use
            # the same retry-safe cleanup as the ordinary answer pipeline.
            db.rollback()
            persisted_user_message = (
                db.query(AgentMessage)
                .filter(
                    AgentMessage.id == user_message.id,
                    AgentMessage.thread_id == thread.id,
                    AgentMessage.user_id == thread.user_id,
                )
                .first()
            )
            if persisted_user_message is not None:
                db.delete(persisted_user_message)
            thread.status = "failed"
            thread.updated_at = _utcnow()
            db.commit()
            raise

    try:
        result = ai_juicer.answer_library_question(
            sources=_answer_sources(notes),
            question=clean_content,
            history=history,
            research_mode=research_mode,
            output_style=output_style,
            custom_instruction=custom_instruction,
            web_scope=web_scope,
            progress_callback=progress_callback,
            answer_delta=answer_delta,
            tool_executor=tool_executor,
            validated_stream_only=validated_stream_only,
        )
    except Exception:
        # The browser presents this turn as retryable. Do not leave behind a
        # persisted user-only turn that would be duplicated on retry/refresh.
        # A durable event write may be the failing operation. Roll it back
        # before cleanup so SQLAlchemy does not turn the useful error into a
        # PendingRollbackError and strand the thread in `running`.
        db.rollback()
        persisted_user_message = (
            db.query(AgentMessage)
            .filter(
                AgentMessage.id == user_message.id,
                AgentMessage.thread_id == thread.id,
                AgentMessage.user_id == thread.user_id,
            )
            .first()
        )
        if persisted_user_message is not None:
            db.delete(persisted_user_message)
        persisted_thread = db.query(AgentThread).filter(
            AgentThread.id == thread.id,
            AgentThread.user_id == thread.user_id,
        ).first()
        if persisted_thread is not None:
            persisted_thread.status = "failed"
            persisted_thread.updated_at = _utcnow()
        db.commit()
        raise

    if len(previous_messages) == 0 and thread.title.endswith("研究"):
        thread.title = clean_content[:40]
    assistant_message = _persist_answer_result(
        db,
        thread=thread,
        user_message=user_message,
        notes=notes,
        result=result,
        limitation=visual_limitation,
    )
    _emit_progress(
        progress_callback,
        "completed",
        "回答和引用已经保存",
        assistant_message_id=assistant_message.id,
    )
    return user_message, assistant_message


def _agent_turn_messages(
    db: Session,
    *,
    thread: AgentThread,
    turn_id: str,
) -> tuple[AgentMessage | None, AgentMessage | None]:
    rows = (
        db.query(AgentMessage)
        .filter(
            AgentMessage.thread_id == thread.id,
            AgentMessage.user_id == thread.user_id,
            AgentMessage.turn_id == turn_id,
        )
        .order_by(AgentMessage.created_at.asc())
        .all()
    )
    return (
        next((row for row in rows if row.role == "user"), None),
        next((row for row in rows if row.role == "assistant"), None),
    )


def _video_analysis_card_run_id(
    message: AgentMessage | None,
    *,
    expected_type: str,
) -> str:
    if message is None:
        return ""
    payload = _safe_json_dict(message.result_json)
    if str(payload.get("type") or "") != expected_type:
        return ""
    analysis = payload.get("video_analysis")
    run = analysis.get("run") if isinstance(analysis, dict) else None
    return str(run.get("id") or "") if isinstance(run, dict) else ""


def _run_analysis_payload(db: Session, run: Any) -> dict[str, Any]:
    from app.models.video_analysis import VideoAnalysisItem
    from app.services import video_analysis_service

    items = (
        db.query(VideoAnalysisItem)
        .filter(VideoAnalysisItem.run_id == run.id)
        .order_by(VideoAnalysisItem.created_at.asc())
        .all()
    )
    return {
        "run": video_analysis_service.serialize_run(run, items=items),
        "items": [
            video_analysis_service.serialize_item(item)
            for item in items
        ] if hasattr(video_analysis_service, "serialize_item") else [],
    }


def _analysis_card_state(
    message: AgentMessage | None,
) -> tuple[str, str, str]:
    """Return persisted card type, bound run id, and finalized run id."""
    if message is None:
        return "", "", ""
    payload = _safe_json_dict(message.result_json)
    analysis = payload.get("video_analysis")
    run = analysis.get("run") if isinstance(analysis, dict) else None
    return (
        str(payload.get("type") or ""),
        str(run.get("id") or "") if isinstance(run, dict) else "",
        str(payload.get("video_analysis_run_id") or ""),
    )


def _run_visual_result_profile(
    db: Session,
    run: Any,
) -> tuple[bool, bool]:
    """Report whether a run produced semantic and/or structural visual data."""
    from app.models.video_analysis import VideoAnalysis, VideoAnalysisItem

    analysis_ids = [
        str(analysis_id)
        for (analysis_id,) in (
            db.query(VideoAnalysisItem.analysis_id)
            .filter(
                VideoAnalysisItem.run_id == run.id,
                VideoAnalysisItem.analysis_id.is_not(None),
            )
            .all()
        )
        if analysis_id
    ]
    if not analysis_ids:
        return False, False
    rows = db.query(VideoAnalysis).filter(VideoAnalysis.id.in_(analysis_ids)).all()
    has_semantic = False
    has_structure = False
    semantic_keys = (
        "summary",
        "observation",
        "description",
        "ocr_text",
        "visible_text",
        "people",
        "objects",
        "actions",
        "events",
        "key_events",
    )
    for row in rows:
        result = row.result
        try:
            scene_count = max(0, int(result.get("scene_count") or 0))
        except (TypeError, ValueError):
            scene_count = 0
        has_structure = has_structure or bool(
            scene_count
            or result.get("chapters")
            or result.get("scenes")
        )
        collections = [
            result.get("visual_observations"),
            result.get("observations"),
            result.get("evidence"),
        ]
        for collection in collections:
            if not isinstance(collection, list):
                continue
            for item in collection:
                if not isinstance(item, dict):
                    continue
                if any(item.get(key) for key in semantic_keys) or item.get("quote"):
                    has_semantic = True
                    break
            if has_semantic:
                break
    return has_semantic, has_structure


def reconcile_video_analysis_agent_run(event: Any) -> None:
    """Repair the durable Agent card/thread state after a process restart.

    ``prepare_run`` intentionally commits its persistent quote before the
    caller creates the Agent card. A crash in that narrow window, or while a
    terminal run is resuming the text answer, is repaired here from the Run's
    immutable thread/turn ownership. The latest Run for a turn is authoritative
    so an older re-quote can never steal a newer question.
    """
    from app.core.database import SessionLocal
    from app.models.video_analysis import VideoAnalysisRun
    from app.services import video_analysis_service

    run_id = str(getattr(event, "run_id", "") or "")
    user_id = str(getattr(event, "user_id", "") or "")
    if not run_id or not user_id:
        return
    should_resume = False
    with SessionLocal() as db:
        run = video_analysis_service.get_run(db, user_id=user_id, run_id=run_id)
        if run is None or str(run.trigger or "") != "agent":
            return
        thread_id = str(run.agent_thread_id or "")
        turn_id = str(run.agent_turn_id or "")
        if not thread_id or not turn_id:
            return
        latest = (
            db.query(VideoAnalysisRun)
            .filter(
                VideoAnalysisRun.user_id == user_id,
                VideoAnalysisRun.trigger == "agent",
                VideoAnalysisRun.agent_thread_id == thread_id,
                VideoAnalysisRun.agent_turn_id == turn_id,
            )
            .order_by(VideoAnalysisRun.created_at.desc(), VideoAnalysisRun.id.desc())
            .first()
        )
        if latest is None or latest.id != run.id:
            return
        thread = get_thread(db, thread_id, user_id)
        if thread is None or thread.status == "archived":
            return
        user_message, card = _agent_turn_messages(
            db,
            thread=thread,
            turn_id=turn_id,
        )
        if user_message is None:
            if str(run.status or "") in {
                "prepared", "reserved", "queued", "running",
                "reauthorization_required",
            }:
                video_analysis_service.cancel_run(
                    db,
                    user_id=user_id,
                    run_id=run.id,
                )
            return

        card_type, bound_run_id, finalized_run_id = _analysis_card_state(card)
        if finalized_run_id == run.id:
            return
        if card_type in {
            "video_analysis_cancelled",
            "video_analysis_resume_failed",
        }:
            return
        if (
            thread.status == "ready"
            and card is not None
            and card_type not in {
                "video_analysis_approval_required",
                "video_analysis_analysis_started",
                "video_analysis_requoting",
            }
        ):
            return

        status = str(run.status or "")
        if card_type == "video_analysis_requoting" and status == "cancelled":
            card.content = "服务重启中断了重新报价，请重新发起问题或稍后再试。"
            card.result_json = json.dumps(
                {"type": "video_analysis_resume_failed"},
                ensure_ascii=False,
            )
            thread.status = "ready"
            thread.updated_at = _utcnow()
            db.commit()
            return

        analysis = _run_analysis_payload(db, run)
        if status == "prepared":
            desired_type = "video_analysis_approval_required"
            content = (
                "服务恢复了尚未开始的详细解析报价。"
                "请确认后再读取视频画面。"
            )
            thread.status = "awaiting_approval"
        elif status in {"reserved", "queued", "running"}:
            desired_type = "video_analysis_analysis_started"
            content = "详细解析正在后台恢复运行，完成后会自动继续回答。"
            thread.status = "running_analysis"
        elif status in {
            "succeeded", "partial", "failed", "cancelled",
            "reauthorization_required",
        }:
            desired_type = "video_analysis_analysis_started"
            content = "详细解析已经结束，正在恢复原问题的回答。"
            thread.status = "running_analysis"
            should_resume = True
        else:
            return

        result_json = json.dumps(
            {"type": desired_type, "video_analysis": analysis},
            ensure_ascii=False,
        )
        if card is None:
            card = AgentMessage(
                thread_id=thread.id,
                user_id=user_id,
                turn_id=turn_id,
                role="assistant",
                content=content,
                result_json=result_json,
            )
            db.add(card)
        else:
            # A current card may reference the cancelled predecessor of a
            # re-quote. Only the newest Run selected above may replace it.
            if bound_run_id and bound_run_id != run.id and card_type not in {
                "video_analysis_requoting",
                "video_analysis_approval_required",
            }:
                return
            card.content = content
            card.result_json = result_json
        thread.updated_at = _utcnow()
        db.commit()

    if should_resume:
        handle_video_analysis_completion(
            SimpleNamespace(
                run_id=run_id,
                user_id=user_id,
                item_id="",
                note_id="",
                status=str(getattr(event, "status", "") or ""),
                recovery=True,
            )
        )


def _resume_agent_answer(
    db: Session,
    *,
    thread: AgentThread,
    turn_id: str,
    run: Any | None,
    limitation: str = "",
    already_claimed: bool = False,
    suppress_visual: bool = False,
) -> AgentMessage:
    user_message, placeholder = _agent_turn_messages(
        db,
        thread=thread,
        turn_id=turn_id,
    )
    if user_message is None:
        raise ValueError("待恢复的 Agent 问题不存在")
    if not already_claimed:
        claimed = (
            db.query(AgentThread)
            .filter(
                AgentThread.id == thread.id,
                AgentThread.user_id == thread.user_id,
                AgentThread.status.in_(("awaiting_approval", "running_analysis")),
            )
            .update(
                {AgentThread.status: "running", AgentThread.updated_at: _utcnow()},
                synchronize_session=False,
            )
        )
        if claimed != 1:
            db.rollback()
            raise AgentThreadConflictError("这条 Agent 问题已经在恢复或已完成")
        db.commit()
        db.refresh(thread)

    context = _safe_json_dict(getattr(run, "agent_context_json", None))
    notes = _thread_notes(db, thread)
    if not notes:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        db.commit()
        raise ValueError("这项任务的资料文稿已不可用")
    history = _history_before_turn(
        db,
        thread=thread,
        user_message=user_message,
    )
    try:
        result = ai_juicer.answer_library_question(
            sources=_answer_sources(notes, include_visual=not suppress_visual),
            question=user_message.content,
            history=history,
            research_mode=str(context.get("research_mode") or "fast"),
            output_style=str(context.get("output_style") or "answer"),
            custom_instruction=str(context.get("custom_instruction") or ""),
            web_scope=str(context.get("web_scope") or "auto"),
        )
    except Exception:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        if placeholder is not None:
            previous = placeholder.result
            placeholder.content = "详细解析已经结束，但自动继续回答失败。你可以点击重新生成。"
            placeholder.result_json = json.dumps(
                {**previous, "type": "video_analysis_resume_failed"},
                ensure_ascii=False,
            )
        db.commit()
        raise

    analysis_meta: dict[str, Any] = {}
    if run is not None:
        analysis_meta = _run_analysis_payload(db, run)
    return _persist_answer_result(
        db,
        thread=thread,
        user_message=user_message,
        notes=notes,
        result=result,
        replace_message=placeholder,
        limitation=limitation,
        extra_result={
            "video_analysis": analysis_meta,
            "video_analysis_run_id": str(getattr(run, "id", "") or ""),
        },
    )


def decide_agent_video_analysis(
    db: Session,
    *,
    thread: AgentThread,
    user_id: str,
    run_id: str,
    action: str,
    idempotency_key: str = "",
    offering_id: str | None = None,
    use_byok: bool = False,
) -> dict[str, Any]:
    """Approve, decline, cancel, or re-quote one persisted Agent tool call."""
    from app.models.video_analysis import VideoAnalysisItem
    from app.services import video_analysis_service

    locked_thread = (
        db.query(AgentThread)
        .filter(
            AgentThread.id == thread.id,
            AgentThread.user_id == user_id,
        )
        .with_for_update()
        .first()
    )
    if locked_thread is None:
        raise ValueError("Agent 任务不存在")
    thread = locked_thread

    run = video_analysis_service.get_run(
        db,
        user_id=user_id,
        run_id=run_id,
    )
    if (
        run is None
        or str(getattr(run, "trigger", "")) != "agent"
        or str(getattr(run, "agent_thread_id", "")) != thread.id
        or not getattr(run, "agent_turn_id", None)
    ):
        raise ValueError("Agent 详细解析审批不存在")
    turn_id = str(run.agent_turn_id)
    user_message, card = _agent_turn_messages(
        db,
        thread=thread,
        turn_id=turn_id,
    )
    if user_message is None or card is None:
        raise ValueError("Agent 详细解析审批记录不完整")
    card_result = _safe_json_dict(card.result_json)
    card_analysis = card_result.get("video_analysis")
    card_run = card_analysis.get("run") if isinstance(card_analysis, dict) else None
    card_run_id = str(card_run.get("id") or "") if isinstance(card_run, dict) else ""
    if (
        thread.status != "awaiting_approval"
        or str(card_result.get("type") or "") != "video_analysis_approval_required"
        or card_run_id != run.id
    ):
        raise AgentThreadConflictError("这张详细解析审批卡已失效，请刷新当前 Agent 任务")
    normalized_action = str(action or "").strip().lower()

    if normalized_action == "approve":
        if str(run.status or "") == "reauthorization_required":
            raise AgentThreadConflictError("实际用量已变化，请先重新报价后再确认")
        if str(run.status or "") != "prepared" or run.confirm_idempotency_key:
            raise AgentThreadConflictError("这份详细解析报价已处理，请刷新当前 Agent 任务")
        def persist_approved_state(
            confirmed_run: Any,
            confirmed_items: list[Any],
        ) -> None:
            confirmed_preview = {
                **(card_analysis if isinstance(card_analysis, dict) else {}),
                "run": video_analysis_service.serialize_run(
                    confirmed_run,
                    items=confirmed_items,
                ),
                "items": [
                    video_analysis_service.serialize_item(item)
                    for item in confirmed_items
                ],
            }
            card.content = "详细解析已进入后台。完成后我会自动继续回答这个问题。"
            card.result_json = json.dumps(
                {
                    "type": "video_analysis_analysis_started",
                    "video_analysis": confirmed_preview,
                },
                ensure_ascii=False,
            )
            thread.status = "running_analysis"
            thread.updated_at = _utcnow()
            db.flush()

        confirmed = video_analysis_service.confirm_run(
            db,
            user_id=user_id,
            run_id=run.id,
            idempotency_key=(
                str(idempotency_key or "").strip()
                or f"agent-approval:{thread.id}:{turn_id}"
            ),
            before_commit=persist_approved_state,
        )
        db.refresh(card)
        db.refresh(thread)
        return _video_analysis_terminal_payload(
            db,
            thread=thread,
            user_message=user_message,
            assistant_message=card,
            analysis=confirmed,
            event_type="analysis_started",
        )

    if normalized_action == "text_only":
        claimed = (
            db.query(AgentThread)
            .filter(
                AgentThread.id == thread.id,
                AgentThread.user_id == user_id,
                AgentThread.status == "awaiting_approval",
            )
            .update(
                {AgentThread.status: "running", AgentThread.updated_at: _utcnow()},
                synchronize_session=False,
            )
        )
        if claimed != 1:
            db.rollback()
            raise AgentThreadConflictError("这张详细解析审批卡已由其他操作处理")
        db.flush()
        video_analysis_service.cancel_run(db, user_id=user_id, run_id=run.id)
        db.refresh(thread)
        assistant = _resume_agent_answer(
            db,
            thread=thread,
            turn_id=turn_id,
            run=run,
            limitation="本次未读取视频画面；回答仅依据已有文稿和摘要。",
            already_claimed=True,
            suppress_visual=True,
        )
        return _video_analysis_terminal_payload(
            db,
            thread=thread,
            user_message=user_message,
            assistant_message=assistant,
            analysis=_run_analysis_payload(db, run),
            event_type="done",
        )

    if normalized_action == "cancel":
        card.content = "已取消这次提问，未开始新的画面解析。"
        card.result_json = json.dumps(
            {
                "type": "video_analysis_cancelled",
                "video_analysis": card_analysis,
            },
            ensure_ascii=False,
        )
        thread.status = "ready"
        thread.updated_at = _utcnow()
        db.flush()
        cancelled = video_analysis_service.cancel_run(
            db,
            user_id=user_id,
            run_id=run.id,
        )
        card.result_json = json.dumps(
            {"type": "video_analysis_cancelled", "video_analysis": cancelled},
            ensure_ascii=False,
        )
        db.commit()
        db.refresh(card)
        db.refresh(thread)
        return _video_analysis_terminal_payload(
            db,
            thread=thread,
            user_message=user_message,
            assistant_message=card,
            analysis=cancelled,
            event_type="cancelled",
        )

    if normalized_action == "reprepare":
        items = (
            db.query(VideoAnalysisItem)
            .filter(VideoAnalysisItem.run_id == run.id)
            .order_by(VideoAnalysisItem.created_at.asc())
            .all()
        )
        note_ids = [str(item.note_id) for item in items if item.note_id]
        if not note_ids:
            raise ValueError("没有可重新报价的视频")
        context = _safe_json_dict(run.agent_context_json)
        thread.status = "running"
        thread.updated_at = _utcnow()
        card.content = "正在重新生成服务端报价…"
        card.result_json = json.dumps(
            {
                "type": "video_analysis_requoting",
                "video_analysis": card_analysis,
            },
            ensure_ascii=False,
        )
        db.flush()
        try:
            video_analysis_service.cancel_run(db, user_id=user_id, run_id=run.id)
            prepared = video_analysis_service.prepare_run(
                db,
                user_id=user_id,
                note_ids=note_ids,
                offering_id=offering_id or str(run.offering_id or "") or None,
                use_byok=bool(use_byok),
                trigger="agent",
                agent_thread_id=thread.id,
                agent_turn_id=turn_id,
                agent_context=context,
            )
        except Exception:
            db.rollback()
            current_thread = get_thread(db, thread.id, user_id)
            _, current_card = (
                _agent_turn_messages(db, thread=current_thread, turn_id=turn_id)
                if current_thread is not None
                else (None, None)
            )
            if current_thread is not None:
                current_thread.status = "ready"
                current_thread.updated_at = _utcnow()
            if current_card is not None:
                current_card.content = "重新报价没有完成，请重新发起问题或稍后再试。"
                current_card.result_json = json.dumps(
                    {"type": "video_analysis_resume_failed"},
                    ensure_ascii=False,
                )
            db.commit()
            raise
        card.content = (
            f"已按新方案重新报价 {len(note_ids)} 条视频。"
            "确认后我会开始解析并自动继续回答。"
        )
        card.result_json = json.dumps(
            {
                "type": "video_analysis_approval_required",
                "video_analysis": prepared,
            },
            ensure_ascii=False,
        )
        thread.status = "awaiting_approval"
        thread.updated_at = _utcnow()
        db.commit()
        db.refresh(card)
        db.refresh(thread)
        return _video_analysis_terminal_payload(
            db,
            thread=thread,
            user_message=user_message,
            assistant_message=card,
            analysis=prepared,
            event_type="approval_required",
        )

    raise ValueError("无效的 Agent 详细解析操作")


def handle_video_analysis_completion(event: Any) -> None:
    """Resume the original Agent question once every item is terminal."""
    from app.core.database import SessionLocal
    from app.services import video_analysis_service

    run_id = str(getattr(event, "run_id", "") or "")
    user_id = str(getattr(event, "user_id", "") or "")
    if not run_id or not user_id:
        return
    with SessionLocal() as db:
        run = video_analysis_service.get_run(
            db,
            user_id=user_id,
            run_id=run_id,
        )
        if run is None or str(getattr(run, "trigger", "")) != "agent":
            return
        status = str(getattr(run, "status", "") or "")
        thread_id = str(getattr(run, "agent_thread_id", "") or "")
        turn_id = str(getattr(run, "agent_turn_id", "") or "")
        if not thread_id or not turn_id:
            return
        thread = get_thread(db, thread_id, user_id)
        if thread is None:
            return
        _, current_card = _agent_turn_messages(
            db,
            thread=thread,
            turn_id=turn_id,
        )
        # Completion hooks and startup reconciliation are at-least-once.  An
        # old run may share the same thread while a newer question is active;
        # only the currently persisted running card is allowed to resume it.
        if _video_analysis_card_run_id(
            current_card,
            expected_type="video_analysis_analysis_started",
        ) != run_id:
            return
        if status == "reauthorization_required":
            changed = (
                db.query(AgentThread)
                .filter(
                    AgentThread.id == thread.id,
                    AgentThread.user_id == user_id,
                    AgentThread.status == "running_analysis",
                )
                .update(
                    {
                        AgentThread.status: "awaiting_approval",
                        AgentThread.updated_at: _utcnow(),
                    },
                    synchronize_session=False,
                )
            )
            if changed:
                if current_card is not None:
                    current_card.content = "实际用量将超过已授权上限，需要重新报价后才能继续。"
                    current_card.result_json = json.dumps(
                        {
                            "type": "video_analysis_approval_required",
                            "video_analysis": _run_analysis_payload(db, run),
                        },
                        ensure_ascii=False,
                    )
                db.commit()
            return
        if status not in {"succeeded", "partial", "failed", "cancelled"}:
            return
        claimed = (
            db.query(AgentThread)
            .filter(
                AgentThread.id == thread.id,
                AgentThread.user_id == user_id,
                AgentThread.status == "running_analysis",
            )
            .update(
                {AgentThread.status: "running", AgentThread.updated_at: _utcnow()},
                synchronize_session=False,
            )
        )
        if claimed != 1:
            db.rollback()
            return
        db.commit()
        db.refresh(thread)
        limitation = ""
        has_semantic_visual, has_structural_visual = _run_visual_result_profile(
            db,
            run,
        )
        if status == "partial":
            limitation = "部分视频画面解析未完成；回答只使用已经成功生成的视觉结果。"
        elif status in {"failed", "cancelled"}:
            limitation = "详细解析未形成可用画面结果；回答仅依据已有文稿和摘要。"
        elif not has_semantic_visual and has_structural_visual:
            limitation = (
                "本次详细解析只获得镜头与章节结构，未形成可用于判断动作、"
                "人物、物体或可见文字的语义观察。"
            )
        _resume_agent_answer(
            db,
            thread=thread,
            turn_id=turn_id,
            run=run,
            limitation=limitation,
            already_claimed=True,
            suppress_visual=status in {"failed", "cancelled"},
        )


def add_digest_message(
    db: Session,
    *,
    thread: AgentThread,
    content: str,
    result: dict[str, Any],
) -> AgentMessage:
    message = AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        role="assistant",
        content=content,
        result_json=json.dumps(result, ensure_ascii=False),
    )
    thread.status = "ready"
    thread.updated_at = _utcnow()
    db.add(message)
    db.commit()
    db.refresh(message)
    return message
