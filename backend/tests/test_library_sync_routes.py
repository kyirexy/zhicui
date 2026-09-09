from __future__ import annotations

import hashlib
import json
import re
import unittest
from pathlib import Path
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
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_sync import LibrarySyncRun
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger


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
                "client_version": "1.1.4",
                "source_order_reliable": True, "items": [item(first_id), item(second_id)],
            })
            second = self.client.post("/api/library/douyin/local-sync", json={
                "source_mode": "collect", "source_synced_at": "2026-09-09T01:00:00Z",
                "client_version": "1.1.4",
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

    @staticmethod
    def local_payload(ids: list[str], **updates) -> dict:
        value = {
            "source_mode": "collect", "source_synced_at": "2026-09-08T01:00:00Z",
            "client_version": "1.1.4", "source_order_reliable": True,
            "source_coverage": "limited",
            "items": [{
                "video_id": video_id, "source_url": f"https://www.douyin.com/video/{video_id}",
                "title": f"测试资料 {video_id}", "author_name": "测试作者",
                "caption": f"测试文案 {video_id}", "cover_url": "https://p3.douyinpic.com/example.jpg",
                "source_rank": index,
            } for index, video_id in enumerate(ids)],
        }
        value.update(updates)
        return value

    def local_state(self, *, include_runs: bool = True) -> str:
        self.db.expire_all()
        models = [DouyinLocalLibraryItem, VideoSourceLedger, Note, LibraryHiddenItem]
        if include_runs:
            models.append(LibrarySyncRun)
        return json.dumps({
            model.__tablename__: [
                {column.name: getattr(row, column.name) for column in model.__table__.columns}
                for row in self.db.query(model).order_by(model.id).all()
            ]
            for model in models
        }, sort_keys=True, default=str)

    def test_cached_old_client_cannot_overwrite_order_or_advance_watermark(self) -> None:
        self.login()
        first_id, second_id = "7672579366093622501", "7672579366093622502"
        with patch.object(routes.activity_service, "log_activity_safely"):
            for mode in ("collect", "like", "post"):
                baseline = self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                    [first_id, second_id], source_mode=mode,
                ))
                self.assertEqual(baseline.status_code, 200, baseline.text)
                before = self.local_state()
                # 旧窗口仍可能使用缓存网页；新请求时间不能让 1.1.2 的错误排名覆盖已校准数据。
                for version in ("1.1.2", "1.1.3"):
                    stale_client = self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                        [second_id, first_id], source_mode=mode, client_version=version,
                        source_synced_at="2026-09-09T01:00:00Z",
                    ))
                    self.assertEqual(stale_client.status_code, 422, stale_client.text)
                    self.assertIn("升级", stale_client.json()["detail"])
                    self.assertEqual(self.local_state(), before)

    def test_unknown_or_malformed_reliable_client_rejected_before_starting_run(self) -> None:
        self.login()
        versions = ("", "2.0", "1.1.4-old", "2.0.0.9", "v2.0.0", "01.1.4", "1.1.4\n", "2.bad.0")
        for version in versions:
            with self.subTest(version=version), patch.object(
                routes.library_sync_service, "start_run",
            ) as start, patch.object(
                routes.local_douyin_library_service, "ingest_items",
            ) as ingest, patch.object(routes.activity_service, "log_activity_safely"):
                result = self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                    ["7672579366093622501"], client_version=version,
                ))
                self.assertEqual(result.status_code, 422, result.text)
                start.assert_not_called()
                ingest.assert_not_called()

    def test_current_and_future_released_clients_can_update_order(self) -> None:
        self.login()
        ids = ["7672579366093622501", "7672579366093622502"]
        with patch.object(routes.activity_service, "log_activity_safely"):
            for day, version in enumerate(("1.1.4", "1.1.10", "1.2.0", "2.0.0"), start=1):
                expected = ids if day % 2 else list(reversed(ids))
                result = self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                    expected, client_version=version, source_synced_at=f"2026-09-0{day}T01:00:00Z",
                ))
                self.assertEqual(result.status_code, 200, result.text)
                self.db.expire_all()
                rows = routes.local_douyin_library_service.list_items(self.db, user_id=self.user.id, source_mode="collect")
                self.assertEqual([row["aweme_id"] for row in rows], expected)

    def test_older_unreliable_metadata_sync_preserves_ranks_and_imports_unranked(self) -> None:
        self.login()
        first_id, second_id, extra_id = "7672579366093622501", "7672579366093622502", "7672579366093622503"
        with patch.object(routes.activity_service, "log_activity_safely"):
            self.assertEqual(self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                [first_id, second_id],
            )).status_code, 200)
            for version in ("1.1.2", ""):
                result = self.client.post("/api/library/douyin/local-sync", json=self.local_payload(
                    [extra_id, second_id, first_id], client_version=version, source_order_reliable=False,
                    source_synced_at="2026-09-09T01:00:00Z",
                ))
                self.assertEqual(result.status_code, 200, result.text)
                self.db.expire_all()
                rows = routes.local_douyin_library_service.list_items(self.db, user_id=self.user.id, source_mode="collect")
                self.assertEqual([row["aweme_id"] for row in rows], [first_id, second_id, extra_id])
                self.assertEqual([row["source_rank"] for row in rows], [0, 1, None])
                self.assertEqual(rows[0]["source_synced_at"], "2026-09-08T01:00:00Z")

    def test_backend_and_frontend_order_capability_versions_match(self) -> None:
        source = (Path(__file__).resolve().parents[2] / "frontend/src/lib/douyinDesktopSync.ts").read_text(encoding="utf-8")
        match = re.search(r"export const MIN_LOCAL_DOUYIN_DESKTOP_VERSION = '([^']+)'", source)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), routes.local_douyin_library_service.MIN_LOCAL_DOUYIN_DESKTOP_VERSION)

    def test_mid_batch_failure_rolls_back_metadata_and_ranks_then_retries_without_note_or_hide_loss(self) -> None:
        self.login()
        first_id, extra_id = "7672579366093622501", "7672579366093622502"
        self.db.add_all([
            Note(user_id=self.user.id, video_id=first_id, video_title="已编辑的知识标题",
                 video_url=f"https://www.douyin.com/video/{first_id}", transcript_raw="已保存的完整文稿",
                 ai_summary='{"sections":[{"title":"已保存的 AI 内容"}]}',
                 seo_title="已编辑的知识标题", seo_slug="atomic-sync-test", seo_meta="原始说明"),
            LibraryHiddenItem(user_id=self.user.id, aweme_id=first_id, hide_mode="permanent"),
        ])
        self.db.commit()
        with patch.object(routes.activity_service, "log_activity_safely"):
            first = self.client.post("/api/library/douyin/local-sync", json=self.local_payload([first_id]))
            self.assertEqual(first.status_code, 200, first.text)
            before = self.local_state(include_runs=False)
            payload = self.local_payload([first_id, extra_id], source_synced_at="2026-09-09T01:00:00Z")
            payload["items"][0]["title"] = "本次更新的元数据"
            ledger = routes.local_douyin_library_service.video_source_ledger_service
            original_upsert = ledger.upsert_source

            def fail_on_second_item(*args, **kwargs):
                if kwargs["video_id"] == extra_id:
                    raise RuntimeError("模拟批次中途数据库写入失败")
                return original_upsert(*args, **kwargs)

            with patch.object(ledger, "upsert_source", side_effect=fail_on_second_item):
                failed = self.client.post("/api/library/douyin/local-sync", json=payload)
            self.assertEqual(failed.status_code, 500, failed.text)
            self.assertEqual(self.local_state(include_runs=False), before)
            run = self.db.query(LibrarySyncRun).filter_by(status="failed").one()
            self.assertEqual(run.error_code, "sync_failed")
            run_id = run.id
            retried = self.client.post("/api/library/douyin/local-sync", json=payload)
            self.assertEqual(retried.status_code, 200, retried.text)
            self.assertEqual(retried.json()["data"]["created_video_ids"], [extra_id])
            self.db.expire_all()
            run = self.db.get(LibrarySyncRun, run_id)
            self.assertEqual((run.status, run.attempt_count), ("succeeded", 2))
            after = json.loads(self.local_state(include_runs=False))
            prior = json.loads(before)
            self.assertEqual(after["notes"], prior["notes"])
            self.assertEqual(after["library_hidden_items"], prior["library_hidden_items"])


if __name__ == "__main__":
    unittest.main()
