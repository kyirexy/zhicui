"""「创作工坊」路由回归:envelope、越权 404、开关 fail-closed 与取消状态机。"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "video-creation-test-secret")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.video_creation_routes import router, _author_task
from app.core.auth import get_current_admin, get_current_user
from app.core.database import get_db
from app.models.admin_audit_log import AdminAuditLog
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.models.video_creation import VideoCreationJob
from app.services import hypit_service, settings_service


class _SyncThread:
    """把后台创作线程替换为同步执行,保证测试确定性。"""

    def __init__(self, target=None, args=(), name=None, daemon=None):
        self._target = target
        self._args = args

    def start(self):
        self._target(*self._args)


class VideoCreationRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = patch.multiple(
            hypit_service.settings,
            HYPIT_PROJECT_ROOT=str(Path(self.temp.name)),
            HYPIT_ENABLED=True,
        )
        self.config.start()

        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        User.__table__.create(self.engine)
        VideoCreationJob.__table__.create(self.engine)
        SystemSetting.__table__.create(self.engine)
        AdminAuditLog.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)

        self.app = FastAPI()
        self.app.include_router(router)

        def database():
            with self.Session() as session:
                yield session

        def current_user():
            return SimpleNamespace(id="user-1")

        self.app.dependency_overrides[get_db] = database
        self.app.dependency_overrides[get_current_user] = current_user
        self.client = TestClient(self.app)
        # 默认放行全部端点;个别测试自行收紧。
        patcher = patch(
            "app.api.video_creation_routes._feature_unavailable",
            return_value="",
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        self.config.stop()
        self.temp.cleanup()

    def _create_job(self, **fields) -> str:
        fields.setdefault("user_id", "user-1")
        with self.Session() as db:
            job = VideoCreationJob(**fields)
            db.add(job)
            db.commit()
            return job.id

    def test_create_requires_feature_enabled(self):
        with patch("app.api.video_creation_routes._feature_unavailable",
                   return_value="创作工坊暂未开启"):
            response = self.client.post(
                "/api/video-creation/jobs", json={"requirement_text": "咖啡科普"}
            )
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json()["success"])
        self.assertIn("暂未开启", response.json()["error"])

    def test_create_rejects_blank_requirement(self):
        response = self.client.post("/api/video-creation/jobs", json={"requirement_text": "  "})
        self.assertEqual(response.status_code, 422)

    def test_create_runs_author_synchronously_in_test(self):
        with patch("app.api.video_creation_routes.threading.Thread", _SyncThread), \
                patch("app.core.database.SessionLocal", self.Session), \
                patch("app.services.video_creation_author.draft_svml",
                      return_value=("<svml/>", "完成")):
            response = self.client.post(
                "/api/video-creation/jobs", json={"requirement_text": "咖啡科普"}
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        # 创建响应语义:进入 drafting(创作中);创作结果通过详情轮询获得。
        self.assertEqual(payload["data"]["status"], "drafting")
        job_id = payload["data"]["id"]
        detail = self.client.get(f"/api/video-creation/jobs/{job_id}")
        self.assertEqual(detail.json()["data"]["status"], "draft")
        self.assertEqual(detail.json()["data"]["svml_text"], "<svml/>")
        self.assertEqual(detail.json()["data"]["explanation"], "完成")

    def test_list_and_get_are_user_scoped(self):
        job_id = self._create_job(requirement_text="a", status="draft", svml_text="<svml/>")
        listing = self.client.get("/api/video-creation/jobs")
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.json()["data"]), 1)

        detail = self.client.get(f"/api/video-creation/jobs/{job_id}")
        self.assertEqual(detail.status_code, 200)

        # 其他用户的 job 视为不存在(404,不泄露存在性)。
        other_id = self._create_job(user_id="user-2", requirement_text="b", status="draft")
        self.assertEqual(
            self.client.get(f"/api/video-creation/jobs/{other_id}").status_code, 404
        )
        self.assertEqual(self.client.get("/api/video-creation/jobs/missing").status_code, 404)

    def test_confirm_requires_draft_with_svml(self):
        draft_id = self._create_job(status="draft", svml_text="<svml/>")
        queued_id = self._create_job(status="queued", svml_text="<svml/>")
        empty_id = self._create_job(status="draft", svml_text="")

        with patch.object(hypit_service, "price_project",
                          return_value={"estimate": {"total": 1.2}}):
            ok = self.client.post(f"/api/video-creation/jobs/{draft_id}/confirm")
            blocked = self.client.post(f"/api/video-creation/jobs/{queued_id}/confirm")
            empty = self.client.post(f"/api/video-creation/jobs/{empty_id}/confirm")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["data"]["status"], "queued")
        self.assertEqual(ok.json()["data"]["pricing"]["estimate"]["total"], 1.2)
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(empty.status_code, 400)

    def test_confirm_pricing_failure_keeps_draft(self):
        draft_id = self._create_job(status="draft", svml_text="<svml/>")
        from app.services.hypit_service import HypitError

        with patch.object(hypit_service, "price_project",
                          side_effect=HypitError("hypit_command_failed", "endpoint 未配置")):
            response = self.client.post(f"/api/video-creation/jobs/{draft_id}/confirm")
        self.assertEqual(response.status_code, 400)
        self.assertIn("endpoint", response.json()["error"])
        with self.Session() as db:
            job = db.get(VideoCreationJob, draft_id)
            self.assertEqual(job.status, "draft")
            self.assertIn("endpoint", job.error)

    def test_iterate_requires_existing_draft(self):
        draft_id = self._create_job(status="draft", svml_text="<svml/>")
        with patch("app.api.video_creation_routes.threading.Thread", _SyncThread), \
                patch("app.core.database.SessionLocal", self.Session), \
                patch("app.services.video_creation_author.iterate_svml",
                      return_value=("<svml v2/>", "改了开头")):
            response = self.client.post(
                f"/api/video-creation/jobs/{draft_id}/iterate",
                json={"feedback": "把开头改快一点"},
            )
        self.assertEqual(response.status_code, 200)
        detail = self.client.get(f"/api/video-creation/jobs/{draft_id}")
        self.assertEqual(detail.json()["data"]["svml_text"], "<svml v2/>")
        self.assertEqual(detail.json()["data"]["status"], "draft")

    def test_cancel_transition_rules(self):
        rendering_id = self._create_job(status="rendering", svml_text="<svml/>")
        done_id = self._create_job(status="completed", svml_text="<svml/>")
        self.assertEqual(
            self.client.post(f"/api/video-creation/jobs/{done_id}/cancel").status_code, 400
        )
        ok = self.client.post(f"/api/video-creation/jobs/{rendering_id}/cancel")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["data"]["status"], "cancelled")

    def test_author_task_discards_result_after_cancel(self):
        job_id = self._create_job(status="cancelled", requirement_text="咖啡科普")
        with patch("app.core.database.SessionLocal", self.Session), \
                patch("app.services.video_creation_author.draft_svml",
                      return_value=("<svml/>", "完成")) as draft:
            _author_task(job_id, "咖啡科普", "")
            draft.assert_not_called()
        with self.Session() as db:
            job = db.get(VideoCreationJob, job_id)
            self.assertEqual(job.status, "cancelled")

    def test_video_endpoint_serves_completed_file(self):
        job_id = self._create_job(status="completed", output_filename="done.mp4")
        directory = hypit_service.job_dir(job_id)
        directory.mkdir(parents=True)
        (directory / "done.mp4").write_bytes(b"fake-mp4")
        response = self.client.get(f"/api/video-creation/jobs/{job_id}/video")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertIn("no-store", response.headers["cache-control"])

        missing = self._create_job(status="rendering", output_filename="")
        self.assertEqual(
            self.client.get(f"/api/video-creation/jobs/{missing}/video").status_code, 404
        )

    def test_admin_config_requires_admin(self):
        def plain_user():
            return SimpleNamespace(id="user-1", is_admin=False)

        self.app.dependency_overrides[get_current_user] = plain_user
        self.assertEqual(
            self.client.get("/api/admin/video-creation-config").status_code, 403
        )

    def test_admin_config_roundtrip(self):
        def admin_user():
            return SimpleNamespace(id="user-1", is_admin=True)

        self.app.dependency_overrides[get_current_admin] = admin_user

        initial = self.client.get("/api/admin/video-creation-config")
        self.assertEqual(initial.status_code, 200)
        self.assertTrue(initial.json()["data"]["env_enabled"])
        self.assertTrue(initial.json()["data"]["admin_enabled"])
        self.assertFalse(initial.json()["data"]["cli_available"])
        self.assertEqual(initial.json()["data"]["api_key_masked"], "")

        saved = self.client.put(
            "/api/admin/video-creation-config",
            json={"admin_enabled": False, "api_key": "hh-test-key-1234"},
        )
        self.assertEqual(saved.status_code, 200)
        data = saved.json()["data"]
        self.assertFalse(data["admin_enabled"])
        self.assertFalse(data["enabled"])
        self.assertTrue(data["api_key_masked"].endswith("1234"))

        with self.Session() as db:
            self.assertEqual(
                settings_service.get_setting(db, "hypit_enabled"), "false"
            )
            self.assertEqual(
                settings_service.get_secret(db, "hypihub_api_key"),
                "hh-test-key-1234",
            )
            logs = db.query(AdminAuditLog).all()
            self.assertEqual(len(logs), 1)
            self.assertEqual(logs[0].action, "video_creation_config_update")

        follow_up = self.client.get("/api/admin/video-creation-config")
        self.assertFalse(follow_up.json()["data"]["admin_enabled"])


if __name__ == "__main__":
    unittest.main()
