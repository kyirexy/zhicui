"""User-scoped routes for the video Agent workspace and daily digests."""

from __future__ import annotations

import json
import queue
import secrets
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import SessionLocal, get_db
from app.core.request_context import reset_request_context, set_request_context
from app.models.user import User
from app.models.note import Note
from app.models.agent_thread import AgentMessage
from app.services import (
    activity_service,
    auth_service,
    agent_service,
    agent_runtime_service,
    agent_runtime_worker,
    automation_runner,
    automation_service,
    chat_credit_billing_service,
    chat_model_catalog_service,
    creator_sync_service,
    email_delivery,
    error_log_service,
    library_hidden_service,
    library_removal_service,
    user_ai_provider_service,
    settings_service,
    plan_service,
)


_DURABLE_STREAM_POLL_SECONDS = 0.05
_SSE_HEARTBEAT_SECONDS = 5.0


router = APIRouter(prefix="/api/agent", tags=["video-agent"])


def _ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


def _agent_failure_metadata(user_id: str) -> dict[str, str]:
    """Best-effort diagnostics that must never mask the original failure."""
    metadata = {"operation": "agent_ask"}
    try:
        with SessionLocal() as log_db:
            llm_config = user_ai_provider_service.effective_config(
                log_db,
                user_id,
            )
    except Exception:
        return metadata
    metadata["provider"] = str(llm_config.get("provider", ""))
    metadata["model"] = str(llm_config.get("model", ""))
    return metadata


def _reserve_chat_charge(db: Session, user_id: str):
    if user_ai_provider_service.uses_custom_provider(db, user_id):
        return None
    offering = chat_model_catalog_service.selected_offering(db, user_id)
    return chat_credit_billing_service.reserve(
        db,
        user_id=user_id,
        offering=offering,
        request_id=str(uuid.uuid4()),
    )


def _release_chat_charge_safely(db: Session, charge) -> None:
    if charge is None:
        return
    try:
        chat_credit_billing_service.release(db, charge)
    except Exception:
        db.rollback()


