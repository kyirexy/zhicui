import unittest
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.agent_runtime import AgentEvent, AgentMemoryCheckpoint, AgentTurn, AgentTurnSource
from app.models.note import Note  # noqa: F401
from app.models.user import User  # noqa: F401
from app.services import agent_runtime_service, agent_service, ai_juicer
from app.services import agent_runtime_worker
from app.api.agent_routes import (
    _DURABLE_STREAM_POLL_SECONDS,
    _SSE_HEARTBEAT_SECONDS,
    _project_durable_event,
    _sse_headers,
)
from app.services.agent_repeat_tool_guard import RepeatToolGuard, canonical_arguments
from app.services.agent_tool_runtime import (
    AgentTool,
    AgentToolAlreadyRegistered,
    AgentToolBudgetExceeded,
    AgentToolExecutor,
    AgentToolRegistry,
    AgentToolRepeatBlocked,
    AgentToolResultTooLarge,
    AgentToolUnknown,
)


class AgentRuntimeV2Tests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def tearDown(self):
        self.engine.dispose()

    def test_durable_stream_discovers_committed_events_within_fifty_ms(self):
        self.assertLessEqual(_DURABLE_STREAM_POLL_SECONDS, 0.05)

    def test_sse_transport_disables_buffering_and_sends_frequent_heartbeats(self):
        headers = _sse_headers()

        self.assertLessEqual(_SSE_HEARTBEAT_SECONDS, 5.0)
        self.assertEqual(headers["X-Accel-Buffering"], "no")
        self.assertEqual(headers["Content-Encoding"], "identity")
        self.assertIn("no-transform", headers["Cache-Control"])

    def test_exact_broad_question_resolves_deep(self):
        self.assertEqual(
            agent_runtime_service.resolve_research_mode(
                "auto",
                question="这些视频反复出现的核心观点是什么？",
                source_count=37,
                output_style="answer",
            ),
            "deep",
        )
        self.assertEqual(
            agent_runtime_service.resolve_research_mode(
                "auto",
                question="请完整列出25个机制元，并分别说明作用",
                source_count=37,
                output_style="answer",
            ),
            "deep",
        )

    def test_turn_client_id_is_idempotent_and_user_scoped(self):
        with self.Session() as db:
            thread = AgentThread(
                id="thread-1", user_id="user-1", title="研究",
                scope_type="selected", scope_label="手选视频", source_ids_json="[]",
            )
            db.add(thread)
            db.commit()
            first, created = agent_runtime_service.create_or_get_turn(
                db, thread=thread, client_turn_id="client-turn-0001",
                question="问题", requested_mode="auto", output_style="answer",
                custom_instruction="", web_scope="video_only",
            )
            second, created_again = agent_runtime_service.create_or_get_turn(
                db, thread=thread, client_turn_id="client-turn-0001",
                question="问题", requested_mode="auto", output_style="answer",
                custom_instruction="", web_scope="video_only",
            )
            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(first.id, second.id)
            self.assertIsNone(agent_runtime_service.get_turn(db, first.id, "other-user"))

    def test_append_event_repairs_a_stale_sequence_counter(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="event-seq-repair")
            existing = agent_runtime_service.list_events(db, turn=turn)
            self.assertEqual([event.seq for event in existing], [1])

            # Simulate the SQLite race seen when cancellation and worker
            # progress both observed the same counter before one committed.
            turn.next_event_seq = 1
            db.commit()
            repaired = agent_runtime_service.append_event(
                db,
                turn=turn,
                event_type="turn.progress",
                phase="researching",
                message="继续研究",
            )

            self.assertEqual(repaired.seq, 2)
            self.assertEqual(turn.next_event_seq, 3)
            self.assertEqual(
                [event.seq for event in agent_runtime_service.list_events(db, turn=turn)],
                [1, 2],
            )

    def test_thirty_seven_sources_are_all_available_to_deep_map(self):
        sources = [
            {
                "note_id": f"note-{index}",
                "title": f"视频 {index}",
                "transcript": f"共同主题 第{index}条具体说明。" * 20,
                "ai_summary": "",
            }
            for index in range(37)
        ]
        _, _, context = ai_juicer._build_library_research_context(
            sources, ["共同主题"], coverage="broad", research_mode="deep"
        )
        self.assertEqual(context["scanned_count"], 37)
        self.assertEqual(context["mapped_count"], 37)
        self.assertEqual(len(context["_map_sources"]), 37)

        _, _, focused_context = ai_juicer._build_library_research_context(
            sources, ["机制元"], coverage="focused", research_mode="deep"
        )
        self.assertEqual(focused_context["scanned_count"], 37)
        self.assertEqual(focused_context["mapped_count"], 12)
        self.assertEqual(len(focused_context["_map_sources"]), 12)

    def test_exact_enumeration_plan_is_focused(self):
        plan = ai_juicer._library_research_plan(
            "请完整列出25个机制元，并分别说明作用",
            ["游戏机制元素周期表"],
            [],
            "answer",
            "",
            use_model=False,
        )
        self.assertEqual(plan["coverage"], "focused")

    def test_recurring_claim_requires_two_verified_sources(self):
        supplied = {
            "a": {"title": "A", "raw_transcript": "同一观点", "transcript_context": "同一观点", "summary_context": "", "visual_evidence": []},
            "b": {"title": "B", "raw_transcript": "同一观点", "transcript_context": "同一观点", "summary_context": "", "visual_evidence": []},
        }
        claims, rejected = ai_juicer._validated_library_claims(
            [{
                "claim_id": "C1", "kind": "recurring", "text": "反复观点",
                "evidence": [{"note_id": "a", "quote": "同一观点", "source": "transcript"}],
            }],
            supplied_sources=supplied,
            source_total_count=2,
        )
        self.assertEqual(claims, [])
        self.assertEqual(rejected, 1)

    def test_deep_claim_quality_triggers_repair_without_dropping_grounded_claim(self):
        supplied = {
            "a": {"title": "A", "raw_transcript": "观点原文A", "transcript_context": "观点原文A", "summary_context": "", "visual_evidence": []},
            "b": {"title": "B", "raw_transcript": "观点原文B", "transcript_context": "观点原文B", "summary_context": "", "visual_evidence": []},
        }
        claims, rejected = ai_juicer._validated_library_claims(
            [{
                "claim_id": "C1", "kind": "recurring", "text": "共同观点",
                "explanation": "解释太短",
                "evidence": [
                    {"note_id": "a", "quote": "观点原文A", "source": "transcript"},
                    {"note_id": "b", "quote": "观点原文B", "source": "transcript"},
                ],
            }],
            supplied_sources=supplied,
            source_total_count=37,
            minimum_explanation_chars=100,
            reject_partial_evidence=True,
        )
        self.assertEqual(len(claims), 1)
        self.assertEqual(rejected, 1)

    def test_validated_answer_renders_exact_quotes_for_research_depth(self):
        answer = ai_juicer._render_validated_claim_answer(
            "这是整体结论。",
            [{
                "claim_id": "C1", "kind": "recurring", "text": "共同观点",
                "explanation": "这是对共同观点的具体解释。",
                "support_count": 2,
                "evidence": [
                    {"note_id": "a", "title": "视频 A", "quote": "观点原文A"},
                    {"note_id": "b", "title": "视频 B", "quote": "观点原文B"},
                ],
            }],
            source_total_count=37,
        )
        self.assertIn("已核验原文", answer)
        self.assertIn("《视频 A》：“观点原文A”", answer)

    def test_validated_answer_replaces_placeholder_overview_without_model_call(self):
        answer = ai_juicer._render_validated_claim_answer(
            "视频",
            [{
                "claim_id": "C1",
                "kind": "recurring",
                "text": "把复杂问题拆成可验证步骤",
                "explanation": "先建立结构，再逐项验证证据，最后组合成结论。",
                "support_count": 2,
                "evidence": [],
            }],
            source_total_count=37,
        )

        self.assertNotEqual(answer.splitlines()[0], "视频")
        self.assertIn("37 条视频", answer)
        self.assertIn("把复杂问题拆成可验证步骤", answer)

    def test_video_only_claim_drops_unsourced_named_theory(self):
        supplied = {
            "a": {"title": "A", "raw_transcript": "把视角切换到玩家", "transcript_context": "把视角切换到玩家", "summary_context": "", "visual_evidence": []},
            "b": {"title": "B", "raw_transcript": "把痛苦看作经验值", "transcript_context": "把痛苦看作经验值", "summary_context": "", "visual_evidence": []},
        }
        claims, rejected = ai_juicer._validated_library_claims(
            [{
                "claim_id": "C1", "kind": "recurring", "text": "认知重构",
                "explanation": "换视角能减少情绪卷入。该方法基于认知行为疗法原理。",
                "evidence": [
                    {"note_id": "a", "quote": "把视角切换到玩家", "source": "transcript"},
                    {"note_id": "b", "quote": "把痛苦看作经验值", "source": "transcript"},
                ],
            }],
            supplied_sources=supplied,
            source_total_count=37,
            reject_partial_evidence=True,
        )
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["explanation"], "换视角能减少情绪卷入。")
        self.assertEqual(rejected, 1)

    def _new_turn(self, db, *, suffix: str = "1"):
        thread = AgentThread(
            id=f"thread-{suffix}", user_id=f"user-{suffix}", title="研究",
            scope_type="selected", scope_label="手选视频", source_ids_json="[]",
        )
        db.add(thread)
        db.commit()
        turn, _ = agent_runtime_service.create_or_get_turn(
            db, thread=thread, client_turn_id=f"client-turn-{suffix.zfill(4)}",
            question="这些视频的共同观点？", requested_mode="auto",
            output_style="answer", custom_instruction="", web_scope="video_only",
        )
        return thread, turn

    def test_expired_lease_can_transfer_and_stale_worker_cannot_commit(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="lease")
            first = agent_runtime_service.claim_turn(db, turn.id)
            self.assertIsNotNone(first)
            _, first_token = first
            self.assertIsNone(agent_runtime_service.claim_turn(db, turn.id))

            persisted = db.query(AgentTurn).filter(AgentTurn.id == turn.id).one()
            persisted.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()
            second = agent_runtime_service.claim_turn(db, turn.id)
            self.assertIsNotNone(second)
            claimed_turn, second_token = second
            self.assertNotEqual(first_token, second_token)
            with self.assertRaises(agent_runtime_service.AgentTurnLeaseLost):
                agent_runtime_service.complete_turn(
                    db,
                    turn=claimed_turn,
                    lease_token=first_token,
                    user_message_id="stale-user",
                    assistant_message_id="stale-assistant",
                    result={},
                )

    def test_queued_cancel_is_terminal_and_retry_reuses_same_turn(self):
        with self.Session() as db:
            thread, turn = self._new_turn(db, suffix="cancel")
            thread.status = "running"
            db.commit()
            cancelled = agent_runtime_service.request_cancel(db, turn)
            self.assertEqual(cancelled.status, "cancelled")
            self.assertIsNone(agent_runtime_service.claim_turn(db, turn.id))
            retried = agent_runtime_service.retry_turn(db, cancelled)
            self.assertEqual(retried.id, turn.id)
            self.assertEqual(retried.status, "queued")
            self.assertFalse(retried.cancellation_requested)
            db.refresh(thread)
            self.assertEqual(thread.status, "failed")
            event_types = [
                item.event_type for item in agent_runtime_service.list_events(db, turn=retried)
            ]
            self.assertIn("turn.cancelled", event_types)
            self.assertIn("turn.retried", event_types)

    def test_memory_checkpoint_replaces_old_turns_but_keeps_recent_context(self):
        with self.Session() as db:
            thread = AgentThread(
                id="thread-memory", user_id="user-memory", title="长期研究",
                scope_type="selected", scope_label="手选视频", source_ids_json="[]",
            )
            db.add(thread)
            start = datetime(2026, 8, 20, tzinfo=timezone.utc)
            for index in range(10):
                role = "user" if index % 2 == 0 else "assistant"
                result = {}
                if role == "assistant":
                    result = {
                        "claims": [{
                            "claim_id": f"C{index}",
                            "text": f"已验证观点 {index}",
                            "supporting_note_ids": ["note-a", "note-b"],
                        }]
                    }
                db.add(AgentMessage(
                    id=f"message-{index}", thread_id=thread.id,
                    user_id=thread.user_id, turn_id=f"turn-{index // 2}",
                    role=role, content=f"第 {index} 条消息",
                    result_json=json.dumps(result, ensure_ascii=False),
                    created_at=start + timedelta(minutes=index),
                ))
            db.commit()
            checkpoint = agent_runtime_service.maybe_checkpoint_memory(db, thread=thread)
            self.assertIsNotNone(checkpoint)
            context = agent_runtime_service.conversation_context(db, thread=thread)
            self.assertEqual(context[0]["role"], "system")
            self.assertIn("长期会话记忆", context[0]["content"])
            self.assertLessEqual(len(context), 9)
            self.assertIn("第 9 条消息", context[-1]["content"])

    def test_thread_projection_contains_recoverable_active_turn(self):
        with self.Session() as db:
            thread, turn = self._new_turn(db, suffix="projection")
            projected = agent_service.serialize_thread(db, thread)
            self.assertEqual(projected["active_turn"]["id"], turn.id)
            self.assertEqual(projected["active_turn"]["status"], "queued")

    def test_thread_projection_repairs_terminal_turn_ghost_running_state(self):
        with self.Session() as db:
            thread, turn = self._new_turn(db, suffix="ghost-running")
            thread.status = "running"
            thread.updated_at = datetime.now(timezone.utc) - timedelta(minutes=5)
            turn.status = "failed"
            turn.phase = "failed"
            turn.error_code = "AgentThreadConflictError"
            turn.error_message = "这个任务正在回答上一条问题，请稍候"
            turn.completed_at = datetime.now(timezone.utc)
            turn.updated_at = datetime.now(timezone.utc)
            db.commit()

            projected = agent_service.serialize_thread(db, thread)

            self.assertIsNone(projected["active_turn"])
            self.assertEqual(projected["status"], "failed")
            db.refresh(thread)
            self.assertEqual(thread.status, "failed")

    def test_inline_source_numbers_are_removed(self):
        cleaned = ai_juicer._strip_inline_source_numbers(
            "核心观点（来源16），同时参见来源 3 和【来源2】。"
        )
        self.assertNotIn("来源16", cleaned)
        self.assertNotIn("来源 3", cleaned)
        self.assertNotIn("来源2", cleaned)

    def test_repeat_tool_guard_canonicalizes_warns_and_blocks(self):
        self.assertEqual(
            canonical_arguments({"b": 2, "a": {"d": 4, "c": 3}}),
            canonical_arguments({"a": {"c": 3, "d": 4}, "b": 2}),
        )
        guard = RepeatToolGuard()
        decisions = [
            guard.observe("turn-1", "transcript.read", {"note_id": "n1", "page": 1})
            for _ in range(5)
        ]
        self.assertFalse(decisions[1].reminder)
        self.assertTrue(decisions[2].reminder)
        self.assertFalse(decisions[2].blocked)
        self.assertTrue(decisions[4].blocked)

    def test_tool_registry_fails_closed_and_rejects_duplicates(self):
        registry = AgentToolRegistry()
        tool = AgentTool(
            name="video.echo",
            description="回显测试",
            handler=lambda arguments: dict(arguments),
        )
        registry.register(tool)
        self.assertEqual(registry.names, ("video.echo",))
        with self.assertRaises(AgentToolAlreadyRegistered):
            registry.register(tool)
        with self.assertRaises(AgentToolUnknown):
            registry.get("shell.exec")

    def test_tool_executor_checks_bounds_and_emits_only_safe_summaries(self):
        events = []
        boundaries = []
        executor = AgentToolExecutor(
            turn_id="turn-tool-safe",
            boundary_check=lambda: boundaries.append("checked"),
            event_callback=lambda event_type, message, payload: events.append(
                (event_type, message, payload)
            ),
        )
        executor.register(AgentTool(
            name="video.echo",
            description="回显测试",
            handler=lambda arguments: {"ok": True, "count": len(arguments)},
        ))
        result = executor.execute(
            "video.echo",
            {"question": "不应进入事件", "api_key": "secret-value"},
        )
        self.assertEqual(result, {"ok": True, "count": 2})
        self.assertEqual(boundaries, ["checked", "checked"])
        self.assertEqual(events[0][0], "turn.tool.started")
        self.assertEqual(events[-1][0], "turn.tool.completed")
        encoded_events = json.dumps(events, ensure_ascii=False)
        self.assertNotIn("不应进入事件", encoded_events)
        self.assertNotIn("secret-value", encoded_events)

    def test_tool_executor_warns_then_blocks_exact_repeats(self):
        calls = []
        events = []
        executor = AgentToolExecutor(
            turn_id="turn-tool-repeat",
            event_callback=lambda event_type, _message, payload: events.append(
                (event_type, payload)
            ),
        )
        executor.register(AgentTool(
            name="video.repeat",
            description="重复测试",
            handler=lambda arguments: calls.append(dict(arguments)) or "ok",
        ))
        for _ in range(4):
            self.assertEqual(executor.execute("video.repeat", {"page": 1}), "ok")
        with self.assertRaises(AgentToolRepeatBlocked):
            executor.execute("video.repeat", {"page": 1})
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(executor.reminders), 3)
        self.assertIn(
            "turn.tool.repeat_reminder",
            [event_type for event_type, _payload in events],
        )
        self.assertEqual(events[-1][0], "turn.tool.repeat_blocked")

    def test_tool_executor_enforces_total_budget_and_result_limit(self):
        budgeted = AgentToolExecutor(turn_id="turn-budget", max_calls=1)
        budgeted.register(AgentTool(
            name="video.small",
            description="小结果",
            handler=lambda _arguments: "ok",
        ))
        self.assertEqual(budgeted.execute("video.small"), "ok")
        with self.assertRaises(AgentToolBudgetExceeded):
            budgeted.execute("video.small", {"different": True})

        limited = AgentToolExecutor(turn_id="turn-result-limit")
        limited.register(AgentTool(
            name="video.large",
            description="大结果",
            max_result_chars=10,
            handler=lambda _arguments: "x" * 20,
        ))
        with self.assertRaises(AgentToolResultTooLarge):
            limited.execute("video.large")

    def test_persistent_tool_events_cancel_and_stale_lease_boundaries(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="tool-events")
            claimed = agent_runtime_service.claim_turn(db, turn.id)
            self.assertIsNotNone(claimed)
            claimed_turn, lease_token = claimed

            def boundary() -> None:
                db.expire_all()
                current = db.query(AgentTurn).filter(
                    AgentTurn.id == claimed_turn.id
                ).one()
                if current.cancellation_requested:
                    raise agent_runtime_service.AgentTurnCancelled("cancelled")
                if current.lease_token != lease_token or current.status != "running":
                    raise agent_runtime_service.AgentTurnLeaseLost("lease lost")

            def persist_event(event_type, message, payload) -> None:
                agent_runtime_service.append_event(
                    db,
                    turn=claimed_turn,
                    event_type=event_type,
                    phase="researching",
                    message=message,
                    payload=payload,
                    lease_token=lease_token,
                )

            executor = AgentToolExecutor(
                turn_id=claimed_turn.id,
                boundary_check=boundary,
                event_callback=persist_event,
            )
            executor.register(AgentTool(
                name="video.persisted",
                description="持久事件测试",
                handler=lambda _arguments: {"items": [1, 2]},
            ))
            executor.execute("video.persisted", {"transcript": "不应落库"})
            event_types = [
                item.event_type
                for item in agent_runtime_service.list_events(
                    db, turn=claimed_turn
                )
            ]
            self.assertIn("turn.tool.started", event_types)
            self.assertIn("turn.tool.completed", event_types)
            persisted_payload = "".join(
                item.payload_json
                for item in agent_runtime_service.list_events(
                    db, turn=claimed_turn
                )
                if item.event_type.startswith("turn.tool.")
            )
            self.assertNotIn("不应落库", persisted_payload)

            agent_runtime_service.request_cancel(db, claimed_turn)
            with self.assertRaises(agent_runtime_service.AgentTurnCancelled):
                executor.execute("video.persisted", {"page": 2})

        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="tool-stale")
            claimed_turn, lease_token = agent_runtime_service.claim_turn(db, turn.id)

            def stale_boundary() -> None:
                db.expire_all()
                current = db.query(AgentTurn).filter(
                    AgentTurn.id == claimed_turn.id
                ).one()
                if current.lease_token != lease_token:
                    raise agent_runtime_service.AgentTurnLeaseLost("lease lost")

            def transfer_lease(_arguments):
                current = db.query(AgentTurn).filter(
                    AgentTurn.id == claimed_turn.id
                ).one()
                current.lease_token = "replacement-token"
                db.commit()
                return {"stale": True}

            executor = AgentToolExecutor(
                turn_id=claimed_turn.id,
                boundary_check=stale_boundary,
            )
            executor.register(AgentTool(
                name="video.stale",
                description="租约转移测试",
                handler=transfer_lease,
            ))
            with self.assertRaises(agent_runtime_service.AgentTurnLeaseLost):
                executor.execute("video.stale")

    def test_answer_deltas_are_coalesced_persisted_and_replayable(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="answer-events")
            claimed = agent_runtime_service.claim_turn(db, turn.id)
            self.assertIsNotNone(claimed)
            claimed_turn, lease_token = claimed
            writer = agent_runtime_worker._DurableAnswerWriter(
                db, claimed_turn, lease_token
            )

            visible_answer = "首段连续正文" * 30 + "后" * 420
            writer(visible_answer)
            writer.flush()

            events = agent_runtime_service.list_events(db, turn=claimed_turn)
            answer_events = [
                event for event in events
                if event.event_type.startswith("turn.answer.")
            ]
            self.assertEqual(answer_events[0].event_type, "turn.answer.started")
            delta_events = [
                event for event in answer_events
                if event.event_type == "turn.answer.delta"
            ]
            self.assertGreaterEqual(len(delta_events), 3)
            self.assertEqual(
                "".join(str(event.payload.get("delta") or "") for event in delta_events),
                visible_answer,
            )
            self.assertTrue(all(
                len(str(event.payload.get("delta") or "")) <= 96
                for event in delta_events
            ))
            self.assertLessEqual(
                len(str(delta_events[0].payload.get("delta") or "")),
                96,
            )
            self.assertLessEqual(len(delta_events), 20)
            expected_offset = 0
            for event in delta_events:
                delta = str(event.payload.get("delta") or "")
                self.assertEqual(event.payload.get("start_offset"), expected_offset)
                expected_offset += len(delta)
                self.assertEqual(event.payload.get("end_offset"), expected_offset)
            projected = _project_durable_event(claimed_turn, delta_events[0])
            self.assertEqual(projected["type"], "delta")
            self.assertEqual(projected["event_seq"], delta_events[0].seq)
            replay = agent_runtime_service.list_events(
                db,
                turn=claimed_turn,
                after_seq=delta_events[0].seq,
            )
            self.assertTrue(all(event.seq > delta_events[0].seq for event in replay))

            persisted = db.query(AgentTurn).filter(
                AgentTurn.id == claimed_turn.id
            ).one()
            persisted.lease_token = "replacement-token"
            db.commit()
            with self.assertRaises(agent_runtime_service.AgentTurnLeaseLost):
                writer("租约失效后不得继续输出")
                writer.flush()

    def test_answer_writer_flushes_sentence_boundary_and_short_final_tail(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="answer-natural-flush")
            claimed_turn, lease_token = agent_runtime_service.claim_turn(db, turn.id)
            writer = agent_runtime_worker._DurableAnswerWriter(
                db, claimed_turn, lease_token
            )

            writer("开头")
            writer("这是达到自然边界后应立即出现的完整句子。")
            writer("短尾")

            before_flush = [
                str(event.payload.get("delta") or "")
                for event in agent_runtime_service.list_events(db, turn=claimed_turn)
                if event.event_type == "turn.answer.delta"
            ]
            self.assertEqual(
                "".join(before_flush),
                "开头这是达到自然边界后应立即出现的完整句子。",
            )

            writer.flush()
            after_flush = [
                str(event.payload.get("delta") or "")
                for event in agent_runtime_service.list_events(db, turn=claimed_turn)
                if event.event_type == "turn.answer.delta"
            ]
            self.assertEqual("".join(after_flush), writer.visible_text)
            self.assertEqual(after_flush[-1], "短尾")

    def test_answer_delta_honors_running_turn_cancellation(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="answer-cancel")
            claimed_turn, lease_token = agent_runtime_service.claim_turn(db, turn.id)
            writer = agent_runtime_worker._DurableAnswerWriter(
                db, claimed_turn, lease_token
            )
            agent_runtime_service.request_cancel(db, claimed_turn)
            with self.assertRaises(agent_runtime_service.AgentTurnCancelled):
                writer("取消后不得继续输出")

    def test_queued_cancellation_does_not_retain_local_worker_signal(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="queued-cancel-signal")
            agent_runtime_service.cancellation_signal(turn.id)

            cancelled = agent_runtime_service.request_cancel(db, turn)

            self.assertEqual(cancelled.status, "cancelled")
            self.assertNotIn(turn.id, agent_runtime_service._CANCEL_SIGNALS)

    def test_answer_finish_streams_the_canonical_suffix_without_retracting_text(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="answer-finish")
            claimed_turn, lease_token = agent_runtime_service.claim_turn(db, turn.id)
            writer = agent_runtime_worker._DurableAnswerWriter(
                db, claimed_turn, lease_token
            )

            writer("稳定开头。")
            writer.finish("稳定开头。\n\n经过校验的完整正文。")

            events = agent_runtime_service.list_events(db, turn=claimed_turn)
            visible = "".join(
                str(event.payload.get("delta") or "")
                for event in events
                if event.event_type == "turn.answer.delta"
            )
            self.assertEqual(visible, "稳定开头。\n\n经过校验的完整正文。")

    def test_answer_finish_streams_complete_validated_markdown_from_empty_draft(self):
        with self.Session() as db:
            _, turn = self._new_turn(db, suffix="answer-canonical")
            claimed_turn, lease_token = agent_runtime_service.claim_turn(db, turn.id)
            writer = agent_runtime_worker._DurableAnswerWriter(
                db, claimed_turn, lease_token
            )
            canonical = (
                "总览正文。\n\n"
                "### 1. 天赋树提供基础升级\n\n"
                "这是经过校验的解释。\n\n"
                "**已核验证据：1 条视频（研究范围 1 条）**\n\n"
                "**已核验原文：**\n\n"
                "- 《测试视频》：\"50 个泥土可以升级。\"\n"
            ) * 12

            writer.finish(canonical)

            events = agent_runtime_service.list_events(db, turn=claimed_turn)
            delta_events = [
                event for event in events
                if event.event_type == "turn.answer.delta"
            ]
            self.assertGreater(len(delta_events), 3)
            self.assertEqual(
                "".join(str(event.payload.get("delta") or "") for event in delta_events),
                canonical,
            )
            self.assertTrue(all(
                later.seq > earlier.seq
                for earlier, later in zip(delta_events, delta_events[1:])
            ))
            self.assertTrue(all(
                len(str(event.payload.get("delta") or "")) <= 96
                for event in delta_events
            ))


if __name__ == "__main__":
    unittest.main()
