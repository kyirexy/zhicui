from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.creator_sync import (
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
)
from app.models.note import Note
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services import creator_connectors, creator_sync_service, platform_library_service
from app.services import library_extraction_service
from app.services import settings_service


class CreatorCatalogServiceTests(unittest.TestCase):
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
                Note.__table__,
                SystemSetting.__table__,
                CreatorSource.__table__,
                CreatorSyncRun.__table__,
                CreatorSourceItem.__table__,
                CreatorSyncRunItem.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(email="catalog@example.com", hashed_password="x")
        self.other = User(email="catalog-other@example.com", hashed_password="x")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        settings_service.set_setting(
            self.db, settings_service.CREATOR_SYNC_ENABLED_KEY, "true",
        )
        settings_service.set_setting(
            self.db, settings_service.CREATOR_SYNC_HEALTH_KEYS["bilibili"], "true",
        )
        self.source = CreatorSource(
            user_id=self.user.id,
            platform="bilibili",
            creator_id="12345",
            profile_url="https://space.bilibili.com/12345/video",
            display_name="目录 UP",
            avatar_url="https://i.example/avatar.jpg",
        )
        self.db.add(self.source)
        self.db.commit()
        self.config = {
            "enabled": True,
            "platforms": {"douyin": True, "bilibili": True, "xiaohongshu": True},
            "concurrency": {"douyin": 1, "bilibili": 2, "xiaohongshu": 1},
            "xhs_cookie": "do-not-persist-cookie",
        }

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _create_run(self, **kwargs):
        with patch.object(creator_sync_service, "_require_catalog_health"):
            return creator_sync_service.create_run(
                self.db,
                user_id=self.user.id,
                source_id=self.source.id,
                **kwargs,
            )

    def _process_with_catalog(self, run_id: str, discover) -> None:
        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=self.config),
            patch.object(creator_connectors, "discover_catalog", side_effect=discover),
        ):
            creator_sync_service.process_run(run_id)

    def test_operations_legacy_compatibility_selection_limit_and_scope(self) -> None:
        legacy, reused = self._create_run(limit=20)
        self.assertFalse(reused)
        self.assertEqual(legacy.operation, "recent_transcript")
        self.assertEqual(legacy.target_count, 20)
        creator_sync_service.request_cancel(
            self.db, user_id=self.user.id, run_id=legacy.id,
        )

        items = [
            CreatorSourceItem(
                user_id=self.user.id,
                source_id=self.source.id,
                platform="bilibili",
                external_id=f"BV{i:04d}",
                source_url=f"https://www.bilibili.com/video/BV{i:04d}",
            )
            for i in range(51)
        ]
        foreign_source = CreatorSource(
            user_id=self.other.id,
            platform="bilibili",
            creator_id="99999",
            profile_url="https://space.bilibili.com/99999/video",
            display_name="其他 UP",
        )
        self.db.add_all([*items, foreign_source])
        self.db.commit()
        foreign_item = CreatorSourceItem(
            user_id=self.other.id,
            source_id=foreign_source.id,
            platform="bilibili",
            external_id="BVFOREIGN",
            source_url="https://www.bilibili.com/video/BVFOREIGN",
        )
        self.db.add(foreign_item)
        self.db.commit()

        with self.assertRaises(creator_sync_service.CreatorSyncError) as too_many:
            self._create_run(
                operation="selected_transcript", item_ids=[item.id for item in items],
            )
        self.assertEqual(too_many.exception.code, "invalid_selection")
        with self.assertRaises(creator_sync_service.CreatorSyncError) as not_owned:
            self._create_run(
                operation="selected_transcript", item_ids=[items[0].id, foreign_item.id],
            )
        self.assertEqual(not_owned.exception.code, "selection_not_owned")

        selected, _ = self._create_run(
            operation="selected_transcript", item_ids=[item.id for item in items[:3]],
        )
        self.assertEqual(selected.requested_limit, 20)
        self.assertEqual(selected.target_count, 3)
        self.assertTrue(selected.discovery_complete)
        self.assertEqual(
            self.db.query(CreatorSyncRunItem).filter_by(run_id=selected.id).count(), 3,
        )

    def test_thousand_item_catalog_is_idempotent_paginated_and_redacted(self) -> None:
        unseen = CreatorSourceItem(
            user_id=self.user.id,
            source_id=self.source.id,
            platform="bilibili",
            external_id="BVUNSEEN",
            source_url="https://www.bilibili.com/video/BVUNSEEN",
        )
        tombstone = CreatorSourceItem(
            user_id=self.user.id,
            source_id=self.source.id,
            platform="bilibili",
            external_id="BVTOMB",
            source_url="https://www.bilibili.com/video/BVTOMB",
            state="removed",
            removed_at=datetime.now(timezone.utc),
            is_available=False,
        )
        self.db.add_all([unseen, tombstone])
        self.db.commit()
        works = [{
            "external_id": "BVTOMB",
            "source_url": "https://www.bilibili.com/video/BVTOMB?token=drop-me",
            "title": "墓碑",
            "cookie": "cookie-secret",
            "media_url": "https://media.example/signed-secret",
        }]
        works.extend({
            "external_id": f"BV{i:06d}",
            "source_url": f"https://www.bilibili.com/video/BV{i:06d}?signed=drop",
            "title": f"作品 {i:06d}",
            "cover_url": f"https://i.example/{i}.jpg",
            "description": "公开简介",
            "author_name": "目录 UP",
            "published_at": 1_800_000_000 - i,
            "duration_seconds": 60 + i % 300,
            "order_index": i,
            "local_path": "C:/secret/video.mp4",
            "authorization": "Bearer secret",
            "binary": b"secret",
        } for i in range(1005))

        def discover(_source, *, on_item, **_kwargs):
            for work in works:
                on_item(work)
            return {
                "items": [],
                "complete": True,
                "total_count": len(works),
                "failures": [],
            }

        first, _ = self._create_run(operation="catalog_all")
        self._process_with_catalog(first.id, discover)
        self.db.expire_all()
        finished = self.db.query(CreatorSyncRun).filter_by(id=first.id).one()
        self.assertEqual(finished.status, "succeeded")
        self.assertEqual(finished.discovered_count, len(works))
        self.assertEqual(finished.total_count, len(works))
        self.assertEqual(
            self.db.query(CreatorSyncRunItem).filter_by(run_id=first.id).count(), 0,
        )
        self.assertFalse(self.db.query(CreatorSourceItem).filter_by(id=unseen.id).one().is_available)
        stored_tombstone = self.db.query(CreatorSourceItem).filter_by(id=tombstone.id).one()
        self.assertEqual(stored_tombstone.state, "removed")
        self.assertFalse(stored_tombstone.is_available)
        page = creator_sync_service.list_source_items(
            self.db,
            user_id=self.user.id,
            source_id=self.source.id,
            page=2,
            per_page=50,
            search="作品",
            status="untranscribed",
        )
        self.assertEqual(page["total"], 1005)
        self.assertEqual(page["total_pages"], 21)
        self.assertEqual(len(page["items"]), 50)

        serialized = str(page).lower()
        self.assertNotIn("cookie-secret", serialized)
        self.assertNotIn("signed-secret", serialized)
        self.assertNotIn("c:/secret", serialized)
        sample = self.db.query(CreatorSourceItem).filter_by(external_id="BV000001").one()
        self.assertNotIn("signed", sample.source_url)
        self.assertEqual(set(sample.safe_parts()), set())

        second, _ = self._create_run(operation="catalog_all")
        self._process_with_catalog(second.id, discover)
        self.db.expire_all()
        second_finished = self.db.query(CreatorSyncRun).filter_by(id=second.id).one()
        self.assertEqual(second_finished.discovered_count, len(works))
        self.assertEqual(
            self.db.query(CreatorSourceItem).filter(
                CreatorSourceItem.source_id == self.source.id,
            ).count(),
            len(works) + 1,
        )

    def test_final_catalog_result_enriches_streamed_multi_part_item(self) -> None:
        streamed = {
            "external_id": "BVENRICH",
            "source_url": "https://www.bilibili.com/video/BVENRICH",
            "title": "多 P",
            "parts": [{
                "cid": "1", "page": 1, "title": "P1",
                "source_url": "https://www.bilibili.com/video/BVENRICH?p=1",
            }],
        }
        final = {
            **streamed,
            "parts": [
                *streamed["parts"],
                {
                    "cid": "2", "page": 2, "title": "P2",
                    "source_url": "https://www.bilibili.com/video/BVENRICH?p=2",
                },
            ],
        }

        def discover(_source, *, on_item, **_kwargs):
            on_item(streamed, 1, 1)
            return {
                "items": [final], "complete": True, "total_count": 1, "failures": [],
            }

        run, _ = self._create_run(operation="catalog_all")
        self._process_with_catalog(run.id, discover)
        self.db.expire_all()
        stored = self.db.query(CreatorSourceItem).filter_by(
            external_id="BVENRICH",
        ).one()
        self.assertEqual([part["page"] for part in stored.safe_parts()], [1, 2])
        finished = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        self.assertEqual(finished.discovered_count, 1)

    def test_partial_scan_preserves_old_availability_and_needs_action_can_retry(self) -> None:
        old = CreatorSourceItem(
            user_id=self.user.id,
            source_id=self.source.id,
            platform="bilibili",
            external_id="BVOLD",
            source_url="https://www.bilibili.com/video/BVOLD",
        )
        self.db.add(old)
        self.db.commit()

        def partial(_source, *, on_item, **_kwargs):
            on_item({
                "external_id": "BVNEW",
                "source_url": "https://www.bilibili.com/video/BVNEW",
                "title": "新作品",
            })
            return {
                "items": [],
                "complete": False,
                "total_count": None,
                "failures": [{"code": "catalog_partial", "message": "部分页面失败"}],
            }

        run, _ = self._create_run(operation="catalog_all")
        self._process_with_catalog(run.id, partial)
        self.db.expire_all()
        self.assertEqual(self.db.query(CreatorSyncRun).filter_by(id=run.id).one().status, "partial")
        self.assertTrue(self.db.query(CreatorSourceItem).filter_by(id=old.id).one().is_available)

        retried_partial, _ = creator_sync_service.retry_run(
            self.db, user_id=self.user.id, run_id=run.id,
        )

        def complete_retry(_source, *, on_item, **_kwargs):
            on_item({
                "external_id": "BVOTHER",
                "source_url": "https://www.bilibili.com/video/BVOTHER",
                "title": "重试中仍存在",
            })
            return {
                "items": [], "complete": True, "total_count": 1, "failures": [],
            }

        self._process_with_catalog(retried_partial.id, complete_retry)
        self.db.expire_all()
        self.assertFalse(
            self.db.query(CreatorSourceItem).filter_by(external_id="BVNEW").one().is_available
        )

        def login_required(*_args, **_kwargs):
            raise creator_connectors.CreatorConnectorError(
                "bilibili_login_required", "登录已失效，请重新连接",
            )

        blocked, _ = self._create_run(operation="catalog_all")
        self._process_with_catalog(blocked.id, login_required)
        self.db.expire_all()
        failed = self.db.query(CreatorSyncRun).filter_by(id=blocked.id).one()
        self.assertEqual(failed.status, "failed")
        self.assertTrue(failed.needs_action)
        self.assertTrue(failed.to_dict()["needs_action"]["required"])
        other_active, _ = self._create_run(operation="catalog_all")
        with self.assertRaises(creator_sync_service.CreatorSyncError) as active_error:
            creator_sync_service.retry_run(
                self.db, user_id=self.user.id, run_id=blocked.id,
            )
        self.assertEqual(active_error.exception.code, "user_run_active")
        creator_sync_service.request_cancel(
            self.db, user_id=self.user.id, run_id=other_active.id,
        )
        retried, reused = creator_sync_service.retry_run(
            self.db, user_id=self.user.id, run_id=blocked.id,
        )
        self.assertFalse(reused)
        self.assertEqual(retried.status, "queued")
        self.assertFalse(retried.needs_action)

    def test_transient_backoff_and_atomic_lease_claim(self) -> None:
        run, _ = self._create_run(operation="catalog_all")

        def unavailable(*_args, **_kwargs):
            raise creator_connectors.CreatorConnectorError(
                "connector_unavailable", "连接器暂不可用",
            )

        self._process_with_catalog(run.id, unavailable)
        self.db.expire_all()
        waiting = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        self.assertEqual(waiting.status, "queued")
        self.assertEqual(waiting.attempt_count, 1)
        self.assertIsNotNone(waiting.next_retry_at)
        with patch.object(creator_sync_service, "SessionLocal", self.Session):
            self.assertNotIn(run.id, creator_sync_service.due_run_ids())
        waiting.next_retry_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.db.commit()
        with patch.object(creator_sync_service, "SessionLocal", self.Session):
            first_token = creator_sync_service._claim_run(run.id)
            second_token = creator_sync_service._claim_run(run.id)
        self.assertIsNotNone(first_token)
        self.assertIsNone(second_token)
        with patch.object(creator_sync_service, "SessionLocal", self.Session):
            self.assertTrue(creator_sync_service._renew_lease(run.id, first_token))
        self.db.expire_all()
        claimed = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        claimed.lease_token = "another-worker"
        self.db.commit()
        with patch.object(creator_sync_service, "SessionLocal", self.Session):
            self.assertFalse(creator_sync_service._renew_lease(run.id, first_token))

    def test_transcript_worker_does_not_write_after_lease_transfer(self) -> None:
        run, _ = self._create_run(limit=20)

        def transfer_lease(_run, _work, **_kwargs):
            with self.Session() as competing_db:
                claimed = competing_db.query(CreatorSyncRun).filter_by(id=run.id).one()
                claimed.lease_token = "new-worker-token"
                claimed.lease_until = datetime.now(timezone.utc) + timedelta(minutes=5)
                competing_db.commit()
            return "imported", "note-from-old-worker"

        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=self.config),
            patch.object(creator_connectors, "discover_works", return_value=[{
                "external_id": "BVLEASE",
                "source_url": "https://www.bilibili.com/video/BVLEASE",
                "media_type": "video",
            }]),
            patch.object(creator_sync_service, "_import_work", side_effect=transfer_lease),
        ):
            creator_sync_service.process_run(run.id)

        self.db.expire_all()
        transferred = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        run_item = self.db.query(CreatorSyncRunItem).filter_by(run_id=run.id).one()
        source_item = self.db.query(CreatorSourceItem).filter_by(
            external_id="BVLEASE",
        ).one()
        self.assertEqual(transferred.lease_token, "new-worker-token")
        self.assertEqual(run_item.state, "importing")
        self.assertIsNone(run_item.note_id)
        self.assertIsNone(source_item.note_id)

    def test_transcript_cancellation_is_not_recorded_as_item_failure(self) -> None:
        run, _ = self._create_run(limit=20)
        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=self.config),
            patch.object(creator_connectors, "discover_works", return_value=[{
                "external_id": "BVCANCELRUN",
                "source_url": "https://www.bilibili.com/video/BVCANCELRUN",
                "media_type": "video",
            }]),
            patch.object(
                creator_sync_service,
                "_import_work",
                side_effect=creator_sync_service._RunCancelled("用户已取消"),
            ),
        ):
            creator_sync_service.process_run(run.id)

        self.db.expire_all()
        cancelled = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        run_item = self.db.query(CreatorSyncRunItem).filter_by(run_id=run.id).one()
        self.assertEqual(cancelled.status, "cancelled")
        self.assertEqual(cancelled.failed_count, 0)
        self.assertNotEqual(run_item.state, "failed")

    def test_recent_discovery_does_not_erase_catalog_metadata_or_parts(self) -> None:
        item = CreatorSourceItem(
            user_id=self.user.id,
            source_id=self.source.id,
            platform="bilibili",
            external_id="BVPRESERVE",
            source_url="https://www.bilibili.com/video/BVPRESERVE",
            title="完整目录标题",
            cover_url="https://i.example/preserve.jpg",
            description="完整目录简介",
            author_name="目录 UP",
            parts_json=(
                '[{"cid":"1","page":1,"title":"P1",'
                '"page_url":"https://www.bilibili.com/video/BVPRESERVE?p=1"}]'
            ),
        )
        self.db.add(item)
        self.db.commit()
        run, _ = self._create_run(limit=20)
        config = self.config
        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=config),
            patch.object(creator_connectors, "discover_works", return_value=[{
                "external_id": "BVPRESERVE",
                "source_url": "https://www.bilibili.com/video/BVPRESERVE",
                "media_type": "video",
            }]),
            patch.object(
                creator_sync_service, "_import_work", return_value=("imported", "note-preserve"),
            ),
        ):
            creator_sync_service.process_run(run.id)
        self.db.expire_all()
        preserved = self.db.query(CreatorSourceItem).filter_by(id=item.id).one()
        self.assertEqual(preserved.title, "完整目录标题")
        self.assertEqual(preserved.description, "完整目录简介")
        self.assertEqual(preserved.safe_parts()[0]["cid"], "1")

    def test_multi_part_transcript_is_ordered_and_saved_once(self) -> None:
        work = {
            "external_id": "BVMULTI",
            "source_url": "https://www.bilibili.com/video/BVMULTI",
            "title": "多 P 教程",
            "parts": [
                {"cid": "2", "page": 2, "title": "进阶", "page_url": "https://www.bilibili.com/video/BVMULTI?p=2"},
                {"cid": "1", "page": 1, "title": "入门", "page_url": "https://www.bilibili.com/video/BVMULTI?p=1"},
            ],
        }
        extracted_urls: list[str] = []

        def extract(url, _db):
            extracted_urls.append(url)
            page = 1 if "p=1" in url else 2
            return (
                {"video_id": f"temporary-{page}", "title": f"part {page}"},
                f"文稿 {page}",
                {
                    "source_url": url,
                    "platform": "bilibili",
                    "cover_url": "https://i0.hdslb.com/cover.jpg",
                    "author_name": "测试 UP",
                    "transcript_source": "manual-subtitle",
                    "speech_ready": True,
                },
            )

        saved: dict[str, object] = {}

        def save(_db, **kwargs):
            saved.update(kwargs)
            return SimpleNamespace(id="note-multi"), False

        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(platform_library_service, "_extract_bilibili", side_effect=extract),
            patch.object(platform_library_service, "_save_or_refresh", side_effect=save) as saver,
        ):
            status, note_id = creator_sync_service._import_bilibili_parts(
                SimpleNamespace(user_id=self.user.id), work,
            )
        self.assertEqual(status, "imported")
        self.assertEqual(note_id, "note-multi")
        self.assertEqual(extracted_urls, [
            "https://www.bilibili.com/video/BVMULTI?p=1",
            "https://www.bilibili.com/video/BVMULTI?p=2",
        ])
        self.assertEqual(saver.call_count, 1)
        self.assertEqual(saved["info"]["video_id"], "BVMULTI")
        transcript = str(saved["transcript"])
        self.assertLess(transcript.index("P1"), transcript.index("P2"))

    def test_multi_part_cancellation_is_not_swallowed_or_saved(self) -> None:
        work = {
            "external_id": "BVCANCEL",
            "source_url": "https://www.bilibili.com/video/BVCANCEL",
            "parts": [
                {"page": 1, "title": "P1", "page_url": "https://www.bilibili.com/video/BVCANCEL?p=1"},
                {"page": 2, "title": "P2", "page_url": "https://www.bilibili.com/video/BVCANCEL?p=2"},
            ],
        }
        cancellation_checks = 0
        extracted_urls: list[str] = []

        def should_cancel() -> bool:
            nonlocal cancellation_checks
            cancellation_checks += 1
            return cancellation_checks >= 2

        def extract(url, _db):
            extracted_urls.append(url)
            return (
                {"video_id": "temporary", "title": "P1"},
                "P1 文稿",
                {
                    "source_url": url,
                    "platform": "bilibili",
                    "cover_url": "https://i0.hdslb.com/cover.jpg",
                    "author_name": "测试 UP",
                    "transcript_source": "manual-subtitle",
                    "speech_ready": True,
                },
            )

        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(platform_library_service, "_extract_bilibili", side_effect=extract),
            patch.object(platform_library_service, "_save_or_refresh") as saver,
        ):
            with self.assertRaises(creator_sync_service._RunCancelled):
                creator_sync_service._import_bilibili_parts(
                    SimpleNamespace(user_id=self.user.id),
                    work,
                    should_cancel=should_cancel,
                )
        self.assertEqual(extracted_urls, [
            "https://www.bilibili.com/video/BVCANCEL?p=1",
        ])
        saver.assert_not_called()

    def test_selected_douyin_uses_safe_in_memory_catalog_item(self) -> None:
        run = SimpleNamespace(
            user_id=self.user.id,
            platform="douyin",
            operation="selected_transcript",
        )
        work = {
            "external_id": "7350000000000000001",
            "source_url": "https://www.douyin.com/video/7350000000000000001?signature=drop",
            "title": "公开标题",
            "cover_url": "https://p.example/cover.jpg",
            "description": "公开简介",
            "author_name": "作者",
            "published_at": datetime(2026, 8, 20, tzinfo=timezone.utc),
            "order_index": 3,
            "media_url": "https://media.example/signed-secret",
            "cookie": "cookie-secret",
        }
        with patch.object(
            library_extraction_service,
            "extract_library_item",
            return_value={"id": "note-douyin", "already_existed": False},
        ) as extract:
            status, note_id = creator_sync_service._import_work(run, work)
        self.assertEqual((status, note_id), ("imported", "note-douyin"))
        passed = extract.call_args.kwargs["item"]
        self.assertTrue(passed["can_extract"])
        self.assertEqual(passed["aweme_id"], work["external_id"])
        self.assertEqual(
            passed["source_url"],
            "https://www.douyin.com/video/7350000000000000001",
        )
        self.assertNotIn("media_url", passed)
        self.assertNotIn("cookie", passed)
        self.assertNotIn("signed-secret", str(passed))

    def test_multi_part_failure_keeps_completed_transcript_for_retry(self) -> None:
        work = {
            "external_id": "BVPARTIAL",
            "source_url": "https://www.bilibili.com/video/BVPARTIAL",
            "title": "部分完成",
            "parts": [
                {"cid": "1", "page": 1, "title": "可用", "page_url": "https://www.bilibili.com/video/BVPARTIAL?p=1"},
                {"cid": "2", "page": 2, "title": "失败", "page_url": "https://www.bilibili.com/video/BVPARTIAL?p=2"},
            ],
        }
        saved: dict[str, object] = {}

        def extract(url, _db):
            if "p=2" in url:
                raise RuntimeError("signed-url=must-not-leak")
            return (
                {"video_id": "temporary", "title": "P1"},
                "已完成的 P1 文稿",
                {
                    "source_url": url,
                    "platform": "bilibili",
                    "cover_url": "https://i0.hdslb.com/cover.jpg",
                    "author_name": "测试 UP",
                    "transcript_source": "manual-subtitle",
                    "speech_ready": True,
                },
            )

        def save(_db, **kwargs):
            saved.update(kwargs)
            return SimpleNamespace(id="note-partial"), False

        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(platform_library_service, "_extract_bilibili", side_effect=extract),
            patch.object(platform_library_service, "_save_or_refresh", side_effect=save),
        ):
            with self.assertRaises(creator_sync_service._PartialImportError) as raised:
                creator_sync_service._import_bilibili_parts(
                    SimpleNamespace(user_id=self.user.id), work,
                )
        self.assertEqual(raised.exception.note_id, "note-partial")
        self.assertIn("已完成的 P1 文稿", str(saved["transcript"]))
        code, message = creator_sync_service._safe_error(raised.exception)
        self.assertEqual(code, "multipart_partial")
        self.assertTrue(creator_sync_service._is_transient(code))
        self.assertNotIn("signed-url", message)