def _sse_data(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _sse_headers() -> dict[str, str]:
    """Headers that keep each yielded SSE frame observable end-to-end."""
    return {
        "Cache-Control": "no-cache, no-transform",
        "Pragma": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        # Compression middleware and some reverse proxies otherwise wait for a
        # larger body before forwarding the first small event.
        "Content-Encoding": "identity",
        "X-Content-Type-Options": "nosniff",
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _answer_stream_chunks(content: str) -> list[str]:
    """Split finalized Markdown at natural boundaries for stable rendering."""
    chunks: list[str] = []
    current: list[str] = []
    boundaries = set("，。！？；：、,.!?;:\n")
    for character in content:
        current.append(character)
        if (
            len(current) >= 8 and character in boundaries
        ) or len(current) >= 18:
            chunks.append("".join(current))
            current = []
    if current:
        chunks.append("".join(current))
    return chunks


def _project_durable_event(turn, event) -> dict[str, Any] | None:
    """Map one persisted runtime event onto the public SSE contract."""
    payload = event.payload
    if event.event_type == "turn.answer.delta":
        delta = str(payload.get("delta") or "")
        if not delta:
            return None
        return {
            "type": "delta",
            "turn_id": turn.id,
            "event_seq": event.seq,
            "delta": delta,
            "chunk_index": payload.get("chunk_index"),
        }
    return {
        "type": "progress",
        "turn_id": turn.id,
        "event_seq": event.seq,
        "event_type": event.event_type,
        "stage": event.phase,
        "message": event.message,
        "resolved_mode": turn.resolved_mode,
        **payload,
    }


def _durable_turn_stream(
    turn_id: str,
    user_id: str,
    *,
    initial_after_seq: int = 0,
):
    """Replay committed Agent V2 events, then follow until terminal."""
    after_seq = max(0, initial_after_seq)
    last_keepalive = time.monotonic()
    yield _sse_data({
        "type": "turn",
        "turn_id": turn_id,
        "event_seq": after_seq,
    })
    while True:
        with SessionLocal() as stream_db:
            turn = agent_runtime_service.get_turn(stream_db, turn_id, user_id)
            if turn is None:
                yield _sse_data({"type": "error", "status": 404, "message": "Agent Turn 不存在"})
                return
            for event in agent_runtime_service.list_events(
                stream_db, turn=turn, after_seq=after_seq
            ):
                after_seq = event.seq
                projected = _project_durable_event(turn, event)
                if projected is not None:
                    yield _sse_data(projected)
            if turn.status == "completed":
                thread = agent_service.get_thread(stream_db, turn.thread_id, user_id)
                user_message = stream_db.query(AgentMessage).filter(
                    AgentMessage.id == turn.user_message_id
                ).first()
                assistant_message = stream_db.query(AgentMessage).filter(
                    AgentMessage.id == turn.assistant_message_id
                ).first()
                if thread is None or user_message is None or assistant_message is None:
                    yield _sse_data({"type": "error", "status": 500, "message": "回答已完成但会话投影暂不可用"})
                    return
                yield _sse_data({
                    "type": "done",
                    "turn_id": turn.id,
                    "event_seq": after_seq,
                    "data": {
                        "turn": turn.to_dict(),
                        "thread": agent_service.serialize_thread(
                            stream_db, thread, include_messages=True, include_sources=True
                        ),
                        "user_message": user_message.to_dict(),
                        "assistant_message": assistant_message.to_dict(),
                    },
                })
                return
            if turn.status in {"failed", "cancelled"}:
                yield _sse_data({
                    "type": "error",
                    "turn_id": turn.id,
                    "event_seq": after_seq,
                    "status": 409 if turn.status == "cancelled" else 502,
                    "message": turn.error_message or ("本次生成已停止" if turn.status == "cancelled" else "视频 Agent 暂时没有完成回答"),
                })
                return
        if time.monotonic() - last_keepalive >= _SSE_HEARTBEAT_SECONDS:
            yield f": heartbeat {int(time.time())}\n\n"
            last_keepalive = time.monotonic()
        # Persist first, then follow at low latency. The browser still applies
        # frame-level backpressure, so faster discovery does not create one
        # React render per database event.
        time.sleep(_DURABLE_STREAM_POLL_SECONDS)


class ThreadCreateRequest(BaseModel):
    title: str = Field(default="", max_length=256)
    source_scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post", "selected",
    ] = "all_ready"
    source_ids: list[str] = Field(default_factory=list, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", max_length=64)
    context_type: Literal["video", "plan"] = "video"
    context_id: str | None = Field(default=None, max_length=36)


class ThreadUpdateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)


class ThreadMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=600)
    client_turn_id: str = Field(
        default_factory=lambda: str(uuid.uuid4()), min_length=8, max_length=80
    )
    research_mode: Literal["auto", "fast", "deep"] = "auto"
    output_style: Literal[
        "answer", "summary", "comparison", "action_plan", "custom"
    ] = "answer"
    custom_instruction: str = Field(default="", max_length=600)
    web_scope: Literal["auto", "video_only"] = "video_only"


class VideoAnalysisDecisionRequest(BaseModel):
    action: Literal["approve", "text_only", "cancel", "reprepare"]
    idempotency_key: str = Field(default="", max_length=160)
    offering_id: str | None = Field(default=None, max_length=36)
    use_byok: bool = False


class SourceSearchRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=200)
    scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post",
    ] = "all_ready"
    timezone: str = Field(default="Asia/Shanghai", max_length=64)
    limit: int = Field(default=30, ge=1, le=50)


