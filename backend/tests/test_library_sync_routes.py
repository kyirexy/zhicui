from __future__ import annotations

import hashlib
import json
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import routes
from app.core.auth import get_current_user
from app.core.database import Base, get_db
from app.models.user import User


class LibrarySyncRoutesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(email="sync-owner@example.com", hashed_password="x")
        self.other = User(email="sync-other@example.com", hashed_password="x")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[get_db] = lambda: self.db
        self.app = app
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def login(self, user: User | None = None) -> None:
        self.app.dependency_overrides[get_current_user] = lambda: user or self.user

    def test_history_requires_auth_and_is_user_scoped_and_not_cacheable(self) -> None:
        self.assertEqual(self.client.get("/api/library/sync-runs").status_code, 401)
        self.login()
        result = {"items": [], "total": 2, "success": 2, "failed": 0, "imported": 1, "reused": 1,
                  "video_ids": ["BV1TEST111", "BV1TEST222"]}
        with patch.object(routes.platform_library_service, "import_many", return_value=result):
            response = self.client.post("/api/library/imports", json={
                "urls": ["https://www.bilibili.com/video/BV1TEST111?token=do-not-store",
                         "https://www.bilibili.com/video/BV1TEST222"],
                "source_mode": "collect", "source_synced_at": "2026-09-09T01:00:00Z",
            })
        self.assertEqual(response.status_code, 200, response.text)
        run_id = response.json()["data"]["sync_run_id"]
        history = self.client.get("/api/library/sync-runs")
        self.assertEqual(history.headers["cache-control"], "no-store")
        record = history.json()["data"]["items"][0]
        self.assertEqual(record["id"], run_id)
        self.assertEqual((record["created"], record["reused"], record["failed_count"]), (1, 1, 0))
        self.assertEqual(record["status"], "succeeded")
        self.assertNotIn("do-not-store", history.text)
        self.assertNotIn("request_fingerprint", record)
        self.login(self.other)
        self.assertEqual(self.client.get("/api/library/sync-runs").json()["data"]["items"], [])
        self.assertEqual(self.client.get("/api/library/sync-runs?limit=51").status_code, 422)

    def test_failed_import_keeps_safe_durable_record(self) -> None:
        self.login()
        with patch.object(routes.platform_library_service, "import_many", side_effect=RuntimeError("private upstream detail")):
            result = self.client.post("/api/library/imports", json={"urls": ["https://www.bilibili.com/video/BV1TEST111"]})
        self.assertEqual(result.status_code, 500)
        history = self.client.get("/api/library/sync-runs")
        record = history.json()["data"]["items"][0]
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error_code"], "sync_failed")
        self.assertNotIn("private upstream detail", history.text)

    def test_duplicate_running_requests_do_not_execute_or_finalize_owner(self) -> None:
        self.login()
        for platform, path, payload, model, executor in (
            ("bilibili", "/api/library/imports", {
                "urls": ["https://www.bilibili.com/video/BV1TEST111"],
                "source_mode": "collect", "source_synced_at": "2026-09-09T01:00:00Z",
            }, routes.PlatformLibraryImportRequest, routes.platform_library_service),
            ("douyin", "/api/library/douyin/local-sync", {
                "source_mode": "collect", "source_synced_at": "2026-09-09T01:00:00Z",
                "items": [{"video_id": "7672579366093622537", "title": "测试资料",
                           "source_url": "https://www.douyin.com/video/7672579366093622537"}],
            }, routes.LocalDouyinLibrarySyncRequest, routes.local_douyin_library_service),
        ):
            with self.subTest(platform=platform):
                body = model.model_validate(payload)
                values = body.urls if platform == "bilibili" else [item.model_dump() for item in body.items]
                encoded = (json.dumps(values, ensure_ascii=False) if platform == "bilibili"
                           else json.dumps(values, ensure_ascii=False, sort_keys=True, default=str))
                run = routes.library_sync_service.start_run(
                    self.db, user_id=self.user.id, platform=platform, source_mode="collect",
                    source_synced_at=body.source_synced_at, requested_count=len(values),
                    coverage=body.source_coverage, order_reliable=body.source_order_reliable,
                    request_fingerprint=hashlib.sha256(encoded.encode()).hexdigest(),
                )
                run_id = run.id
                self.db.expunge(run)
                method = "import_many" if platform == "bilibili" else "ingest_items"
                with patch.object(executor, method) as execute:
                    response = self.client.post(path, json=payload)
                self.assertEqual(response.status_code, 409, response.text)
                execute.assert_not_called()
                records = self.client.get("/api/library/sync-runs").json()["data"]["items"]
                record = next(item for item in records if item["id"] == run_id)
                self.assertEqual(record["status"], "running")
                self.assertIsNone(record["finished_at"])

    def test_local_sync_records_reuse_and_complete_snapshot_preserves_history(self) -> None:
        self.login()
        def item(video_id: str) -> dict:
            return {"video_id": video_id, "source_url": f"https://www.douyin.com/video/{video_id}",
                    "title": "测试资料", "author_name": "测试作者", "caption": "测试发布文案",
                    "cover_url": "https://p3.douyinpic.com/example.jpg", "source_rank": 0}
        first_id, second_id = "7672579366093622537", "7672579366093622538"
        with patch.object(routes.activity_service, "log_activity_safely"):
            first = self.client.post("/api/library/douyin/local-sync", json={
                "source_mode": "collect", "source_synced_at": "2026-09-08T01:00:00Z",
                "source_order_reliable": True, "items": [item(first_id), item(second_id)],
            })
            second = self.client.post("/api/library/douyin/local-sync", json={
                "source_mode": "collect", "source_synced_at": "2026-09-09T01:00:00Z",
                "source_order_reliable": True, "source_coverage": "complete", "items": [item(second_id)],
            })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["data"]["created_video_ids"], [])
        records = self.client.get("/api/library/sync-runs").json()["data"]["items"]
        self.assertEqual(len(records), 2)
        self.assertEqual((records[0]["created"], records[0]["reused"]), (0, 1))
        items = routes.local_douyin_library_service.list_items(self.db, user_id=self.user.id, source_mode="collect")
        self.assertEqual([entry["aweme_id"] for entry in items], [second_id, first_id])


if __name__ == "__main__":
    unittest.main()
