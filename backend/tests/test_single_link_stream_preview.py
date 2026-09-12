import os
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("JWT_SECRET", "test-single-link-preview-secret")

from app.api.routes import _safe_extraction_video_preview, _save_generated_note, _transcript_progress_payload
from app.services.platform_library_service import serialize_item
from app.api import routes


class SingleLinkStreamPreviewTests(unittest.TestCase):
    def test_metadata_after_transcription_reads_only_existing_session_cache(self) -> None:
        info = {"video_id": "7681642132423200019", "title": "分享标题", "author_name": ""}
        binding = SimpleNamespace(id="binding", session_scope="scope", status="connected")
        with (
            patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding),
            patch.object(routes.douyin_library, "resolve_item_metadata", return_value={"caption": "真实完整标题", "author_name": "真实作者"}) as metadata,
        ):
            routes._refresh_bound_video_metadata(MagicMock(), user_id="owner", video_info=info)
        metadata.assert_called_once_with("scope", "binding", "7681642132423200019", cache_only=True)
        self.assertEqual(info["title"], "真实完整标题")
        self.assertEqual(info["author_name"], "真实作者")

    def test_missing_cached_metadata_preserves_share_title_without_live_query(self) -> None:
        info = {"video_id": "7681642132423200019", "title": "分享标题", "author_name": ""}
        binding = SimpleNamespace(id="binding", session_scope="scope", status="connected")
        with (
            patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding),
            patch.object(routes.douyin_library, "resolve_item_metadata", return_value=None) as metadata,
        ):
            routes._refresh_bound_video_metadata(MagicMock(), user_id="owner", video_info=info)
        self.assertEqual(info["title"], "分享标题")
        self.assertTrue(metadata.call_args.kwargs["cache_only"])

    def test_repeat_import_returns_owned_note_and_plan_without_reprocessing(self) -> None:
        note = SimpleNamespace(id="owned-note", to_dict=lambda: {"id": "owned-note", "video_title": "原视频标题"})
        db = MagicMock()
        with (
            patch.object(routes.single_video_reuse_service, "find_reusable_note", return_value=note) as find,
            patch.object(routes.single_video_reuse_service, "needs_metadata", return_value=False),
            patch.object(routes.plan_service, "get_plan_by_note", return_value=SimpleNamespace(id="owned-plan")) as plan,
            patch.object(routes.video_extractor, "parse_video_info") as parse,
            patch.object(routes.video_extractor, "extract_transcript") as asr,
            patch.object(routes.ai_juicer, "generate_card") as generate,
            patch.object(routes.note_service, "create_note") as create,
        ):
            result = routes.extract(routes.ExtractRequest(url="https://www.douyin.com/video/7681642132423200019"), db=db, current_user=SimpleNamespace(id="owner"))
        self.assertEqual(result["data"]["id"], "owned-note")
        self.assertEqual(result["data"]["plan_id"], "owned-plan")
        self.assertEqual(find.call_args.kwargs["user_id"], "owner")
        plan.assert_called_once_with(db, "owned-note", user_id="owner")
        for operation in (parse, asr, generate, create):
            operation.assert_not_called()

    def test_short_link_reuses_resolved_video_even_when_public_metadata_is_missing(self) -> None:
        note = SimpleNamespace(id="owned-note", to_dict=lambda: {"id": "owned-note"})
        async def collect(response):
            return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]
        with (
            patch.object(routes.single_video_reuse_service, "find_reusable_note", side_effect=[None, note]) as find,
            patch.object(routes.single_video_reuse_service, "needs_metadata", return_value=False),
            patch.object(routes.plan_service, "get_plan_by_note", return_value=None),
            patch.object(routes.video_extractor, "parse_video_info", side_effect=routes.video_extractor.VideoMetadataUnavailableError("公开信息不可用", item_id="7681642132423200019")),
            patch.object(routes, "_recover_bound_douyin_video") as recover,
            patch.object(routes.video_extractor, "extract_transcript") as asr,
        ):
            events = asyncio.run(collect(routes.extract_stream(url="https://v.douyin.com/example/", db=MagicMock(), current_user=SimpleNamespace(id="owner"))))
        self.assertEqual(events[-1]["step"], "done")
        self.assertEqual(events[-1]["data"]["id"], "owned-note")
        self.assertEqual(find.call_args.kwargs["source_url"], "https://www.douyin.com/video/7681642132423200019")
        recover.assert_not_called()
        asr.assert_not_called()

    def test_bound_uncatalogued_video_uses_live_title_and_author(self) -> None:
        binding = SimpleNamespace(id="binding", session_scope="private-scope", status="connected", cookie_count=1)
        with (
            patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding),
            patch.object(routes.douyin_library, "resolve_item_metadata", return_value={"title": "真实标题", "author_name": "真实作者", "media_type": "video"}),
            patch.object(routes.douyin_library, "get_item") as manifest,
            patch.object(routes.douyin_library, "public_media_url", return_value="/api/signed/media"),
            patch.object(routes.douyin_library, "public_cover_url", return_value="/api/signed/cover"),
            patch.object(routes.douyin_library, "companion_media_url", return_value="http://127.0.0.1/media"),
            patch.object(routes.douyin_library, "companion_headers", return_value={"X-Zhicui-Scope": "private-scope"}),
        ):
            recovered = routes._recover_bound_douyin_video(MagicMock(), user_id="owner", error=routes.video_extractor.VideoMetadataUnavailableError("不可用", item_id="7681642132423200019"))
        self.assertEqual(recovered[0]["title"], "真实标题")
        self.assertEqual(recovered[0]["author_name"], "真实作者")
        self.assertNotIn("private-scope", str(recovered[0]))
        manifest.assert_not_called()

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
        self.assertNotIn("media_url", source_meta)
        self.assertEqual(source_meta["source_url"], video_info["source_url"])
        self.assertEqual(source_meta["author_name"], "作者")

    def test_legacy_note_never_returns_the_stored_cdn_url(self) -> None:
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
        self.assertEqual(item["media_url"], "")
        self.assertEqual(item["source_url"], "")
        self.assertNotIn(note.video_url, str(item))


if __name__ == "__main__":
    unittest.main()
