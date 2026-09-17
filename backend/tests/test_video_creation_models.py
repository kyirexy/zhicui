"""「创作工坊」模型回归:状态机集合、as_dict 结构与 pricing 解析。"""
from __future__ import annotations

import json
import os
import unittest

os.environ.setdefault("JWT_SECRET", "video-creation-test-secret")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models.video_creation import JOB_STATUSES, VideoCreationJob


class VideoCreationModelTests(unittest.TestCase):
    def test_status_vocabulary_is_closed(self):
        self.assertEqual(
            JOB_STATUSES,
            {"drafting", "draft", "queued", "rendering", "completed", "failed", "cancelled"},
        )

    def test_defaults_are_safe(self):
        # SQLAlchemy 列 default 在 flush 时生效,不在构造时生效。
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        VideoCreationJob.__table__.create(engine)
        try:
            with Session(bind=engine, expire_on_commit=False) as db:
                job = VideoCreationJob(user_id="u1")
                db.add(job)
                db.flush()
                self.assertEqual(job.status, "draft")
                self.assertEqual(job.render_seconds, 0)
                self.assertEqual(job.output_filename, "")
                self.assertTrue(job.id, "uuid 主键应有默认生成")
        finally:
            engine.dispose()

    def test_as_dict_shape(self):
        job = VideoCreationJob(
            user_id="u1",
            status="completed",
            requirement_text="做一条 20 秒的咖啡科普",
            svml_text="<?svml using=\"@hypit/markup@1\"?>",
            explanation="三段式开场",
            output_filename="job-1.mp4",
            render_seconds=180,
        )
        payload = job.as_dict()
        for key in (
            "id", "status", "requirement_text", "svml_text", "explanation",
            "pricing", "build_id", "output_filename", "error", "render_seconds",
            "created_at", "updated_at", "completed_at",
        ):
            self.assertIn(key, payload)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["pricing"], {})
        self.assertIsNone(payload["completed_at"])

    def test_pricing_property_tolerates_corrupt_json(self):
        job = VideoCreationJob(user_id="u1", pricing_json="{not-json")
        self.assertEqual(job.pricing, {})
        job.pricing_json = json.dumps({"estimate": {"total": 1.15}}, ensure_ascii=False)
        self.assertEqual(job.pricing, {"estimate": {"total": 1.15}})


if __name__ == "__main__":
    unittest.main()
