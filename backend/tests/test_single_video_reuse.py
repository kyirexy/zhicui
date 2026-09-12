from __future__ import annotations

import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "single-video-reuse-isolated-tests")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.note import Note
from app.models.user import User
from app.services.single_video_reuse_service import find_reusable_note, needs_metadata


VIDEO_ID = "7681642132423200019"
SOURCE = f"https://www.douyin.com/video/{VIDEO_ID}"


class SingleVideoReuseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://")
        User.__table__.create(self.engine)
        Note.__table__.create(self.engine)
        self.db = Session(self.engine)
        self.counter = 0

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def note(self, *, owner="owner", platform="douyin", title="有效视频标题", author="作者", **kwargs):
        self.counter += 1
        payload = kwargs.pop("payload", {
            "sections": [{"title": "摘要", "content": "有效内容总结"}],
            "generation_status": "ready",
        })
        payload.setdefault("source_meta", {"platform": platform, "author_name": author})
        defaults = dict(
            id=f"note-{self.counter}", user_id=owner, video_id=VIDEO_ID,
            video_title=title, video_url=SOURCE, transcript_raw="这是已完成的真实视频文稿。",
            ai_initialized=True, ai_summary=json.dumps(payload, ensure_ascii=False),
            seo_title="旧标题", seo_slug=f"slug-{self.counter}", seo_meta="摘要",
            created_at=datetime(2026, 9, 12, tzinfo=timezone.utc) + timedelta(seconds=self.counter),
        )
        defaults.update(kwargs)
        note = Note(**defaults)
        self.db.add(note)
        self.db.commit()
        return note

    def find(self, **kwargs):
        return find_reusable_note(self.db, user_id=kwargs.pop("user_id", "owner"), source_url=kwargs.pop("source_url", SOURCE), **kwargs)

    def test_returns_newest_own_completed_note_without_creating_duplicates(self):
        self.note()
        latest = self.note()
        self.note(owner="another-user")
        self.assertEqual(self.find().id, latest.id)
        self.assertEqual(self.db.query(Note).count(), 3)

    def test_requires_explicit_owner_and_never_uses_other_users_metadata(self):
        owned = self.note(title=f"抖音作品 {VIDEO_ID}", author="")
        self.note(owner="another-user", title="别人的标题", author="别人的作者")
        self.assertIsNone(self.find(user_id=""))
        reused = self.find()
        self.assertEqual(reused.id, owned.id)
        self.assertEqual(reused.video_title, f"抖音作品 {VIDEO_ID}")
        self.assertEqual(reused.to_dict()["author_name"], "")

    def test_ignores_different_platform_and_conflicting_source_page(self):
        self.note(platform="bilibili")
        self.note(video_url="https://www.douyin.com/video/1234567890123456")
        self.assertIsNone(self.find())

    def test_short_links_and_untrusted_domains_do_not_hit_network(self):
        self.note()
        with patch("requests.sessions.Session.request", side_effect=AssertionError("不得请求网络")):
            for source in (
                "https://v.douyin.com/share/", "https://evil-douyin.com/video/" + VIDEO_ID,
                "https://www.douyin.com.evil.test/video/" + VIDEO_ID,
                "https://user:pass@www.douyin.com/video/" + VIDEO_ID,
            ):
                with self.subTest(source=source):
                    self.assertIsNone(self.find(source_url=source))
            self.assertIsNotNone(self.find())

    def test_partial_and_failed_results_do_not_block_retry(self):
        cases = (
            {"transcript_raw": "  "},
            {"transcript_raw": "[no audio — analysed from video frames]"},
            {"transcript_raw": "[no audio transcript — analysed from video frames]"},
            {"transcript_raw": "[B站视频] 仅有标题"},
            {"ai_initialized": False},
            {"payload": {"generation_status": "fallback", "sections": [{"content": "兜底原文"}]}},
            {"payload": {"sections": []}},
            {"payload": {"sections": [{"title": "没有内容"}]}},
            {"payload": {"source_meta": {"platform": "douyin", "degraded": True}, "sections": [{"content": "占位"}]}},
            {"payload": {"source_meta": {"platform": "douyin", "transcript_source": "creator-caption"}, "sections": [{"content": "标题"}]}},
            {"payload": {"source_meta": {"platform": "douyin", "transcript_source": "caption-only"}, "sections": [{"content": "标题"}]}},
        )
        for values in cases:
            with self.subTest(values=values):
                self.note(**values)
                self.assertIsNone(self.find())

    def test_picks_older_completed_note_when_latest_is_not_complete(self):
        complete = self.note()
        self.note(ai_initialized=False)
        self.assertEqual(self.find().id, complete.id)

    def test_repairs_only_missing_metadata_from_owned_matching_note(self):
        self.note(title="真实标题", author="真实作者")
        latest = self.note(title=f"抖音作品 {VIDEO_ID}", author="未知作者")
        latest_payload = json.loads(latest.ai_summary)
        latest_payload["source_meta"]["source_modes"] = ["favorite"]
        latest.ai_summary = json.dumps(latest_payload)
        self.db.commit()
        result = self.find()
        self.db.expire_all()
        self.assertEqual(result.id, latest.id)
        self.assertEqual(result.video_title, "真实标题")
        self.assertEqual(result.to_dict()["author_name"], "真实作者")
        self.assertEqual(json.loads(result.ai_summary)["source_meta"]["source_modes"], ["favorite"])
        self.assertEqual(result.transcript_raw, "这是已完成的真实视频文稿。")

    def test_never_overwrites_existing_non_placeholder_metadata(self):
        self.note(title="早期标题", author="早期作者")
        latest = self.note(title="现有标题", author="现有作者")
        result = self.find()
        self.assertEqual(result.id, latest.id)
        self.assertEqual(result.video_title, "现有标题")
        self.assertEqual(result.to_dict()["author_name"], "现有作者")

    def test_legacy_owned_note_can_match_by_canonical_page(self):
        legacy = self.note(payload={"sections": [{"content": "已生成内容"}], "source_meta": {}})
        self.assertEqual(self.find().id, legacy.id)

    def test_share_caption_fills_missing_title_and_explicit_author(self):
        latest = self.note(title=f"抖音作品 {VIDEO_ID}", author="")
        share_text = f"4.12 复制打开抖音，看看【分享作者的作品】真实视频标题 #知识 {SOURCE} 复制此链接，打开抖音搜索"
        result = self.find(share_text=share_text)
        self.assertEqual(result.id, latest.id)
        self.assertEqual(result.video_title, "真实视频标题 #知识")
        self.assertEqual(result.to_dict()["author_name"], "分享作者")

    def test_different_video_share_caption_cannot_relabel_existing_note(self):
        latest = self.note(title=f"抖音作品 {VIDEO_ID}", author="")
        share_text = "复制打开抖音，看看【别的作者的作品】别的标题 https://www.douyin.com/video/1234567890123456"
        result = self.find(share_text=share_text)
        self.assertEqual(result.id, latest.id)
        self.assertEqual(result.video_title, f"抖音作品 {VIDEO_ID}")
        self.assertEqual(result.to_dict()["author_name"], "")

    def test_bilibili_chapters_are_not_conflated(self):
        source = "https://www.bilibili.com/video/BV1234567890"
        self.note(platform="bilibili", video_id="BV1234567890", video_url=source)
        self.assertIsNotNone(self.find(source_url=source))
        self.assertIsNone(self.find(source_url=source + "?p=2"))

    def test_stored_second_chapter_cannot_satisfy_first_chapter(self):
        source = "https://www.bilibili.com/video/BV1234567890"
        self.note(platform="bilibili", video_id="BV1234567890", video_url=source + "?p=2")
        self.assertIsNone(self.find(source_url=source))

    def test_fresh_matching_metadata_repairs_only_missing_fields(self):
        note = self.note(title=f"抖音作品 {VIDEO_ID}", author="")
        self.assertTrue(needs_metadata(note))
        result = self.find(video_info={
            "platform": "douyin", "video_id": VIDEO_ID, "title": "正式标题",
            "author_name": "正式作者", "cover_url": "https://images.example/cover.jpg",
        })
        self.assertFalse(needs_metadata(result))
        self.assertEqual(result.video_title, "正式标题")
        self.assertEqual(result.to_dict()["author_name"], "正式作者")
        self.assertEqual(result.to_dict()["cover_url"], "https://images.example/cover.jpg")
        self.find(video_info={
            "platform": "douyin", "video_id": VIDEO_ID, "title": "另一标题",
            "author_name": "另一作者", "cover_url": "https://images.example/other.jpg",
        })
        self.assertEqual(result.video_title, "正式标题")
        self.assertEqual(result.to_dict()["author_name"], "正式作者")
        self.assertEqual(result.to_dict()["cover_url"], "https://images.example/cover.jpg")

    def test_unrelated_fresh_metadata_cannot_relabel_reused_note(self):
        note = self.note(title=f"抖音作品 {VIDEO_ID}", author="")
        for fresh in (
            {"platform": "douyin", "video_id": "1234567890123456"},
            {"platform": "bilibili", "video_id": VIDEO_ID},
            {"video_id": VIDEO_ID},
            {"platform": "douyin", "video_id": VIDEO_ID, "source_url": "https://www.douyin.com/video/1234567890123456"},
        ):
            with self.subTest(fresh=fresh):
                self.find(video_info={**fresh, "title": "外来标题", "author_name": "外来作者"})
                self.assertTrue(needs_metadata(note))
                self.assertEqual(note.video_title, f"抖音作品 {VIDEO_ID}")
                self.assertEqual(note.to_dict()["author_name"], "")


if __name__ == "__main__":
    unittest.main()
