from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_sync import LibrarySyncRun
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import (
    douyin_library,
    library_extraction_service,
    local_douyin_library_service,
)


class LocalDouyinLibraryTests(unittest.TestCase):
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
                Plan.__table__,
                DouyinLocalLibraryItem.__table__,
                VideoSourceLedger.__table__,
                LibrarySyncRun.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Session()
        self.user_a = User(email="local-a@example.com", hashed_password="x")
        self.user_b = User(email="local-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def item(video_id: str = "7672579366093622537", **updates) -> dict:
        value = {
            "video_id": video_id,
            "source_url": f"https://www.douyin.com/video/{video_id}",
            "title": "测试作品",
            "caption": "这是一段用于测试的作品发布文案",
            "author_name": "测试作者",
            "cover_url": "https://p3.douyinpic.com/example.jpg",
            "published_at": "2026-08-27T08:00:00Z",
            "duration_seconds": 23,
            "source_rank": 0,
        }
        value.update(updates)
        return value

    def test_ingest_is_idempotent_and_user_scoped(self) -> None:
        first = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item()],
        )
        second = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(title="更新后的标题")],
        )
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_b.id,
            source_mode="collect",
            items=[self.item(title="另一个用户的标题")],
        )

        self.assertEqual(first["created"], 1)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["reused"], 1)
        a_items = local_douyin_library_service.list_items(
            self.db, user_id=self.user_a.id, source_mode="like",
        )
        b_items = local_douyin_library_service.list_items(
            self.db, user_id=self.user_b.id, source_mode="collect",
        )
        self.assertEqual(a_items[0]["title"], "更新后的标题")
        self.assertEqual(b_items[0]["title"], "另一个用户的标题")
        self.assertEqual(a_items[0]["provider"], "desktop-local")

    def test_new_snapshot_prefix_does_not_mix_with_old_rank_zero(self) -> None:
        old = datetime(2026, 8, 1, tzinfo=timezone.utc)
        new = datetime(2026, 8, 2, tzinfo=timezone.utc)
        a, b, c = '7672579366093622537', '7672579366093622538', '7672579366093622539'
        local_douyin_library_service.ingest_items(self.db, user_id=self.user_a.id,
            source_mode='collect', source_synced_at=old, source_order_reliable=True,
            items=[self.item(a, source_rank=0), self.item(b, source_rank=1)])
        local_douyin_library_service.ingest_items(self.db, user_id=self.user_a.id,
            source_mode='collect', source_synced_at=new, source_order_reliable=True,
            items=[self.item(c, source_rank=0), self.item(b, source_rank=1)])
        rows = local_douyin_library_service.list_items(self.db, user_id=self.user_a.id, source_mode='collect')
        self.assertEqual([item['aweme_id'] for item in rows], [c, b, a])

    def test_delayed_snapshot_and_transcript_observation_cannot_reset_rank(self) -> None:
        from app.services import video_source_ledger_service as ledger
        old = datetime(2026, 8, 1, tzinfo=timezone.utc)
        new = datetime(2026, 8, 2, tzinfo=timezone.utc)
        video = '7672579366093622537'
        for stamp, rank in [(new, 3), (old, 0)]:
            local_douyin_library_service.ingest_items(self.db, user_id=self.user_a.id,
                source_mode='like', source_synced_at=stamp, source_order_reliable=True,
                items=[self.item(video, source_rank=rank)])
        ledger.upsert_source(self.db, user_id=self.user_a.id, video_id=video, source_mode='like')
        self.db.expire_all()
        row = self.db.query(VideoSourceLedger).filter_by(user_id=self.user_a.id, video_id=video).one()
        self.assertEqual(row.source_rank, 3)
        self.assertEqual(row.source_synced_at.replace(tzinfo=timezone.utc), new)

    def test_complete_snapshot_preserves_all_previous_source_memberships(self) -> None:
        old = datetime(2026, 8, 1, tzinfo=timezone.utc)
        new = datetime(2026, 8, 2, tzinfo=timezone.utc)
        a, b = '7672579366093622537', '7672579366093622538'
        for mode in ['collect', 'like']:
            local_douyin_library_service.ingest_items(self.db, user_id=self.user_a.id, source_mode=mode,
                source_synced_at=old, items=[self.item(a), self.item(b, source_rank=1)])
        local_douyin_library_service.ingest_items(self.db, user_id=self.user_a.id, source_mode='collect',
            source_synced_at=new, source_coverage='complete', source_order_reliable=True, items=[self.item(b)])
        self.assertEqual(self.db.query(VideoSourceLedger).filter_by(source_mode='collect').count(), 2)
        self.assertEqual(self.db.query(VideoSourceLedger).filter_by(source_mode='like').count(), 2)
        self.assertEqual(self.db.query(DouyinLocalLibraryItem).count(), 2)
        rows = local_douyin_library_service.list_items(self.db, user_id=self.user_a.id, source_mode='collect')
        self.assertEqual([item['aweme_id'] for item in rows], [b, a])

    def test_older_snapshot_cannot_insert_previously_unseen_video(self) -> None:
        current, stale = '7672579366093622537', '7672579366093622538'
        local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode='collect',
            source_synced_at=datetime(2026, 9, 8, tzinfo=timezone.utc), items=[self.item(current)],
        )
        result = local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode='collect',
            source_synced_at=datetime(2026, 9, 7, tzinfo=timezone.utc), items=[self.item(stale)],
            source_coverage='complete', source_order_reliable=True,
        )
        self.assertTrue(result['stale_snapshot'])
        self.assertEqual(result['accepted'], 0)
        self.assertEqual(self.db.query(DouyinLocalLibraryItem).count(), 1)
        self.assertEqual(self.db.query(VideoSourceLedger).count(), 1)

    def test_started_empty_snapshot_blocks_old_data_before_any_ledger_exists(self) -> None:
        from app.services import library_sync_service
        library_sync_service.start_run(
            self.db, user_id=self.user_a.id, platform="douyin", source_mode="collect",
            source_synced_at="2026-09-08T00:00:00Z", requested_count=0,
            coverage="complete", order_reliable=True,
        )
        result = local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="collect", items=[self.item()],
            source_synced_at=datetime(2026, 9, 7, tzinfo=timezone.utc), source_order_reliable=True,
        )
        self.assertTrue(result["stale_snapshot"])
        self.assertEqual(result["created_video_ids"], [])
        self.assertEqual(self.db.query(DouyinLocalLibraryItem).count(), 0)

    def test_unreliable_snapshot_keeps_confirmed_order_and_new_items_unranked(self) -> None:
        first, second, unknown = "7672579366093622501", "7672579366093622502", "7672579366093622503"
        initial = local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="collect", source_order_reliable=True,
            source_synced_at=datetime(2026, 9, 6, tzinfo=timezone.utc),
            items=[self.item(first, source_rank=0), self.item(second, source_rank=1)],
        )
        result = local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="collect", source_order_reliable=False,
            source_synced_at=datetime(2026, 9, 7, tzinfo=timezone.utc),
            items=[self.item(video, source_rank=index, title=video, caption=video)
                   for index, video in enumerate([unknown, second, first])],
        )
        self.assertEqual(initial["created_video_ids"], [first, second])
        self.assertEqual(result["created_video_ids"], [unknown])
        for stamp in (7, 8):
            local_douyin_library_service.ingest_items(
                self.db, user_id=self.user_a.id, source_mode="collect", source_order_reliable=False,
                source_synced_at=datetime(2026, 9, stamp, tzinfo=timezone.utc),
                items=[self.item(unknown, source_rank=0)],
            )
        self.db.expire_all()
        rows = local_douyin_library_service.list_items(self.db, user_id=self.user_a.id, source_mode="collect")
        self.assertEqual([row["aweme_id"] for row in rows], [first, second, unknown])
        self.assertEqual([row["source_rank"] for row in rows], [0, 1, None])
        self.assertEqual(rows[0]["source_synced_at"], "2026-09-06T00:00:00Z")
        self.assertEqual(rows[1]["source_synced_at"], "2026-09-06T00:00:00Z")

    def test_sensitive_and_noncanonical_fields_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "不得包含"):
            local_douyin_library_service.ingest_items(
                self.db,
                user_id=self.user_a.id,
                source_mode="like",
                items=[self.item(cookie="sessionid=secret")],
            )
        with self.assertRaises(ValueError):
            local_douyin_library_service.ingest_items(
                self.db,
                user_id=self.user_a.id,
                source_mode="like",
                items=[self.item(source_url="https://example.com/video/7672579366093622537")],
            )

    def _legacy_route_items(self, items: list[dict], *, limit: int = 0, mode: str = "like") -> list[dict]:
        from app.api import routes
        with (
            patch.object(routes.douyin_binding_service, "get_or_create", return_value=SimpleNamespace(
                id="dyb-0123456789abcdef0123", session_scope="S" * 32,
            )),
            patch.object(local_douyin_library_service, "list_items", return_value=[]),
            patch.object(douyin_library, "list_items", return_value=items),
            patch.object(routes.library_hidden_service, "list_hidden_modes", return_value={}),
            patch.object(routes.library_hidden_service, "count_hidden", return_value=0),
        ):
            response = routes.list_douyin_library_items(
                limit=limit, mode=mode, sort="collection", refresh_order=False,
                local_only=False, db=self.db, current_user=self.user_a,
            )
        return response["data"]["items"]

    def test_route_uses_matching_ledger_before_limiting_preview(self) -> None:
        first, second = "7672579366093622501", "7672579366093622502"
        local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="like",
            source_synced_at=datetime(2026, 9, 2, tzinfo=timezone.utc),
            source_order_reliable=True,
            items=[self.item(first, source_rank=0), self.item(second, source_rank=1)],
        )
        stale_items = [
            {**self.item(second), "aweme_id": second, "source_mode": "like", "source_rank": 0,
             "source_synced_at": "2026-09-01T00:00:00Z"},
            {**self.item(first), "aweme_id": first, "source_mode": "like", "source_rank": 1,
             "source_synced_at": "2026-09-01T00:00:00Z"},
        ]
        result = self._legacy_route_items(stale_items, limit=1)
        self.assertEqual([item["aweme_id"] for item in result], [first])
        self.assertEqual(result[0]["source_rank"], 0)
        self.assertEqual(result[0]["source_synced_at"], "2026-09-02T00:00:00Z")

    def test_route_does_not_borrow_other_modes_ledger_time(self) -> None:
        old_id, new_id = "7672579366093622501", "7672579366093622502"
        local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="collect",
            source_synced_at=datetime(2026, 9, 3, tzinfo=timezone.utc),
            items=[self.item(old_id)],
        )
        result = self._legacy_route_items([
            {**self.item(old_id), "aweme_id": old_id, "source_mode": "like", "source_rank": 0,
             "source_synced_at": "2026-09-01T00:00:00Z"},
            {**self.item(new_id), "aweme_id": new_id, "source_mode": "like", "source_rank": 1,
             "source_synced_at": "2026-09-02T00:00:00Z"},
        ])
        self.assertEqual([item["aweme_id"] for item in result], [new_id, old_id])
        self.assertEqual(result[1]["source_synced_at"], "2026-09-01T00:00:00Z")
        self.assertNotIn("source_ledger", result[1])

    def test_route_preserves_newer_connector_snapshot_than_ledger(self) -> None:
        first, second = "7672579366093622501", "7672579366093622502"
        local_douyin_library_service.ingest_items(
            self.db, user_id=self.user_a.id, source_mode="like",
            source_synced_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            source_order_reliable=True,
            items=[self.item(second, source_rank=0), self.item(first, source_rank=1)],
        )
        result = self._legacy_route_items([
            {**self.item(second), "aweme_id": second, "source_mode": "like", "source_rank": 1,
             "source_synced_at": "2026-09-02T00:00:00Z"},
            {**self.item(first), "aweme_id": first, "source_mode": "like", "source_rank": 0,
             "source_synced_at": "2026-09-02T00:00:00Z"},
        ])
        self.assertEqual([item["aweme_id"] for item in result], [first, second])
        self.assertEqual(result[0]["source_rank"], 0)
        self.assertEqual(result[0]["source_synced_at"], "2026-09-02T00:00:00Z")

    def test_legacy_catalog_sorts_latest_batch_before_rank_for_all_modes(self) -> None:
        for mode in ("like", "collect", "post", None):
            with self.subTest(mode=mode):
                items = [
                    {"aweme_id": "old", "source_mode": mode, "source_rank": 0, "source_synced_at": "2026-09-01T00:00:00Z"},
                    {"aweme_id": "second", "source_mode": mode, "source_rank": 1, "source_synced_at": "2026-09-02T00:00:00Z"},
                    {"aweme_id": "first", "source_mode": mode, "source_rank": 0, "source_synced_at": "2026-09-02T00:00:00Z"},
                ]
                with patch.object(douyin_library, "_load_normalized_items", return_value=items):
                    result = douyin_library.list_items("scope", "binding", 2, mode=mode)
                self.assertEqual([item["aweme_id"] for item in result], ["first", "second"])

    def test_repeated_page_text_is_not_saved_as_multiple_video_captions(self) -> None:
        repeated = "热门：这是页面级推荐文字，不属于列表中的任何一条作品，不能重复写入资料库"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[
                self.item(
                    video_id=f"76725793660936225{index}",
                    title=repeated,
                    caption=repeated,
                    author_name="",
                    cover_url="",
                    published_at="",
                    duration_seconds=0,
                    source_rank=index,
                )
                for index in range(3)
            ],
        )
        items = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )
        self.assertEqual(items, [])
        stored = self.db.execute(
            select(DouyinLocalLibraryItem).where(
                DouyinLocalLibraryItem.user_id == self.user_a.id,
            )
        ).scalars().all()
        self.assertEqual(len(stored), 3)
        self.assertTrue(all(not item.available for item in stored))

        recovered_id = "767257936609362250"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(video_id=recovered_id, source_rank=0)],
        )
        recovered = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )
        self.assertEqual([item["id"] for item in recovered], [recovered_id])
        self.assertEqual(recovered[0]["title"], "测试作品")

    def test_title_only_dom_snapshot_is_quarantined_until_metadata_recovers(self) -> None:
        video_id = "7672579366093622511"
        first = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(
                video_id=video_id,
                title="真实但只有 DOM 能看到的作品标题",
                caption="真实但只有 DOM 能看到的作品标题",
                author_name="",
                cover_url="",
                published_at="",
                duration_seconds=0,
            )],
        )

        self.assertEqual(first["ready"], 0)
        self.assertEqual(first["quarantined"], 1)
        self.assertEqual(local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        ), [])

        recovered = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(video_id=video_id)],
        )
        items = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )

        self.assertEqual(recovered["ready"], 1)
        self.assertEqual(recovered["quarantined"], 0)
        self.assertEqual([item["id"] for item in items], [video_id])
        self.assertEqual(items[0]["author_name"], "测试作者")
        self.assertEqual(items[0]["cover_url"], "https://p3.douyinpic.com/example.jpg")

    def test_lower_quality_retry_cannot_regress_complete_snapshot(self) -> None:
        video_id = "7672579366093622512"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="collect",
            items=[self.item(video_id=video_id)],
        )
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="collect",
            items=[self.item(
                video_id=video_id,
                title="DOM 兜底标题",
                caption="DOM 兜底标题",
                author_name="",
                cover_url="",
                published_at="",
                duration_seconds=0,
            )],
        )

        item = local_douyin_library_service.get_item(
            self.db,
            user_id=self.user_a.id,
            video_id=video_id,
        )
        self.assertIsNotNone(item)
        self.assertEqual(item["title"], "测试作品")
        self.assertEqual(item["caption"], "这是一段用于测试的作品发布文案")
        self.assertEqual(item["author_name"], "测试作者")
        self.assertEqual(item["cover_url"], "https://p3.douyinpic.com/example.jpg")

    def test_local_item_uses_bound_sidecar_for_transcript_extraction(self) -> None:
        item = self.item()
        session_scope = "s" * 32
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="post",
            items=[item],
        )
        self.db.close()
        with (
            patch.object(library_extraction_service, "SessionLocal", self.Session),
            patch.object(
                library_extraction_service.douyin_binding_service,
                "get_or_create",
                return_value=SimpleNamespace(id="binding", session_scope=session_scope),
            ),
            patch.object(
                library_extraction_service.douyin_library,
                "get_item",
                side_effect=douyin_library.DouyinLibraryError("sidecar blocked"),
            ),
            patch.object(
                library_extraction_service.settings_service,
                "get_asr_config",
                return_value={"api_key": "key", "api_base_url": "https://asr.example", "model": "asr"},
            ),
            patch.object(
                library_extraction_service.video_extractor,
                "parse_video_info",
            ) as parse_video,
            patch.object(
                library_extraction_service.video_extractor,
                "extract_media_url_transcript",
                return_value="这是从视频语音提取出的完整文案",
            ) as transcribe,
        ):
            result = library_extraction_service.extract_library_item(
                user_id=self.user_a.id,
                aweme_id=item["video_id"],
                operation="transcript",
            )

        parse_video.assert_not_called()
        self.assertEqual(
            transcribe.call_args.args[0],
            library_extraction_service.douyin_library.companion_media_url(
                item["video_id"]
            ),
        )
        self.assertEqual(
            transcribe.call_args.kwargs["request_headers"],
            library_extraction_service.douyin_library.companion_headers(session_scope),
        )
        self.assertEqual(result["transcript_raw"], "这是从视频语音提取出的完整文案")

    def test_ephemeral_media_is_used_without_public_page_resolution(self) -> None:
        item = self.item(video_id="7672579366093622538")
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[item],
        )
        self.db.close()
        with (
            patch.object(library_extraction_service, "SessionLocal", self.Session),
            patch.object(
                library_extraction_service.douyin_binding_service,
                "get_or_create",
                return_value=SimpleNamespace(id="binding", session_scope="scope"),
            ),
            patch.object(
                library_extraction_service.douyin_library,
                "get_item",
                side_effect=douyin_library.DouyinLibraryError("sidecar blocked"),
            ),
            patch.object(
                library_extraction_service.settings_service,
                "get_asr_config",
                return_value={"api_key": "key", "api_base_url": "https://asr.example", "model": "asr"},
            ),
            patch.object(
                library_extraction_service.video_extractor,
                "parse_video_info",
            ) as parse_video,
            patch.object(
                library_extraction_service.video_extractor,
                "extract_media_url_transcript",
                return_value="使用桌面端临时媒体地址提取的完整文案",
            ) as transcribe,
        ):
            result = library_extraction_service.extract_library_item(
                user_id=self.user_a.id,
                aweme_id=item["video_id"],
                operation="transcript",
                ephemeral_media_url=(
                    "https://v3-web.douyinvod.com/video.mp4?token=temporary"
                ),
            )

        parse_video.assert_not_called()
        self.assertEqual(
            transcribe.call_args.args[0],
            "https://v3-web.douyinvod.com/video.mp4?token=temporary",
        )
        self.assertEqual(result["transcript_raw"], "使用桌面端临时媒体地址提取的完整文案")
        self.assertNotIn("temporary", str(result))

    def test_ephemeral_media_rejects_untrusted_hosts(self) -> None:
        with self.assertRaisesRegex(ValueError, "受信任"):
            library_extraction_service.normalize_ephemeral_media_url(
                "https://example.com/video.mp4"
            )

    def test_ephemeral_media_accepts_current_official_cdn_hosts(self) -> None:
        for url in (
            "https://v5-dy-o-abtest.zjcdn.com/video.mp4?token=temporary",
            "https://v3-web.volccdn.com/video.mp4?token=temporary",
            "https://v9-web.bytecdn.com/video.mp4?token=temporary",
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    library_extraction_service.normalize_ephemeral_media_url(url),
                    url,
                )

    def test_optional_untrusted_media_falls_back_without_fetching_it(self) -> None:
        self.assertEqual(
            library_extraction_service.optional_ephemeral_media_url(
                "https://example.com/video.mp4"
            ),
            "",
        )


if __name__ == "__main__":
    unittest.main()
