"""CLI 设置任务目标状态时的幂等性与用户隔离回归。"""

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.note import Note  # noqa: F401
from app.models.plan import Plan
from app.models.user import User
from app.services import plan_service


class PlanTaskCompletionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.db.add_all([
            User(id=user_id, email=f"{user_id}@example.test", username=user_id,
                 hashed_password="unused", is_active=True, is_admin=False)
            for user_id in ["owner", "other"]
        ])
        self.db.commit()
        self.plan = plan_service.create_plan(
            self.db, note_id=None, title="目标状态测试", user_id="owner",
            tasks=[{"id": "task-1", "title": "复习", "done": False}],
        )

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_same_target_preserves_completion_timestamp_and_can_reopen(self):
        row = plan_service.set_task_completion(
            self.db, self.plan.id, "task-1", True, user_id="owner",
        )
        first = row.to_dict()
        self.assertEqual(first["status"], "done")
        self.assertTrue(first["tasks"][0]["done"])
        completed_at = first["tasks"][0]["completed_at"]
        updated_at = row.updated_at
        repeated = plan_service.set_task_completion(
            self.db, self.plan.id, "task-1", True, user_id="owner",
        )
        self.assertEqual(repeated.to_dict()["tasks"][0]["completed_at"], completed_at)
        self.assertEqual(repeated.updated_at, updated_at)
        reopened = plan_service.set_task_completion(
            self.db, self.plan.id, "task-1", False, user_id="owner",
        ).to_dict()
        self.assertEqual(reopened["status"], "active")
        self.assertFalse(reopened["tasks"][0]["done"])
        self.assertFalse(reopened["tasks"][0].get("completed_at"))

    def test_other_user_missing_task_and_non_boolean_do_not_modify_plan(self):
        before = self.plan.to_dict()
        self.assertIsNone(plan_service.set_task_completion(
            self.db, self.plan.id, "task-1", True, user_id="other",
        ))
        self.assertIsNone(plan_service.set_task_completion(
            self.db, self.plan.id, "missing", True, user_id="owner",
        ))
        with self.assertRaises(ValueError):
            plan_service.set_task_completion(
                self.db, self.plan.id, "task-1", "true", user_id="owner",
            )
        self.db.refresh(self.plan)
        self.assertEqual(self.plan.to_dict(), before)


if __name__ == "__main__":
    unittest.main()
