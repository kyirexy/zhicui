from __future__ import annotations

import json
import tempfile
import subprocess
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.core.config import settings
from app.models.note import Note
from app.models.user import User
from app.services import agent_video_link_service as media, note_service, product_action_handlers
from app.services.agent_credential_service import issue_pat, revoke_credential
from tests.test_agent_interface_routes import AgentInterfaceRouteTests


class AgentMediaRouteTests(unittest.TestCase):
    setUp = AgentInterfaceRouteTests.setUp
    tearDown = AgentInterfaceRouteTests.tearDown

    def _pat(self, scopes):
        with self.Session() as db:
            row, token = issue_pat(db, user_id=self.user_id, name="测试视频下载", scopes=scopes, expires_in_days=1)
            return row.id, token

    def _note(self, db, *, user_id=None, transcript=""):
        return note_service.create_transcript_note(
            db, user_id=user_id or self.user_id,
            video_info={"video_id": "7659724478275947822", "title": "测试视频", "source_url": "https://www.douyin.com/video/7659724478275947822", "platform": "douyin"},
            transcript=transcript,
            source_meta={"platform": "douyin", "source_kind": media.SOURCE_KIND, "media_type": "video"},
        )

    def test_authentication_scope_and_ownership_checked_before_network(self):
        with self.Session() as db:
            other = User(email="media-other@example.com", username="media-other", hashed_password="x")
            db.add(other)
            db.commit()
            note_id = self._note(db, user_id=other.id).id
        _, read = self._pat(["library:read"])
        _, wrong = self._pat(["account:read"])
        endpoint = f"/api/agent-interface/v1/library/{note_id}/media"
        with patch.object(media, "prepared_media") as prepare:
            for token, status, code in [(None, 401, "AUTHENTICATION_REQUIRED"), (wrong, 403, "SCOPE_DENIED"), (read, 404, "RESOURCE_NOT_FOUND"), (self.jwt, 401, "INVALID_CREDENTIAL")]:
                response = self.client.get(endpoint, headers={"Authorization": f"Bearer {token}"} if token else {})
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(response.json()["error"]["code"], code)
            prepare.assert_not_called()

    def test_media_bytes_are_same_origin_and_temporary_file_is_cleaned(self):
        with self.Session() as db:
            note_id = self._note(db).id
        _, token = self._pat(["library:read"])
        prepared = []

        @contextmanager
        def fake_media(note):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"\0\0\0\x18ftypmp42" + b"video-evidence")
                prepared.append(path)
                yield path

        with patch.object(media, "prepared_media", side_effect=fake_media):
            response = self.client.get(f"/api/agent-interface/v1/library/{note_id}/media", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("location", response.headers)
        self.assertIn(b"video-evidence", response.content)
        self.assertFalse(prepared[0].exists())

    def test_platform_failure_is_structured_and_has_no_upstream_url(self):
        with self.Session() as db:
            note_id = self._note(db).id
        _, token = self._pat(["library:read"])
        with patch.object(media, "prepared_media", side_effect=media.VideoLinkError("PLATFORM_AUTH_REQUIRED", "平台需要验证", status=409)):
            response = self.client.get(f"/api/agent-interface/v1/library/{note_id}/media", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "PLATFORM_AUTH_REQUIRED")
        self.assertNotIn("https://", response.text)

    def test_action_kill_switch_and_revocation_stop_download(self):
        with self.Session() as db:
            note_id = self._note(db).id
        credential_id, token = self._pat(["library:read"])
        endpoint = f"/api/agent-interface/v1/library/{note_id}/media"
        settings.AGENT_INTERFACE_ACTION_ALLOWLIST = "library.list"
        with patch.object(media, "prepared_media") as prepare:
            response = self.client.get(endpoint, headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(response.status_code, 404)
            prepare.assert_not_called()
        settings.AGENT_INTERFACE_ACTION_ALLOWLIST = ""
        with self.Session() as db:
            revoke_credential(db, user_id=self.user_id, credential_id=credential_id)
        response = self.client.get(endpoint, headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)

    def test_revocation_during_media_preparation_prevents_returning_bytes(self):
        with self.Session() as db:
            note_id = self._note(db).id
        credential_id, token = self._pat(["library:read"])
        paths = []
        @contextmanager
        def fake_media(note):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"never-return-this-video")
                paths.append(path)
                with self.Session() as db:
                    revoke_credential(db, user_id=self.user_id, credential_id=credential_id)
                yield path
        with patch.object(media, "prepared_media", side_effect=fake_media):
            response = self.client.get(f"/api/agent-interface/v1/library/{note_id}/media", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["error"]["code"], "CREDENTIAL_REVOKED")
        self.assertNotIn("never-return-this-video", response.text)
        self.assertFalse(paths[0].exists())

    def test_import_reuses_owned_metadata_without_paid_extraction(self):
        info = {"video_id": "7659724478275947822", "title": "测试视频", "download_url": "https://v.douyinvod.com/private?signature=never-persist", "platform": "douyin"}
        with self.Session() as db, patch.object(media, "_public_info", return_value=info) as parse:
            first = media.import_link(db, user_id=self.user_id, value="https://www.douyin.com/video/7659724478275947822")
            second = media.import_link(db, user_id=self.user_id, value="https://www.douyin.com/video/7659724478275947822")
            self.assertEqual(first["item"]["note_id"], second["item"]["note_id"])
            self.assertEqual(second["status"], "reused")
            self.assertEqual(parse.call_count, 1)
            note = db.get(Note, first["item"]["note_id"])
            self.assertEqual(note.transcript_raw, "")
            self.assertNotIn("never-persist", note.ai_summary + note.video_url)
            other = User(email="import-other@example.com", username="import-other", hashed_password="x")
            db.add(other)
            db.commit()
            third = media.import_link(db, user_id=other.id, value="https://www.douyin.com/video/7659724478275947822")
            self.assertNotEqual(first["item"]["note_id"], third["item"]["note_id"])

    def test_public_douyin_share_entry_is_preserved_without_signed_media(self):
        share = "https://v.douyin.com/MXcIo7LVWSA/"
        info = {"video_id": "7659724478275947822", "title": "公开分享视频", "download_url": "https://v.douyinvod.com/a?signature=temporary"}
        with self.Session() as db, patch.object(media, "_target"), patch.object(media.video_extractor, "parse_video_info", return_value=info) as parse:
            result = media.import_link(db, user_id=self.user_id, value=share)
            note = db.get(Note, result["item"]["note_id"])
            self.assertEqual(json.loads(note.ai_summary)["source_meta"]["public_share_url"], share)
            self.assertEqual(note.video_url, "https://www.douyin.com/video/7659724478275947822")
            self.assertNotIn("temporary", note.ai_summary)
            parse.assert_called_once_with(share)
            snapshot = media.media_snapshot(note)
        with patch.object(media, "_public_info", side_effect=media.VideoLinkError("STOP_AFTER_SOURCE", "source assertion")) as parsed_again:
            with self.assertRaises(media.VideoLinkError):
                with media.prepared_media(snapshot):
                    pass
            parsed_again.assert_called_once_with(share, "douyin")

    def test_saved_transcript_reuse_never_parses_or_calls_asr(self):
        with self.Session() as db, patch.object(media, "prepared_media") as prepare, patch.object(media.settings_service, "get_asr_config") as config:
            note = self._note(db, transcript="用户已有的真实文稿")
            result = media.transcribe_note(db, user_id=self.user_id, note_id=note.id)
            self.assertTrue(result["already_existed"])
            self.assertEqual(result["transcript_raw"], "用户已有的真实文稿")
            prepare.assert_not_called()
            config.assert_not_called()
            with self.assertRaises(media.VideoLinkError) as error:
                media.transcribe_note(db, user_id="another-user", note_id=note.id)
            self.assertEqual(error.exception.code, "RESOURCE_NOT_FOUND")

    def test_cancel_after_download_prevents_paid_asr_and_persistence(self):
        calls = []
        def check_active():
            calls.append(True)
            if len(calls) == 2:
                raise product_action_handlers.ActionHandlerError("RUN_CANCELED", "运行已取消")
        @contextmanager
        def fake_media(note):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"video")
                yield path
        with self.Session() as db, patch.object(media.settings_service, "get_asr_config", return_value={"api_key": "unit-test"}), patch.object(media, "prepared_media", side_effect=fake_media), patch.object(media.video_extractor, "_asr_audio_file") as asr:
            note = self._note(db)
            with self.assertRaises(product_action_handlers.ActionHandlerError) as error:
                media.transcribe_note(db, user_id=self.user_id, note_id=note.id, check_active=check_active)
            self.assertEqual(error.exception.code, "RUN_CANCELED")
            asr.assert_not_called()
            db.refresh(note)
            self.assertEqual(note.transcript_raw, "")

    def test_no_audio_is_a_reusable_content_state_not_a_network_failure(self):
        @contextmanager
        def fake_media(note):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "video.mp4"
                path.write_bytes(b"video")
                yield path
        with self.Session() as db, patch.object(media.settings_service, "get_asr_config", return_value={"api_key": "unit-test"}), patch.object(media, "prepared_media", side_effect=fake_media) as prepare, patch.object(media.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=b"Stream map '0:a:0' matches no streams")), patch.object(media.video_extractor, "_asr_audio_file") as asr:
            note = self._note(db)
            first = media.transcribe_note(db, user_id=self.user_id, note_id=note.id)
            second = media.transcribe_note(db, user_id=self.user_id, note_id=note.id)
            self.assertEqual(first["state"], "no_audio")
            self.assertEqual(second["transcript_notice"], "无音频")
            self.assertTrue(second["already_existed"])
            self.assertEqual(prepare.call_count, 1)
            asr.assert_not_called()

    def test_transcript_handler_rejects_missing_or_ambiguous_note_identity(self):
        with self.Session() as db:
            ctx = SimpleNamespace(db=db, user=SimpleNamespace(id=self.user_id))
            for payload in [{}, {"note_id": "a", "aweme_id": "b"}]:
                with self.assertRaises(product_action_handlers.ActionHandlerError) as error:
                    product_action_handlers.library_transcript_generate(ctx, payload)
                self.assertEqual(error.exception.code, "INVALID_INPUT")

    def test_core_import_does_not_reach_other_platform_cookie_paths(self):
        with self.Session() as db, patch.object(product_action_handlers, "profile_name", return_value="core"), patch.object(product_action_handlers.platform_library_service, "import_one") as old_import:
            ctx = SimpleNamespace(db=db, user=SimpleNamespace(id=self.user_id))
            with self.assertRaises(product_action_handlers.ActionHandlerError) as error:
                product_action_handlers.library_import_link(ctx, {"url": "https://www.xiaohongshu.com/explore/example"})
            self.assertEqual(error.exception.code, "UNSUPPORTED_PLATFORM")
            old_import.assert_not_called()


