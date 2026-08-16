from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_service, agent_video_analysis_service, ai_juicer


class AgentVisualEvidenceTests(unittest.TestCase):
    def test_visual_quote_uses_persisted_server_timestamp(self) -> None:
        summary = {
            "conclusion": "普通摘要",
            "detailed_video_analysis": {
                "scenes": [
                    {
                        "timestamp_ms": 83_000,
                        "observation": "演示者将红色按钮向右旋转。",
                        "visible_text": ["LOCK", "OPEN"],
                    }
                ]
            },
        }
        observations = ai_juicer._note_visual_evidence(summary)
        supplied = {
            "note-1": {
                "title": "开关演示",
                "raw_transcript": "这里介绍开关的使用方法。",
                "transcript_context": "这里介绍开关的使用方法。",
                "summary_context": "普通摘要",
                "visual_context": ai_juicer._visual_context_text(observations),
                "visual_evidence": observations,
            }
        }

        evidence = ai_juicer._validated_library_evidence(
            [
                {
                    "note_id": "note-1",
                    "quote": "演示者将红色按钮向右旋转。",
                    "source": "visual",
                    # A model cannot replace the persisted timestamp.
                    "timestamp_ms": 1,
                }
            ],
            supplied,
        )

        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["source"], "visual")
        self.assertEqual(evidence[0]["timestamp_ms"], 83_000)

    def test_visual_context_is_separate_and_marked_as_ai_observation(self) -> None:
        summary = json.dumps(
            {
                "sections": [{"title": "摘要", "content": "来自文稿"}],
                "detailed_video_analysis": {
                    "scenes": [
                        {
                            "timestamp_ms": 5_000,
                            "description": "画面中出现一张折线图。",
                        }
                    ]
                },
            },
            ensure_ascii=False,
        )

        blocks, supplied, context = ai_juicer._build_library_research_context(
            [
                {
                    "note_id": "note-1",
                    "title": "图表讲解",
                    "transcript": "这段文稿解释增长趋势。",
                    "ai_summary": summary,
                }
            ],
            ["折线图"],
            coverage="focused",
            research_mode="fast",
        )

        self.assertEqual(context["visual_source_count"], 1)
        self.assertIn("AI 画面观察", blocks[0])
        self.assertIn("画面中出现一张折线图。", supplied["note-1"]["visual_context"])

    def test_visible_visual_section_does_not_downgrade_evidence_to_summary(self) -> None:
        quote = "画面中出现一张折线图。"
        summary = {
            "sections": [
                {"title": "普通摘要", "content": "来自文稿"},
                {
                    "title": "画面补充",
                    "content": f"00:05 · {quote}",
                    "source": "detailed_video_analysis",
                },
            ],
            "detailed_video_analysis": {
                "visual_observations": [
                    {"timestamp_ms": 5_000, "summary": quote}
                ]
            },
        }
        observations = ai_juicer._note_visual_evidence(summary)
        summary_context = ai_juicer._note_ai_summary_context(summary)
        supplied = {
            "note-1": {
                "title": "图表讲解",
                "raw_transcript": "文稿没有描述这张图。",
                "transcript_context": "文稿没有描述这张图。",
                "summary_context": summary_context,
                "visual_context": ai_juicer._visual_context_text(observations),
                "visual_evidence": observations,
            }
        }

        evidence = ai_juicer._validated_library_evidence(
            [{"note_id": "note-1", "quote": quote, "source": "visual"}],
            supplied,
        )

        self.assertNotIn(quote, summary_context)
        self.assertEqual(evidence[0]["source"], "visual")
        self.assertEqual(evidence[0]["timestamp_ms"], 5_000)

    def test_structured_visual_lists_keep_timestamp_and_semantics(self) -> None:
        observations = ai_juicer._note_visual_evidence({
            "detailed_video_analysis": {
                "visual_observations": [
                    {
                        "timestamp_ms": 42_000,
                        "ocr_text": ["LOCK", "OPEN"],
                        "people": ["一名穿蓝衣的演示者"],
                        "objects": ["红色旋钮"],
                        "actions": ["向右旋转旋钮"],
                        "events": ["指示灯由红变绿"],
                    }
                ]
            }
        })

        by_quote = {item["quote"]: item["timestamp_ms"] for item in observations}
        self.assertEqual(by_quote["可见文字：LOCK"], 42_000)
        self.assertEqual(by_quote["人物：一名穿蓝衣的演示者"], 42_000)
        self.assertEqual(by_quote["物体：红色旋钮"], 42_000)
        self.assertEqual(by_quote["动作：向右旋转旋钮"], 42_000)
        self.assertEqual(by_quote["事件：指示灯由红变绿"], 42_000)

    def test_local_scene_structure_becomes_timestamped_evidence(self) -> None:
        observations = ai_juicer._note_visual_evidence({
            "detailed_video_analysis": {
                "method": "local_scene",
                "scene_count": 12,
                "chapters": [
                    {
                        "title": "片段 1",
                        "start_ms": 5_000,
                        "end_ms": 35_000,
                    }
                ],
            }
        })

        self.assertEqual(observations[0]["quote"], "镜头结构：检测到 12 个镜头，整理为 1 个章节。")
        chapter = next(item for item in observations if item["quote"].startswith("镜头章节："))
        self.assertEqual(chapter["timestamp_ms"], 5_000)
        self.assertIn("00:05–00:35", chapter["quote"])


