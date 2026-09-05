from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.agent_runtime import AgentTurn  # noqa: F401
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.user import User
from app.services import agent_service, ai_juicer


class AgentKnowledgeCreationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

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
            id="note-knowledge-1",
            user_id=user_id,
            video_id="video-knowledge-1",
            video_title="高效复盘方法",
            video_url="https://example.com/knowledge-1",
            transcript_raw="复盘时记录目标、实际结果、差异原因和下一步行动。",
            ai_summary="{}",
            card_type="general",
            seo_title="高效复盘方法",
            seo_slug="review-method",
            seo_meta="高效复盘方法",
            pitfall_rating=3,
        )

    @staticmethod
    def _thread(user_id: str) -> AgentThread:
        return AgentThread(
            id="thread-knowledge-1",
            user_id=user_id,
            title="复盘资料研究",
            scope_type="selected",
            scope_label="手动选择",
            source_ids_json='["note-knowledge-1"]',
            source_available_count=1,
            source_selected_count=1,
            source_truncated=False,
            context_type="video",
            status="ready",
        )

    def test_intent_gate_requires_an_affirmative_write_command(self) -> None:
        accepted = (
            "把上面的结论整理后保存到我的知识库",
            "请将当前资料整理成知识卡",
            "帮我把刚才的回答记下来",
            "把这些要点保存成笔记",
            "请创建一个知识条目记录这些结论",
            "把这个写到知识库",
            "帮我把这些内容写入知识",
        )
        rejected = (
            "怎么把内容保存到知识库？",
            "知识库可以保存哪些内容？",
            "先不要保存到知识库",
            "介绍一下这个视频",
            "我想知道如何记录知识",
        )
        for text in accepted:
            self.assertTrue(
                agent_service.is_explicit_knowledge_creation_request(text),
                text,
            )
        for text in rejected:
            self.assertFalse(
                agent_service.is_explicit_knowledge_creation_request(text),
                text,
            )

    def test_explicit_request_creates_owned_knowledge_and_result(self) -> None:
        with self.Session() as db:
            db.add_all([self._user("user-1"), self._user("user-2")])
            db.commit()
            db.add_all([self._note("user-1"), self._thread("user-1")])
            prior_time = datetime.now(timezone.utc) - timedelta(minutes=1)
            db.add_all([
                AgentMessage(
                    thread_id="thread-knowledge-1",
                    user_id="user-1",
                    turn_id="prior-turn",
                    role="user",
                    content="介绍一下复盘方法",
                    created_at=prior_time,
                ),
                AgentMessage(
                    thread_id="thread-knowledge-1",
                    user_id="user-1",
                    turn_id="prior-turn",
                    role="assistant",
                    content="复盘的核心是比较目标和结果，并明确下一步行动。",
                    created_at=prior_time + timedelta(seconds=1),
                ),
            ])
            db.commit()
            thread = db.query(AgentThread).filter_by(id="thread-knowledge-1").one()

            generated = {
                "title": "四步复盘法",
                "summary": "通过目标、结果、差异和行动完成复盘。",
                "content": "## 四个步骤\n\n1. 目标\n2. 结果\n3. 差异\n4. 行动",
            }
            with patch.object(
                ai_juicer,
                "generate_knowledge_entry",
                return_value=generated,
            ) as generator:
                _, assistant = agent_service.ask_thread(
                    db,
                    thread=thread,
                    content="把刚才的回答整理后保存到我的知识库",
                )

            created = db.query(KnowledgeEntry).one()
            result = json.loads(assistant.result_json or "{}")
            self.assertEqual(created.user_id, "user-1")
            self.assertEqual(created.title, "四步复盘法")
            self.assertEqual(created.content, generated["content"])
            self.assertEqual(result["type"], "knowledge_created")
            self.assertEqual(result["created_knowledge"]["id"], created.id)
            self.assertEqual(result["created_knowledge"]["content_chars"], len(created.content))
            self.assertEqual(db.query(KnowledgeEntry).filter_by(user_id="user-2").count(), 0)
            call = generator.call_args.kwargs
            self.assertIn("复盘的核心", call["conversation_context"])
            self.assertIn("目标、实际结果", call["source_context"])

    def test_generation_failure_leaves_no_entry_or_orphan_message(self) -> None:
        with self.Session() as db:
            db.add(self._user("user-1"))
            db.commit()
            db.add_all([self._note("user-1"), self._thread("user-1")])
            db.commit()
            thread = db.query(AgentThread).filter_by(id="thread-knowledge-1").one()

            with patch.object(
                ai_juicer,
                "generate_knowledge_entry",
                side_effect=RuntimeError("模型不可用"),
            ):
                with self.assertRaisesRegex(RuntimeError, "模型不可用"):
                    agent_service.ask_thread(
                        db,
                        thread=thread,
                        content="把当前资料保存到知识库",
                    )

            self.assertEqual(db.query(KnowledgeEntry).count(), 0)
            self.assertEqual(db.query(AgentMessage).count(), 0)
            db.refresh(thread)
            self.assertEqual(thread.status, "failed")


if __name__ == "__main__":
    unittest.main()