class AutomationCreateRequest(BaseModel):
    name: str = Field(default="昨日视频摘要", min_length=1, max_length=160)
    enabled: bool = True
    schedule_time: str = Field(default="08:00", min_length=5, max_length=5)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    source_scope: Literal["yesterday", "yesterday_new"] = "yesterday_new"
    source_mode: Literal["all", "collect", "like", "post"] = "collect"
    instruction: str = Field(
        default=automation_service.DEFAULT_INSTRUCTION,
        min_length=1,
        max_length=2000,
    )
    recipient_email: str = Field(default="", max_length=256)
    destination: str = Field(default="", max_length=256)


class AutomationUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    enabled: bool | None = None
    schedule_time: str | None = Field(default=None, min_length=5, max_length=5)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    source_scope: Literal["yesterday", "yesterday_new"] | None = None
    source_mode: Literal["all", "collect", "like", "post"] | None = None
    instruction: str | None = Field(default=None, min_length=1, max_length=2000)
    recipient_email: str | None = Field(default=None, max_length=256)
    destination: str | None = Field(default=None, max_length=256)


class AutomationRunRequest(BaseModel):
    deliver: bool = False


class EmailVerificationConfirmRequest(BaseModel):
    token: str = Field(..., min_length=20, max_length=2048)


class SourceBatchDeleteRequest(BaseModel):
    note_ids: list[str] = Field(..., min_length=1, max_length=50)


