"""计划并发编辑与 AI 修订后的完成历史回归。"""
from __future__ import annotations

import unittest
from sqlalchemy import create_engine, event
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.user import User
from app.models.note import Note
from app.models.plan import Plan
from app.services import plan_service as service


class PlanMutationIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine, tables=[User.__table__, Note.__table__, Plan.__table__])
        self.factory = sessionmaker(bind=self.engine)
        self.db = self.factory()
        self.db.add(User(id="owner", email="owner@example.test", hashed_password="unused", is_active=True))
        self.db.add(Note(id="note", user_id="owner", video_id="video", video_title="资料",
            video_url="https://example.test/video", seo_title="资料", seo_slug="note", seo_meta="资料"))
        self.db.commit()
        self.plan = service.create_plan(self.db, "note", "计划", user_id="owner",
            tasks=[{"id": "t-001", "title": "阅读", "done": False}, {"id": "t-002", "title": "练习", "done": False}])

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_web_toggles_reload_stale_snapshot_and_lock_the_row(self):
        first, second = self.factory(), self.factory()
        one = service.get_plan(first, self.plan.id, user_id="owner")
        two = service.get_plan(second, self.plan.id, user_id="owner")
        self.assertIsNot(one, two)
        statements = []
        def capture(conn, clause, multiparams, params, execution_options):
            if getattr(clause, "is_select", False):
                statements.append(str(clause.compile(dialect=postgresql.dialect())))
        event.listen(self.engine, "before_execute", capture)
        try:
            service.toggle_task(first, self.plan.id, "t-001", user_id="owner")
            service.toggle_task(second, self.plan.id, "t-002", user_id="owner")
        finally:
            event.remove(self.engine, "before_execute", capture)
        self.db.refresh(self.plan)
        self.assertTrue(all(task["done"] for task in self.plan.to_dict()["tasks"]))
        self.assertEqual(self.plan.status, "done")
        self.assertGreaterEqual(sum("FOR UPDATE" in sql for sql in statements), 2)
        first.close(); second.close()

    def revise(self, tasks):
        return service.upsert_agent_plan(self.db, note_id="note", title="修订", fields=[],
            tasks=tasks, days=[], total_days=1, user_id="owner")[0]

    def test_revision_preserves_original_completion_time_and_weekly_review(self):
        service.set_task_completion(self.db, self.plan.id, "t-001", True, user_id="owner")
        timestamp = self.plan.to_dict()["tasks"][0]["completed_at"]
        revised = self.revise([{"id": "t-001", "title": "阅读", "done": False},
            {"id": "t-002", "title": "练习", "done": False}])
        task = revised.to_dict()["tasks"][0]
        self.assertEqual(task["completed_at"], timestamp)
        self.assertTrue(task["done"])
        review = service.get_weekly_review(self.db, user_id="owner")
        self.assertEqual(review["summary"]["completed_tasks"], 1)
        self.assertFalse(review["partial_history"])

    def test_reused_id_is_new_task_and_completed_history_is_retained(self):
        service.set_task_completion(self.db, self.plan.id, "t-001", True, user_id="owner")
        tasks = self.revise([{"id": "t-001", "title": "另一项新行动", "done": False}]).to_dict()["tasks"]
        new = next(task for task in tasks if task["title"] == "另一项新行动")
        old = next(task for task in tasks if task["title"] == "阅读")
        self.assertFalse(new["done"])
        self.assertNotEqual(new["id"], old["id"])
        self.assertTrue(old["done"])
        self.assertIn("completed_at", old)

    def test_repeated_title_on_other_day_does_not_inherit_completion(self):
        for new_id in ("new-day", "old-day"):
            with self.subTest(new_id=new_id):
                result = service._reconcile_agent_tasks(
                    [{"id": new_id, "title": "跑步", "day": 2}],
                    [{"id": "old-day", "title": "跑步", "day": 1, "done": True, "completed_at": "2026-10-19T01:00:00+00:00"}])
                self.assertFalse(result[0]["done"])
                self.assertEqual(result[1]["id"], "old-day")
                self.assertNotEqual(result[0]["id"], result[1]["id"])


if __name__ == "__main__":
    unittest.main()
