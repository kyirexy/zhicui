from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.user import User
from app.models.video_analysis import VideoAnalysisRun
from app.services import agent_service


class AgentVideoAnalysisRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                AgentThread.__table__,
                AgentMessage.__table__,
                VideoAnalysisRun.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.Session() as db:
            db.add(User(
                id="u-agent-recovery",
                email="agent-recovery@example.com",
                username="agent-recovery",
                hashed_password="test",
                is_active=True,
            ))
            db.commit()

    def tearDown(self) -> None:
        Base.metadata.drop_all(
            self.engine,
            tables=[
                AgentMessage.__table__,
                VideoAnalysisRun.__table__,
                AgentThread.__table__,
                User.__table__,
            ],
        )
        self.engine.dispose()

    def _seed_turn(
        self,
        *,
        run_status: str,
        thread_status: str = "running",
        with_started_card: bool = False,
    ) -> tuple[str, str, str]:
        thread_id = "00000000-0000-0000-0000-000000000101"
        turn_id = "00000000-0000-0000-0000-000000000102"
        run_id = "00000000-0000-0000-0000-000000000103"
        with self.Session() as db:
            thread = AgentThread(
                id=thread_id,
                user_id="u-agent-recovery",
                title="恢复测试",
                scope_type="selected",
                scope_label="已选视频",
                source_ids_json='["note-1"]',
                source_available_count=1,
                source_selected_count=1,
                status=thread_status,
            )
            user_message = AgentMessage(
                thread_id=thread_id,
                user_id="u-agent-recovery",
                turn_id=turn_id,
                role="user",
                content="画面里先拿起了什么？",
            )
            run = VideoAnalysisRun(
                id=run_id,
                user_id="u-agent-recovery",
                trigger="agent",
                status=run_status,
                billing_status="quoted" if run_status == "prepared" else "captured",
                offering_id="00000000-0000-0000-0000-000000000201",
                offering_version_id="00000000-0000-0000-0000-000000000202",
                agent_thread_id=thread_id,
                agent_turn_id=turn_id,
                source_count=1,
                quote_json=json.dumps({
                    "offering_name": "免费基础解析",
                    "estimated_points": 0,
                    "max_reserved_points": 0,
                }, ensure_ascii=False),
            )
            db.add_all([thread, user_message, run])
            if with_started_card:
                db.add(AgentMessage(
                    thread_id=thread_id,
                    user_id="u-agent-recovery",
                    turn_id=turn_id,
                    role="assistant",
                    content="正在解析",
                    result_json=json.dumps({
                        "type": "video_analysis_analysis_started",
                        "video_analysis": {"run": {"id": run_id}},
                    }, ensure_ascii=False),
                ))
            db.commit()
        return thread_id, turn_id, run_id

    @staticmethod
    def _event(run_id: str, status: str) -> SimpleNamespace:
        return SimpleNamespace(
            run_id=run_id,
            user_id="u-agent-recovery",
            item_id="",
            note_id="",
            status=status,
            recovery=True,
        )

    def test_prepared_run_without_card_recovers_approval_state(self) -> None:
        thread_id, turn_id, run_id = self._seed_turn(run_status="prepared")
        analysis_payload = {
            "run": {"id": run_id, "status": "prepared"},
            "items": [],
        }

        with patch("app.core.database.SessionLocal", self.Session), patch.object(
            agent_service,
            "_run_analysis_payload",
            return_value=analysis_payload,
        ):
            agent_service.reconcile_video_analysis_agent_run(
                self._event(run_id, "prepared")
            )

        with self.Session() as db:
            thread = db.get(AgentThread, thread_id)
            card = (
                db.query(AgentMessage)
                .filter(
                    AgentMessage.thread_id == thread_id,
                    AgentMessage.turn_id == turn_id,
                    AgentMessage.role == "assistant",
                )
                .one()
            )
            self.assertEqual(thread.status, "awaiting_approval")
            self.assertEqual(card.result["type"], "video_analysis_approval_required")
            self.assertEqual(card.result["video_analysis"]["run"]["id"], run_id)

    def test_terminal_run_resumes_once_after_crash_window(self) -> None:
        thread_id, turn_id, run_id = self._seed_turn(
            run_status="succeeded",
            thread_status="running_analysis",
            with_started_card=True,
        )
        resume_calls: list[str] = []

        def fake_resume(db, *, thread, turn_id, run, **_kwargs):
            resume_calls.append(run.id)
            _, card = agent_service._agent_turn_messages(
                db,
                thread=thread,
                turn_id=turn_id,
            )
            card.content = "已根据画面继续回答。"
            card.result_json = json.dumps({
                "answer": "已根据画面继续回答。",
                "video_analysis_run_id": run.id,
                "video_analysis": {"run": {"id": run.id, "status": run.status}},
            }, ensure_ascii=False)
            thread.status = "ready"
            db.commit()
            return card

        patches = (
            patch("app.core.database.SessionLocal", self.Session),
            patch.object(
                agent_service,
                "_run_analysis_payload",
                return_value={
                    "run": {"id": run_id, "status": "succeeded"},
                    "items": [],
                },
            ),
            patch.object(
                agent_service,
                "_run_visual_result_profile",
                return_value=(True, True),
            ),
            patch.object(agent_service, "_resume_agent_answer", side_effect=fake_resume),
        )
        with patches[0], patches[1], patches[2], patches[3]:
            event = self._event(run_id, "succeeded")
            agent_service.reconcile_video_analysis_agent_run(event)
            # Startup and worker delivery are both at-least-once. The final
            # run binding on the card makes the second delivery a no-op.
            agent_service.reconcile_video_analysis_agent_run(event)

        with self.Session() as db:
            thread = db.get(AgentThread, thread_id)
            _, card = agent_service._agent_turn_messages(
                db,
                thread=thread,
                turn_id=turn_id,
            )
            self.assertEqual(thread.status, "ready")
            self.assertEqual(card.result["video_analysis_run_id"], run_id)
            self.assertEqual(resume_calls, [run_id])


if __name__ == "__main__":
    unittest.main()