class CreatorConnectorAdminGateTests(unittest.TestCase):
    def test_bilibili_profile_test_keeps_recent_available_when_catalog_is_unhealthy(self) -> None:
        from app.api import routes

        body = routes.CreatorConnectorTestRequest(
            platform="bilibili",
            profile_ref="https://space.bilibili.com/123/video",
        )
        with (
            patch.object(
                routes.settings_service,
                "get_creator_sync_config",
                return_value={"xhs_cookie": ""},
            ),
            patch.object(
                routes.creator_connectors,
                "resolve_creator",
                return_value={"platform": "bilibili", "creator_id": "123"},
            ),
            patch.object(
                routes.creator_connectors,
                "catalog_health",
                return_value={"healthy": False, "supports_catalog_all": False},
            ),
            patch.object(
                routes.settings_service, "record_creator_connector_test",
            ) as record_test,
        ):
            result = routes.admin_test_creator_sync_connector(
                body,
                db=SimpleNamespace(),
                current_user=SimpleNamespace(id="admin-1"),
            )

        self.assertTrue(result["success"])
        self.assertTrue(result["data"]["healthy"])
        self.assertFalse(result["data"]["catalog_healthy"])
        record_test.assert_called_once()
        self.assertTrue(record_test.call_args.kwargs["healthy"])
        self.assertFalse(record_test.call_args.kwargs["catalog_healthy"])

    def test_xiaohongshu_profile_test_keeps_recent_only_health_gate(self) -> None:
        from app.api import routes

        body = routes.CreatorConnectorTestRequest(
            platform="xiaohongshu",
            profile_ref="https://www.xiaohongshu.com/user/profile/abc",
        )
        with (
            patch.object(
                routes.settings_service,
                "get_creator_sync_config",
                return_value={"xhs_cookie": "safe-placeholder"},
            ),
            patch.object(
                routes.creator_connectors,
                "resolve_creator",
                return_value={"platform": "xiaohongshu", "creator_id": "abc"},
            ),
            patch.object(
                routes.creator_connectors, "catalog_health",
            ) as catalog_health,
            patch.object(
                routes.settings_service, "record_creator_connector_test",
            ) as record_test,
        ):
            result = routes.admin_test_creator_sync_connector(
                body,
                db=SimpleNamespace(),
                current_user=SimpleNamespace(id="admin-1"),
            )

        self.assertTrue(result["success"])
        catalog_health.assert_not_called()
        record_test.assert_called_once()
        self.assertTrue(record_test.call_args.kwargs["healthy"])


