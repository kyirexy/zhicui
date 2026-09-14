from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import routes
from app.core.database import Base
from app.models.douyin_legacy_catalog import DouyinLegacyCatalog
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import douyin_binding_service, douyin_library, douyin_legacy_catalog_service as service
from app.services import library_extraction_service, local_douyin_library_service as local


class DouyinLegacyCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Session()
        self.user = User(email="archive-owner@example.com", hashed_password="x")
        self.other = User(email="archive-other@example.com", hashed_password="x")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.binding = douyin_binding_service.get_or_create(self.db, self.user.id)
        self.other_binding = douyin_binding_service.get_or_create(self.db, self.other.id)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def item(self, video_id="7672579366093622537", mode="like", **updates) -> dict:
        item = {
            "aweme_id": video_id, "source_mode": mode, "title": "历史作品", "caption": "自己的作品文案",
            "author_name": "历史作者", "cover_url": "https://p3.douyinpic.com/history.jpg",
            "source_url": f"https://www.douyin.com/video/{video_id}", "media_type": "video",
            "source_rank": 0, "source_synced_at": "2026-08-01T00:00:00Z",
            "recorded_at": "2026-08-01T00:00:00Z", "can_extract": True,
            "media_url": "https://signed.example/secret-media", "file_paths": ["private-local-path"],
        }
        item.update(updates)
        return item

    def archive(self, items) -> None:
        service.archive_items(self.db, user_id=self.user.id, binding_id=self.binding.id, items=items)

    def listing(self, mode="like", *, tasks=None, user=None, local_only=True, refresh_order=False):
        return routes.list_douyin_library_items(
            background_tasks=tasks, limit=0, mode=mode, sort="collection", refresh_order=refresh_order,
            local_only=local_only, db=self.db, current_user=user or self.user,
        )["data"]

    def test_archive_retains_sources_gallery_and_only_public_fields(self) -> None:
        video, gallery = "7672579366093622537", "7672579366093622538"
        self.archive([self.item(video), self.item(video, "collect"), self.item(
            gallery, "collect", media_type="gallery", gallery_images=["signed-secret-1", "signed-secret-2"],
        )])
        row = self.db.query(DouyinLegacyCatalog).one()
        self.assertNotIn("secret", row.items_json)
        self.assertNotIn("private-local-path", row.items_json)
        stored = json.loads(row.items_json)
        self.assertEqual(len(stored), 3)
        self.assertTrue(all(item["source_rank"] is None for item in stored))
        self.assertEqual(self.db.query(VideoSourceLedger).count(), 0, "归档不能制造新同步水位和排名")
        collected = self.listing("collect")["items"]
        photo = next(item for item in collected if item["aweme_id"] == gallery)
        self.assertEqual(photo["media_type"], "gallery")
        self.assertFalse(photo["can_extract"])
        self.assertEqual(len(photo["gallery_images"]), 2)
        self.assertNotIn("signed-secret", str(photo))
        self.assertEqual(self.listing("like")["total"], 1)
        self.assertEqual(self.listing("collect", user=self.other)["total"], 0)
        self.assertEqual(service.list_items(self.db, user_id=self.other.id, binding_id=self.binding.id), [])

    def test_new_local_video_preserves_old_catalog_without_reading_sidecar(self) -> None:
        old, new = "7672579366093622537", "7672579366093622539"
        self.archive([self.item(old), self.item(new, title="旧目录中的同一作品")])
        local.ingest_items(self.db, user_id=self.user.id, source_mode="like", source_order_reliable=True,
                           items=[{"video_id": new, "source_url": f"https://www.douyin.com/video/{new}",
                                   "title": "新的真实标题", "caption": "新文案", "author_name": "作者",
                                   "cover_url": "https://p3.douyinpic.com/new.jpg"}])
        with patch.object(douyin_library, "list_items") as sidecar:
            result = self.listing(tasks=BackgroundTasks())
        sidecar.assert_not_called()
        self.assertEqual([item["aweme_id"] for item in result["items"]], [new, old])
        self.assertEqual(result["items"][0]["title"], "新的真实标题")
        self.assertIsNone(result["items"][1]["source_rank"])
        self.assertFalse(result["catalog_recovery_pending"])
        self.archive([])
        self.assertEqual(self.listing()["total"], 2, "后续空目录不能删除历史")

    def test_initial_legacy_read_archives_all_categories_before_local_ingest(self) -> None:
        with patch.object(douyin_library, "list_items", return_value=[
            self.item(), self.item("7672579366093622538", "collect"),
        ]) as sidecar:
            result = self.listing(local_only=False)
        self.assertEqual(result["total"], 1)
        self.assertTrue(sidecar.call_args.kwargs["preserve_sources"])
        self.assertNotIn("mode", sidecar.call_args.kwargs)
        with patch.object(douyin_library, "list_items") as sidecar:
            self.assertEqual(self.listing("collect")["total"], 1)
        sidecar.assert_not_called()

    def test_background_recovery_does_not_block_list_and_runs_once_per_binding(self) -> None:
        tasks = BackgroundTasks()
        with patch.object(douyin_library, "list_items", return_value=[self.item()]) as sidecar:
            initial = self.listing(tasks=tasks)
            sidecar.assert_not_called()
            self.assertTrue(initial["catalog_recovery_pending"])
            self.assertEqual(len(tasks.tasks), 1)
            duplicate = BackgroundTasks()
            self.listing(tasks=duplicate)
            self.assertEqual(duplicate.tasks, [])
            with patch.object(service, "SessionLocal", self.Session):
                task = tasks.tasks[0]
                task.func(*task.args, **task.kwargs)
            self.assertEqual(sidecar.call_count, 1)
        done = BackgroundTasks()
        result = self.listing(tasks=done)
        self.assertEqual(result["total"], 1)
        self.assertFalse(result["catalog_recovery_pending"])
        self.assertEqual(done.tasks, [])

    def test_failed_recovery_keeps_history_and_is_retryable_after_delay(self) -> None:
        tasks = BackgroundTasks()
        self.listing(tasks=tasks)
        with patch.object(service, "SessionLocal", self.Session), patch.object(
            douyin_library, "list_items", side_effect=douyin_library.DouyinLibraryError("offline"),
        ):
            service.recover(self.user.id, self.binding.id)
        self.db.expire_all()
        row = self.db.query(DouyinLegacyCatalog).one()
        self.assertIsNone(row.completed_at, "失败不能标记恢复成功")
        self.assertFalse(service.claim_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id))
        future = datetime.now(timezone.utc) + timedelta(minutes=6)
        with patch.object(service, "_now", return_value=future):
            self.assertTrue(service.claim_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id))

    def test_recovery_rechecks_binding_after_sidecar_response(self) -> None:
        def replaced_binding(*_args, **_kwargs):
            with self.Session() as db:
                binding = db.get(type(self.binding), self.binding.id)
                binding.session_scope = "replacement-scope"
                db.commit()
            return [self.item()]
        service.claim_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id)
        with patch.object(service, "SessionLocal", self.Session), patch.object(
            douyin_library, "list_items", side_effect=replaced_binding,
        ):
            service.recover(self.user.id, self.binding.id)
        self.db.expire_all()
        row = self.db.query(DouyinLegacyCatalog).one()
        self.assertIsNone(row.completed_at)
        self.assertEqual(json.loads(row.items_json), [])

    def test_manifest_snapshot_keeps_multiple_source_memberships(self) -> None:
        with patch.object(douyin_library, "_load_normalized_items", return_value=[
            self.item(), self.item(mode="collect"), self.item(mode="collect"),
        ]):
            items = douyin_library.list_items("scope", "binding", preserve_sources=True)
        self.assertEqual({item["source_mode"] for item in items}, {"like", "collect"})
        self.assertEqual(len(items), 2)

    def test_empty_completed_archive_does_not_requery_until_explicit_legacy_sync(self) -> None:
        self.archive([])
        with patch.object(douyin_library, "list_items") as sidecar:
            self.assertEqual(self.listing(local_only=False)["total"], 0)
        sidecar.assert_not_called()
        service.invalidate_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id)
        # 旧版显式同步成功后先保存本批新增，下次后台补完整目录；保留历史。
        service.archive_items(self.db, user_id=self.user.id, binding_id=self.binding.id,
                              items=[self.item()], complete=False)
        self.assertTrue(service.recovery_pending(self.db, user_id=self.user.id, binding_id=self.binding.id))
        self.assertEqual(self.listing()["total"], 1)
        self.assertTrue(service.claim_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id))

    def test_extraction_prefetch_uses_archive_without_reloading_the_connector_catalog(self) -> None:
        item = self.item()
        self.archive([item])
        with patch.object(library_extraction_service, "SessionLocal", self.Session), patch.object(
            douyin_library, "list_items",
        ) as sidecar:
            values = library_extraction_service._prefetch_items(self.user.id, {item["aweme_id"]})
        sidecar.assert_not_called()
        self.assertEqual(set(values), {item["aweme_id"]})
        self.assertEqual(values[item["aweme_id"]]["source_mode"], "like")

    def ingest(self, ids):
        return local.ingest_items(
            self.db, user_id=self.user.id, source_mode="collect", source_order_reliable=True,
            items=[{
                "video_id": video_id, "source_url": f"https://www.douyin.com/video/{video_id}",
                "title": "桌面确认的最新标题", "caption": "作品文案", "author_name": "作者",
                "cover_url": "https://p3.douyinpic.com/new.jpg", "source_rank": index,
            } for index, video_id in enumerate(ids)],
        )

    def test_ingest_counts_current_binding_archived_video_as_reused_across_categories(self) -> None:
        old, new = "7672579366093622537", "7672579366093622539"
        self.archive([self.item(old, "like")])
        with patch.object(douyin_library, "list_items") as sidecar:
            result = self.ingest([old, new])
        sidecar.assert_not_called()
        self.assertEqual((result["accepted"], result["created"], result["reused"]), (2, 1, 1))
        self.assertEqual(result["created_video_ids"], [new])
        self.assertEqual(result["video_ids"], [old, new])
        items = local.list_items(self.db, user_id=self.user.id, source_mode="collect")
        self.assertEqual([item["aweme_id"] for item in items], [old, new])
        self.assertTrue(all(item["title"] == "桌面确认的最新标题" for item in items))

    def test_ingest_never_borrows_another_user_or_inactive_bindings_archive(self) -> None:
        peer, retired = "7672579366093622540", "7672579366093622541"
        service.archive_items(self.db, user_id=self.other.id, binding_id=self.other_binding.id,
                              items=[self.item(peer)])
        self.db.add(DouyinLegacyCatalog(user_id=self.user.id, binding_id="retired-binding",
                                       items_json=json.dumps([service._public_item(self.item(retired))])))
        self.db.commit()
        result = self.ingest([peer, retired])
        self.assertEqual((result["created"], result["reused"]), (2, 0))
        self.assertEqual(result["created_video_ids"], [peer, retired])
        # 即使归档的 user_id 错误指向当前用户，绑定仍必须属于同一个用户。
        misplaced = "7672579366093622542"
        other_row = self.db.get(DouyinLegacyCatalog, self.other_binding.id)
        other_row.user_id = self.user.id
        other_row.items_json = json.dumps([service._public_item(self.item(misplaced))])
        self.db.commit()
        self.assertEqual(self.ingest([misplaced])["created_video_ids"], [misplaced])
        wrong_owner = "7672579366093622545"
        self.db.add(DouyinLegacyCatalog(
            user_id=self.other.id, binding_id=self.binding.id,
            items_json=json.dumps([service._public_item(self.item(wrong_owner))]),
        ))
        self.db.commit()
        self.assertEqual(self.ingest([wrong_owner])["created_video_ids"], [wrong_owner])

    def test_pending_archive_uses_only_known_ids_and_never_waits_for_recovery(self) -> None:
        known, unknown = "7672579366093622543", "7672579366093622544"
        service.claim_recovery(self.db, user_id=self.user.id, binding_id=self.binding.id)
        service.archive_items(self.db, user_id=self.user.id, binding_id=self.binding.id,
                              items=[self.item(known)], complete=False)
        self.assertTrue(service.recovery_pending(self.db, user_id=self.user.id, binding_id=self.binding.id))
        with patch.object(service, "recover") as recover, patch.object(douyin_library, "list_items") as sidecar:
            result = self.ingest([known, unknown])
        recover.assert_not_called()
        sidecar.assert_not_called()
        self.assertEqual((result["created"], result["reused"]), (1, 1))
        self.assertEqual(result["created_video_ids"], [unknown])

    def test_explicit_legacy_refresh_bypasses_archive_and_persists_new_metadata_without_deleting_history(self) -> None:
        old, history, new = "7672579366093622550", "7672579366093622551", "7672579366093622552"
        self.archive([self.item(old), self.item(history)])
        with patch.object(douyin_library, "refresh_source_order") as refresh, patch.object(
            douyin_library, "list_items", return_value=[
                self.item(new, title="新读取的作品", source_rank=0),
                self.item(old, title="更新后的标题", source_rank=1),
            ],
        ) as sidecar:
            result = self.listing(local_only=False, refresh_order=True)
        refresh.assert_called_once_with(self.binding.session_scope, "like")
        sidecar.assert_called_once()
        self.assertEqual([item["aweme_id"] for item in result["items"]], [new, old, history])
        with patch.object(douyin_library, "list_items") as sidecar:
            saved = self.listing()["items"]
        sidecar.assert_not_called()
        self.assertEqual({item["aweme_id"] for item in saved}, {old, history, new})
        self.assertEqual(next(item for item in saved if item["aweme_id"] == old)["title"], "更新后的标题")
        self.assertTrue(all(item["source_rank"] is None for item in saved))
        self.assertEqual(self.db.query(VideoSourceLedger).count(), 0)

    def test_refresh_failure_keeps_archive_and_local_only_never_refreshes_legacy(self) -> None:
        self.archive([self.item()])
        with patch.object(douyin_library, "refresh_source_order", side_effect=douyin_library.DouyinLibraryError(
            "private-upstream-error",
        )) as refresh, patch.object(douyin_library, "list_items") as sidecar:
            result = self.listing(local_only=False, refresh_order=True)
            self.assertEqual(result["total"], 1)
            self.assertNotIn("private-upstream-error", result["catalog_warning"])
            refresh.assert_called_once()
            sidecar.assert_not_called()
            self.listing(local_only=True, refresh_order=True)
            refresh.assert_called_once()

    def test_details_prefer_local_then_archive_and_do_not_wait_for_legacy(self) -> None:
        local_id, archived_id = "7672579366093622553", "7672579366093622554"
        self.archive([self.item(local_id, "collect"), self.item(archived_id)])
        self.ingest([local_id])
        with patch.object(douyin_library, "get_item") as sidecar:
            current = routes.get_douyin_library_item(aweme_id=local_id, db=self.db, current_user=self.user)["data"]
            archived = routes.get_douyin_library_item(aweme_id=archived_id, db=self.db, current_user=self.user)["data"]
        sidecar.assert_not_called()
        self.assertEqual(current["item"]["title"], "桌面确认的最新标题")
        self.assertEqual(archived["item"]["title"], "历史作品")
        self.assertTrue(archived["item"]["media_url"])
        self.assertIsNone(archived["note"])
        with patch.object(douyin_library, "get_item", return_value=None) as sidecar:
            with self.assertRaises(HTTPException) as denied:
                routes.get_douyin_library_item(aweme_id=archived_id, db=self.db, current_user=self.other)
        self.assertEqual(denied.exception.status_code, 404)
        sidecar.assert_called_once_with(self.other_binding.session_scope, self.other_binding.id, archived_id)

    def test_uncached_detail_still_uses_current_users_legacy_connector(self) -> None:
        item = self.item()
        with patch.object(douyin_library, "get_item", return_value=item) as sidecar:
            result = routes.get_douyin_library_item(aweme_id=item["aweme_id"], db=self.db, current_user=self.user)
        self.assertEqual(result["data"]["item"]["aweme_id"], item["aweme_id"])
        sidecar.assert_called_once_with(self.binding.session_scope, self.binding.id, item["aweme_id"])

    def test_signed_cover_uses_current_bindings_archived_public_url(self) -> None:
        item = self.item()
        self.archive([item])
        with patch.object(douyin_library, "verify_cover_signature", return_value=True), patch.object(
            routes, "_proxy_douyin_image",
        ) as proxy:
            routes.stream_douyin_library_cover(
                aweme_id=item["aweme_id"], expires=1, signature="x" * 64,
                binding=self.binding.id, db=self.db,
            )
            self.assertEqual(proxy.call_args.kwargs["fallback_url"], item["cover_url"])
            self.assertEqual(proxy.call_args.args[1], self.binding.session_scope)
            routes.stream_douyin_library_cover(
                aweme_id=item["aweme_id"], expires=1, signature="x" * 64,
                binding=self.other_binding.id, db=self.db,
            )
            self.assertEqual(proxy.call_args.kwargs["fallback_url"], "")
        with patch.object(douyin_library, "verify_cover_signature", return_value=False), patch.object(
            routes, "_proxy_douyin_image",
        ) as proxy:
            with self.assertRaises(HTTPException) as denied:
                routes.stream_douyin_library_cover(
                    aweme_id=item["aweme_id"], expires=1, signature="x" * 64,
                    binding=self.binding.id, db=self.db,
                )
        self.assertEqual(denied.exception.status_code, 403)
        proxy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