class StarterQuestionsRequest(BaseModel):
    source_scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post", "selected",
    ] = "all_ready"
    source_ids: list[str] = Field(default_factory=list, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", max_length=64)


@router.get("/sources")
def list_agent_sources(
    scope: Literal[
        "all", "all_ready", "yesterday", "yesterday_new",
        "collect", "like", "post",
    ] = Query("all_ready"),
    q: str = Query("", max_length=80),
    timezone: str = Query("Asia/Shanghai", max_length=64),
    limit: int = Query(100, ge=1, le=1000),
    include_id: list[str] | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    raw_include_ids = include_id or []
    if len(raw_include_ids) > 100:
        raise HTTPException(status_code=422, detail="一次最多补齐 100 条已选资料")
    clean_include_ids: list[str] = []
    for raw_note_id in raw_include_ids:
        note_id = str(raw_note_id or "").strip()
        try:
            valid_uuid = str(UUID(note_id))
        except (TypeError, ValueError, AttributeError) as exc:
            raise HTTPException(status_code=422, detail="已选资料标识格式无效") from exc
        if len(note_id) != 36 or valid_uuid != note_id.lower():
            raise HTTPException(status_code=422, detail="已选资料标识格式无效")
        clean_include_ids.append(note_id)
    try:
        result = agent_service.list_sources(
            db,
            user_id=current_user.id,
            scope=scope,
            search=q,
            timezone_name=timezone,
            limit=limit,
            include_ids=clean_include_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.post("/starter-questions")
def generate_agent_starter_questions(
    body: StarterQuestionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        result = agent_service.suggest_starter_questions(
            db,
            user_id=current_user.id,
            scope=body.source_scope,
            source_ids=body.source_ids,
            timezone_name=body.timezone,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.delete("/sources/{note_id}")
def delete_agent_source(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    note = db.query(Note).filter(
        Note.id == note_id,
        Note.user_id == current_user.id,
    ).first()
    if note is None:
        raise HTTPException(status_code=404, detail="视频资料不存在或已删除")
    source = note.to_dict()
    platform = str(source.get("platform") or "").strip().lower()
    video_id = str(note.video_id or "").strip()
    if platform == "douyin" and video_id:
        library_hidden_service.hide_aweme_ids(
            db, current_user.id, [video_id], "permanent",
        )
    creator_sync_service.mark_note_permanently_removed(
        db, user_id=current_user.id, note_id=note.id
    )
    db.delete(note)
    db.commit()
    return _ok({"deleted": True, "note_id": note_id, "permanent": True})


@router.post("/sources/batch-delete")
def batch_delete_agent_sources(
    body: SourceBatchDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        result = library_removal_service.remove_many(
            db,
            user_id=current_user.id,
            note_ids=body.note_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.post("/source-search")
def search_agent_sources(
    body: SourceSearchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        result = agent_service.smart_search_sources(
            db,
            user_id=current_user.id,
            query=body.query,
            scope=body.scope,
            timezone_name=body.timezone,
            limit=body.limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/threads")
def list_agent_threads(
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    items = agent_service.list_threads(
        db,
        user_id=current_user.id,
        limit=limit,
    )
    return _ok({"items": items, "total": len(items)})


@router.post("/threads")
def create_agent_thread(
    body: ThreadCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        thread = agent_service.create_thread(
            db,
            user_id=current_user.id,
            scope=body.source_scope,
            source_ids=body.source_ids,
            title=body.title,
            timezone_name=body.timezone,
            context_type=body.context_type,
            context_id=body.context_id,
        )
    except ValueError as exc:
        message = str(exc)
        status = 404 if "不存在" in message else 422
        raise HTTPException(status_code=status, detail=message) from exc
    return _ok(agent_service.serialize_thread(
        db,
        thread,
        include_messages=True,
        include_sources=True,
    ))


@router.get("/threads/{thread_id}")
def get_agent_thread(
    thread_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    return _ok(agent_service.serialize_thread(
        db,
        thread,
        include_messages=True,
        include_sources=True,
    ))


@router.patch("/threads/{thread_id}")
def update_agent_thread(
    thread_id: str,
    body: ThreadUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        agent_service.update_thread(db, thread, title=body.title)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(agent_service.serialize_thread(db, thread))


@router.delete("/threads/{thread_id}")
def delete_agent_thread(
    thread_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        agent_service.delete_thread(db, thread)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _ok({"deleted": True})


@router.post("/messages/{message_id}/plan-change/apply")
def apply_agent_plan_change(
    message_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        plan, message = agent_service.apply_plan_change_message(
            db,
            message_id=message_id,
            user_id=current_user.id,
        )
    except plan_service.PlanConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        detail = str(exc)
        status = 404 if "不存在" in detail else 422
        raise HTTPException(status_code=status, detail=detail) from exc
    return _ok({"plan": plan.to_dict(), "message": message.to_dict()})


@router.post("/threads/{thread_id}/messages")
def send_agent_message(
    thread_id: str,
    body: ThreadMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    charge = None
    try:
        charge = _reserve_chat_charge(db, str(current_user.id))
        user_message, assistant_message = agent_service.ask_thread(
            db,
            thread=thread,
            content=body.content,
            research_mode=body.research_mode,
            output_style=body.output_style,
            custom_instruction=body.custom_instruction,
            web_scope=body.web_scope,
        )
        if charge is not None:
            chat_credit_billing_service.capture(db, charge)
        charge = None
    except agent_service.AgentVideoAnalysisTerminal as exc:
        _release_chat_charge_safely(db, charge)
        return _ok(exc.payload)
    except agent_service.AgentThreadConflictError as exc:
        _release_chat_charge_safely(db, charge)
        raise HTTPException(
            status_code=409,
            detail=str(exc),
            headers={"Retry-After": "3"},
        ) from exc
    except ValueError as exc:
        _release_chat_charge_safely(db, charge)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        _release_chat_charge_safely(db, charge)
        traceback.print_exc()
        error_log_service.record_exception_safely(
            exc,
            source="llm",
            status_code=502,
            method="POST",
            path="/api/agent/threads/{thread_id}/messages",
            user_id=current_user.id,
            ip=request.client.host if request.client else None,
            metadata=_agent_failure_metadata(current_user.id),
        )
        raise HTTPException(
            status_code=502,
            detail="视频 Agent 暂时没有完成回答，请稍后重试。",
        ) from exc
    return _ok({
        "thread": agent_service.serialize_thread(
            db,
            thread,
            include_messages=True,
            include_sources=True,
        ),
        "user_message": user_message.to_dict(),
        "assistant_message": assistant_message.to_dict(),
    })


@router.post("/threads/{thread_id}/messages/stream")
def stream_agent_message(
    thread_id: str,
    body: ThreadMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Stream real research milestones, then the validated final answer.

    The LLM's final call returns structured JSON containing the answer and its
    citations. Streaming that raw JSON would expose broken partial syntax, so
    milestones are emitted while research runs and only the validated answer
    text is progressively revealed once its evidence has been checked.
    """
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")

    if settings_service.agent_v2_enabled_for_user(db, str(current_user.id)):
        turn, created = agent_runtime_service.create_or_get_turn(
            db,
            thread=thread,
            client_turn_id=body.client_turn_id,
            question=body.content,
            requested_mode=body.research_mode,
            output_style=body.output_style,
            custom_instruction=body.custom_instruction,
            web_scope=body.web_scope,
        )
        if created or turn.status in {"queued", "retry_wait"}:
            agent_runtime_worker.runner.submit(turn.id)
        return StreamingResponse(
            _durable_turn_stream(turn.id, str(current_user.id)),
            media_type="text/event-stream",
            headers=_sse_headers(),
        )

    user_id = str(current_user.id)
    client_ip = request.client.host if request.client else None
    request_body = body.model_dump()
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def emit(event: dict[str, Any]) -> None:
        events.put(event)

    def run_agent() -> None:
        context_tokens = set_request_context(
            user_id,
            f"/api/agent/threads/{thread_id}/messages/stream",
        )
        charge = None
        try:
            with SessionLocal() as worker_db:
                worker_thread = agent_service.get_thread(
                    worker_db,
                    thread_id,
                    user_id,
                )
                if worker_thread is None:
                    emit({
                        "type": "error",
                        "status": 404,
                        "message": "Agent 任务不存在",
                    })
                    return

                charge = _reserve_chat_charge(worker_db, user_id)
                answer_started = {"value": False}

                def emit_answer_delta(delta_text: str) -> None:
                    if not delta_text:
                        return
                    if not answer_started["value"]:
                        answer_started["value"] = True
                        emit({
                            "type": "assistant_start",
                            "message": {
                                "id": "",
                                "thread_id": worker_thread.id,
                                "role": "assistant",
                                "content": "",
                                "created_at": _now_iso(),
                            },
                        })
                    emit({"type": "delta", "delta": delta_text})

                user_message, assistant_message = agent_service.ask_thread(
                    worker_db,
                    thread=worker_thread,
                    content=request_body["content"],
                    research_mode=request_body["research_mode"],
                    output_style=request_body["output_style"],
                    custom_instruction=request_body["custom_instruction"],
                    web_scope=request_body["web_scope"],
                    progress_callback=lambda progress: emit({
                        "type": "progress",
                        **progress,
                    }),
                    answer_delta=emit_answer_delta,
                )
                if charge is not None:
                    chat_credit_billing_service.capture(worker_db, charge)
                charge = None

                assistant_payload = assistant_message.to_dict()
                if not answer_started["value"]:
                    emit({
                        "type": "assistant_start",
                        "message": {**assistant_payload, "content": ""},
                    })
                for chunk in _answer_stream_chunks(assistant_message.content):
                    if answer_started["value"]:
                        # The validated answer was already streamed token by
                        # token; do not reveal it a second time.
                        break
                    emit({"type": "delta", "delta": chunk})
                    # A very short yield keeps markdown updates observable while
                    # adding less than a second for a typical response.
                    time.sleep(0.02)

                result = {
                    "thread": agent_service.serialize_thread(
                        worker_db,
                        worker_thread,
                        include_messages=True,
                        include_sources=True,
                    ),
                    "user_message": user_message.to_dict(),
                    "assistant_message": assistant_payload,
                }
                emit({"type": "done", "data": result})
        except agent_service.AgentVideoAnalysisTerminal as exc:
            with SessionLocal() as release_db:
                _release_chat_charge_safely(release_db, charge)
            emit({"type": exc.event_type, "data": exc.payload})
        except agent_service.AgentThreadConflictError as exc:
            with SessionLocal() as release_db:
                _release_chat_charge_safely(release_db, charge)
            emit({"type": "error", "status": 409, "message": str(exc)})
        except ValueError as exc:
            with SessionLocal() as release_db:
                _release_chat_charge_safely(release_db, charge)
            emit({"type": "error", "status": 422, "message": str(exc)})
        except Exception as exc:
            with SessionLocal() as release_db:
                _release_chat_charge_safely(release_db, charge)
            traceback.print_exc()
            error_log_service.record_exception_safely(
                exc,
                source="llm",
                status_code=502,
                method="POST",
                path="/api/agent/threads/{thread_id}/messages/stream",
                user_id=user_id,
                ip=client_ip,
                metadata=_agent_failure_metadata(user_id),
            )
            emit({
                "type": "error",
                "status": 502,
                "message": "视频 Agent 暂时没有完成回答，请稍后重试。",
            })
        finally:
            reset_request_context(context_tokens)
            events.put(None)

    threading.Thread(
        target=run_agent,
        name=f"agent-stream-{thread_id[:8]}",
        daemon=True,
    ).start()

    def event_stream():
        yield _sse_data({
            "type": "progress",
            "stage": "queued",
            "message": "问题已接收，正在准备视频资料",
        })
        while True:
            try:
                event = events.get(timeout=_SSE_HEARTBEAT_SECONDS)
            except queue.Empty:
                yield f": heartbeat {int(time.time())}\n\n"
                continue
            if event is None:
                break
            yield _sse_data(event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@router.get("/threads/{thread_id}/turns/{turn_id}")
def get_agent_turn(
    thread_id: str,
    turn_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    turn = agent_runtime_service.get_turn(db, turn_id, str(current_user.id))
    if turn is None or turn.thread_id != thread_id:
        raise HTTPException(status_code=404, detail="Agent Turn 不存在")
    return _ok(turn.to_dict())


@router.get("/threads/{thread_id}/turns/{turn_id}/events")
def list_agent_turn_events(
    thread_id: str,
    turn_id: str,
    after_seq: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    turn = agent_runtime_service.get_turn(db, turn_id, str(current_user.id))
    if turn is None or turn.thread_id != thread_id:
        raise HTTPException(status_code=404, detail="Agent Turn 不存在")
    events = agent_runtime_service.list_events(db, turn=turn, after_seq=after_seq)
    return _ok({"turn": turn.to_dict(), "items": [event.to_dict() for event in events]})


@router.get("/threads/{thread_id}/turns/{turn_id}/stream")
def resume_agent_turn_stream(
    thread_id: str,
    turn_id: str,
    after_seq: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    turn = agent_runtime_service.get_turn(db, turn_id, str(current_user.id))
    if turn is None or turn.thread_id != thread_id:
        raise HTTPException(status_code=404, detail="Agent Turn 不存在")
    return StreamingResponse(
        _durable_turn_stream(
            turn.id,
            str(current_user.id),
            initial_after_seq=after_seq,
        ),
        media_type="text/event-stream",
        headers=_sse_headers(),
    )


@router.post("/threads/{thread_id}/turns/{turn_id}/cancel")
def cancel_agent_turn(
    thread_id: str,
    turn_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    turn = agent_runtime_service.get_turn(db, turn_id, str(current_user.id))
    if turn is None or turn.thread_id != thread_id:
        raise HTTPException(status_code=404, detail="Agent Turn 不存在")
    return _ok(agent_runtime_service.request_cancel(db, turn).to_dict())


@router.post("/threads/{thread_id}/turns/{turn_id}/retry")
def retry_agent_turn(
    thread_id: str,
    turn_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    turn = agent_runtime_service.get_turn(db, turn_id, str(current_user.id))
    if turn is None or turn.thread_id != thread_id:
        raise HTTPException(status_code=404, detail="Agent Turn 不存在")
    try:
        retried = agent_runtime_service.retry_turn(db, turn)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    agent_runtime_worker.runner.submit(retried.id)
    return _ok(retried.to_dict())


@router.post("/threads/{thread_id}/video-analysis/{run_id}/decision")
def decide_agent_video_analysis(
    thread_id: str,
    run_id: str,
    body: VideoAnalysisDecisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    thread = agent_service.get_thread(db, thread_id, current_user.id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Agent 任务不存在")
    try:
        result = agent_service.decide_agent_video_analysis(
            db,
            thread=thread,
            user_id=current_user.id,
            run_id=run_id,
            action=body.action,
            idempotency_key=body.idempotency_key,
            offering_id=body.offering_id,
            use_byok=body.use_byok,
        )
    except agent_service.AgentThreadConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=int(getattr(exc, "status_code", 422)),
            detail=str(exc),
        ) from exc
    except Exception as exc:
        traceback.print_exc()
        error_log_service.record_exception_safely(
            exc,
            source="backend",
            status_code=502,
            method="POST",
            path="/api/agent/threads/{thread_id}/video-analysis/{run_id}/decision",
            user_id=current_user.id,
            ip=request.client.host if request.client else None,
            metadata={"operation": "agent_video_analysis_decision"},
        )
        raise HTTPException(
            status_code=502,
            detail="详细解析操作暂时没有完成，请稍后重试。",
        ) from exc
    return _ok(result)


@router.get("/automations/status")
def get_agent_automation_status(
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    runner_status = automation_runner.runner.status()
    return _ok({
        "runner": {
            "enabled": runner_status["enabled"],
            "running": runner_status["running"],
            "poll_seconds": runner_status["poll_seconds"],
        },
        "email": email_delivery.public_status(),
        "account_email": current_user.email,
        "email_verified": bool(current_user.email_verified),
        "recipient_policy": "account_email_only",
    })


@router.get("/email/status")
def get_agent_email_status(
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return _ok({
        "account_email": current_user.email,
        "email_verified": bool(current_user.email_verified),
        "delivery": email_delivery.public_status(),
    })


@router.post("/email/verification/send")
def send_agent_email_verification(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    user = (
        db.query(User)
        .filter(User.id == current_user.id)
        .with_for_update()
        .one()
    )
    if user.email_verified:
        return _ok({
            "status": "already_verified",
            "email_verified": True,
        })
    if not email_delivery.is_configured():
        raise HTTPException(
            status_code=503,
            detail="邮件服务尚未启用；定时摘要会先保存在知萃中，不会外发。",
        )
    now = datetime.now(timezone.utc)
    sent_at = user.email_verification_sent_at
    if sent_at is not None:
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if sent_at > now - timedelta(seconds=60):
            raise HTTPException(
                status_code=429,
                detail="验证邮件刚刚已经提交，请稍后再试。",
            )
    nonce = secrets.token_urlsafe(32)
    user.email_verification_nonce = nonce
    user.email_verification_sent_at = now
    db.commit()
    db.refresh(user)
    token = auth_service.create_email_verification_token(
        user,
        nonce,
    )
    delivery = email_delivery.send_verification(
        recipient=user.email,
        token=token,
        message_key=f"{user.id}-{nonce}",
    )
    if delivery["status"] != "sent":
        raise HTTPException(
            status_code=502,
            detail=delivery.get("error") or "验证邮件暂时没有提交成功。",
        )
    return _ok({
        "status": "submitted",
        "email_verified": False,
    })


@router.post("/email/verification/confirm")
def confirm_agent_email_verification(
    body: EmailVerificationConfirmRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    payload = auth_service.decode_email_verification_token(body.token)
    if payload is None:
        raise HTTPException(
            status_code=422,
            detail="验证链接无效或已过期，请重新发送。",
        )
    user = (
        db.query(User)
        .filter(
            User.id == str(payload.get("sub") or ""),
            User.email == str(payload.get("email") or "").lower(),
        )
        .first()
    )
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="账号不存在或已停用。")
    if user.email_verified:
        return _ok({"email_verified": True, "status": "already_verified"})
    token_nonce = str(payload.get("nonce") or "")
    stored_nonce = str(user.email_verification_nonce or "")
    if (
        not token_nonce
        or not stored_nonce
        or not secrets.compare_digest(token_nonce, stored_nonce)
    ):
        raise HTTPException(
            status_code=422,
            detail="验证链接已失效，请重新发送。",
        )
    user.email_verified = True
    user.email_verification_nonce = None
    db.commit()
    activity_service.log_activity_safely(
        user_id=user.id,
        action="email_verification_confirm",
        method="POST",
        path="/api/agent/email/verification/confirm",
        status_code=200,
        detail={"outcome": "success"},
    )
    return _ok({"email_verified": True, "status": "verified"})


@router.get("/automations")
def list_agent_automations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    items = [
        {
            **item.to_dict(),
            "channel": "email",
            "destination": item.recipient_email,
        }
        for item in automation_service.list_automations(db, current_user.id)
    ]
    return _ok({"items": items, "total": len(items)})


@router.post("/automations")
def create_agent_automation(
    body: AutomationCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        automation = automation_service.create_automation(
            db,
            user=current_user,
            name=body.name,
            enabled=body.enabled,
            schedule_time=body.schedule_time,
            timezone_name=body.timezone,
            source_scope=body.source_scope,
            source_mode=body.source_mode,
            instruction=body.instruction,
            recipient_email=body.recipient_email or body.destination,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.get("/automations/{automation_id}")
def get_agent_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.patch("/automations/{automation_id}")
def update_agent_automation(
    automation_id: str,
    body: AutomationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    changes = body.model_dump(exclude_unset=True)
    destination = changes.pop("destination", None)
    if destination and "recipient_email" not in changes:
        changes["recipient_email"] = destination
    try:
        automation_service.update_automation(
            db,
            automation,
            user=current_user,
            changes=changes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok({
        **automation.to_dict(),
        "channel": "email",
        "destination": automation.recipient_email,
    })


@router.delete("/automations/{automation_id}")
def delete_agent_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    automation_service.delete_automation(db, automation)
    return _ok({"deleted": True})


@router.post("/automations/{automation_id}/run")
def run_agent_automation(
    automation_id: str,
    body: AutomationRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if body.deliver:
        raise HTTPException(
            status_code=422,
            detail="手动运行只生成预览；邮件仅由已启用的每日摘要按时发送。",
        )
    automation = automation_service.get_automation(
        db, automation_id, current_user.id
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    try:
        run = automation_service.create_manual_run(
            db,
            automation=automation,
        )
    except ValueError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    completed = automation_service.execute_run(
        db,
        run_id=run.id,
        deliver=False,
    )
    if completed is None:
        raise HTTPException(status_code=500, detail="未能创建运行记录")
    return _ok(completed.to_dict())


@router.get("/automations/{automation_id}/runs")
def list_agent_automation_runs(
    automation_id: str,
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    automation = automation_service.get_automation(
        db,
        automation_id,
        current_user.id,
        include_deleted=True,
    )
    if automation is None:
        raise HTTPException(status_code=404, detail="自动摘要不存在")
    runs = automation_service.list_runs(
        db,
        automation_id=automation.id,
        user_id=current_user.id,
        limit=limit,
    )
    return _ok({"items": [run.to_dict() for run in runs], "total": len(runs)})
