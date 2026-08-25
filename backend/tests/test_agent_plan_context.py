from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.agent_runtime import AgentTurn  # noqa: F401
from app.models.note import Note  # noqa: F401
from app.models.plan import Plan
from app.models.user import User  # noqa: F401
from app.services import (
    agent_runtime_service,
    agent_runtime_worker,
    agent_service,
    ai_juicer,
    plan_service,
)


class AgentPlanContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    @staticmethod
    def _plan(user_id: str = "user-1") -> Plan:
        tasks = [
            {
                "id": "t-open",
                "title": "整理本周资料",
                "done": False,
                "day": 1,
                "priority": "medium",
                "position": 0,
            },
            {
                "id": "t-done",
                "title": "确定目标",
                "done": True,
                "day": 1,
                "priority": "high",
                "position": 1,
            },
        ]
        return Plan(
            id="plan-1",
            user_id=user_id,
            title="一周执行计划",
            total_days=7,
            fields="[]",
            tasks=json.dumps(tasks, ensure_ascii=False),
            days_json="[]",
            status="active",
        )

    def test_plan_thread_requires_an_owned_plan_and_serializes_context(self) -> None:
        with self.Session() as db:
            db.add(self._plan())
            db.commit()

            thread = agent_service.create_thread(
                db,
                user_id="user-1",
                scope="selected",
                source_ids=[],
                context_type="plan",
                context_id="plan-1",
            )
            payload = agent_service.serialize_thread(db, thread)

            self.assertEqual(thread.context_type, "plan")
            self.assertEqual(thread.context_id, "plan-1")
            self.assertEqual(payload["source_count"], 0)
            self.assertEqual(payload["context"]["type"], "plan")
            self.assertEqual(payload["context"]["plan"]["title"], "一周执行计划")

            with self.assertRaisesRegex(ValueError, "计划不存在"):
                agent_service.create_thread(
                    db,
                    user_id="other-user",
                    scope="selected",
                    source_ids=[],
                    context_type="plan",
                    context_id="plan-1",
                )

    def test_plan_preview_is_persisted_and_apply_is_idempotent(self) -> None:
        generated = {
            "plan": {
                "goal": "轻量的一周执行计划",
                "duration": "7天",
                "dynamic_fields": [],
                "days": [
                    {
                        "day": 1,
                        "label": "第一天",
                        "tasks": [
                            {
                                "id": "t-open",
                                "title": "只整理最重要的资料",
                                "done": False,
                                "priority": "high",
                            }
                        ],
                    }
                ],
                "tasks": [],
            },
            "change_summary": "已把计划压缩为最重要的一步",
            "source_context": {"transcript_chars": 0},
        }
        with self.Session() as db:
            db.add(self._plan())
            db.commit()
            thread = agent_service.create_thread(
                db,
                user_id="user-1",
                scope="selected",
                source_ids=[],
                context_type="plan",
                context_id="plan-1",
            )

            with patch.object(
                ai_juicer,
                "generate_or_revise_plan",
                return_value=generated,
            ):
                _, assistant = agent_service.ask_thread(
                    db,
                    thread=thread,
                    content="把接下来一周安排得轻一点",
                )

            persisted = db.query(AgentMessage).filter(
                AgentMessage.id == assistant.id,
            ).one()
            result = json.loads(persisted.result_json or "{}")
            self.assertEqual(result["type"], "plan_change_preview")
            self.assertEqual(result["plan_change"]["state"], "pending")
            self.assertEqual(result["plan_change"]["plan_id"], "plan-1")

            applied, applied_message = agent_service.apply_plan_change_message(
                db,
                message_id=assistant.id,
                user_id="user-1",
            )
            self.assertEqual(applied.title, "轻量的一周执行计划")
            self.assertEqual(
                [task["title"] for task in applied.to_dict()["tasks"]],
                ["只整理最重要的资料", "确定目标"],
            )
            self.assertEqual(
                json.loads(applied_message.result_json or "{}")["plan_change"]["state"],
                "applied",
            )

            repeated, _ = agent_service.apply_plan_change_message(
                db,
                message_id=assistant.id,
                user_id="user-1",
            )
            self.assertEqual(repeated.to_dict()["tasks"], applied.to_dict()["tasks"])

            with self.assertRaisesRegex(ValueError, "不存在"):
                agent_service.apply_plan_change_message(
                    db,
                    message_id=assistant.id,
                    user_id="other-user",
                )

    def test_plan_preview_rejects_stale_apply(self) -> None:
        with self.Session() as db:
            plan = self._plan()
            db.add(plan)
            db.commit()
            thread = AgentThread(
                id="thread-stale",
                user_id="user-1",
                title="调整计划",
                scope_type="selected",
                scope_label="当前计划",
                source_ids_json="[]",
                context_type="plan",
                context_id=plan.id,
            )
            preview = plan_service.build_coaching_preview(
                plan,
                proposed_title=plan.title,
                proposed_fields=[],
                proposed_tasks=[{"id": "t-open", "title": "新的安排"}],
                proposed_days=[],
                proposed_total_days=7,
                change_summary="调整安排",
            )
            message = AgentMessage(
                id="message-stale",
                thread_id=thread.id,
                user_id="user-1",
                role="assistant",
                content="预览",
                result_json=json.dumps({
                    "type": "plan_change_preview",
                    "plan_change": {**preview, "state": "pending"},
                }, ensure_ascii=False),
            )
            db.add_all([thread, message])
            db.commit()
            plan_service.update_plan(
                db,
                plan.id,
                {"title": "用户刚刚手动修改的计划"},
                user_id="user-1",
            )

            with self.assertRaises(plan_service.PlanConflictError):
                agent_service.apply_plan_change_message(
                    db,
                    message_id=message.id,
                    user_id="user-1",
                )

    def test_failed_plan_turn_releases_reserved_charge(self) -> None:
        with self.Session() as db:
            db.add(self._plan())
            db.commit()
            thread = agent_service.create_thread(
                db,
                user_id="user-1",
                scope="selected",
                source_ids=[],
                context_type="plan",
                context_id="plan-1",
            )
            turn, _ = agent_runtime_service.create_or_get_turn(
                db,
                thread=thread,
                client_turn_id="plan-turn-failure",
                question="把计划调轻一点",
                requested_mode="auto",
                output_style="answer",
                custom_instruction="",
                web_scope="video_only",
            )

        charge = object()
        with (
            patch.object(agent_runtime_worker, "SessionLocal", self.Session),
            patch.object(agent_runtime_worker, "_reserve_charge", return_value=charge),
            patch.object(
                agent_runtime_worker.agent_service,
                "ask_thread",
                side_effect=RuntimeError("模型暂时不可用"),
            ),
            patch.object(
                agent_runtime_worker.chat_credit_billing_service,
                "release",
            ) as release,
            patch.object(agent_runtime_worker.agent_runtime_service, "fail_turn") as fail,
        ):
            agent_runtime_worker.process_turn(turn.id)

        release.assert_called_once()
        self.assertIs(release.call_args.args[1], charge)
        fail.assert_called_once()


if __name__ == "__main__":
    unittest.main()
