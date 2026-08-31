from __future__ import annotations

import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "test-media-capability-secret")

from app.core.database import Base
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import note_service, platform_library_service


class MediaCapabilityTests(unittest.TestCase):
    def test_douyin_short_share_is_persisted_as_canonical_work_page(self) -> None:
        note = note_service.create_note(
            self.db,
            {
                "video_id": "7668973835866282495",
                "title": "分享链接作品",
                "source_url": "https://v.douyin.com/JKqNrU4mC1I/",
                "download_url": "https://v3-dy.example/video.mp4",
                "platform": "douyin",
            },
            "完整文案",
            {
                "card_type": "general",
                "source_meta": {
                    "platform": "douyin",
                    "source_url": "https://v.douyin.com/JKqNrU4mC1I/",
                },
            },
            self.user_a.id,
        )

        expected = "https://www.douyin.com/video/7668973835866282495"
        self.assertEqual(note.video_url, expected)
        self.assertEqual(note.to_dict()["source_url"], expected)

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
        self.user_a = User(email="media-a@example.com", hashed_password="x")
        self.user_b = User(email="media-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_create_note_persists_only_stable_source(self) -> None:
        transient = "https://v3-web.douyinvod.com/video.mp4?token=secret"
        source = "https://www.douyin.com/video/7350000000000000001"
        note = note_service.create_note(
            self.db,
            {
                "video_id": "7350000000000000001",
                "title": "作品",
                "platform": "douyin",
                "source_url": source,
                "download_url": transient,
            },
            "完整文案",
            {
                "card_type": "general",
                "source_meta": {
                    "platform": "douyin",
                    "source_url": source,
                    "media_url": transient,
                    "play_url": transient,
                    "media_type": "video",
                },
            },
            self.user_a.id,
        )

        self.assertEqual(note.video_url, source)
        self.assertNotIn(transient, note.ai_summary or "")
        self.assertEqual(note.to_dict()["media_url"], "")

        item = platform_library_service.serialize_item(note)
        self.assertEqual(item["source_url"], source)
        self.assertNotIn("douyinvod.com", item["media_url"])
        parsed = urlsplit(item["media_url"])
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.path, f"/api/library/imports/{note.id}/media")
        self.assertTrue(platform_library_service.verify_media_signature(
            note.id,
            int(query["expires"][0]),
            query["signature"][0],
        ))

    def test_create_note_bounds_long_source_title_for_postgres_columns(self) -> None:
        note = note_service.create_transcript_note(
            self.db,
            video_info={
                "video_id": "7350000000000000099",
                "title": "很长的抖音标题" * 100,
                "platform": "douyin",
                "source_url": "https://www.douyin.com/video/7350000000000000099",
            },
            transcript="完整文案",
            source_meta={"platform": "douyin"},
            user_id=self.user_a.id,
        )

        self.assertLessEqual(len(note.video_title), 512)
        self.assertLessEqual(len(note.seo_title), 256)
        self.assertLessEqual(len(note.seo_meta), 512)
        self.assertTrue(note.seo_title.endswith("的文字笔记与步骤总结》"))

    def test_owned_workspace_is_the_only_place_that_mints_capability(self) -> None:
        note = note_service.create_note(
            self.db,
            {
                "video_id": "7350000000000000002",
                "title": "作品",
                "platform": "douyin",
                "source_url": "https://www.douyin.com/video/7350000000000000002",
            },
            "文案",
            {"source_meta": {"platform": "douyin", "media_type": "video"}},
            self.user_a.id,
        )
        self.assertIsNone(platform_library_service.get_workspace(
            self.db,
            user_id=self.user_b.id,
            note_id=note.id,
        ))
        workspace = platform_library_service.get_workspace(
            self.db,
            user_id=self.user_a.id,
            note_id=note.id,
        )
        self.assertIsNotNone(workspace)
        self.assertIn("/media?", workspace["item"]["media_url"])

    def test_legacy_scrub_removes_cdn_without_reordering_note(self) -> None:
        original_updated = datetime(2025, 1, 2, tzinfo=timezone.utc)
        transient = "https://v3-web.douyinvod.com/video.mp4?token=secret"
        source = "https://www.douyin.com/video/7350000000000000003"
        note = Note(
            user_id=self.user_a.id,
            video_id="7350000000000000003",
            video_title="旧作品",
            video_url=transient,
            transcript_raw="文案",
            ai_summary=json.dumps({
                "source_meta": {
                    "platform": "douyin",
                    "source_url": source,
                    "media_url": transient,
                    "media_type": "video",
                }
            }),
            card_type="general",
            seo_title="旧作品",
            seo_slug="legacy-media-capability",
            seo_meta="旧作品",
            pitfall_rating=3,
            updated_at=original_updated,
        )
        self.db.add(note)
        self.db.commit()
        persisted_updated = note.updated_at

        self.assertTrue(note_service.scrub_note_ephemeral_media(self.db, note))
        self.assertEqual(note.video_url, source)
        self.assertNotIn(transient, note.ai_summary or "")
        self.assertEqual(note.updated_at, persisted_updated)

    def test_media_target_rejects_private_dns_and_wrong_cdn(self) -> None:
        with patch.object(
            platform_library_service.socket,
            "getaddrinfo",
            return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
        ):
            self.assertEqual(
                platform_library_service.validated_media_target(
                    "https://v3-web.douyinvod.com/video.mp4",
                    "douyin",
                ),
                "",
            )
        self.assertEqual(
            platform_library_service.validated_media_target(
                "https://attacker.example/video.mp4",
                "xiaohongshu",
            ),
            "",
        )


if __name__ == "__main__":
    unittest.main()
