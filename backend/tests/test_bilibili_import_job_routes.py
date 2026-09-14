"""B站同步短请求接收、任务恢复和账号隔离回归。"""
from __future__ import annotations

import unittest
from unittest.mock import patch

import app.main  # 注册外键模型；不运行生产生命周期。
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import routes
from app.core.auth import get_current_user
from app.core.database import Base, get_db
from app.models.user import User


class BilibiliImportJobRoutesTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.owner = User(id="bili-owner", username="bili-owner", email="owner@example.test", hashed_password="unused")
        self.other = User(id="bili-other", username="bili-other", email="other@example.test", hashed_password="unused")
        self.db.add_all([self.owner, self.other])
        self.db.commit()
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.wake = patch.object(routes.platform_import_job_service.runner, "wake")
        self.wake_mock = self.wake.start()

    def tearDown(self):
        self.wake.stop()
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def login(self, user=None):
        self.app.dependency_overrides[get_current_user] = lambda: user or self.owner

    def payload(self, **overrides):
        return {"urls": ["https://www.bilibili.com/video/BV1xx411c7mD/",
                         "https://www.bilibili.com/video/BV1xx411c7mE/"],
                "source_mode": "collect", "source_synced_at": "2026-09-14T10:00:00Z",
                "source_rank_offset": 0, "source_snapshot_size": 2,
                "source_order_reliable": True, "source_coverage": "limited", **overrides}

    def test_registration_returns_before_any_upstream_extraction(self):
        self.login()
        with patch.object(routes.platform_library_service, "import_one",
                          side_effect=AssertionError("HTTP接收阶段不允许字幕或ASR请求")) as extract:
            response = self.client.post("/api/library/bilibili/import-jobs", json=self.payload())
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        job = response.json()["data"]
        self.assertEqual((job["total"], job["completed"], job["success"], job["pending"]), (2, 0, 0, 2))
        self.assertEqual(job["status"], "queued")
        self.assertTrue(all(item["platform"] == "bilibili" and not item["success"] for item in job["items"]))
        extract.assert_not_called()
        self.wake_mock.assert_called_once()

    def test_identical_registration_recovers_one_durable_job(self):
        self.login()
        first = self.client.post("/api/library/bilibili/import-jobs", json=self.payload())
        second = self.client.post("/api/library/bilibili/import-jobs", json=self.payload())
        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(first.json()["data"]["id"], second.json()["data"]["id"])
        listed = self.client.get("/api/library/bilibili/import-jobs")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.headers["cache-control"], "no-store")
        self.assertEqual(listed.json()["data"]["total"], 1)
        job_id = first.json()["data"]["id"]
        recovered = self.client.get(f"/api/library/bilibili/import-jobs/{job_id}")
        self.assertEqual(recovered.json()["data"]["pending"], 2)

    def test_other_user_cannot_read_or_list_owner_job(self):
        self.login()
        response = self.client.post("/api/library/bilibili/import-jobs", json=self.payload())
        job_id = response.json()["data"]["id"]
        self.login(self.other)
        hidden = self.client.get(f"/api/library/bilibili/import-jobs/{job_id}")
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(self.client.get("/api/library/bilibili/import-jobs").json()["data"]["items"], [])

    def test_all_job_routes_require_authentication(self):
        self.assertEqual(self.client.post("/api/library/bilibili/import-jobs", json=self.payload()).status_code, 401)
        self.assertEqual(self.client.get("/api/library/bilibili/import-jobs").status_code, 401)
        self.assertEqual(self.client.get("/api/library/bilibili/import-jobs/no-such-job").status_code, 401)

    def test_invalid_sources_and_sensitive_extra_fields_are_rejected(self):
        self.login()
        for values in (
            self.payload(urls=["https://www.douyin.com/video/7672579366093622537"]),
            self.payload(urls=["https://bilibili.com.evil.test/video/BV1xx411c7mD"]),
            self.payload(urls=["https://127.0.0.1/video/BV1xx411c7mD"]),
            self.payload(urls=["https://www.bilibili.com/video/BV1xx411c7mD"] * 11),
            self.payload(source_mode="import"),
            self.payload(source_synced_at="2099-01-01T00:00:00Z"),
            self.payload(cookie="must-not-be-accepted"),
        ):
            with self.subTest(values=values):
                response = self.client.post("/api/library/bilibili/import-jobs", json=values)
                self.assertEqual(response.status_code, 422, response.text)
        self.wake_mock.assert_not_called()
        self.assertEqual(self.client.get("/api/library/bilibili/import-jobs").json()["data"]["items"], [])

    def test_list_limit_is_bounded(self):
        self.login()
        for limit in (0, 51):
            self.assertEqual(self.client.get(f"/api/library/bilibili/import-jobs?limit={limit}").status_code, 422)


if __name__ == "__main__":
    unittest.main()
