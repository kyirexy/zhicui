from __future__ import annotations

import json
import re
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import ai_juicer
from app.core.request_context import (
    get_current_user_id,
    reset_request_context,
    set_request_context,
)


class AgentResponseParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = {
            "answer": "两个视频讨论的主题不同，没有共同结论。",
            "evidence": [
                {
                    "note_id": "note-1",
                    "quote": "第一个视频讨论 AI 代码助手引发的学术诚信争议。",
                    "source": "transcript",
                }
            ],
            "web_source_ids": [],
            "grounded": True,
            "follow_up_questions": ["要分别总结两个视频吗？"],
        }
        self.raw_json = json.dumps(self.payload, ensure_ascii=False, indent=2)

    def test_parses_screenshot_shape_inside_fence_and_commentary(self) -> None:
        raw = f"下面是结构化结果：\n```json\n{self.raw_json}\n```\n处理完成。"

        parsed = ai_juicer._parse_agent_response_payload(raw)

        self.assertEqual(parsed["answer"], self.payload["answer"])
        self.assertEqual(parsed["evidence"], self.payload["evidence"])
        self.assertEqual(
            parsed["follow_up_questions"],
            self.payload["follow_up_questions"],
        )
        self.assertIs(parsed["grounded"], True)
        self.assertEqual(parsed["web_source_ids"], [])

    def test_parses_double_encoded_payload(self) -> None:
        raw = json.dumps(self.raw_json, ensure_ascii=False)

        parsed = ai_juicer._parse_agent_response_payload(raw)

        self.assertEqual(parsed, self.payload)

    def test_parses_valid_object_with_prefix_and_suffix(self) -> None:
        raw = f"模型结果如下：\n{self.raw_json}\n以上。"

        parsed = ai_juicer._parse_agent_response_payload(raw)

        self.assertEqual(parsed, self.payload)

    def test_recovers_fields_from_truncated_object(self) -> None:
        raw = (
            '{"answer":"核心回答","evidence":[],"web_source_ids":[],'
            '"grounded":false,"follow_up_questions":["继续追问"]'
        )

        parsed = ai_juicer._parse_agent_response_payload(raw)

        self.assertEqual(parsed["answer"], "核心回答")
        self.assertEqual(parsed["evidence"], [])
        self.assertEqual(parsed["web_source_ids"], [])
        self.assertIs(parsed["grounded"], False)
        self.assertEqual(parsed["follow_up_questions"], ["继续追问"])

    def test_never_stringifies_nested_contract_as_answer(self) -> None:
        parsed = ai_juicer._parse_agent_response_payload(
            '{"answer":{"internal":"not user text"},"evidence":[]}'
        )

        answer = ai_juicer._agent_answer_text(parsed, "安全回退回答")

        self.assertEqual(answer, "安全回退回答")
        self.assertNotIn("internal", answer)

    def test_structured_but_unrecoverable_output_is_not_exposed(self) -> None:
        raw = '```json\n{"answer": [invalid internal contract]\n```'

        parsed = ai_juicer._parse_agent_response_payload(raw)

        self.assertEqual(parsed, {})


class LibraryAnswerContractTests(unittest.TestCase):
    def test_library_answer_separates_json_contract_fields(self) -> None:
        quote = "第一个视频讨论 AI 代码助手引发的学术诚信争议。"
        planner = json.dumps(
            {
                "search_queries": ["AI 代码助手 学术诚信"],
                "subquestions": [],
                "coverage": "broad",
                "answer_plan": "先回答，再说明差异。",
            },
            ensure_ascii=False,
        )
        synthesis = {
            "answer": "两个视频主题不同，因此没有反复出现的共同观点。",
            "evidence": [
                {
                    "note_id": "note-1",
                    "quote": quote,
                    "source": "transcript",
                }
            ],
            "web_source_ids": [],
            # 服务端必须根据校验后的依据推导可信状态，不能直接相信模型。
            "grounded": False,
            "follow_up_questions": ["分别总结两个视频的重点吗？"],
        }
        wrapped_synthesis = (
            "结构化回答：\n```json\n"
            + json.dumps(synthesis, ensure_ascii=False, indent=2)
            + "\n```"
        )

        with patch.object(
            ai_juicer,
            "_call_llm",
            side_effect=[planner, wrapped_synthesis],
        ):
            result = ai_juicer.answer_library_question(
                sources=[
                    {
                        "note_id": "note-1",
                        "title": "AI 代码助手争议",
                        "transcript": quote + " 视频还解释了争议产生的背景。",
                        "ai_summary": None,
                    },
                    {
                        "note_id": "note-2",
                        "title": "肩部训练教程",
                        "transcript": "第二个视频介绍肩部训练动作与注意事项。",
                        "ai_summary": None,
                    },
                ],
                question="这些视频反复出现的核心观点是什么？",
                research_mode="deep",
                web_scope="video_only",
            )

        self.assertEqual(result["answer"], synthesis["answer"])
        self.assertNotIn('"evidence"', result["answer"])
        self.assertEqual(len(result["evidence"]), 1)
        self.assertEqual(result["evidence"][0]["note_id"], "note-1")
        self.assertEqual(
            result["follow_up_questions"],
            synthesis["follow_up_questions"],
        )
        self.assertIs(result["grounded"], True)
        self.assertEqual(result["web_source_ids"], [])
        self.assertEqual(result["web_sources"], [])


