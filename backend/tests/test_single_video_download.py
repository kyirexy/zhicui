from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests

from tests.test_agent_interface_routes import AgentInterfaceRouteTests
from app.api import routes
from app.models.note import Note
from app.models.user import User
from app.services import agent_video_link_service as media, note_service, single_video_reuse_service


VIDEO_ID = "7616369026764347109"
SHARE_URL = "https://v.douyin.com/JUV4bfM5wBU/"
CONFIG = {"api_key": "test-asr-key", "api_base_url": "https://asr.example/v1", "model": "test-asr"}


def info():
    return {"video_id": VIDEO_ID, "title": "测试视频", "platform": "douyin", "source_url": SHARE_URL, "download_url": "https://v.example.douyinvod.com/video.mp4"}


class SingleVideoRecoveryTests(unittest.TestCase):
    def test_missing_bound_metadata_does_not_invent_found_video(self):
        binding = SimpleNamespace(id="binding", status="connected", cookie_count=1, session_scope="s" * 32)
        error = routes.video_extractor.VideoMetadataUnavailableError("公开信息不可用", item_id=VIDEO_ID)
        with patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding), patch.object(routes.douyin_library, "resolve_item_metadata", return_value=None), patch.object(routes.douyin_library, "get_item", return_value=None), patch.object(routes.video_extractor, "parse_video_info", side_effect=error) as parse:
            self.assertIsNone(routes._recover_bound_douyin_video(MagicMock(), user_id="owner", error=error, share_text=SHARE_URL))
            parse.assert_called_once_with(SHARE_URL)

    def test_missing_bound_metadata_can_use_verified_public_video(self):
        binding = SimpleNamespace(id="binding", status="connected", cookie_count=1, session_scope="s" * 32)
        error = routes.video_extractor.VideoMetadataUnavailableError("公开信息不可用", item_id=VIDEO_ID)
        with patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding), patch.object(routes.douyin_library, "resolve_item_metadata", return_value=None), patch.object(routes.douyin_library, "get_item", return_value=None), patch.object(routes.video_extractor, "parse_video_info", return_value=info()):
            recovered = routes._recover_bound_douyin_video(MagicMock(), user_id="owner", error=error, share_text=SHARE_URL)
            self.assertEqual(recovered[0]["title"], "测试视频")
            self.assertEqual(recovered[1:], ("", {}))

    def bound_error(self, status):
        response = requests.Response()
        response.status_code = status
        response.url = f"http://127.0.0.1:9000/api/v1/media/{VIDEO_ID}"
        return requests.HTTPError("private upstream details", response=response)

    def run_transcript(self, video_info=None):
        return routes._transcribe_bound_video(media_url=f"http://127.0.0.1:9000/api/v1/media/{VIDEO_ID}", headers={"X-Zhicui-Scope": "test-private-scope"}, source_url=SHARE_URL, video_info=video_info or info(), asr_config=CONFIG)

    def test_expired_bound_stream_uses_original_short_link_once_and_never_forwards_scope(self):
        initial = info()
        initial["note_id"] = "saved-preview"
        with patch.object(routes.video_extractor, "extract_media_url_transcript", side_effect=self.bound_error(404)), patch.object(routes.video_extractor, "parse_video_info", return_value=info()) as parse, patch.object(routes.video_extractor, "extract_transcript", return_value="真实文稿") as transcribe:
            self.assertEqual(self.run_transcript(initial), "真实文稿")
        parse.assert_called_once_with(SHARE_URL)
        self.assertEqual(initial["note_id"], "saved-preview")
        self.assertNotIn("request_headers", transcribe.call_args.kwargs)
        self.assertNotIn("test-private-scope", str(transcribe.call_args))

    def test_auth_challenge_and_rate_limit_do_not_trigger_public_retry(self):
        for status in (401, 403, 412, 429, 500):
            with self.subTest(status=status), patch.object(routes.video_extractor, "extract_media_url_transcript", side_effect=self.bound_error(status)), patch.object(routes.video_extractor, "parse_video_info") as parse:
                with self.assertRaises(requests.HTTPError):
                    self.run_transcript()
                parse.assert_not_called()

    def test_recovery_rejects_a_different_video(self):
        wrong = {**info(), "video_id": "1234567890123456789"}
        with patch.object(routes.video_extractor, "extract_media_url_transcript", side_effect=self.bound_error(410)), patch.object(routes.video_extractor, "parse_video_info", return_value=wrong), patch.object(routes.video_extractor, "extract_transcript") as transcribe:
            with self.assertRaises(media.VideoLinkError):
                self.run_transcript()
            transcribe.assert_not_called()

    def test_audio_service_error_is_not_reported_as_media_failure(self):
        error = routes.video_extractor.CloudAsrError("语音识别配置无效", retryable=False, status_code=401)
        self.assertEqual(routes._safe_transcript_error(error, bound=True), "语音识别配置无效")
        self.assertEqual(routes._safe_transcript_error(routes.video_extractor.NoAudioError(), bound=True), "无音频")

    def test_bound_download_404_falls_back_once_with_no_scope_forwarding(self):
        snapshot = SimpleNamespace(video_id=VIDEO_ID, video_url=f"https://www.douyin.com/video/{VIDEO_ID}", ai_summary=json.dumps({"source_meta": {"platform": "douyin", "public_share_url": SHARE_URL}}))
        session = MagicMock()
        response = session.get.return_value.__enter__.return_value
        response.status_code = 404
        @contextmanager
        def public_media(note):
            self.assertIs(note, snapshot)
            yield Path("public.mp4")
        with patch.object(media.requests, "Session") as session_factory, patch.object(media, "prepared_media", side_effect=public_media) as public:
            session_factory.return_value.__enter__.return_value = session
            with media.prepared_user_media(snapshot, session_scope="s" * 32) as path:
                self.assertEqual(path, Path("public.mp4"))
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
        self.assertTrue(session.get.call_args.args[0].startswith("http://127.0.0.1:"))
        public.assert_called_once_with(snapshot)

    def test_bound_download_challenge_or_redirect_never_follows_or_retries(self):
        snapshot = SimpleNamespace(video_id=VIDEO_ID, video_url=f"https://www.douyin.com/video/{VIDEO_ID}", ai_summary=json.dumps({"source_meta": {"platform": "douyin"}}))
        for status in (301, 302, 401, 403, 429):
            with self.subTest(status=status), patch.object(media.requests, "Session") as session_factory, patch.object(media, "prepared_media") as public:
                session = session_factory.return_value.__enter__.return_value
                session.get.return_value.__enter__.return_value.status_code = status
                with self.assertRaises(media.VideoLinkError):
                    with media.prepared_user_media(snapshot, session_scope="s" * 32):
                        self.fail("不得返回受保护的文件")
                self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
                public.assert_not_called()

    def test_download_slots_release_after_exception_and_limit_each_user(self):
        with media.user_download_slot("one-user"):
            with self.assertRaises(media.VideoLinkError) as raised:
                with media.user_download_slot("one-user"):
                    self.fail("重复下载不能开始")
            self.assertEqual(raised.exception.http_status, 429)
        with media.user_download_slot("one-user"):
            pass

    def test_response_cleans_on_invalid_range_and_disconnected_send(self):
        async def invoke(response, headers, fail_send):
            async def send(message):
                if fail_send:
                    raise OSError("client disconnected")
            async def receive():
                return {"type": "http.disconnect"}
            await response({"type": "http", "method": "GET", "headers": headers, "extensions": {}, "asgi": {"spec_version": "2.4"}}, receive, send)
        for headers, fail_send in [([(b"range", b"bytes=bad")], False), ([], True)]:
            with self.subTest(headers=headers, fail_send=fail_send), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"video")
                cleanup = ExitStack()
                cleaned = []
                cleanup.callback(lambda: cleaned.append(True))
                response = routes._TemporaryVideoResponse(path, cleanup=cleanup)
                try:
                    asyncio.run(invoke(response, headers, fail_send))
                except OSError:
                    self.assertTrue(fail_send)
                self.assertEqual(cleaned, [True])


