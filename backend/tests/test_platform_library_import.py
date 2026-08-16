from __future__ import annotations

import unittest
from unittest.mock import patch

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
