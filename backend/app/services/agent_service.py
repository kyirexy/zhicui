"""Persistent video-grounded Agent tasks and source selection."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.agent_thread import AgentMessage, AgentThread
from app.models.note import Note
from app.models.user import User
from app.services import ai_juicer, video_source_ledger_service


SOURCE_LIMIT = 100
SOURCE_SCAN_LIMIT = 2000
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


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


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
    return {
        "note_id": note.id,
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
    safe_limit = max(1, min(limit, 200))
    preferred_mode = (
        normalized_scope
        if normalized_scope in {"collect", "like", "post"}
        else None
    )
    return {
        "scope": normalized_scope,
        "scope_label": SOURCE_SCOPES[normalized_scope],
        "items": [
            _source_dict(
                note,
                ledger_map,
                preferred_mode=preferred_mode,
            )
            for note in notes[:safe_limit]
        ],
        "total": len(notes),
        "truncated": len(notes) > safe_limit,
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


def create_thread(
    db: Session,
    *,
    user_id: str,
    scope: str,
    source_ids: list[str] | None = None,
    title: str = "",
    timezone_name: str = "Asia/Shanghai",
) -> AgentThread:
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


def serialize_thread(
    db: Session,
    thread: AgentThread,
    *,
    include_messages: bool = False,
    include_sources: bool = False,
) -> dict[str, Any]:
    data = thread.to_dict()
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
    if thread.status == "running":
        raise ValueError("这个任务正在回答，完成后即可删除")
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


def ask_thread(
    db: Session,
    *,
    thread: AgentThread,
    content: str,
    research_mode: str = "fast",
    output_style: str = "answer",
    custom_instruction: str = "",
    web_scope: str = "auto",
) -> tuple[AgentMessage, AgentMessage]:
    clean_content = content.strip()
    if not clean_content:
        raise ValueError("问题不能为空")

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
            AgentThread.status == "running",
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
                AgentThread.status != "running",
                AgentThread.updated_at < now - timedelta(hours=1),
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
        raise ValueError("这个任务正在回答上一条问题，请稍候")
    db.commit()
    db.refresh(thread)

    notes = _thread_notes(db, thread)
    if not notes:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        db.commit()
        raise ValueError("这个任务的资料文案已不可用，请重新选择资料")

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
    history = [
        {"role": message.role, "content": message.content}
        for message in reversed(previous_messages)
        if message.role in {"user", "assistant"}
    ]
    turn_id = str(uuid.uuid4())
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

    try:
        result = ai_juicer.answer_library_question(
            sources=[
                {
                    "note_id": note.id,
                    "title": note.video_title,
                    "transcript": note.transcript_raw,
                    "ai_summary": note.ai_summary,
                }
                for note in notes
            ],
            question=clean_content,
            history=history,
            research_mode=research_mode,
            output_style=output_style,
            custom_instruction=custom_instruction,
            web_scope=web_scope,
        )
    except Exception:
        thread.status = "failed"
        thread.updated_at = _utcnow()
        db.commit()
        raise

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

    assistant_message = AgentMessage(
        thread_id=thread.id,
        user_id=thread.user_id,
        turn_id=turn_id,
        role="assistant",
        content=str(result.get("answer") or "").strip(),
        result_json=json.dumps(
            {
                **result,
                # Persist the exact bounded snapshot retrieval inspected,
                # rather than independently assuming every loaded note was
                # researched. This keeps future limit changes honest.
                "note_ids": persisted_note_ids,
            },
            ensure_ascii=False,
        ),
    )
    if len(previous_messages) == 0 and thread.title.endswith("研究"):
        thread.title = clean_content[:40]
    thread.status = "ready"
    thread.updated_at = _utcnow()
    db.add(assistant_message)
    db.commit()
    db.refresh(assistant_message)
    db.refresh(thread)
    return user_message, assistant_message


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
