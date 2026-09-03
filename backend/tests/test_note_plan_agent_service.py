from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services import note_plan_agent_service, product_action_handlers
from app.services.product_action_registry import registry


class NotePlanAgentServiceTests(unittest.TestCase):
    def test_product_action_contract_is_explicit_and_idempotent(self) -> None:
        definition = registry.get("plan.from_library.generate")
        self.assertIsNotNone(definition)
        assert definition is not None
        self.assertEqual(definition.handler_name, "plan_from_library_generate")
        self.assertEqual(definition.scopes, ("plan:write",))
        self.assertEqual(definition.idempotency.value, "required")
        self.assertEqual([risk.value for risk in definition.risk], ["write"])
        self.assertEqual(
            set(definition.input_schema.get("required") or []),
            {"note_id", "instruction"},
        )

    def test_missing_note_is_a_stable_not_found_error(self) -> None:
        with patch.object(
            note_plan_agent_service.note_service,
            "get_note",
            return_value=None,
        ):
            with self.assertRaises(note_plan_agent_service.NotePlanAgentError) as captured:
                note_plan_agent_service.generate_or_revise_from_note(
                    Mock(),
                    user_id="user-a",
                    note_id="note-missing",
                    instruction="整理成三天计划",
                )
        self.assertEqual(captured.exception.code, "RESOURCE_NOT_FOUND")
        self.assertEqual(captured.exception.status_code, 404)

    def test_generated_plan_is_saved_for_the_same_user_and_note(self) -> None:
        db = Mock()
        note = SimpleNamespace(
            id="note-a",
            video_title="资料标题",
            transcript_raw="完整文稿",
            ai_summary={"summary": "摘要"},
        )
        stored = SimpleNamespace(to_dict=lambda: {"id": "plan-a", "title": "三天计划"})
        generated = {
            "plan": {
                "goal": "三天计划",
                "fields": [],
                "tasks": [{"id": "task-1", "title": "第一步"}],
                "days": [{"day": 1, "task_ids": ["task-1"]}],
            },
            "change_summary": "已生成三天安排",
            "source_context": {"note_id": "note-a"},
        }
        with (
            patch.object(note_plan_agent_service.note_service, "get_note", return_value=note) as get_note,
            patch.object(note_plan_agent_service.plan_service, "get_plan_by_note", return_value=None),
            patch.object(note_plan_agent_service.ai_juicer, "generate_or_revise_plan", return_value=generated),
            patch.object(
                note_plan_agent_service.ai_juicer,
                "plan_to_storage",
                return_value=([], generated["plan"]["tasks"], 3),
            ),
            patch.object(
                note_plan_agent_service.plan_service,
                "upsert_agent_plan",
                return_value=(stored, True),
            ) as upsert,
        ):
            result = note_plan_agent_service.generate_or_revise_from_note(
                db,
                user_id="user-a",
                note_id="note-a",
                instruction="整理成三天计划",
            )

        get_note.assert_called_once_with(db, "note-a", user_id="user-a")
        self.assertEqual(upsert.call_args.kwargs["user_id"], "user-a")
        self.assertEqual(upsert.call_args.kwargs["note_id"], "note-a")
        self.assertEqual(result["plan"]["id"], "plan-a")
        self.assertTrue(result["created"])

    def test_plan_validation_error_is_normalized(self) -> None:
        note = SimpleNamespace(
            id="note-a",
            video_title="资料标题",
            transcript_raw="完整文稿",
            ai_summary={},
        )
        with (
            patch.object(note_plan_agent_service.note_service, "get_note", return_value=note),
            patch.object(note_plan_agent_service.plan_service, "get_plan_by_note", return_value=None),
            patch.object(
                note_plan_agent_service.ai_juicer,
                "generate_or_revise_plan",
                side_effect=ValueError("计划至少需要一个任务"),
            ),
        ):
            with self.assertRaises(note_plan_agent_service.NotePlanAgentError) as captured:
                note_plan_agent_service.generate_or_revise_from_note(
                    Mock(),
                    user_id="user-a",
                    note_id="note-a",
                    instruction="生成计划",
                )
        self.assertEqual(captured.exception.code, "INVALID_INPUT")

    def test_action_handler_never_leaks_unexpected_model_errors(self) -> None:
        context = SimpleNamespace(
            db=Mock(),
            user=SimpleNamespace(id="user-a"),
        )
        with patch.object(
            product_action_handlers.note_plan_agent_service,
            "generate_or_revise_from_note",
            side_effect=RuntimeError("provider key=do-not-leak"),
        ):
            with self.assertRaises(product_action_handlers.ActionHandlerError) as captured:
                product_action_handlers.plan_from_library_generate(
                    context,
                    {"note_id": "note-a", "instruction": "生成计划"},
                )
        self.assertEqual(captured.exception.code, "MODEL_UNAVAILABLE")
        self.assertTrue(captured.exception.retryable)
        self.assertNotIn("do-not-leak", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
