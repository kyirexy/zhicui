"""Recoverable local worker for durable Agent V2 turns."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

from app.core.database import SessionLocal
from app.core.request_context import reset_request_context, set_request_context
from app.models.agent_thread import AgentThread
from app.services import (
    agent_runtime_service,
    agent_service,
    chat_credit_billing_service,
    chat_model_catalog_service,
    user_ai_provider_service,
)
from app.services.agent_tool_runtime import AgentToolExecutor, AgentToolRegistry


logger = logging.getLogger(__name__)
_SCAN_INTERVAL_SECONDS = 5.0
_HEARTBEAT_SECONDS = 60.0


class _DurableAnswerWriter:
    """Coalesce visible answer text into small lease-checked replay events."""

    # Live model chunks must stay visible while the durable log remains
    # bounded. 48–96 characters yields roughly 10–25 database events for an
    # ordinary answer; sentence endings and a short time budget flush earlier
    # so a sub-threshold tail is never held until the outer JSON finishes.
    _MIN_BOUNDARY_CHARS = 12
    _TARGET_CHARS = 48
    _MAX_CHARS = 96
    _PERSIST_INTERVAL_SECONDS = 0.35
    _CONTROL_CHECK_INTERVAL_SECONDS = 0.25
    _STRONG_BOUNDARIES = frozenset("。！？!?\n")
    _SOFT_BOUNDARIES = frozenset("，；：、,.;:")

    def __init__(self, db, turn, lease_token: str) -> None:
        self.db = db
        self.turn = turn
        self.lease_token = lease_token
        self.started = False
        self.buffer = ""
        self.visible_text = ""
        self.chunk_index = 0
        self.persisted_offset = 0
        now = time.monotonic()
        self.last_persisted_at = now
        self.next_control_check_at = now + self._CONTROL_CHECK_INTERVAL_SECONDS
        self.cancel_signal = agent_runtime_service.cancellation_signal(turn.id)

    def __call__(self, delta: str) -> None:
        text = str(delta or "")
        if not text:
            return
        if self.started:
            self.check_active()
        elif self.cancel_signal.is_set():
            raise agent_runtime_service.AgentTurnCancelled("Agent Turn 已取消")
        self.visible_text += text
        if not self.started:
            agent_runtime_service.append_event(
                self.db,
                turn=self.turn,
                event_type="turn.answer.started",
                phase="synthesizing",
                message="正在生成回答",
                payload={"streaming": True},
                lease_token=self.lease_token,
            )
            self.started = True
            # Expose the first non-empty content immediately, but bound it as
            # strictly as later chunks. Some providers deliver the whole JSON
            # answer field in one callback.
            self._persist(text[:self._MAX_CHARS])
            text = text[self._MAX_CHARS:]
        self.buffer += text
        self._flush_ready()

    def check_active(self, *, force: bool = False) -> None:
        """Stop explicit cancellation quickly, with a DB cross-process fallback."""
        if self.cancel_signal.is_set():
            raise agent_runtime_service.AgentTurnCancelled("Agent Turn 已取消")
        now = time.monotonic()
        if not force and now < self.next_control_check_at:
            return
        agent_runtime_service.assert_turn_active(
            self.db, self.turn.id, self.lease_token
        )
        self.next_control_check_at = now + self._CONTROL_CHECK_INTERVAL_SECONDS

    def _boundary_index(self, boundaries: frozenset[str]) -> int:
        limit = min(self._MAX_CHARS, len(self.buffer))
        if limit < self._MIN_BOUNDARY_CHARS:
            return 0
        for index in range(limit - 1, self._MIN_BOUNDARY_CHARS - 2, -1):
            if self.buffer[index] in boundaries:
                return index + 1
        return 0

    def _take_chunk(self, *, force: bool = False) -> str:
        limit = min(self._MAX_CHARS, len(self.buffer))
        split_at = self._boundary_index(self._STRONG_BOUNDARIES)
        if not split_at and (force or len(self.buffer) >= self._TARGET_CHARS):
            split_at = self._boundary_index(self._SOFT_BOUNDARIES)
        if not split_at:
            if not force and len(self.buffer) < self._TARGET_CHARS:
                return ""
            split_at = limit
        chunk = self.buffer[:split_at]
        self.buffer = self.buffer[split_at:]
        return chunk

    def _flush_ready(self) -> None:
        while self.buffer:
            now = time.monotonic()
            has_sentence = bool(self._boundary_index(self._STRONG_BOUNDARIES))
            force = now - self.last_persisted_at >= self._PERSIST_INTERVAL_SECONDS
            if not has_sentence and len(self.buffer) < self._TARGET_CHARS and not force:
                return
            chunk = self._take_chunk(force=force)
            if not chunk:
                return
            self._persist(chunk)

    def _persist(self, delta: str) -> None:
        if not delta:
            return
        self.chunk_index += 1
        start_offset = self.persisted_offset
        self.persisted_offset += len(delta)
        agent_runtime_service.append_event(
            self.db,
            turn=self.turn,
            event_type="turn.answer.delta",
            phase="synthesizing",
            payload={
                "delta": delta,
                "chunk_index": self.chunk_index,
                "start_offset": start_offset,
                "end_offset": self.persisted_offset,
            },
            lease_token=self.lease_token,
        )
        self.last_persisted_at = time.monotonic()

    def flush(self) -> None:
        if not self.started and not self.buffer:
            return
        self.check_active(force=True)
        while self.buffer:
            self._persist(self._take_chunk(force=True))

    def finish(self, canonical: str) -> None:
        """Finish with the validated answer without retracting visible text."""
        self.flush()
        final_text = str(canonical or "")
        if final_text.startswith(self.visible_text):
            self(final_text[len(self.visible_text):])
            self.flush()


class _LeaseHeartbeat:
    def __init__(self, turn_id: str, token: str) -> None:
        self.turn_id = turn_id
        self.token = token
        self.lost = threading.Event()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name=f"agent-lease-{turn_id[:8]}", daemon=True
        )

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop_event.set()
        self.thread.join(timeout=2.0)

    def _run(self) -> None:
        while not self.stop_event.wait(_HEARTBEAT_SECONDS):
            if not agent_runtime_service.heartbeat(self.turn_id, self.token):
                self.lost.set()
                return


def _reserve_charge(db, turn):
    if user_ai_provider_service.uses_custom_provider(db, turn.user_id):
        return None
    offering = chat_model_catalog_service.selected_offering(db, turn.user_id)
    return chat_credit_billing_service.reserve(
        db, user_id=turn.user_id, offering=offering, request_id=turn.id
    )


def process_turn(turn_id: str) -> None:
    lease_token = ""
    charge = None
    try:
        with SessionLocal() as db:
            claimed = agent_runtime_service.claim_turn(db, turn_id)
            if claimed is None:
                return
            turn, lease_token = claimed
            thread = db.query(AgentThread).filter(
                AgentThread.id == turn.thread_id,
                AgentThread.user_id == turn.user_id,
            ).first()
            if thread is None:
                raise ValueError("Agent 会话不存在")
            charge = _reserve_charge(db, turn)
            agent_runtime_service.append_event(
                db,
                turn=turn,
                event_type="turn.started",
                phase="planning",
                message=(
                    "正在读取当前计划"
                    if thread.context_type == "plan"
                    else (
                        "已自动切换为深度研究"
                        if turn.resolved_mode == "deep"
                        else "正在准备视频资料"
                    )
                ),
                payload={
                    "resolved_mode": turn.resolved_mode,
                    "source_total_count": turn.source_total_count,
                    "context_type": thread.context_type or "video",
                    "context_id": thread.context_id,
                },
                lease_token=lease_token,
            )

            def progress_callback(progress: dict) -> None:
                agent_runtime_service.renew_lease_or_raise(turn.id, lease_token)
                phase = str(progress.get("stage") or "researching")
                event_type = str(progress.get("event_type") or "turn.progress")
                agent_runtime_service.append_event(
                    db,
                    turn=turn,
                    event_type=event_type,
                    phase=phase,
                    message=str(progress.get("message") or "")[:500],
                    payload={
                        key: value
                        for key, value in progress.items()
                        if key not in {"message", "event_type"}
                    },
                    lease_token=lease_token,
                )

            def tool_boundary_check() -> None:
                agent_runtime_service.renew_lease_or_raise(turn.id, lease_token)

            tool_phases = {
                "video.source_scan": "scanning",
                "video.transcript_map": "researching",
                "web.public_research": "web",
                "video.answer_synthesize": "synthesizing",
                "video.claim_repair": "verifying",
                "video.claim_validate": "verifying",
            }

            def tool_event_callback(
                event_type: str,
                message: str,
                payload: dict,
            ) -> None:
                tool_name = str(payload.get("tool_name") or "")
                agent_runtime_service.append_event(
                    db,
                    turn=turn,
                    event_type=event_type,
                    phase=tool_phases.get(tool_name, "researching"),
                    message=message,
                    payload=payload,
                    lease_token=lease_token,
                )

            tool_executor = AgentToolExecutor(
                turn_id=turn.id,
                registry=AgentToolRegistry(),
                max_calls=24,
                boundary_check=tool_boundary_check,
                event_callback=tool_event_callback,
            )

            history = agent_runtime_service.conversation_context(db, thread=thread)
            answer_writer = _DurableAnswerWriter(db, turn, lease_token)
            context_tokens = set_request_context(
                str(turn.user_id),
                f"/api/agent/turns/{turn.id}/worker",
            )
            try:
                with _LeaseHeartbeat(turn.id, lease_token) as heartbeat:
                    try:
                        user_message, assistant_message = agent_service.ask_thread(
                            db,
                            thread=thread,
                            content=turn.question,
                            research_mode=turn.resolved_mode or "fast",
                            output_style=turn.output_style,
                            custom_instruction=turn.custom_instruction,
                            web_scope=turn.web_scope,
                            progress_callback=progress_callback,
                            answer_delta=answer_writer,
                            allow_video_analysis=False,
                            turn_id_override=turn.id,
                            history_override=history,
                            tool_executor=tool_executor,
                            # 普通问题的 answer 叙述字段可以随供应商流实时写入；
                            # 跨视频共同观点仍由 ai_juicer 的 claim_required 门槛
                            # 自动扣留，claims 与逐字引用始终在校验后追加。
                            validated_stream_only=False,
                        )
                    except (
                        agent_runtime_service.AgentTurnCancelled,
                        agent_runtime_service.AgentTurnLeaseLost,
                    ):
                        raise
                    except Exception as primary_error:
                        # Once visible answer text exists, replaying a second
                        # orchestration would mix two drafts. Fail this Turn
                        # transparently and let the user retry instead.
                        if answer_writer.started:
                            raise
                        db.rollback()
                        db.refresh(thread)
                        agent_runtime_service.append_event(
                            db,
                            turn=turn,
                            event_type="turn.v1_fallback_started",
                            phase="fallback",
                            message="新版研究链路未完成，正在使用兼容模式重试",
                            payload={"primary_error": type(primary_error).__name__},
                            lease_token=lease_token,
                        )
                        user_message, assistant_message = agent_service.ask_thread(
                            db,
                            thread=thread,
                            content=turn.question,
                            research_mode=turn.resolved_mode or "fast",
                            output_style=turn.output_style,
                            custom_instruction=turn.custom_instruction,
                            web_scope=turn.web_scope,
                            progress_callback=progress_callback,
                            answer_delta=answer_writer,
                            allow_video_analysis=False,
                            turn_id_override=turn.id,
                            validated_stream_only=False,
                        )
                    answer_writer.finish(assistant_message.content)
                    if heartbeat.lost.is_set():
                        raise agent_runtime_service.AgentTurnLeaseLost("Agent Turn 租约已转移")
            finally:
                reset_request_context(context_tokens)
            result = assistant_message.result
            agent_runtime_service.complete_turn(
                db,
                turn=turn,
                lease_token=lease_token,
                user_message_id=user_message.id,
                assistant_message_id=assistant_message.id,
                result=result,
            )
            agent_runtime_service.maybe_checkpoint_memory(db, thread=thread)
            if charge is not None:
                chat_credit_billing_service.capture(db, charge)
                charge = None
    except Exception as exc:
        logger.exception("Agent V2 Turn 执行失败: %s", turn_id)
        if charge is not None:
            try:
                with SessionLocal() as release_db:
                    chat_credit_billing_service.release(release_db, charge)
            except Exception:
                logger.exception("释放 Agent V2 额度失败: %s", turn_id)
        if lease_token:
            agent_runtime_service.fail_turn(turn_id, lease_token, exc)


class AgentRuntimeRunner:
    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()
        self._futures: dict[str, Future[None]] = {}
        self._scanner: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._accepting = False

    def start(self) -> None:
        with self._lock:
            self._accepting = True
            self._stop_event.clear()
            if self._executor is None:
                self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="agent-v2")
            if self._scanner is None or not self._scanner.is_alive():
                self._scanner = threading.Thread(
                    target=self._scan_loop, name="agent-v2-scanner", daemon=True
                )
                self._scanner.start()
        self._submit_due()

    def stop(self) -> None:
        with self._lock:
            self._accepting = False
            self._stop_event.set()
            scanner = self._scanner
            self._scanner = None
            executor = self._executor
            self._executor = None
        if scanner is not None and scanner is not threading.current_thread():
            scanner.join(timeout=_SCAN_INTERVAL_SECONDS + 1)
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=False)

    def submit(self, turn_id: str) -> None:
        with self._lock:
            if not self._accepting or self._executor is None:
                return
            current = self._futures.get(turn_id)
            if current is not None and not current.done():
                return
            future = self._executor.submit(process_turn, turn_id)
            self._futures[turn_id] = future
            future.add_done_callback(lambda done, key=turn_id: self._forget(key, done))

    def _forget(self, turn_id: str, future: Future[None]) -> None:
        with self._lock:
            if self._futures.get(turn_id) is future:
                self._futures.pop(turn_id, None)

    def _submit_due(self) -> None:
        try:
            for turn_id in agent_runtime_service.due_turn_ids():
                self.submit(turn_id)
        except Exception:
            logger.exception("扫描 Agent V2 Turn 失败")

    def _scan_loop(self) -> None:
        while not self._stop_event.wait(_SCAN_INTERVAL_SECONDS):
            self._submit_due()


runner = AgentRuntimeRunner()
