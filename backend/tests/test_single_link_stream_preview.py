import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("JWT_SECRET", "test-single-link-preview-secret")

from app.api.routes import _safe_extraction_video_preview, _save_generated_note, _transcript_progress_payload
from app.services.platform_library_service import serialize_item


class SingleLinkStreamPreviewTests(unittest.TestCase):
    def test_preview_exposes_only_ui_fields(self) -> None:
        result = _safe_extraction_video_preview(
            {
                "title": "测试视频",
                "video_id": "123",
                "download_url": "https://media.example/video.mp4",
                "thumbnail": "https://media.example/cover.jpg",
                "author": "作者",
                "cookie": "must-not-leak",
                "local_path": "D:/private/video.mp4",
            },
            source_url="https://example.com/video/123",
            platform="douyin",
        )
        self.assertEqual(
            set(result),
            {"title", "video_id", "platform", "source_url", "media_url", "cover_url", "author_name"},
        )
        self.assertNotIn("must-not-leak", result.values())
        self.assertNotIn("D:/private/video.mp4", result.values())

    def test_transcript_payload_carries_the_complete_text(self) -> None:
        transcript = "第一段。\n第二段完整文稿。"
        result = _transcript_progress_payload(transcript, platform="bilibili")
        self.assertEqual(result["transcript"], transcript)
        self.assertEqual(result["transcript_chars"], len(transcript))
        self.assertEqual(result["phase"], "transcribe_done")

    def test_generated_note_receives_complete_single_link_source_metadata(self) -> None:
        captured: dict = {}
        fake_note = SimpleNamespace(id="note-1", video_title="视频", to_dict=lambda: {"id": "note-1"})

        def create_note(_db, video_info, _transcript, ai_result, _user_id):
            captured["video_info"] = video_info
            captured["ai_result"] = ai_result
            return fake_note

        video_info = {
            "video_id": "123",
            "title": "视频",
            "platform": "douyin",
            "source_url": "https://www.douyin.com/video/123",
            "download_url": "https://media.example/video.mp4",
            "thumbnail": "https://media.example/cover.jpg",
            "author": "作者",
        }
        with patch("app.api.routes.note_service.create_note", side_effect=create_note):
            result, plan_created = _save_generated_note(MagicMock(), video_info, "文稿", {"card_type": "general"}, "user-1")

        self.assertEqual(result["id"], "note-1")
        self.assertFalse(plan_created)
        source_meta = captured["ai_result"]["source_meta"]
        self.assertEqual(source_meta["media_url"], video_info["download_url"])
        self.assertEqual(source_meta["source_url"], video_info["source_url"])
        self.assertEqual(source_meta["author_name"], "作者")

    def test_legacy_note_media_falls_back_to_stored_video_url(self) -> None:
        note = SimpleNamespace(
            id="note-legacy",
            video_id="123",
            video_title="旧视频",
            video_url="https://media.example/legacy.mp4",
            transcript_raw="文稿",
            ai_summary="{}",
            ai_initialized=True,
            card_type="general",
            created_at=None,
            to_dict=lambda: {"created_at": "", "card_type": "general"},
        )
        item = serialize_item(note)
        self.assertEqual(item["media_url"], note.video_url)


if __name__ == "__main__":
    unittest.main()
