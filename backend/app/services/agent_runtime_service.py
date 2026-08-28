"""Durable turn/event primitives for the video research Agent.

The module deliberately stays independent from the HTTP/SSE layer.  A stream
is only a projection of committed events; disconnecting a client never owns or
cancels the underlying turn.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.agent_runtime import (
    AgentEvent,
    AgentMemoryCheckpoint,
    AgentTurn,
    AgentTurnSource,
)
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.note import Note


LEASE_SECONDS = 300
MAX_EVENT_JSON_CHARS = 12_000
ACTIVE_STATUSES = ("queued", "running", "retry_wait")
TERMINAL_STATUSES = ("completed", "failed", "cancelled")
_BROAD_TERMS = (
    "全部", "所有", "共同", "共性", "反复", "重复出现", "核心观点", "主题",
    "主线", "整体", "规律", "趋势", "归纳", "总结", "综合", "对比", "区别",
    "异同", "分歧", "行动建议", "方法论", "这些视频", "这批视频",
    "完整列出", "具体包含", "分别说明",
)
_SENSITIVE_KEYS = (
    "cookie", "authorization", "token", "secret", "password", "api_key",
    "download_url", "media_url", "signed_url", "local_path", "file_path",
)

# Explicit cancellation uses a process-local fast path in addition to the
# durable database flag. The event lets a same-process worker stop on the next
# provider chunk without turning every token into a database query;
# ``assert_turn_active`` remains the cross-process source of truth.
_CANCEL_SIGNAL_LOCK = threading.Lock()
_CANCEL_SIGNALS: dict[str, threading.Event] = {}


class AgentTurnLeaseLost(RuntimeError):
    pass


class AgentTurnCancelled(RuntimeError):
    pass


def cancellation_signal(turn_id: str) -> threading.Event:
    """Return the process-local cancellation signal for one durable Turn."""
    with _CANCEL_SIGNAL_LOCK:
        return _CANCEL_SIGNALS.setdefault(str(turn_id), threading.Event())


def _signal_cancel(turn_id: str) -> None:
    cancellation_signal(turn_id).set()


def _clear_cancel_signal(turn_id: str) -> None:
    with _CANCEL_SIGNAL_LOCK:
        signal = _CANCEL_SIGNALS.get(str(turn_id))
        if signal is not None:
            signal.clear()


def _drop_cancel_signal(turn_id: str) -> None:
    with _CANCEL_SIGNAL_LOCK:
        _CANCEL_SIGNALS.pop(str(turn_id), None)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _safe_value(value: Any, *, key: str = "", depth: int = 0) -> Any:
    lowered = key.lower()
    if any(marker in lowered for marker in _SENSITIVE_KEYS):
        return "[redacted]"
    if depth > 5:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:1200]
    if isinstance(value, dict):
        return {
            str(child_key)[:80]: _safe_value(
                child_value, key=str(child_key), depth=depth + 1
            )
            for child_key, child_value in list(value.items())[:80]
        }
    if isinstance(value, (list, tuple)):
        return [_safe_value(item, depth=depth + 1) for item in list(value)[:100]]
    return str(value)[:500]


def _safe_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    safe = _safe_value(payload or {})
    if not isinstance(safe, dict):
        return {}
    encoded = json.dumps(safe, ensure_ascii=False)
    if len(encoded) <= MAX_EVENT_JSON_CHARS:
        return safe
    return {
        "truncated": True,
        "preview": encoded[: MAX_EVENT_JSON_CHARS - 100],
    }


def _public_turn_error(exc: Exception, *, cancelled: bool) -> str:
    if cancelled:
        return "本次生成已停止"
    raw = (str(exc) or type(exc).__name__).strip()
    lowered = raw.lower()
    if isinstance(exc, IntegrityError) or any(marker in lowered for marker in (
        "sqlalchemy", "integrityerror", "constraint failed", "sql:",
        "transaction has been rolled back", "traceback",
    )):
        return "研究状态同步时发生冲突，请重新尝试"
    return raw[:500] or "视频 Agent 暂时没有完成回答"


def resolve_research_mode(
    requested_mode: str,
    *,
    question: str,
    source_count: int,
    output_style: str,
) -> str:
    if requested_mode in {"fast", "deep"}:
        return requested_mode
    normalized = re.sub(r"\s+", "", question.lower())
    broad = any(term in normalized for term in _BROAD_TERMS)
    structured_output = output_style in {"summary", "comparison", "action_plan"}
    if source_count >= 6 and (broad or structured_output):
        return "deep"
    return "fast"


def _thread_notes(db: Session, thread: AgentThread) -> list[Note]:
    notes = db.query(Note).filter(
        Note.user_id == thread.user_id,
        Note.id.in_(thread.source_ids),
        Note.transcript_raw.is_not(None),
        Note.transcript_raw != "",
    ).all()
    by_id = {note.id: note for note in notes}
    return [by_id[note_id] for note_id in thread.source_ids if note_id in by_id]


def create_or_get_turn(
    db: Session,
    *,
    thread: AgentThread,
    client_turn_id: str,
    question: str,
    requested_mode: str,
    output_style: str,
    custom_instruction: str,
    web_scope: str,
) -> tuple[AgentTurn, bool]:
    clean_client_id = client_turn_id.strip()[:80] or str(uuid.uuid4())
    existing = db.query(AgentTurn).filter(
        AgentTurn.thread_id == thread.id,
        AgentTurn.user_id == thread.user_id,
        AgentTurn.client_turn_id == clean_client_id,
    ).first()
    if existing is not None:
        return existing, False

    notes = _thread_notes(db, thread)
    resolved_mode = resolve_research_mode(
        requested_mode,
        question=question,
        source_count=len(notes),
        output_style=output_style,
    )
    turn = AgentTurn(
        thread_id=thread.id,
        user_id=thread.user_id,
        client_turn_id=clean_client_id,
        question=question.strip()[:600],
        requested_mode=requested_mode if requested_mode in {"auto", "fast", "deep"} else "auto",
        resolved_mode=resolved_mode,
        output_style=output_style,
        custom_instruction=custom_instruction.strip()[:600],
        web_scope="auto" if web_scope == "auto" else "video_only",
        source_total_count=len(notes),
    )
    db.add(turn)
    try:
        db.flush()
        for position, note in enumerate(notes):
            transcript = note.transcript_raw or ""
            db.add(AgentTurnSource(
                turn_id=turn.id,
                note_id=note.id,
                position=position,
                title_snapshot=note.video_title[:500],
                transcript_hash=hashlib.sha256(transcript.encode("utf-8")).hexdigest(),
            ))
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(AgentTurn).filter(
            AgentTurn.thread_id == thread.id,
            AgentTurn.client_turn_id == clean_client_id,
        ).first()
        if existing is None:
            raise
        return existing, False
    db.refresh(turn)
    append_event(
        db,
        turn=turn,
        event_type="turn.created",
        phase="queued",
        message=(
            "计划调整已进入处理队列"
            if thread.context_type == "plan"
            else "问题已进入研究队列"
        ),
        payload={
            "requested_mode": turn.requested_mode,
            "resolved_mode": turn.resolved_mode,
            "source_total_count": turn.source_total_count,
            "web_scope": turn.web_scope,
            "context_type": thread.context_type or "video",
            "context_id": thread.context_id,
        },
    )
    return turn, True


def append_event(
    db: Session,
    *,
    turn: AgentTurn,
    event_type: str,
    phase: str,
    message: str = "",
    payload: dict[str, Any] | None = None,
    lease_token: str | None = None,
) -> AgentEvent:
    # PostgreSQL serialises this path through FOR UPDATE. SQLite ignores that
    # clause, so a worker progress callback and a cancellation request can
    # briefly choose the same sequence. The unique key remains the source of
    # truth; repair a stale counter and retry instead of leaking an IntegrityError
    # into the user's Turn.
    for attempt in range(4):
        query = db.query(AgentTurn).filter(
            AgentTurn.id == turn.id,
            AgentTurn.user_id == turn.user_id,
        )
        if lease_token is not None:
            query = query.filter(AgentTurn.lease_token == lease_token)
        locked = query.with_for_update().populate_existing().first()
        if locked is None:
            db.rollback()
            raise AgentTurnLeaseLost("Agent Turn 租约已转移")
        if locked.cancellation_requested and event_type not in {
            "turn.cancel_requested", "turn.cancelled", "turn.failed"
        }:
            db.rollback()
            raise AgentTurnCancelled("Agent Turn 已取消")

        latest_seq = db.query(func.max(AgentEvent.seq)).filter(
            AgentEvent.turn_id == locked.id
        ).scalar()
        event_seq = max(locked.next_event_seq, int(latest_seq or 0) + 1)
        event = AgentEvent(
            turn_id=locked.id,
            thread_id=locked.thread_id,
            user_id=locked.user_id,
            seq=event_seq,
            event_type=event_type[:64],
            phase=phase[:32],
            message=message[:500],
            payload_json=json.dumps(_safe_payload(payload), ensure_ascii=False),
        )
        locked.next_event_seq = event_seq + 1
        locked.phase = phase[:32]
        locked.updated_at = _utcnow()
        db.add(event)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if attempt >= 3:
                raise
            continue
        db.refresh(event)
        db.refresh(turn)
        return event

    raise RuntimeError("Agent 事件序号分配失败")


def get_turn(db: Session, turn_id: str, user_id: str) -> AgentTurn | None:
    return db.query(AgentTurn).filter(
        AgentTurn.id == turn_id, AgentTurn.user_id == user_id
    ).first()


def list_events(
    db: Session,
    *,
    turn: AgentTurn,
    after_seq: int = 0,
    limit: int = 200,
) -> list[AgentEvent]:
    return db.query(AgentEvent).filter(
        AgentEvent.turn_id == turn.id,
        AgentEvent.user_id == turn.user_id,
        AgentEvent.seq > max(0, after_seq),
    ).order_by(AgentEvent.seq.asc()).limit(min(500, max(1, limit))).all()


def active_turn_for_thread(db: Session, thread_id: str, user_id: str) -> AgentTurn | None:
    return db.query(AgentTurn).filter(
        AgentTurn.thread_id == thread_id,
        AgentTurn.user_id == user_id,
        AgentTurn.status.in_(ACTIVE_STATUSES),
    ).order_by(AgentTurn.created_at.desc()).first()


def due_turn_ids(limit: int = 20) -> list[str]:
    now = _utcnow()
    with SessionLocal() as db:
        rows = db.query(AgentTurn.id).filter(
            or_(
                AgentTurn.status.in_(("queued", "retry_wait")),
                (AgentTurn.status == "running")
                & or_(AgentTurn.lease_expires_at.is_(None), AgentTurn.lease_expires_at < now),
            )
        ).order_by(AgentTurn.created_at.asc()).limit(limit).all()
        return [row[0] for row in rows]


def claim_turn(db: Session, turn_id: str) -> tuple[AgentTurn, str] | None:
    now = _utcnow()
    token = str(uuid.uuid4())
    claimed = db.query(AgentTurn).filter(
        AgentTurn.id == turn_id,
        AgentTurn.cancellation_requested.is_(False),
        or_(
            AgentTurn.status.in_(("queued", "retry_wait")),
            (AgentTurn.status == "running")
            & or_(AgentTurn.lease_expires_at.is_(None), AgentTurn.lease_expires_at < now),
        ),
    ).update({
        AgentTurn.status: "running",
        AgentTurn.phase: "planning",
        AgentTurn.lease_token: token,
        AgentTurn.lease_expires_at: now + timedelta(seconds=LEASE_SECONDS),
        AgentTurn.attempt_count: AgentTurn.attempt_count + 1,
        AgentTurn.started_at: now,
        AgentTurn.updated_at: now,
    }, synchronize_session=False)
    if claimed != 1:
        db.rollback()
        return None
    db.commit()
    turn = db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
    if turn is not None:
        _clear_cancel_signal(turn.id)
    return (turn, token) if turn is not None else None


def heartbeat(turn_id: str, lease_token: str) -> bool:
    with SessionLocal() as db:
        now = _utcnow()
        updated = db.query(AgentTurn).filter(
            AgentTurn.id == turn_id,
            AgentTurn.status == "running",
            AgentTurn.lease_token == lease_token,
            AgentTurn.cancellation_requested.is_(False),
        ).update({
            AgentTurn.lease_expires_at: now + timedelta(seconds=LEASE_SECONDS),
            AgentTurn.updated_at: now,
        }, synchronize_session=False)
        db.commit()
        return updated == 1


def renew_lease_or_raise(turn_id: str, lease_token: str) -> None:
    """Renew one active lease or distinguish cancellation from ownership loss."""
    if heartbeat(turn_id, lease_token):
        return
    with SessionLocal() as db:
        turn = db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
        if (
            turn is not None
            and turn.lease_token == lease_token
            and turn.cancellation_requested
        ):
            raise AgentTurnCancelled("Agent Turn 已取消")
    raise AgentTurnLeaseLost("Agent Turn 租约已转移")


def assert_turn_active(db: Session, turn_id: str, lease_token: str) -> None:
    """Check cancellation/ownership through the worker's existing session.

    The lease heartbeat owns renewal.  Token callbacks only need a cheap,
    read-only control-plane check; reusing their session also keeps SQLite
    tests and deployments with a custom session factory on the same database.
    ``populate_existing`` prevents the identity map from hiding a cancel or
    lease transfer committed by another request/process.
    """
    turn = db.query(AgentTurn).populate_existing().filter(
        AgentTurn.id == turn_id
    ).first()
    if (
        turn is not None
        and turn.lease_token == lease_token
        and turn.cancellation_requested
    ):
        raise AgentTurnCancelled("Agent Turn 已取消")
    if (
        turn is None
        or turn.status != "running"
        or turn.lease_token != lease_token
    ):
        raise AgentTurnLeaseLost("Agent Turn 租约已转移")


def request_cancel(db: Session, turn: AgentTurn) -> AgentTurn:
    if turn.status in TERMINAL_STATUSES:
        return turn
    turn.cancellation_requested = True
    turn.updated_at = _utcnow()
    queued = turn.status in {"queued", "retry_wait"}
    if queued:
        turn.status = "cancelled"
        turn.phase = "cancelled"
        turn.error_code = "cancelled"
        turn.error_message = "本次生成已停止"
        turn.completed_at = _utcnow()
    db.commit()
    db.refresh(turn)
    # Wake a same-process streaming worker immediately. A queued Turn has no
    # consumer to wake, so avoid retaining an unused process-local signal.
    # The committed flag remains authoritative across workers/restarts.
    if queued:
        _drop_cancel_signal(turn.id)
    else:
        _signal_cancel(turn.id)
    append_event(
        db,
        turn=turn,
        event_type="turn.cancelled" if queued else "turn.cancel_requested",
        phase=turn.phase,
        message="本次生成已停止" if queued else "正在停止本次回答",
    )
    return turn


def retry_turn(db: Session, turn: AgentTurn) -> AgentTurn:
    if turn.status not in {"failed", "cancelled"}:
        raise ValueError("只有失败或已取消的 Agent Turn 可以重试")
    active = active_turn_for_thread(db, turn.thread_id, turn.user_id)
    if active is not None and active.id != turn.id:
        raise ValueError("这个会话已有问题正在运行")
    turn.status = "queued"
    turn.phase = "queued"
    turn.cancellation_requested = False
    turn.lease_token = None
    turn.lease_expires_at = None
    turn.error_code = None
    turn.error_message = None
    turn.updated_at = _utcnow()
    # A provider/event failure can happen after the conversation thread was
    # claimed but before ask_thread restored it. Put the parent back into the
    # retryable state before the worker claims this Turn again.
    db.query(AgentThread).filter(
        AgentThread.id == turn.thread_id,
        AgentThread.user_id == turn.user_id,
        AgentThread.status.in_(("running", "failed")),
    ).update({
        AgentThread.status: "failed",
        AgentThread.updated_at: _utcnow(),
    }, synchronize_session=False)
    db.commit()
    db.refresh(turn)
    _clear_cancel_signal(turn.id)
    append_event(db, turn=turn, event_type="turn.retried", phase="queued", message="任务已重新排队")
    return turn


def complete_turn(
    db: Session,
    *,
    turn: AgentTurn,
    lease_token: str,
    user_message_id: str,
    assistant_message_id: str,
    result: dict[str, Any],
) -> None:
    source_context = result.get("source_context") if isinstance(result, dict) else {}
    if not isinstance(source_context, dict):
        source_context = {}
    evidence = result.get("evidence") if isinstance(result, dict) else []
    claims = result.get("claims") if isinstance(result, dict) else []
    now = _utcnow()
    updated = db.query(AgentTurn).filter(
        AgentTurn.id == turn.id,
        AgentTurn.lease_token == lease_token,
        AgentTurn.status == "running",
        AgentTurn.cancellation_requested.is_(False),
    ).update({
        AgentTurn.status: "completed",
        AgentTurn.phase: "completed",
        AgentTurn.user_message_id: user_message_id,
        AgentTurn.assistant_message_id: assistant_message_id,
        AgentTurn.scanned_count: int(source_context.get("scanned_count") or turn.source_total_count),
        AgentTurn.mapped_count: int(source_context.get("mapped_count") or source_context.get("context_source_count") or 0),
        AgentTurn.deep_read_count: int(source_context.get("deep_read_count") or 0),
        AgentTurn.claim_count: len(claims) if isinstance(claims, list) else 0,
        AgentTurn.evidence_count: len(evidence) if isinstance(evidence, list) else 0,
        AgentTurn.completed_at: now,
        AgentTurn.lease_token: None,
        AgentTurn.lease_expires_at: None,
        AgentTurn.updated_at: now,
    }, synchronize_session=False)
    if updated != 1:
        db.rollback()
        raise AgentTurnLeaseLost("完成前 Agent Turn 租约已转移")
    db.commit()
    db.refresh(turn)
    append_event(
        db, turn=turn, event_type="turn.completed", phase="completed",
        message="回答和引用已经保存",
        payload={
            "assistant_message_id": assistant_message_id,
            "source_total_count": turn.source_total_count,
            "scanned_count": turn.scanned_count,
            "mapped_count": turn.mapped_count,
            "deep_read_count": turn.deep_read_count,
            "claim_count": turn.claim_count,
            "evidence_count": turn.evidence_count,
        },
    )
    _drop_cancel_signal(turn.id)


def fail_turn(turn_id: str, lease_token: str, exc: Exception) -> None:
    with SessionLocal() as db:
        turn = db.query(AgentTurn).filter(
            AgentTurn.id == turn_id, AgentTurn.lease_token == lease_token
        ).first()
        if turn is None:
            return
        cancelled = turn.cancellation_requested or isinstance(exc, AgentTurnCancelled)
        turn.status = "cancelled" if cancelled else "failed"
        turn.phase = turn.status
        turn.error_code = "cancelled" if cancelled else type(exc).__name__[:80]
        turn.error_message = _public_turn_error(exc, cancelled=cancelled)
        turn.completed_at = _utcnow()
        turn.lease_token = None
        turn.lease_expires_at = None
        db.query(AgentThread).filter(
            AgentThread.id == turn.thread_id,
            AgentThread.user_id == turn.user_id,
            AgentThread.status == "running",
        ).update({
            AgentThread.status: "failed",
            AgentThread.updated_at: _utcnow(),
        }, synchronize_session=False)
        db.commit()
        db.refresh(turn)
        append_event(
            db,
            turn=turn,
            event_type="turn.cancelled" if cancelled else "turn.failed",
            phase=turn.phase,
            message="本次生成已停止" if cancelled else "视频 Agent 暂时没有完成回答",
            payload={"error_code": turn.error_code},
        )
        _drop_cancel_signal(turn.id)


def latest_memory(db: Session, thread_id: str, user_id: str) -> dict[str, Any]:
    row = db.query(AgentMemoryCheckpoint).filter(
        AgentMemoryCheckpoint.thread_id == thread_id,
        AgentMemoryCheckpoint.user_id == user_id,
    ).order_by(AgentMemoryCheckpoint.created_at.desc()).first()
    return row.summary if row is not None else {}


def conversation_context(
    db: Session,
    *,
    thread: AgentThread,
    recent_turns: int = 4,
) -> list[dict[str, str]]:
    limit = max(2, recent_turns * 2)
    messages = db.query(AgentMessage).filter(
        AgentMessage.thread_id == thread.id,
        AgentMessage.user_id == thread.user_id,
    ).order_by(AgentMessage.created_at.desc()).limit(limit).all()
    completed = {item.turn_id for item in messages if item.role == "assistant" and item.turn_id}
    history = [
        {"role": item.role, "content": item.content}
        for item in reversed(messages)
        if item.role == "assistant" or not item.turn_id or item.turn_id in completed
    ]
    memory = latest_memory(db, thread.id, thread.user_id)
    if memory:
        history.insert(0, {
            "role": "system",
            "content": "【长期会话记忆】\n" + json.dumps(memory, ensure_ascii=False)[:8000],
        })
    return history


def maybe_checkpoint_memory(db: Session, *, thread: AgentThread) -> AgentMemoryCheckpoint | None:
    messages = db.query(AgentMessage).filter(
        AgentMessage.thread_id == thread.id,
        AgentMessage.user_id == thread.user_id,
    ).order_by(AgentMessage.created_at.asc()).all()
    if len(messages) <= 8:
        return None
    older = messages[:-8]
    user_goals = [item.content[:300] for item in older if item.role == "user"][-8:]
    claims: list[dict[str, Any]] = []
    for item in older:
        if item.role != "assistant":
            continue
        result_claims = item.result.get("claims")
        if isinstance(result_claims, list):
            for claim in result_claims[:8]:
                if isinstance(claim, dict):
                    claims.append({
                        "claim_id": str(claim.get("claim_id") or "")[:80],
                        "text": str(claim.get("text") or claim.get("claim") or "")[:500],
                        "supporting_note_ids": list(claim.get("supporting_note_ids") or [])[:20],
                    })
    summary = {
        "user_goals": user_goals,
        "verified_claims": claims[-20:],
        "source_scope": thread.source_ids,
        "unresolved_questions": user_goals[-2:],
    }
    encoded = json.dumps(summary, ensure_ascii=False)
    last = messages[-9]
    existing = db.query(AgentMemoryCheckpoint).filter(
        AgentMemoryCheckpoint.thread_id == thread.id,
        AgentMemoryCheckpoint.through_message_id == last.id,
    ).first()
    if existing is not None:
        return existing
    checkpoint = AgentMemoryCheckpoint(
        thread_id=thread.id,
        user_id=thread.user_id,
        through_message_id=last.id,
        summary_json=encoded,
        estimated_tokens=max(1, len(encoded) // 3),
    )
    db.add(checkpoint)
    db.commit()
    db.refresh(checkpoint)
    return checkpoint