class AgentPipelineBoundaryTests(unittest.TestCase):
    def test_single_video_full_transcript_request_returns_verbatim_without_llm(self) -> None:
        transcript = "第一段逐字原文。\n第二段逐字原文，标点和换行都要保留。"
        progress: list[dict] = []

        with (
            patch.object(ai_juicer, "_call_llm") as llm,
            patch.object(ai_juicer, "_call_llm_stream") as llm_stream,
        ):
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-full",
                    "title": "完整文案测试",
                    "transcript": transcript,
                    "ai_summary": None,
                }],
                question="完整的文案是什么？",
                research_mode="fast",
                web_scope="video_only",
                progress_callback=progress.append,
            )

        llm.assert_not_called()
        llm_stream.assert_not_called()
        self.assertTrue(result["answer"].endswith(transcript))
        self.assertEqual(result["source_context"]["transcript_chars"], len(transcript))
        self.assertEqual(result["source_context"]["research_mode"], "direct")
        self.assertEqual(result["citation_coverage"]["verified"], 1)
        self.assertEqual(progress[-1]["stage"], "finalizing")

    def test_single_video_broad_summary_repairs_rejected_claims_once(self) -> None:
        quotes = [
            "持续学习是通向超级智能的下一个台阶。",
            "个人偏好应该保存在上下文记忆中。",
            "具体事实应该交给工具层来处理。",
        ]
        transcript = "".join(quotes)
        rejected = json.dumps({
            "answer": "这是一段过短的总览。",
            "claims": [{
                "claim_id": f"C{index}",
                "kind": "recurring",
                "text": f"无效观点 {index}",
                "explanation": "把单一视频错误地当成跨视频共识。",
                "evidence": [{
                    "note_id": "note-one",
                    "quote": f"不存在的改写 {index}",
                    "source": "transcript",
                }],
            } for index in range(1, 4)],
            "evidence": [],
            "web_source_ids": [],
            "follow_up_questions": [],
        }, ensure_ascii=False)
        repaired = json.dumps({
            "answer": "视频从能力、记忆和工具三个层面解释持续学习。",
            "claims": [{
                "claim_id": f"C{index}",
                "kind": "fact",
                "text": f"核心观点 {index}",
                "explanation": f"这是第 {index} 个经过逐字依据支持的具体观点。",
                "evidence": [{
                    "note_id": "note-one",
                    "quote": quote,
                    "source": "transcript",
                }],
            } for index, quote in enumerate(quotes, start=1)],
            "evidence": [],
            "web_source_ids": [],
            "follow_up_questions": [],
        }, ensure_ascii=False)

        with patch.object(
            ai_juicer,
            "_call_llm",
            side_effect=[rejected, repaired],
        ) as llm:
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-one",
                    "title": "持续学习",
                    "transcript": transcript,
                    "ai_summary": None,
                }],
                question="这些视频反复出现的核心观点是什么？",
                research_mode="fast",
                web_scope="video_only",
            )

        self.assertEqual(llm.call_count, 2)
        self.assertEqual(len(result["claims"]), 3)
        self.assertEqual(len(result["evidence"]), 3)
        self.assertIn("### 3. 核心观点 3", result["answer"])
        self.assertIn("本轮只有 1 条视频", llm.call_args_list[0].kwargs["user"])

    def test_fast_independent_answer_skips_model_research_planner(self) -> None:
        answer = "快速模式直接使用本地检索计划组织回答。"
        synthesis = json.dumps(
            {
                "answer": answer,
                "evidence": [],
                "web_source_ids": [],
                "grounded": False,
                "follow_up_questions": [],
            },
            ensure_ascii=False,
        )

        with patch.object(ai_juicer, "_call_llm", return_value=synthesis) as llm:
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-fast",
                    "title": "快速回答测试",
                    "transcript": "这是一段用于本地检索的完整视频文稿。",
                    "ai_summary": None,
                }],
                question="这段视频主要说了什么？",
                history=[
                    {"role": "user", "content": "先说说持续学习是什么。"},
                    {"role": "assistant", "content": "持续学习用于不断吸收新经验。"},
                ],
                research_mode="fast",
                output_style="answer",
                custom_instruction="",
                web_scope="video_only",
            )

        self.assertEqual(result["answer"], answer)
        self.assertEqual(llm.call_count, 1)
        self.assertEqual(llm.call_args.kwargs["operation"], "library_qa")

    def test_explicit_follow_up_still_requests_history_refinement(self) -> None:
        self.assertFalse(
            ai_juicer._question_needs_history_refinement(
                "用两点简要总结这个视频的核心观点。"
            )
        )
        self.assertTrue(
            ai_juicer._question_needs_history_refinement(
                "继续展开你刚才的结论。"
            )
        )

    def test_exact_enumeration_does_not_require_cross_source_claims(self) -> None:
        self.assertFalse(
            ai_juicer._question_requires_cross_source_claims(
                "请完整列出25个机制元，并分别说明作用。"
            )
        )
        self.assertTrue(
            ai_juicer._question_requires_cross_source_claims(
                "这些视频反复出现的核心观点是什么？"
            )
        )

    def test_streaming_answer_emits_one_delta_per_provider_chunk(self) -> None:
        provider_chunks = [
            '{"answer":"第一',
            '段\\n第二',
            '段","evidence":[],"web_source_ids":[],"grounded":false,'
            '"follow_up_questions":[]}',
        ]
        streamed: list[str] = []

        def fake_stream(**kwargs):
            for chunk in provider_chunks:
                kwargs["on_token"](chunk)
            return "".join(provider_chunks)

        with patch.object(ai_juicer, "_call_llm_stream", side_effect=fake_stream):
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-stream",
                    "title": "流式回答测试",
                    "transcript": "第一段和第二段都来自同一条视频文稿。",
                    "ai_summary": None,
                }],
                question="请分两段回答",
                research_mode="fast",
                web_scope="video_only",
                answer_delta=streamed.append,
            )

        self.assertEqual(streamed, ["第一", "段\n第二", "段"])
        self.assertEqual("".join(streamed), result["answer"])

    def test_durable_stream_holds_raw_draft_until_canonical_validation(self) -> None:
        provider_chunks = [
            '{"answer":"总览正文。","evidence":[],',
            '"web_source_ids":[],"grounded":false,',
            '"follow_up_questions":[]}',
        ]
        streamed: list[str] = []

        def fake_stream(**kwargs):
            for chunk in provider_chunks:
                kwargs["on_token"](chunk)
            return "".join(provider_chunks)

        with patch.object(ai_juicer, "_call_llm_stream", side_effect=fake_stream):
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-validated-stream",
                    "title": "完整流测试",
                    "transcript": "这是一条足够支持总览正文的视频文稿。",
                    "ai_summary": None,
                }],
                question="请总结正文",
                research_mode="fast",
                web_scope="video_only",
                answer_delta=streamed.append,
                validated_stream_only=True,
            )

        self.assertEqual(streamed, [])
        self.assertTrue(str(result["answer"]).strip())

    def test_streamed_single_source_answer_does_not_block_on_claim_repair(self) -> None:
        plan = {
            "search_queries": ["升级路线"],
            "subquestions": [],
            "coverage": "broad",
            "answer_plan": "完整说明升级路线",
            "refined_question": "请完整说明升级路线",
            "planner_mode": "test",
        }
        payload = json.dumps({
            "answer": "这是已经随模型实时流出的完整叙述，不应为了补足观点数量再次重写。",
            "claims": [],
            "evidence": [],
            "web_source_ids": [],
            "grounded": False,
            "follow_up_questions": [],
        }, ensure_ascii=False)
        streamed: list[str] = []

        def fake_synthesis(_kwargs, answer_delta):
            self.assertIsNotNone(answer_delta)
            self.assertIn(
                "claims 和 evidence 必须返回空数组",
                str(_kwargs.get("user") or ""),
            )
            answer_delta("这是已经随模型实时流出的完整叙述，")
            answer_delta("不应为了补足观点数量再次重写。")
            return payload

        with (
            patch.object(ai_juicer, "_library_research_plan", return_value=plan),
            patch.object(ai_juicer, "_run_library_synthesis", side_effect=fake_synthesis),
            patch.object(ai_juicer, "_call_llm") as repair_call,
        ):
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-stream-no-repair",
                    "title": "单视频流式测试",
                    "transcript": "视频完整说明了从工具到工人的升级路线。",
                    "ai_summary": None,
                }],
                question="请完整说明升级路线",
                research_mode="fast",
                output_style="answer",
                web_scope="video_only",
                answer_delta=streamed.append,
            )

        repair_call.assert_not_called()
        self.assertEqual("".join(streamed), result["answer"])
        self.assertTrue(result["grounded"])
        self.assertGreaterEqual(len(result["evidence"]), 1)
        self.assertEqual(
            result["source_context"]["evidence_mode"],
            "server_selected",
        )

    def test_streamed_answer_survives_an_unclosed_provider_json_tail(self) -> None:
        plan = {
            "search_queries": ["通关策略"],
            "subquestions": [],
            "coverage": "focused",
            "answer_plan": "说明通关策略",
            "refined_question": "请说明通关策略",
            "planner_mode": "test",
        }
        visible_answer = "这是已经完整显示给用户的通关策略，终态不得把它替换成资料不足。"
        streamed: list[str] = []

        def fake_synthesis(_kwargs, answer_delta):
            self.assertIsNotNone(answer_delta)
            answer_delta(visible_answer)
            return '{"answer":"这是一个没有闭合的 JSON 尾部'

        with (
            patch.object(ai_juicer, "_library_research_plan", return_value=plan),
            patch.object(ai_juicer, "_run_library_synthesis", side_effect=fake_synthesis),
        ):
            result = ai_juicer.answer_library_question(
                sources=[{
                    "note_id": "note-stream-prefix",
                    "title": "终态前缀测试",
                    "transcript": "这段视频文稿逐步说明了完整通关策略与升级原因。",
                    "ai_summary": None,
                }],
                question="请说明通关策略",
                research_mode="fast",
                output_style="answer",
                web_scope="video_only",
                answer_delta=streamed.append,
            )

        self.assertEqual("".join(streamed), visible_answer)
        self.assertEqual(result["answer"], visible_answer)

    def test_streaming_projection_waits_for_claim_validation(self) -> None:
        payload = {
            "answer": "先给出总览。",
            "claims": [
                {
                    "claim_id": "C1",
                    "kind": "fact",
                    "text": "机制元分为五类",
                    "explanation": "每一类都描述一种可组合的基础操作。",
                    "evidence": [{
                        "note_id": "note-secret-1",
                        "quote": "不应进入流式正文的逐字证据",
                    }],
                },
                {
                    "claim_id": "C2",
                    "kind": "action",
                    "text": "组合会形成复杂玩法",
                    "explanation": "例如位移与修改组合后形成“移动”机制。",
                    "evidence": [{
                        "note_id": "note-secret-2",
                        "quote": "另一条不应展示的证据",
                    }],
                },
            ],
            "follow_up_questions": [],
        }
        raw_payload = json.dumps(payload, ensure_ascii=True)
        provider_chunks = [
            raw_payload[:19],
            raw_payload[19:47],
            raw_payload[47:103],
            raw_payload[103:181],
            raw_payload[181:267],
            raw_payload[267:],
        ]
        streamed: list[str] = []

        def fake_stream(**kwargs):
            for chunk in provider_chunks:
                kwargs["on_token"](chunk)
            return raw_payload

        with patch.object(ai_juicer, "_call_llm_stream", side_effect=fake_stream):
            returned = ai_juicer._run_library_synthesis(
                {
                    "system": "system",
                    "user": "question",
                    "operation": "boundary_test",
                },
                streamed.append,
            )

        visible = "".join(streamed)
        self.assertEqual(returned, raw_payload)
        self.assertEqual(visible, "先给出总览。")
        self.assertNotIn("note-secret", visible)
        self.assertNotIn("逐字证据", visible)
        self.assertNotIn("follow_up_questions", visible)

    def test_streaming_projection_never_emits_an_empty_claim_heading(self) -> None:
        provider_chunks = [
            '{"answer":"总览","claims":[{"claim_id":"C1","text":"',
            '核心观点',
            '","explanation":"',
            '具体解释',
            '","evidence":[]}],"follow_up_questions":[]}',
        ]
        streamed: list[str] = []

        def fake_stream(**kwargs):
            for chunk in provider_chunks:
                kwargs["on_token"](chunk)
            return "".join(provider_chunks)

        with patch.object(ai_juicer, "_call_llm_stream", side_effect=fake_stream):
            ai_juicer._run_library_synthesis(
                {
                    "system": "system",
                    "user": "question",
                    "operation": "empty_heading_boundary_test",
                },
                streamed.append,
            )

        self.assertEqual("".join(streamed), "总览")

    def test_answer_field_end_flushes_tail_before_private_claims_finish(self) -> None:
        class AnswerRecorder:
            def __init__(self) -> None:
                self.parts: list[str] = []
                self.flush_snapshots: list[str] = []
                self.active_checks = 0

            def __call__(self, delta: str) -> None:
                self.parts.append(delta)

            def flush(self) -> None:
                self.flush_snapshots.append("".join(self.parts))

            def check_active(self) -> None:
                self.active_checks += 1

        recorder = AnswerRecorder()
        provider_chunks = [
            '{"answer":"最后一小段',
            '也必须立即出现。","claims":[{"claim_id":"C1",',
            '"text":"私有候选","explanation":"待校验","evidence":[]}]}',
        ]

        def fake_stream(**kwargs):
            for chunk in provider_chunks:
                kwargs["on_token"](chunk)
            return "".join(provider_chunks)

        with patch.object(ai_juicer, "_call_llm_stream", side_effect=fake_stream):
            ai_juicer._run_library_synthesis(
                {
                    "system": "system",
                    "user": "question",
                    "operation": "answer_end_flush_test",
                },
                recorder,
            )

        self.assertEqual(
            recorder.flush_snapshots[0],
            "最后一小段也必须立即出现。",
        )
        self.assertGreaterEqual(recorder.active_checks, len(provider_chunks))

    def test_stream_callback_cancellation_closes_provider_iterator(self) -> None:
        class FakeStream:
            def __init__(self) -> None:
                self.emitted = False
                self.closed = False

            def __iter__(self):
                return self

            def __next__(self):
                if self.emitted:
                    raise StopIteration
                self.emitted = True
                return SimpleNamespace(
                    usage=None,
                    choices=[SimpleNamespace(
                        delta=SimpleNamespace(content="第一个增量")
                    )],
                )

            def close(self) -> None:
                self.closed = True

        stream = FakeStream()
        llm_config = {
            "provider": "custom",
            "model": "test-model",
            "runtime_model": "openai/test-model",
            "api_base": "",
            "api_key": "",
        }

        def cancel_on_token(_delta: str) -> None:
            raise ai_juicer.agent_runtime_service.AgentTurnCancelled("已停止")

        with (
            patch.object(ai_juicer, "_get_llm_config", return_value=llm_config),
            patch.object(ai_juicer, "completion", return_value=stream),
        ):
            with self.assertRaises(
                ai_juicer.agent_runtime_service.AgentTurnCancelled
            ):
                ai_juicer._call_llm_stream(
                    "system",
                    "question",
                    on_token=cancel_on_token,
                    operation="cancel_close_test",
                )

        self.assertTrue(stream.closed)

    def test_cross_source_answer_waits_for_validation_before_streaming(self) -> None:
        sources = [
            {
                "note_id": f"note-{index}",
                "title": f"第 {index} 条视频",
                "transcript": f"第 {index} 条视频围绕同一个主题提供了一段可检索文稿。",
                "ai_summary": None,
            }
            for index in range(1, 7)
        ]
        plan = {
            "search_queries": ["共同主题"],
            "subquestions": [],
            "coverage": "broad",
            "answer_plan": "归纳跨视频共同观点",
            "refined_question": "这些视频反复出现的核心观点是什么？",
            "planner_mode": "test",
        }
        synthesis = json.dumps({
            "answer": "这是一段尚未完成引用校验的模型草稿。",
            "claims": [],
            "follow_up_questions": [],
        }, ensure_ascii=False)
        streamed: list[str] = []

        with (
            patch.object(ai_juicer, "_library_research_plan", return_value=plan),
            patch.object(
                ai_juicer,
                "_deep_library_map",
                return_value=([], 0, 0, {
                    "batch_count": 0,
                    "completed_batch_count": 0,
                    "failed_batch_count": 0,
                    "mapped_source_count": 6,
                    "failed_source_count": 0,
                    "budget_exhausted": False,
                }),
            ),
            patch.object(
                ai_juicer,
                "_plan_web_research",
                return_value={"needs_web": False, "queries": [], "reason": ""},
            ),
            patch.object(
                ai_juicer,
                "_run_library_synthesis",
                return_value=synthesis,
            ) as run_synthesis,
            patch.object(ai_juicer, "_call_llm", side_effect=RuntimeError("no repair")),
        ):
            ai_juicer.answer_library_question(
                sources=sources,
                question="这些视频反复出现的核心观点是什么？",
                research_mode="deep",
                web_scope="video_only",
                answer_delta=streamed.append,
            )

        self.assertIsNone(run_synthesis.call_args.args[1])
        self.assertEqual(streamed, [])

    def test_similar_game_question_requests_web_research(self) -> None:
        self.assertTrue(ai_juicer._question_requests_web("同类的游戏都有什么呢？"))
        self.assertTrue(ai_juicer._question_requests_web("还有哪些类似作品值得推荐？"))

    def test_starter_questions_are_generated_from_the_complete_transcript(self) -> None:
        transcript = (
            "玩家先用勺子挖土，然后升级铲子并雇佣蘑菇工人。"
            "解开颜色宝箱后获得兔耳朵，最终效率达到十五万泥土每秒。"
        )
        captured: dict = {}

        def fake_call(**kwargs):
            captured.update(kwargs)
            return json.dumps({
                "questions": [
                    "玩家如何从勺子逐步升级到更高效率的工具？",
                    "颜色宝箱和兔耳朵分别影响了哪些游戏机制？",
                    "达到十五万泥土每秒前，资源分配策略经历了哪些变化？",
                ],
            }, ensure_ascii=False)

        with patch.object(ai_juicer, "_call_llm", side_effect=fake_call):
            questions = ai_juicer.suggest_library_questions([{
                "note_id": "note-game",
                "title": "我挖到了一亿斤土",
                "transcript": transcript,
            }])

        self.assertEqual(len(questions), 3)
        self.assertIn(transcript, captured["user"])
        self.assertIn("颜色宝箱", questions[1])
        self.assertNotEqual(questions[0], "这些视频反复出现的核心观点是什么？")

    def test_starter_questions_use_a_source_specific_fallback(self) -> None:
        with (
            patch.object(ai_juicer, "_call_llm", side_effect=RuntimeError("offline")),
            patch.object(
                ai_juicer.error_log_service,
                "record_exception_safely",
                return_value=None,
            ),
        ):
            questions = ai_juicer.suggest_library_questions([{
                "note_id": "note-game",
                "title": "深渊挖土挑战",
                "transcript": "玩家升级道具、雇佣工人并最终通关游戏。",
            }])

        self.assertEqual(len(questions), 3)
        self.assertIn("深渊挖土挑战", questions[0])
        self.assertTrue(all(question.endswith("？") for question in questions))

    def test_reasoning_content_is_never_used_as_visible_output(self) -> None:
        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=None,
                        reasoning_content="PRIVATE MODEL REASONING",
                    )
                )
            ]
        )
        llm_config = {
            "provider": "deepseek",
            "model": "deepseek-chat",
            "api_base": "",
            "api_key": "",
        }

        with (
            patch.object(ai_juicer, "_get_llm_config", return_value=llm_config),
            patch.object(
                ai_juicer.settings_service,
                "to_litellm_model",
                return_value="deepseek/deepseek-chat",
            ),
            patch.object(
                ai_juicer,
                "_completion_with_usage",
                return_value=response,
            ),
        ):
            with self.assertRaises(RuntimeError) as raised:
                ai_juicer._call_llm(
                    system="system",
                    user="question",
                    operation="boundary_test",
                )

        self.assertNotIn("PRIVATE MODEL REASONING", str(raised.exception))

    def test_empty_visible_content_retries_once_and_returns_recovery(self) -> None:
        empty = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=None))]
        )
        recovered = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"answer":"OK"}'))]
        )
        llm_config = {
            "provider": "deepseek",
            "model": "deepseek-chat",
            "api_base": "",
            "api_key": "",
        }

        with (
            patch.object(ai_juicer, "_get_llm_config", return_value=llm_config),
            patch.object(
                ai_juicer.settings_service,
                "to_litellm_model",
                return_value="deepseek/deepseek-chat",
            ),
            patch.object(
                ai_juicer,
                "_completion_with_usage",
                side_effect=[empty, recovered],
            ) as completion_mock,
        ):
            result = ai_juicer._call_llm(
                system="system",
                user="question",
                operation="boundary_test",
            )

        self.assertEqual(result, '{"answer":"OK"}')
        self.assertEqual(completion_mock.call_count, 2)
        recovery_kwargs = completion_mock.call_args_list[1].args[1]
        self.assertGreaterEqual(recovery_kwargs["max_tokens"], 4096)

    def test_deep_map_drops_unknown_and_inexact_findings(self) -> None:
        exact_quote = "视频原文中可以逐字核对的观点。"
        supplied_sources = {
            "note-1": {
                "title": "来源一",
                "raw_transcript": exact_quote,
                "transcript_context": exact_quote,
                "summary_context": "",
            },
            "note-2": {
                "title": "来源二",
                "raw_transcript": "另一个视频的内容。",
                "transcript_context": "另一个视频的内容。",
                "summary_context": "",
            },
        }
        mapped = json.dumps(
            {
                "findings": [
                    {
                        "claim": "可核验发现",
                        "note_id": "note-1",
                        "quote": exact_quote,
                    },
                    {
                        "claim": "未知来源",
                        "note_id": "note-404",
                        "quote": exact_quote,
                    },
                    {
                        "claim": "改写而非逐字引用",
                        "note_id": "note-2",
                        "quote": "这是一条不存在于候选上下文中的改写。",
                    },
                ],
                "gaps": ["这段内部文本不应进入最终综合"],
            },
            ensure_ascii=False,
        )

        with patch.object(ai_juicer, "_call_llm", return_value=mapped):
            findings, map_calls, validated_count = ai_juicer._deep_library_map(
                ["note-1 block", "note-2 block"],
                supplied_sources,
                "共同观点是什么？",
                [],
            )

        self.assertEqual(map_calls, 1)
        self.assertEqual(validated_count, 1)
        self.assertEqual(len(findings), 1)
        payload = json.loads(findings[0])
        self.assertEqual(len(payload["findings"]), 1)
        self.assertEqual(payload["findings"][0]["note_id"], "note-1")
        self.assertEqual(payload["findings"][0]["quote"], exact_quote)
        self.assertNotIn("gaps", payload)
        self.assertNotIn("note-404", findings[0])

    def test_deep_map_runs_concurrently_keeps_order_and_reports_partial_failure(self) -> None:
        supplied_sources = {
            f"note-{index}": {
                "title": f"来源 {index}",
                "raw_transcript": f"逐字观点 {index}",
                "transcript_context": f"逐字观点 {index}",
                "summary_context": "",
            }
            for index in range(20)
        }
        source_blocks = [
            f"note_id：note-{index}\n文稿片段：逐字观点 {index}"
            for index in range(20)
        ]
        active = 0
        maximum_active = 0
        lock = threading.Lock()
        observed_users: list[str | None] = []
        progress: list[dict] = []

        def fake_map_call(**kwargs):
            nonlocal active, maximum_active
            user = str(kwargs.get("user") or "")
            note_ids = re.findall(r"note_id：(note-\d+)", user)
            first_index = int(note_ids[0].split("-")[1])
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
                observed_users.append(get_current_user_id())
            try:
                time.sleep(0.04 if first_index == 0 else 0.01)
                if first_index == 10:
                    raise RuntimeError("provider batch failed")
                return json.dumps({
                    "findings": [{
                        "claim": f"发现 {first_index}",
                        "note_id": note_ids[0],
                        "quote": f"逐字观点 {first_index}",
                    }],
                }, ensure_ascii=False)
            finally:
                with lock:
                    active -= 1

        tokens = set_request_context("concurrent-user", "/test/map")
        try:
            with patch.object(ai_juicer, "_call_llm", side_effect=fake_map_call):
                findings, map_calls, validated_count, stats = (
                    ai_juicer._deep_library_map(
                        source_blocks,
                        supplied_sources,
                        "共同观点？",
                        [],
                        progress.append,
                        return_stats=True,
                    )
                )
        finally:
            reset_request_context(tokens)

        self.assertGreaterEqual(maximum_active, 2)
        self.assertEqual(set(observed_users), {"concurrent-user"})
        self.assertEqual(map_calls, 4)
        self.assertEqual(validated_count, 3)
        self.assertEqual(stats["completed_batch_count"], 3)
        self.assertEqual(stats["failed_batch_count"], 1)
        self.assertEqual(stats["mapped_source_count"], 15)
        self.assertEqual(stats["failed_source_count"], 5)
        ordered_note_ids = [
            json.loads(item)["findings"][0]["note_id"]
            for item in findings
        ]
        self.assertEqual(ordered_note_ids, ["note-0", "note-5", "note-15"])
        event_types = [item.get("event_type") for item in progress]
        self.assertEqual(event_types.count("turn.map.batch.started"), 4)
        self.assertEqual(event_types.count("turn.map.batch.completed"), 3)
        self.assertEqual(event_types.count("turn.map.batch.failed"), 1)

    def test_deep_reduce_context_is_bounded(self) -> None:
        items = [str(index) * 5_000 for index in range(30)]
        selected = ai_juicer._bounded_synthesis_items(
            items,
            max_items=12,
            max_chars=18_000,
            per_item_chars=3_000,
        )
        self.assertLessEqual(len(selected), 12)
        self.assertLessEqual(sum(len(item) for item in selected), 18_000)
        self.assertTrue(all(len(item) <= 3_000 for item in selected))

    def test_invalid_citation_downgrades_grounding_and_trace_is_public(self) -> None:
        quote = "这是能够在候选文稿中逐字匹配的依据。"
        internal_plan = "内部回答规划不得出现在公开处理阶段"
        planner = json.dumps(
            {
                "search_queries": ["候选文稿 依据"],
                "subquestions": ["依据是否一致"],
                "coverage": "focused",
                "answer_plan": internal_plan,
            },
            ensure_ascii=False,
        )
        synthesis = json.dumps(
            {
                "answer": "回答保留，但无效引用会被移除。",
                "evidence": [
                    {
                        "note_id": "note-1",
                        "quote": quote,
                        "source": "transcript",
                    },
                    {
                        "note_id": "note-404",
                        "quote": "不存在的引用",
                        "source": "transcript",
                    },
                ],
                "web_source_ids": [],
                "grounded": True,
                "follow_up_questions": [],
            },
            ensure_ascii=False,
        )

        with patch.object(
            ai_juicer,
            "_call_llm",
            side_effect=[planner, synthesis],
        ):
            result = ai_juicer.answer_library_question(
                sources=[
                    {
                        "note_id": "note-1",
                        "title": "测试视频",
                        "transcript": quote,
                        "ai_summary": None,
                    }
                ],
                question="依据是什么？",
                research_mode="deep",
                web_scope="video_only",
            )

        self.assertIs(result["grounded"], True)
        self.assertEqual(result["grounding_status"], "partially_grounded")
        self.assertEqual(
            result["citation_coverage"],
            {
                "requested": 2,
                "matched": 1,
                "verified": 1,
                "ratio": 0.5,
            },
        )
        self.assertTrue(
            any("已移除 1 条" in item for item in result["limitations"])
        )
        trace = result["source_context"]["agent_trace"]
        self.assertEqual(
            [stage["stage"] for stage in trace],
            ["planning", "scan", "rank", "web", "synthesize", "verify"],
        )
        self.assertTrue(all("status" in stage for stage in trace))
        self.assertTrue(all("duration_ms" in stage for stage in trace))
        self.assertTrue(all("counts" in stage for stage in trace))
        public_trace = json.dumps(trace, ensure_ascii=False)
        self.assertNotIn(internal_plan, public_trace)
        web_stage = next(stage for stage in trace if stage["stage"] == "web")
        self.assertEqual(web_stage["status"], "skipped")
        self.assertIs(web_stage["counts"]["attempted"], False)
        self.assertIs(web_stage["counts"]["succeeded"], False)

    def test_web_failure_is_reported_without_discarding_video_answer(self) -> None:
        quote = "视频本身仍然提供了可核验的基础结论。"
        planner = json.dumps(
            {
                "search_queries": ["基础结论"],
                "subquestions": [],
                "coverage": "focused",
                "answer_plan": "先回答视频内容，再区分外部信息。",
            },
            ensure_ascii=False,
        )
        web_planner = json.dumps(
            {
                "needs_web": True,
                "queries": ["测试项目 最新链接"],
                "reason": "内部联网理由不得公开",
            },
            ensure_ascii=False,
        )
        synthesis = json.dumps(
            {
                "answer": "视频支持这项基础结论；外部信息暂时无法核验。",
                "evidence": [
                    {
                        "note_id": "note-1",
                        "quote": quote,
                        "source": "transcript",
                    }
                ],
                "web_source_ids": [],
                "grounded": True,
                "follow_up_questions": [],
            },
            ensure_ascii=False,
        )

        with (
            patch.object(
                ai_juicer,
                "_call_llm",
                side_effect=[planner, web_planner, synthesis],
            ),
            patch.object(
                ai_juicer.web_research,
                "research_web",
                side_effect=RuntimeError("network unavailable"),
            ),
            patch.object(
                ai_juicer.error_log_service,
                "record_exception_safely",
                return_value=None,
            ),
        ):
            result = ai_juicer.answer_library_question(
                sources=[
                    {
                        "note_id": "note-1",
                        "title": "测试项目",
                        "transcript": quote,
                        "ai_summary": None,
                    }
                ],
                question="这个项目现在最新链接是什么？",
                research_mode="deep",
                web_scope="auto",
            )

        context = result["source_context"]
        self.assertIs(context["web_search_attempted"], True)
        self.assertIs(context["web_search_succeeded"], False)
        self.assertEqual(context["web_verified_source_count"], 0)
        self.assertTrue(
            any("外部搜索暂时不可用" in item for item in result["limitations"])
        )
        web_stage = next(
            stage for stage in context["agent_trace"]
            if stage["stage"] == "web"
        )
        self.assertEqual(web_stage["status"], "failed")
        self.assertIs(web_stage["counts"]["attempted"], True)
        self.assertIs(web_stage["counts"]["succeeded"], False)
        self.assertEqual(web_stage["counts"]["verified_source_count"], 0)
        public_trace = json.dumps(context["agent_trace"], ensure_ascii=False)
        self.assertNotIn("内部联网理由", public_trace)
        self.assertNotIn("测试项目 最新链接", public_trace)

    def test_full_snapshot_scan_is_bounded_but_complete(self) -> None:
        sources = [
            {
                "note_id": f"note-{index:03d}",
                "title": f"视频 {index}",
                "transcript": f"第 {index} 条视频讨论共同主题与独立细节。",
                "ai_summary": None,
            }
            for index in range(105)
        ]

        blocks, supplied, context = ai_juicer._build_library_research_context(
            sources,
            ["共同主题"],
            coverage="broad",
            research_mode="fast",
        )

        self.assertEqual(context["note_count"], 100)
        self.assertEqual(len(context["researched_note_ids"]), 100)
        self.assertLessEqual(len(blocks), 18)
        self.assertLessEqual(len(supplied), 18)
        self.assertGreater(context["scanned_chunks"], 0)
        self.assertIsInstance(context["scan_duration_ms"], int)
        self.assertIsInstance(context["rank_duration_ms"], int)


if __name__ == "__main__":
    unittest.main()