class CreatorCatalogMigrationTests(unittest.TestCase):
    def test_additive_migration_is_idempotent_and_keeps_legacy_limit_check(self) -> None:
        from app.main import _migrate_creator_sync

        engine = create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE creator_sources ("
                "id VARCHAR(48) PRIMARY KEY, platform VARCHAR(24), "
                "creator_id VARCHAR(192), profile_url VARCHAR(1024), "
                "display_name VARCHAR(160), avatar_url VARCHAR(2048))"
            ))
            conn.execute(text(
                "CREATE TABLE creator_source_items ("
                "id VARCHAR(48) PRIMARY KEY, source_id VARCHAR(48), "
                "external_id VARCHAR(192), state VARCHAR(24), "
                "note_id VARCHAR(36), removed_at TIMESTAMP)"
            ))
            conn.execute(text(
                "CREATE TABLE creator_sync_runs ("
                "id VARCHAR(48) PRIMARY KEY, source_id VARCHAR(48), "
                "requested_limit INTEGER NOT NULL CHECK (requested_limit IN (20,50,100)), "
                "checked_count INTEGER NOT NULL DEFAULT 0)"
            ))
            conn.execute(text(
                "INSERT INTO creator_sources VALUES "
                "('source-1','bilibili','123','https://space.bilibili.com/123',"
                "'UP','https://i.example/avatar.jpg')"
            ))
            conn.execute(text(
                "INSERT INTO creator_sync_runs "
                "(id, source_id, requested_limit, checked_count) "
                "VALUES ('run-1','source-1',20,7)"
            ))
        with engine.begin() as conn:
            _migrate_creator_sync(conn, inspect(engine))
        with engine.begin() as conn:
            _migrate_creator_sync(conn, inspect(engine))
            migrated = conn.execute(text(
                "SELECT operation, target_count, discovered_count, processed_count, "
                "source_snapshot_json FROM creator_sync_runs WHERE id='run-1'"
            )).mappings().one()
            self.assertEqual(migrated["operation"], "recent_transcript")
            self.assertEqual(migrated["target_count"], 20)
            self.assertEqual(migrated["discovered_count"], 7)
            self.assertEqual(migrated["processed_count"], 7)
            self.assertIn('"display_name":"UP"', migrated["source_snapshot_json"])
            with self.assertRaises(IntegrityError):
                conn.execute(text(
                    "INSERT INTO creator_sync_runs "
                    "(id, source_id, requested_limit, checked_count) "
                    "VALUES ('bad','source-1',7,0)"
                ))
        engine.dispose()

    def test_silent_douyin_work_uses_creator_caption_as_text_fallback(self) -> None:
        transcript = library_extraction_service._metadata_transcript_fallback({
            "title": "九秒文字作品",
            "caption": "这里是创作者发布的完整说明，内容足以作为可搜索文稿。",
        })
        self.assertIn("【作品标题】", transcript)
        self.assertIn("九秒文字作品", transcript)
        self.assertIn("【作品发布文案】", transcript)

    def test_caption_fallback_rejects_empty_or_too_short_metadata(self) -> None:
        self.assertEqual(
            library_extraction_service._metadata_transcript_fallback({
                "title": "没有语音",
                "caption": "太短",
            }),
            "",
        )


if __name__ == "__main__":
    unittest.main()
