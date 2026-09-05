from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.agent_runtime import AgentTurn  # noqa: F401
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import agent_service, ai_juicer


class AgentPlanCreationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    @staticmethod
    def _generated_plan() -> dict:
        return {
            "change_summary": "已创建 21 天英语学习计划",
            "source_context": {"transcript_chars": 12},
            "plan": {
                "goal": "21 天英语学习计划",
                "duration": "21天",
                "dynamic_fields": [],
                "days": [
                    {
                        "day": 1,
                        "label": "第一天",
                        "tasks": [
                            {
                                "id": "t-001",
                                "title": "跟读英语材料 20 分钟",
                                "done": False,
                                "priority": "high",
                            }
                        ],
                    }
                ],
                "tasks": [],
            },
        }

    @staticmethod
    def _user(user_id: str) -> User:
        return User(
            id=user_id,
            email=f"{user_id}@example.com",
            username=user_id,
            hashed_password="unused",
            is_active=True,
            is_admin=False,
        )

    @staticmethod
    def _note(user_id: str) -> Note:
        return Note(
            id="note-1",
            user_id=user_id,
            video_id="video-1",
            video_title="英语跟读方法",
            video_url="https://example.com/video-1",
            transcript_raw="每天选择一段材料，先听后跟读并复盘。",
            ai_summary="{}",
            card_type="general",
            seo_title="英语跟读方法",
            seo_slug="english-shadowing",
            seo_meta="英语跟读方法",
            pitfall_rating=3,
        )

    @staticmethod
    def _thread(user_id: str) -> AgentThread:
        return AgentThread(
            id="thread-1",
            user_id=user_id,
            title="英语资料研究",
            scope_type="selected",
            scope_label="手动选择",
            source_ids_json='["note-1"]',
            source_available_count=1,
            source_selected_count=1,
            source_truncated=False,
            context_type="video",
            status="ready",
        )

    def test_intent_gate_only_accepts_explicit_affirmative_creation(self) -> None:
        accepted = (
            "帮我制定一个 21 天英语学习计划",
            "请给我生成一份减脂行动计划",
            "能不能帮我创建一个备考计划？",
            "做一个每天半小时的训练计划",
            "帮我安排一下未来 7 天每天的学习任务",
        )
        rejected = (
            "怎么制定学习计划？",
            "这个计划合理吗？",
            "制定计划需要注意什么？",
            "不要创建计划，只给我建议",
            "介绍一下视频里的训练方法",
        )
        for text in accepted:
            self.assertTrue(agent_service.is_explicit_plan_creation_request(text), text)
        for text in rejected:
            self.assertFalse(agent_service.is_explicit_plan_creation_request(text), text)

    def test_explicit_request_creates_owned_plan_and_structured_result(self) -> None:
        with self.Session() as db:
            db.add_all([self._user("user-1"), self._user("user-2")])
            db.commit()
            db.add_all([self._note("user-1"), self._thread("user-1")])
            db.commit()
            thread = db.query(AgentThread).filter_by(id="thread-1").one()

            with patch.object(
                ai_juicer,
                "generate_or_revise_plan",
                return_value=self._generated_plan(),
            ):
                _, assistant = agent_service.ask_thread(
                    db,
                    thread=thread,
                    content="帮我制定一个 21 天英语学习计划",
                )

            created = db.query(Plan).one()
            result = json.loads(assistant.result_json or "{}")
            self.assertEqual(created.user_id, "user-1")
            self.assertEqual(created.note_id, "note-1")
            self.assertEqual(created.title, "21 天英语学习计划")
            self.assertEqual(result["type"], "plan_created")
            self.assertEqual(result["created_plan"]["id"], created.id)
            self.assertEqual(result["created_plan"]["task_count"], 1)
            self.assertEqual(
                db.query(Plan).filter(Plan.user_id == "user-2").count(),
                0,
            )

    def test_generation_failure_leaves_no_plan_or_orphan_message(self) -> None:
        with self.Session() as db:
            db.add(self._user("user-1"))
            db.commit()
            db.add_all([self._note("user-1"), self._thread("user-1")])
            db.commit()
            thread = db.query(AgentThread).filter_by(id="thread-1").one()

            with patch.object(
                ai_juicer,
                "generate_or_revise_plan",
                side_effect=RuntimeError("模型不可用"),
            ):
                with self.assertRaisesRegex(RuntimeError, "模型不可用"):
                    agent_service.ask_thread(
                        db,
                        thread=thread,
                        content="帮我创建一个英语学习计划",
                    )

            self.assertEqual(db.query(Plan).count(), 0)
            self.assertEqual(db.query(AgentMessage).count(), 0)
            db.refresh(thread)
            self.assertEqual(thread.status, "failed")


if __name__ == "__main__":
    unittest.main()
