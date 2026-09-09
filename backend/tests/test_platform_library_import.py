from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import platform_library_service
from app.services.xhs_downloader_client import (
    XhsDownloaderUnavailable,
    fetch_xhs_detail,
    normalize_xhs_detail,
)


class PlatformLibraryImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[User.__table__, Note.__table__, Plan.__table__],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user_a = User(email="platform-a@example.com", hashed_password="x")
        self.user_b = User(email="platform-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def bili_result() -> tuple[dict, str, dict]:
        return (
            {
                "video_id": "BV1TEST",
                "title": "B站测试视频",
                "description": "发布简介",
                "author_name": "测试 UP",
            },
            "【发布文案】\n发布简介\n\n【视频字幕】\n完整说话内容",
            {
                "source_kind": "platform-import",
                "platform": "bilibili",
                "source_url": "https://www.bilibili.com/video/BV1TEST",
                "cover_url": "https://example.com/cover.jpg",
                "author_name": "测试 UP",
                "caption": "发布简介",
                "tags": ["知识"],
                "media_type": "video",
                "media_url": "",
                "transcript_source": "manual-subtitle",
                "speech_ready": True,
            },
        )

    def test_import_is_idempotent_and_user_scoped(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            first = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
            )
            second = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
            )
            other_user = platform_library_service.import_one(
                self.db,
                user_id=self.user_b.id,
                value="https://www.bilibili.com/video/BV1TEST",
            )

        self.assertEqual(first["status"], "imported")
        self.assertEqual(second["status"], "reused")
        self.assertEqual(first["item"]["id"], second["item"]["id"])
        self.assertNotEqual(first["item"]["id"], other_user["item"]["id"])
        self.assertEqual(len(platform_library_service.list_notes(
            self.db, user_id=self.user_a.id,
        )), 1)
        self.assertIsNone(platform_library_service.get_import(
            self.db, user_id=self.user_b.id, note_id=first["item"]["id"],
        ))

    def test_bilibili_cover_is_returned_through_signed_proxy(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            result = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
            )

        item = result["item"]
        self.assertNotIn("example.com", item["cover_url"])
        parsed = urlsplit(item["cover_url"])
        query = parse_qs(parsed.query)
        self.assertEqual(
            parsed.path,
            f"/api/library/imports/{item['id']}/cover",
        )
        self.assertTrue(platform_library_service.verify_cover_signature(
            item["id"],
            int(query["expires"][0]),
            query["signature"][0],
        ))
        self.assertEqual(
            platform_library_service.cover_target(self.db, item["id"]),
            "https://example.com/cover.jpg",
        )

    def test_list_serialization_can_omit_full_note_payload(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            imported = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
            )

        note = platform_library_service.get_import(
            self.db,
            user_id=self.user_a.id,
            note_id=imported["item"]["id"],
        )
        self.assertIsNotNone(note)
        detail = platform_library_service.serialize_item(note)
        summary = platform_library_service.serialize_item(note, include_note=False)

        self.assertIn("note", detail)
        self.assertNotIn("note", summary)
        self.assertEqual(summary["id"], detail["id"])
        self.assertEqual(summary["transcript_chars"], detail["transcript_chars"])

    def test_bilibili_import_keeps_spoken_text_from_direct_audio_fallback(self) -> None:
        info = self.bili_result()[0] | {
            "bvid": "BV1TEST",
            "cid": "123",
            "cover_url": "https://i0.hdslb.com/cover.jpg",
            "source_url": "https://www.bilibili.com/video/BV1TEST/",
            "tags": [],
            "media_url": "",
        }
        with (
            patch.object(platform_library_service.video_extractor, "_parse_bilibili", return_value=info),
            patch.object(
                platform_library_service.video_extractor,
                "_bilibili_subtitles_with_source",
                side_effect=RuntimeError("no subtitle"),
            ),
            patch.object(
                platform_library_service.settings_service,
                "get_asr_config",
                return_value={
                    "api_key": "asr-key",
                    "api_base_url": "https://asr.example",
                    "model": "sensevoice",
                },
            ),
            patch.object(
                platform_library_service.video_extractor,
                "extract_transcript",
                return_value="这是从公开视频音轨识别出的完整内容",
            ),
        ):
            _, transcript, meta = platform_library_service._extract_bilibili(
                info["source_url"],
                self.db,
            )

        self.assertIn("【视频语音】", transcript)
        self.assertIn("完整内容", transcript)
        self.assertEqual(meta["transcript_source"], "cloud-asr")
        self.assertTrue(meta["speech_ready"])
        self.assertNotIn("media_url", meta)

    def test_bilibili_caption_only_result_is_not_published_as_complete(self) -> None:
        info, _transcript, meta = self.bili_result()
        incomplete = {
            **meta,
            "cover_url": "",
            "author_name": "",
            "transcript_source": "caption-only",
            "speech_ready": False,
        }
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=(info, "【发布文案】\n只有标题和简介", incomplete),
        ):
            with self.assertRaisesRegex(RuntimeError, "不会作为已完成资料入库"):
                platform_library_service.import_one(
                    self.db,
                    user_id=self.user_a.id,
                    value="https://www.bilibili.com/video/BV1TEST",
                )

        self.assertEqual(platform_library_service.list_notes(
            self.db,
            user_id=self.user_a.id,
            platform="bilibili",
        ), [])

    def test_legacy_incomplete_bilibili_note_is_hidden_until_full_refresh(self) -> None:
        info, transcript, meta = self.bili_result()
        incomplete_meta = {
            **meta,
            "cover_url": "",
            "author_name": "",
            "transcript_source": "caption-only",
            "speech_ready": False,
        }
        legacy, reused = platform_library_service._save_or_refresh(
            self.db,
            user_id=self.user_a.id,
            platform="bilibili",
            info=info,
            transcript="【发布文案】\n只有标题和简介",
            source_meta=incomplete_meta,
        )
        self.assertFalse(reused)
        self.assertEqual(platform_library_service.list_notes(
            self.db,
            user_id=self.user_a.id,
            platform="bilibili",
        ), [])

        refreshed, reused = platform_library_service._save_or_refresh(
            self.db,
            user_id=self.user_a.id,
            platform="bilibili",
            info=info,
            transcript=transcript,
            source_meta=meta,
        )
        visible = platform_library_service.list_notes(
            self.db,
            user_id=self.user_a.id,
            platform="bilibili",
        )
        self.assertTrue(reused)
        self.assertEqual(refreshed.id, legacy.id)
        self.assertEqual([note.id for note in visible], [legacy.id])
        self.assertTrue(platform_library_service.serialize_item(legacy)["metadata_complete"])

    def test_partial_batch_failure_does_not_discard_success(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            result = platform_library_service.import_many(
                self.db,
                user_id=self.user_a.id,
                values=[
                    "https://www.bilibili.com/video/BV1TEST",
                    "https://example.com/not-supported",
                ],
            )

        self.assertEqual(result["success"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertNotIn("cookie", str(result).lower())

    def test_import_preserves_account_source_mode(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            result = platform_library_service.import_many(
                self.db,
                user_id=self.user_a.id,
                values=["https://www.bilibili.com/video/BV1TEST"],
                source_mode="collect",
            )

        self.assertEqual(result["success"], 1)
        self.assertEqual(result["items"][0]["item"]["source_mode"], "collect")
        self.assertEqual(result["items"][0]["item"]["source_modes"], ["collect"])

    def test_reused_bilibili_video_preserves_multiple_real_memberships(self) -> None:
        with patch.object(
            platform_library_service,
            "_extract_bilibili",
            return_value=self.bili_result(),
        ):
            liked = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
                source_mode="like",
            )
            collected = platform_library_service.import_one(
                self.db,
                user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST",
                source_mode="collect",
            )

        self.assertEqual(liked["item"]["source_modes"], ["like"])
        self.assertEqual(collected["status"], "reused")
        self.assertEqual(
            set(collected["item"]["source_modes"]),
            {"collect", "like"},
        )

    def test_collect_and_like_keep_independent_positions_and_snapshots(self) -> None:
        with patch.object(platform_library_service, "_extract_bilibili", return_value=self.bili_result()) as extract:
            collected = platform_library_service.import_one(
                self.db, user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST", source_mode="collect",
                source_rank_offset=27, source_synced_at="2026-09-08T01:00:00Z",
                source_coverage="complete",
            )
            liked = platform_library_service.import_one(
                self.db, user_id=self.user_a.id,
                value="https://www.bilibili.com/video/BV1TEST/?spm_id_from=test", source_mode="like",
                source_rank_offset=3, source_synced_at="2026-09-08T02:00:00Z",
            )
        self.assertEqual(collected["item"]["source_rank"], 27)
        self.assertEqual(liked["item"]["source_ranks"], {"collect": 27, "like": 3})
        self.assertEqual(liked["item"]["source_rank"], 3)
        self.assertEqual(liked["item"]["source_coverages"]["collect"], "complete")
        self.assertEqual(liked["item"]["source_synced_ats"]["collect"], "2026-09-08T01:00:00+00:00")
        self.assertEqual(liked["item"]["source_synced_ats"]["like"], "2026-09-08T02:00:00+00:00")
        extract.assert_called_once()

    def test_batch_offsets_preserve_full_platform_order_independent_of_completion(self) -> None:
        def extract(url, _db):
            info, transcript, meta = self.bili_result()
            video_id = url.rsplit("/", 1)[-1]
            return ({**info, "video_id": video_id}, transcript,
                    {**meta, "source_url": url})

        urls = [f"https://www.bilibili.com/video/BV1TEST{index:04d}" for index in range(23)]
        snapshot = "2026-09-08T03:00:00Z"
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=extract):
            # 故意让中批晚到，验证顺序不依赖事务/ASR 完成时间。
            for offset in (20, 0, 10):
                result = platform_library_service.import_many(
                    self.db, user_id=self.user_a.id, values=urls[offset:offset + 10],
                    source_mode="collect", source_rank_offset=offset, source_synced_at=snapshot,
                )
                self.assertEqual(result["failed"], 0)
        notes = platform_library_service.list_notes(
            self.db, user_id=self.user_a.id, platform="bilibili", source_mode="collect",
        )
        self.assertEqual([note.video_url for note in notes], urls)
        notes[-1].updated_at = datetime(2030, 1, 1, tzinfo=timezone.utc)
        self.db.commit()
        unchanged = platform_library_service.list_notes(
            self.db, user_id=self.user_a.id, platform="bilibili", source_mode="collect",
        )
        self.assertEqual([note.id for note in unchanged], [note.id for note in notes])

    def test_new_snapshot_prefix_is_not_interleaved_with_old_rank_zero(self) -> None:
        def extract(url, _db):
            info, transcript, meta = self.bili_result()
            return ({**info, "video_id": url.rsplit("/", 1)[-1]}, transcript,
                    {**meta, "source_url": url})

        old_urls = [f"https://www.bilibili.com/video/BV1OLD{index}" for index in range(3)]
        new_url = "https://www.bilibili.com/video/BV1NEW"
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=extract):
            platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=old_urls, source_mode="like",
                source_synced_at="2026-09-07T00:00:00Z",
            )
            platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=[new_url, old_urls[2]], source_mode="like",
                source_synced_at="2026-09-08T00:00:00Z",
            )
            # 旧批次晚到：同一作品的 1 不能被旧的 0 覆盖。
            late = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_urls[2], source_mode="like",
                source_rank_offset=0, source_synced_at="2026-09-07T00:00:00Z",
            )
        self.assertEqual(late["item"]["source_rank"], 1)
        self.assertEqual(late["item"]["source_synced_at"], "2026-09-08T00:00:00+00:00")
        notes = platform_library_service.list_notes(
            self.db, user_id=self.user_a.id, platform="bilibili", source_mode="like",
        )
        self.assertEqual([note.video_url for note in notes], [new_url, old_urls[2], *old_urls[:2]])

    def test_reimport_retries_incomplete_note_instead_of_faking_ready(self) -> None:
        info, transcript, meta = self.bili_result()
        incomplete = {**meta, "speech_ready": False, "transcript_source": "caption-only"}
        legacy, _ = platform_library_service._save_or_refresh(
            self.db, user_id=self.user_a.id, platform="bilibili", info=info,
            transcript="旧的长发布文案并不代表已经提取了语音。" * 100, source_meta=incomplete,
        )
        with patch.object(platform_library_service, "_extract_bilibili", return_value=(info, transcript, meta)) as extract:
            result = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value="https://www.bilibili.com/video/BV1TEST",
                source_mode="collect",
            )
        extract.assert_called_once()
        self.assertEqual(result["item"]["id"], legacy.id)
        self.assertTrue(result["item"]["metadata_complete"])
        self.assertEqual(result["item"]["note"]["transcript_raw"], transcript)

    def test_unverified_source_order_does_not_expose_invented_rank(self) -> None:
        with patch.object(platform_library_service, "_extract_bilibili", return_value=self.bili_result()):
            result = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value="https://www.bilibili.com/video/BV1TEST",
                source_mode="post", source_rank_offset=2, source_order_reliable=False,
                source_coverage="unknown",
            )
        self.assertNotIn("post", result["item"]["source_ranks"])
        self.assertIsNone(result["item"]["source_rank"])
        self.assertFalse(result["item"]["source_order_reliable"])

    def _bili_for_url(self, url, _db):
        info, transcript, meta = self.bili_result()
        return ({**info, "video_id": url.rsplit("/", 1)[-1]}, transcript,
                {**meta, "source_url": url})

    def test_complete_snapshot_reconciles_only_after_both_batches_and_preserves_other_mode(self) -> None:
        removed_url = "https://www.bilibili.com/video/BV1REMOVED"
        urls = [f"https://www.bilibili.com/video/BV1KEPT{index:04d}" for index in range(11)]
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            old = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=removed_url, source_mode="collect",
                source_synced_at="2026-09-06T00:00:00Z", source_rank_offset=3,
            )
            platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=removed_url, source_mode="like",
                source_synced_at="2026-09-08T01:00:00Z", source_rank_offset=7,
            )
            first = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=urls[:10], source_mode="collect",
                source_synced_at="2026-09-08T00:00:00Z", source_rank_offset=0,
                source_coverage="complete", source_snapshot_size=11,
            )
            self.assertFalse(first["source_reconciled"])
            self.assertIn("collect", platform_library_service.serialize_item(
                platform_library_service.get_import(self.db, user_id=self.user_a.id, note_id=old["item"]["id"]),
            )["source_modes"])
            last = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=urls[10:], source_mode="collect",
                source_synced_at="2026-09-08T00:00:00Z", source_rank_offset=10,
                source_coverage="complete", source_snapshot_size=11,
            )
        self.assertTrue(last["source_reconciled"])
        self.assertEqual(last["source_memberships_removed"], 1)
        saved = platform_library_service.get_import(self.db, user_id=self.user_a.id, note_id=old["item"]["id"])
        item = platform_library_service.serialize_item(saved)
        self.assertEqual(item["source_modes"], ["like"])
        self.assertEqual(item["source_ranks"], {"like": 7})
        self.assertEqual(item["source_mode"], "like")
        self.assertEqual(item["source_synced_at"], "2026-09-08T01:00:00+00:00")
        self.assertTrue(saved.transcript_raw)
        self.assertEqual(self.db.query(Note).count(), 12)

    def test_complete_snapshot_with_failed_earlier_batch_preserves_old_members(self) -> None:
        old_url = "https://www.bilibili.com/video/BV1KEEPOLD"
        urls = [f"https://www.bilibili.com/video/BV1READ{index:04d}" for index in range(11)]

        def extract(url, db):
            if url == urls[4]:
                raise RuntimeError("字幕读取失败")
            return self._bili_for_url(url, db)

        with patch.object(platform_library_service, "_extract_bilibili", side_effect=extract):
            old = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-07T00:00:00Z",
            )
            first = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=urls[:10], source_mode="collect",
                source_synced_at="2026-09-08T00:00:00Z", source_rank_offset=0,
                source_coverage="complete", source_snapshot_size=11,
            )
            last = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=urls[10:], source_mode="collect",
                source_synced_at="2026-09-08T00:00:00Z", source_rank_offset=10,
                source_coverage="complete", source_snapshot_size=11,
            )
        self.assertEqual(first["failed"], 1)
        self.assertFalse(last["source_reconciled"])
        item = platform_library_service.serialize_item(
            platform_library_service.get_import(self.db, user_id=self.user_a.id, note_id=old["item"]["id"]),
        )
        self.assertIn("collect", item["source_modes"])

    def test_missing_size_partial_limited_or_unreliable_never_detaches_old_members(self) -> None:
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            old = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value="https://www.bilibili.com/video/BV1OLD",
                source_mode="collect", source_synced_at="2026-09-07T00:00:00Z",
            )
            for options in (
                {"source_coverage": "complete"},
                {"source_coverage": "partial", "source_snapshot_size": 1},
                {"source_coverage": "limited", "source_snapshot_size": 1},
                {"source_coverage": "complete", "source_snapshot_size": 1, "source_order_reliable": False},
            ):
                result = platform_library_service.import_many(
                    self.db, user_id=self.user_a.id, values=["https://www.bilibili.com/video/BV1NEW"],
                    source_mode="collect", source_synced_at="2026-09-08T00:00:00Z", **options,
                )
                self.assertFalse(result["source_reconciled"])
        self.assertIn("collect", platform_library_service.serialize_item(
            platform_library_service.get_import(self.db, user_id=self.user_a.id, note_id=old["item"]["id"]),
        )["source_modes"])

    def test_late_complete_snapshot_cannot_reconcile_over_newer_snapshot(self) -> None:
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            for video_id, stamp in (("BV1OLD", "2026-09-06T00:00:00Z"),
                                    ("BV1NEWEST", "2026-09-08T00:00:00Z")):
                platform_library_service.import_one(
                    self.db, user_id=self.user_a.id, value=f"https://www.bilibili.com/video/{video_id}",
                    source_mode="like", source_synced_at=stamp,
                )
            late = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=["https://www.bilibili.com/video/BV1LATE"],
                source_mode="like", source_synced_at="2026-09-07T00:00:00Z",
                source_coverage="complete", source_snapshot_size=1,
            )
        self.assertFalse(late["source_reconciled"])
        self.assertEqual(len(platform_library_service.list_notes(
            self.db, user_id=self.user_a.id, platform="bilibili", source_mode="like",
        )), 2)

    def test_future_snapshot_rejected_before_extraction(self) -> None:
        future = (datetime.now(timezone.utc) + timedelta(minutes=6)).isoformat()
        with patch.object(platform_library_service, "_extract_bilibili") as extract:
            with self.assertRaisesRegex(ValueError, "五分钟"):
                platform_library_service.import_many(
                    self.db, user_id=self.user_a.id, values=["https://www.bilibili.com/video/BV1TEST"],
                    source_mode="collect", source_synced_at=future,
                )
        extract.assert_not_called()

    def test_removed_membership_cannot_be_resurrected_by_old_or_same_snapshot(self) -> None:
        old_url = "https://www.bilibili.com/video/BV1REMOVED"
        current_url = "https://www.bilibili.com/video/BV1CURRENT"
        removal_stamp = "2026-09-08T00:00:00Z"
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            old = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-07T00:00:00Z",
            )
            platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="like",
                source_synced_at="2026-09-07T01:00:00Z", source_rank_offset=9,
            )
            cleanup = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=[current_url], source_mode="collect",
                source_synced_at=removal_stamp, source_coverage="complete", source_snapshot_size=1,
            )
            self.assertTrue(cleanup["source_reconciled"])
            for stamp in ("2026-09-07T00:00:00Z", removal_stamp):
                late = platform_library_service.import_one(
                    self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                    source_synced_at=stamp,
                )
                self.assertEqual(late["item"]["source_modes"], ["like"])
                self.assertEqual(late["item"]["source_ranks"], {"like": 9})
            newer = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-08T00:00:01Z", source_rank_offset=2,
            )
        self.assertEqual(set(newer["item"]["source_modes"]), {"collect", "like"})
        self.assertEqual(newer["item"]["source_ranks"], {"like": 9, "collect": 2})
        self.assertEqual(newer["item"]["id"], old["item"]["id"])
        saved = platform_library_service.get_import(
            self.db, user_id=self.user_a.id, note_id=old["item"]["id"],
        )
        self.assertEqual(platform_library_service._source_meta(saved)["source_removed_ats"]["collect"],
                         "2026-09-08T00:00:00+00:00")

    def test_first_created_late_capture_keeps_transcript_without_rejoining_source(self) -> None:
        old_url = "https://www.bilibili.com/video/BV1FIRSTLATE"
        current_url = "https://www.bilibili.com/video/BV1CURRENT"
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            cleanup = platform_library_service.import_many(
                self.db, user_id=self.user_a.id, values=[current_url], source_mode="collect",
                source_synced_at="2026-09-08T00:00:00Z", source_coverage="complete", source_snapshot_size=1,
            )
            self.assertTrue(cleanup["source_reconciled"])
            late = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-07T00:00:00Z",
            )
            self.assertEqual(late["item"]["source_mode"], "import")
            self.assertEqual(late["item"]["source_modes"], [])
            self.assertTrue(late["item"]["note"]["transcript_raw"])
            visible = platform_library_service.list_notes(
                self.db, user_id=self.user_a.id, platform="bilibili", source_mode="collect",
            )
            self.assertEqual([note.video_url for note in visible], [current_url])
            # 该视频确实出现于更新后的采集时，仍然可以正常重新加入。
            fresh = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-08T00:00:01Z", source_rank_offset=1,
            )
        self.assertIn("collect", fresh["item"]["source_modes"])
        self.assertEqual(fresh["item"]["id"], late["item"]["id"])

    def test_ai_completion_preserves_membership_removed_during_llm_request(self) -> None:
        old_url = "https://www.bilibili.com/video/BV1AISTALE"
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self._bili_for_url):
            old = platform_library_service.import_one(
                self.db, user_id=self.user_a.id, value=old_url, source_mode="collect",
                source_synced_at="2026-09-07T00:00:00Z",
            )

            def generate_card(**_kwargs):
                with self.Session() as other:
                    platform_library_service.import_many(
                        other, user_id=self.user_a.id,
                        values=["https://www.bilibili.com/video/BV1AICURRENT"],
                        source_mode="collect", source_synced_at="2026-09-08T00:00:00Z",
                        source_coverage="complete", source_snapshot_size=1,
                    )
                return {"card_type": "general", "sections": [], "pitfall_rating": 0}

            with (
                patch.object(platform_library_service.ai_juicer, "classify_intent",
                             return_value={"card_type": "general", "is_plan": False}),
                patch.object(platform_library_service.ai_juicer, "generate_card", side_effect=generate_card),
            ):
                note, reused = platform_library_service.initialize_ai(
                    self.db, user_id=self.user_a.id, note_id=old["item"]["id"],
                )
        self.assertFalse(reused)
        self.assertTrue(note.ai_initialized)
        item = platform_library_service.serialize_item(note)
        self.assertEqual(item["source_mode"], "import")
        self.assertEqual(item["source_modes"], [])
        self.assertNotIn("collect", item["source_ranks"])
        self.assertEqual(platform_library_service._source_meta(note)["source_removed_ats"]["collect"],
                         "2026-09-08T00:00:00+00:00")

    def test_list_api_filters_source_mode_before_500_item_limit(self) -> None:
        from app.api import routes
        _, transcript, base_meta = self.bili_result()
        for index in range(502):
            mode = "collect" if index == 501 else "like"
            stamp = "2026-09-01T00:00:00Z" if mode == "collect" else "2026-09-02T00:00:00Z"
            meta = {
                **base_meta, "source_mode": mode, "source_modes": [mode],
                "source_ranks": {mode: index}, "source_synced_ats": {mode: stamp},
                "source_order_reliabilities": {mode: True},
            }
            self.db.add(Note(
                user_id=self.user_a.id, video_id=f"BV1FILTER{index}",
                video_title=f"测试作品{index}", video_url=f"https://www.bilibili.com/video/BV1FILTER{index}",
                transcript_raw=transcript, ai_summary=json.dumps({"source_meta": meta}),
                seo_title=f"测试作品{index}", seo_slug=f"filter-{index}", seo_meta="测试",
            ))
        self.db.commit()
        unfiltered = routes.list_platform_library_items(
            platform="bilibili", source_mode=None, db=self.db, current_user=self.user_a,
        )["data"]
        self.assertEqual(unfiltered["total"], 500)
        self.assertTrue(all(item["source_mode"] == "like" for item in unfiltered["items"]))
        collected = routes.list_platform_library_items(
            platform="bilibili", source_mode="collect", db=self.db, current_user=self.user_a,
        )["data"]
        self.assertEqual(collected["total"], 1)
        self.assertEqual(collected["items"][0]["video_id"], "BV1FILTER501")

    def test_xhs_video_keeps_caption_and_spoken_text(self) -> None:
        info = {
            "note_id": "xhs-video-1",
            "title": "小红书视频",
            "desc": "这是发布文案",
            "type": "video",
            "author_name": "作者",
            "source_url": "https://www.xiaohongshu.com/explore/xhs-video-1",
            "cover_url": "",
            "media_url": "https://sns-video.example/video.mp4",
            "tags": ["教程"],
            "provider": "xhs-downloader",
        }
        with (
            patch.object(platform_library_service, "fetch_xhs_detail", return_value=info),
            patch.object(
                platform_library_service.settings_service,
                "get_asr_config",
                return_value={"api_key": "key", "api_base_url": "https://asr.example", "model": "asr"},
            ),
            patch.object(
                platform_library_service.video_extractor,
                "extract_media_url_transcript",
                return_value="这是视频里说的话",
            ),
        ):
            _, transcript, meta = platform_library_service._extract_xiaohongshu(
                info["source_url"], self.db,
            )

        self.assertIn("【发布文案】", transcript)
        self.assertIn("这是发布文案", transcript)
        self.assertIn("【视频语音】", transcript)
        self.assertIn("这是视频里说的话", transcript)
        self.assertEqual(meta["transcript_source"], "cloud-asr")
        self.assertTrue(meta["speech_ready"])
        self.assertNotIn("media_url", meta)

    def test_xhs_sidecar_fallback_is_explicitly_degraded(self) -> None:
        fallback = {
            "note_id": "xhs-image-1",
            "title": "图文笔记",
            "desc": "只有发布正文",
            "type": "image",
            "author_name": "作者",
            "source_url": "https://www.xiaohongshu.com/explore/xhs-image-1",
            "cover_url": "",
            "media_url": "",
            "tags": [],
            "provider": "builtin-fallback",
        }
        with (
            patch.object(
                platform_library_service,
                "fetch_xhs_detail",
                side_effect=XhsDownloaderUnavailable("offline"),
            ),
            patch.object(platform_library_service, "_legacy_xhs_detail", return_value=fallback),
        ):
            _, transcript, meta = platform_library_service._extract_xiaohongshu(
                fallback["source_url"], self.db,
            )

        self.assertIn("只有发布正文", transcript)
        self.assertEqual(meta["transcript_source"], "caption-only")
        self.assertTrue(meta["degraded"])


class XhsDownloaderClientTests(unittest.TestCase):
    def test_localized_response_is_normalized(self) -> None:
        result = normalize_xhs_detail({
            "作品ID": "note-1",
            "作品标题": "标题",
            "作品描述": "正文",
            "作品类型": "视频",
            "作者昵称": "作者",
            "作品标签": "知识 教程",
            "下载地址": ["https://sns-video.example/video.mp4"],
        }, "https://www.xiaohongshu.com/explore/note-1")
        self.assertEqual(result["type"], "video")
        self.assertEqual(result["media_url"], "https://sns-video.example/video.mp4")
        self.assertEqual(result["tags"], ["知识", "教程"])

    def test_sidecar_error_never_echoes_cookie(self) -> None:
        secret = "a1=secret-cookie; web_session=private"
        with patch("app.services.xhs_downloader_client.requests.Session.post", side_effect=RuntimeError(secret)):
            with self.assertRaises(XhsDownloaderUnavailable) as captured:
                fetch_xhs_detail(
                    "https://www.xiaohongshu.com/explore/note-1",
                    cookie=secret,
                    api_base="http://127.0.0.1:5556",
                )
        self.assertNotIn("secret-cookie", str(captured.exception))
        self.assertNotIn("web_session", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
