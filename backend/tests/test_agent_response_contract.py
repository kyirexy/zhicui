from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import ai_juicer


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