class SingleVideoDownloadTests(unittest.TestCase):
    tearDown = AgentInterfaceRouteTests.tearDown

    def setUp(self):
        AgentInterfaceRouteTests.setUp(self)
        self.client.app.include_router(routes.router)
        binding = patch.object(routes.douyin_binding_service, "get_by_user", return_value=None)
        binding.start()
        self.addCleanup(binding.stop)

    def note(self, owner=None):
        with self.Session() as db:
            return single_video_reuse_service.prepare_download_note(db, user_id=owner or self.user_id, video_info=info(), source_url=SHARE_URL).id

    def test_metadata_persistence_is_owned_idempotent_and_not_fake_ai(self):
        note_id = self.note()
        self.assertEqual(self.note(), note_id)
        with self.Session() as db:
            note = db.get(Note, note_id)
            self.assertEqual(db.query(Note).count(), 1)
            self.assertFalse(note.ai_initialized)
            self.assertFalse(note.transcript_raw)
            payload = json.loads(note.ai_summary)
            self.assertEqual(payload["source_meta"]["public_share_url"], SHARE_URL)
            self.assertNotIn("download_url", note.ai_summary)
            self.assertEqual(note.video_url, f"https://www.douyin.com/video/{VIDEO_ID}")

    def test_generated_result_updates_prepared_note_without_duplicate(self):
        note_id = self.note()
        with self.Session() as db:
            result, _ = routes._save_generated_note(db, {**info(), "note_id": note_id}, "真实文稿", {"card_type": "general", "sections": [{"content": "总结"}]}, self.user_id)
            self.assertEqual(result["id"], note_id)
            self.assertEqual(db.query(Note).count(), 1)
            self.assertTrue(db.get(Note, note_id).ai_initialized)

    def test_completed_note_reuse_remembers_verified_public_share_context(self):
        note_id = self.note()
        with self.Session() as db:
            note = db.get(Note, note_id)
            note.ai_initialized = True
            note.transcript_raw = "已有完整文稿"
            note.ai_summary = json.dumps({"sections": [{"content": "摘要"}], "source_meta": {"platform": "douyin"}})
            db.commit()
            reused = single_video_reuse_service.find_reusable_note(db, user_id=self.user_id, source_url=f"https://www.douyin.com/video/{VIDEO_ID}", video_info=info())
            self.assertEqual(reused.id, note_id)
            self.assertEqual(json.loads(reused.ai_summary)["source_meta"]["public_share_url"], SHARE_URL)

    def test_generated_result_preserves_existing_collection_membership(self):
        note_id = self.note()
        previous = {"platform": "douyin", "source_kind": "platform-library", "source_mode": "favorite", "source_modes": ["favorite", "liked"], "source_synced_at": "2026-09-23T09:00:00", "author_name": "原作者"}
        with self.Session() as db:
            note = db.get(Note, note_id)
            note.ai_summary = json.dumps({"source_meta": previous})
            db.commit()
            routes._save_generated_note(db, {**info(), "note_id": note_id, "title": f"抖音作品 {VIDEO_ID}"}, "真实文稿", {"sections": [{"content": "摘要"}]}, self.user_id)
            meta = json.loads(note.ai_summary)["source_meta"]
            for key, value in previous.items():
                self.assertEqual(meta[key], value)
            self.assertEqual(note.video_title, "测试视频")

    def test_jwt_and_ownership_checked_before_downloading(self):
        with self.Session() as db:
            other = User(email="other-video@example.com", username="other-video", hashed_password="unused")
            db.add(other)
            db.commit()
            other_id = other.id
        note_id = self.note(other_id)
        with patch.object(media, "prepared_user_media") as prepare:
            self.assertEqual(self.client.get(f"/api/notes/{note_id}/video/download").status_code, 401)
            response = self.client.get(f"/api/notes/{note_id}/video/download", headers={"Authorization": f"Bearer {self.jwt}"})
            self.assertEqual(response.status_code, 404)
            prepare.assert_not_called()

    def test_download_delivers_mp4_attachment_and_cleans_temporary_file(self):
        note_id = self.note()
        files = []
        @contextmanager
        def fake_media(note, **kwargs):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"\x00\x00\x00\x18ftypmp42-test-video")
                files.append(path)
                yield path
        with patch.object(media, "prepared_user_media", side_effect=fake_media):
            response = self.client.get(f"/api/notes/{note_id}/video/download", headers={"Authorization": f"Bearer {self.jwt}"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertFalse(files[0].exists())

    def test_disabled_user_during_preparation_does_not_receive_video(self):
        note_id = self.note()
        @contextmanager
        def fake_media(note, **kwargs):
            with self.Session() as db:
                db.get(User, self.user_id).is_active = False
                db.commit()
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"video")
                yield path
        with patch.object(media, "prepared_user_media", side_effect=fake_media):
            response = self.client.get(f"/api/notes/{note_id}/video/download", headers={"Authorization": f"Bearer {self.jwt}"})
        self.assertEqual(response.status_code, 401)

    def test_asr_failure_keeps_stream_preview_downloadable(self):
        async def collect(response):
            return [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]
        with self.Session() as db, patch.object(routes, "_reuse_single_video_result", return_value=None), patch.object(routes.video_extractor, "parse_video_info", return_value=info()), patch.object(routes.settings_service, "get_asr_config", return_value=CONFIG), patch.object(routes.video_extractor, "extract_transcript", side_effect=routes.video_extractor.CloudAsrError("语音服务暂不可用", retryable=True)):
            events = asyncio.run(collect(routes.extract_stream(url=SHARE_URL, db=db, current_user=SimpleNamespace(id=self.user_id))))
        preview = next(event["data"]["video"] for event in events if (event.get("data") or {}).get("phase") == "parse_done")
        self.assertTrue(preview["note_id"])
        self.assertEqual(events[-1]["step"], "error")
        with self.Session() as db:
            self.assertFalse(db.get(Note, preview["note_id"]).ai_initialized)

    def test_no_audio_is_saved_without_fake_generated_text(self):
        note_id = self.note()
        with self.Session() as db:
            result = routes._save_single_video_no_audio(db, user_id=self.user_id, video_info={**info(), "note_id": note_id})
            self.assertEqual(result["id"], note_id)
            self.assertEqual(result["transcript_notice"], "无音频")
            self.assertFalse(db.get(Note, note_id).ai_initialized)
            self.assertFalse(db.get(Note, note_id).transcript_raw)


if __name__ == "__main__":
    unittest.main()