class AgentVisualToolGuardrailTests(unittest.TestCase):
    def test_deep_research_and_generic_video_question_do_not_trigger(self) -> None:
        self.assertFalse(
            agent_video_analysis_service.requires_visual_analysis(
                "请用深度研究总结这些视频的共同观点"
            )
        )
        self.assertFalse(
            agent_video_analysis_service.requires_visual_analysis(
                "这些视频里讲了哪些方法？"
            )
        )
        self.assertTrue(
            agent_video_analysis_service.requires_visual_analysis(
                "动作示范是否正确，画面里的手势有什么问题？"
            )
        )

    def test_tool_rejects_note_outside_snapshot(self) -> None:
        with self.assertRaisesRegex(ValueError, "来源快照"):
            agent_video_analysis_service.validate_tool_note_ids(
                ["note-allowed", "note-outside"],
                ["note-allowed"],
            )

    def test_completion_card_is_bound_to_exact_run_and_state(self) -> None:
        running = SimpleNamespace(
            result_json=json.dumps(
                {
                    "type": "video_analysis_analysis_started",
                    "video_analysis": {"run": {"id": "run-current"}},
                }
            )
        )
        stale_approval = SimpleNamespace(
            result_json=json.dumps(
                {
                    "type": "video_analysis_approval_required",
                    "video_analysis": {"run": {"id": "run-old"}},
                }
            )
        )

        self.assertEqual(
            agent_service._video_analysis_card_run_id(
                running,
                expected_type="video_analysis_analysis_started",
            ),
            "run-current",
        )
        self.assertEqual(
            agent_service._video_analysis_card_run_id(
                stale_approval,
                expected_type="video_analysis_analysis_started",
            ),
            "",
        )

    def test_text_only_source_projection_removes_visual_result(self) -> None:
        note = SimpleNamespace(
            id="note-1",
            video_title="演示",
            transcript_raw="只有文稿",
            ai_summary=json.dumps(
                {
                    "sections": [
                        {"title": "普通", "content": "保留"},
                        {
                            "title": "画面补充",
                            "content": "00:01 · 视觉秘密",
                            "source": "detailed_video_analysis",
                        },
                    ],
                    "detailed_video_analysis": {
                        "visual_observations": [
                            {"timestamp_ms": 1000, "summary": "视觉秘密"}
                        ]
                    },
                },
                ensure_ascii=False,
            ),
        )

        projected = agent_service._answer_sources([note], include_visual=False)[0]

        self.assertIn("保留", projected["ai_summary"])
        self.assertNotIn("视觉秘密", projected["ai_summary"])
        self.assertNotIn("detailed_video_analysis", projected["ai_summary"])

    def test_selection_first_ranks_transcript_and_is_bounded(self) -> None:
        notes = [
            SimpleNamespace(
                id=f"note-{index}",
                video_title=f"动作 {index}",
                transcript_raw="演示肩部训练动作。",
                ai_summary=json.dumps({
                    "source_meta": {
                        "platform": "douyin",
                        "media_type": "video",
                    }
                }),
            )
            for index in range(5)
        ]
        with patch.object(
            ai_juicer,
            "rank_library_sources_for_selection",
            return_value={
                "items": [
                    {"note_id": "note-3"},
                    {"note_id": "note-1"},
                    {"note_id": "note-4"},
                ]
            },
        ) as rank_mock, patch.object(
            agent_video_analysis_service,
            "_request_visual_tool_call",
            return_value=(["note-3", "note-1"], "必须看动作画面"),
        ) as gate_mock:
            decision = agent_video_analysis_service.plan_tool_call(
                notes,
                "画面里的动作示范是否正确？",
                limit=2,
            )

        self.assertTrue(decision.needed)
        self.assertEqual(decision.note_ids, ("note-3", "note-1"))
        self.assertEqual(rank_mock.call_count, 1)
        self.assertEqual(gate_mock.call_count, 1)

    def test_tool_gate_uses_only_strict_note_id_arguments(self) -> None:
        note = SimpleNamespace(
            id="note-1",
            video_title="开关演示",
            transcript_raw="文稿只说现在开始演示，没有说明先拿起什么。",
            ai_summary=json.dumps({
                "source_meta": {"platform": "douyin", "media_type": "video"}
            }),
        )
        model_payload = json.dumps({
            "tool_call": {
                "name": "analyze_video_details",
                "arguments": {"note_ids": ["note-1"]},
            },
            "reason": "动作对象只能从画面确认",
        }, ensure_ascii=False)
        with patch.object(ai_juicer, "_call_llm", return_value=model_payload) as llm:
            note_ids, reason = agent_video_analysis_service._request_visual_tool_call(
                [note],
                "他先拿起了哪个东西再放下？",
                maximum=3,
            )

        self.assertEqual(note_ids, ["note-1"])
        self.assertIn("画面", reason)
        self.assertEqual(llm.call_args.kwargs["operation"], "agent_visual_tool_gate")

    def test_tool_gate_fails_closed_when_model_adds_forbidden_argument(self) -> None:
        note = SimpleNamespace(
            id="note-1",
            video_title="演示",
            transcript_raw="没有描述画面。",
        )
        model_payload = json.dumps({
            "tool_call": {
                "name": "analyze_video_details",
                "arguments": {
                    "note_ids": ["note-1"],
                    "provider": "forbidden",
                },
            },
            "reason": "",
        })
        with patch.object(ai_juicer, "_call_llm", return_value=model_payload):
            note_ids, _ = agent_video_analysis_service._request_visual_tool_call(
                [note],
                "画面里有什么？",
                maximum=3,
            )

        self.assertEqual(note_ids, [])


if __name__ == "__main__":
    unittest.main()