class PublicMediaNetworkTests(unittest.TestCase):
    def test_disguised_playlist_is_rejected_before_ffmpeg(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(media.subprocess, "run") as process:
            source = Path(directory) / "not-video.bin"
            source.write_text("#EXTM3U\nfile:///etc/passwd\n", encoding="utf-8")
            with self.assertRaises(media.VideoLinkError) as error:
                media._remux([source], Path(directory) / "video.mp4")
            self.assertEqual(error.exception.code, "INVALID_MEDIA")
            process.assert_not_called()

    def test_known_douyin_id_reads_official_mobile_share_page_once(self):
        info = {"video_id": "7659724478275947822", "title": "真实平台标题", "download_url": "https://v.douyinvod.com/a"}
        with patch.object(media, "_target"), patch.object(media.video_extractor, "parse_video_info", return_value=info) as parse:
            self.assertEqual(media._public_info("https://www.douyin.com/video/7659724478275947822", "douyin"), info)
        parse.assert_called_once_with("https://www.iesdouyin.com/share/video/7659724478275947822")

    def test_local_ffmpeg_remux_preserves_real_video_and_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.mp4", Path(directory) / "output.mp4"
            command = [media.video_extractor._get_ffmpeg_path(), "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.3:r=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source)]
            result = subprocess.run(command, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            media._remux([source], target)
            decoded = subprocess.run([media.video_extractor._get_ffmpeg_path(), "-nostdin", "-loglevel", "error", "-i", str(target), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], capture_output=True, timeout=20)
            self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors="replace"))
            self.assertIn(b"ftyp", target.read_bytes()[:32])

    def test_bilibili_other_parts_fail_explicitly_instead_of_returning_first_part(self):
        with self.assertRaises(media.VideoLinkError) as error:
            media._source("https://www.bilibili.com/video/BV1Example?p=2")
        self.assertEqual(error.exception.code, "UNSUPPORTED_VIDEO_PART")

    def test_platform_open_redirect_or_non_video_page_is_rejected_before_parser(self):
        for url in ["https://www.bilibili.com/redirect?url=http://127.0.0.1", "https://www.douyin.com/redirect?url=http://127.0.0.1", "https://space.bilibili.com/1234"]:
            with self.assertRaises(media.VideoLinkError) as error:
                media._source(url)
            self.assertEqual(error.exception.code, "INVALID_INPUT")
        for url in ["https://v.douyin.com/example/?token=secret", "https://v.douyin.com/redirect/to/another", "https://v.douyin.com/example/#fragment"]:
            with self.assertRaises(media.VideoLinkError):
                media._source(url)

    def test_rejects_private_dns_userinfo_ports_and_wrong_platform(self):
        for url in ["http://v.douyinvod.com/a", "https://user:pass@v.douyinvod.com/a", "https://v.douyinvod.com:8443/a", "https://v.douyinvod.com.evil.test/a", "https://localhost/a", "https://127.0.0.1/a"]:
            with self.assertRaises(media.VideoLinkError):
                media._target(url, media._MEDIA_DOMAINS["douyin"])
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"]:
            with patch.object(media.socket, "getaddrinfo", return_value=[(2, 1, 6, "", (address, 443))]):
                with self.assertRaises(media.VideoLinkError):
                    media._target("https://v.douyinvod.com/a", media._MEDIA_DOMAINS["douyin"])

    def test_connects_to_validated_ip_with_tls_hostname_and_no_credentials(self):
        response = MagicMock(status=200)
        pool = MagicMock()
        pool.urlopen.return_value = response
        with patch.object(media.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]), patch.object(media.urllib3, "HTTPSConnectionPool", return_value=pool) as factory:
            with media._get("https://v.douyinvod.com/a?signature=ephemeral", domains=media._MEDIA_DOMAINS["douyin"], referer="https://www.douyin.com/", deadline=time.monotonic() + 30):
                pass
        self.assertEqual(factory.call_args.args[0], "8.8.8.8")
        self.assertEqual(factory.call_args.kwargs["server_hostname"], "v.douyinvod.com")
        self.assertEqual(factory.call_args.kwargs["assert_hostname"], "v.douyinvod.com")
        headers = pool.urlopen.call_args.kwargs["headers"]
        self.assertFalse({"authorization", "cookie", "x-zhicui-scope"} & {key.lower() for key in headers})
        self.assertFalse(pool.urlopen.call_args.kwargs["redirect"])
        self.assertFalse(pool.urlopen.call_args.kwargs["retries"])
        response.close.assert_called_once()

    def test_redirect_cannot_escape_official_cdn(self):
        response = MagicMock(status=302, headers={"Location": "http://169.254.169.254/latest/meta-data"})
        pool = MagicMock()
        pool.urlopen.return_value = response
        with patch.object(media.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]), patch.object(media.urllib3, "HTTPSConnectionPool", return_value=pool):
            with self.assertRaises(media.VideoLinkError) as error:
                with media._get("https://v.douyinvod.com/a", domains=media._MEDIA_DOMAINS["douyin"], referer="https://www.douyin.com/", deadline=time.monotonic() + 30):
                    pass
            self.assertEqual(error.exception.code, "UNSAFE_MEDIA_TARGET")
            self.assertEqual(pool.urlopen.call_count, 1)

    def test_content_type_size_and_empty_media_are_rejected(self):
        cases = [({"Content-Type": "text/html"}, [b"<html>"], "INVALID_MEDIA"), ({"Content-Type": "video/mp4", "Content-Length": "9999999"}, [b"small"], "MEDIA_TOO_LARGE"), ({"Content-Type": "video/mp4"}, [], "INVALID_MEDIA"), ({"Content-Type": "video/mp4"}, [b"123456"], "MEDIA_TOO_LARGE")]
        for headers, chunks, code in cases:
            response = MagicMock(headers=headers)
            response.stream.return_value = iter(chunks)
            @contextmanager
            def fake_get(*args, **kwargs):
                yield response
            with tempfile.TemporaryDirectory() as directory, patch.object(media, "_get", side_effect=fake_get):
                with self.assertRaises(media.VideoLinkError) as error:
                    media._download("https://v.douyinvod.com/a", Path(directory) / "video.bin", platform="douyin", budget=[5], deadline=time.monotonic() + 30)
                self.assertEqual(error.exception.code, code)

    def test_platform_verification_is_not_automatically_retried(self):
        with patch.object(media, "_target"), patch.object(media.video_extractor, "parse_video_info", side_effect=media.video_extractor.VideoMetadataUnavailableError("upstream sensitive URL")) as parse:
            with self.assertRaises(media.VideoLinkError) as error:
                media._public_info("https://www.douyin.com/video/7659724478275947822", "douyin")
            self.assertEqual(error.exception.code, "PLATFORM_AUTH_REQUIRED")
            self.assertFalse(error.exception.retryable)
            self.assertNotIn("sensitive", str(error.exception))
            parse.assert_called_once()


if __name__ == "__main__":
    unittest.main()
