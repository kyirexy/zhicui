from __future__ import annotations

import io
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.library_extraction_batch import LibraryExtractionBatch, LibraryExtractionBatchItem
from app.models.media_extraction_outcome import MediaExtractionOutcome
from app.models.note import Note
from app.models.user import User
from app.services import library_extraction_service as library
from app.services import media_extraction_outcome_service as outcomes
from app.services import video_extractor


class NoAudioClassificationTests(unittest.TestCase):
    def test_only_explicit_missing_stream_is_no_audio(self):
        self.assertTrue(video_extractor._ffmpeg_has_no_audio("Stream map '0:a:0' matches no streams."))
        self.assertTrue(video_extractor._ffmpeg_has_no_audio(
            "Stream map '' matches no streams.\r\n"
            "To ignore this, add a trailing '?' to the map.\r\n"
            "Failed to set value '0:a:0' for option 'map': Invalid argument\r\n"
            "Error parsing options for output file audio.mp3."
        ))
        self.assertTrue(video_extractor._ffmpeg_has_no_audio("Output file does not contain any stream"))
        for message in (
            "404 Not Found", "Invalid data found when processing input", "Connection reset", "Invalid audio codec",
            "Stream map '' matches no streams. Failed to set value '0:v:0' for option 'map': Invalid argument",
            "Failed to set value '0:a:0' for option 'map': Invalid argument",
        ):
            self.assertFalse(video_extractor._ffmpeg_has_no_audio(message))

    def test_http_error_is_retryable_and_does_not_leak_url(self):
        response = requests.Response()
        response.status_code = 404
        error = requests.HTTPError("404 Client Error for http://127.0.0.1:9000/private?secret=1", response=response)
        self.assertEqual(library._safe_error(error), "资源暂不可用，请稍后重试")
        self.assertNotIsInstance(error, video_extractor.NoAudioError)

    def test_successful_empty_asr_stops_before_local_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "audio.mp3").write_bytes(b"audio")
            process = MagicMock()
            process.stdin = io.BytesIO()
            process.stderr = io.BytesIO(b"")
            process.wait.return_value = 0
            response = MagicMock()
            response.headers = {}
            response.iter_content.return_value = [b"video"]
            response.__enter__.return_value = response
            session = MagicMock()
            session.__enter__.return_value = session
            session.get.return_value = response
            with (
                patch.object(video_extractor.tempfile, "mkdtemp", return_value=str(root)),
                patch.object(video_extractor.subprocess, "Popen", return_value=process),
                patch.object(video_extractor, "_get_ffmpeg_path", return_value="ffmpeg"),
                patch.object(requests, "Session", return_value=session),
                patch.object(video_extractor, "_asr_audio_file", return_value="") as asr,
                patch.dict("sys.modules", {"app.services.local_asr": None}),
            ):
                with self.assertRaises(video_extractor.NoAudioError) as raised:
                    video_extractor.extract_media_url_transcript("https://cdn.example/video", "key")
            self.assertEqual(raised.exception.reason, "no_speech")
            asr.assert_called_once()

    def test_missing_asr_text_field_is_provider_error_not_no_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "audio.mp3"
            path.write_bytes(b"audio")
            response = MagicMock(status_code=200)
            response.json.return_value = {"message": "unexpected payload"}
            with patch.object(requests, "post", return_value=response):
                with self.assertRaises(video_extractor.CloudAsrError):
                    video_extractor._asr_single_audio_file(str(path), "key")

    def test_ffmpeg_early_exit_missing_audio_is_terminal_without_asr(self):
        process = MagicMock()
        process.stdin.write.side_effect = BrokenPipeError()
        process.poll.return_value = 1
        process.stderr = io.BytesIO(b"Stream map '0:a:0' matches no streams.\n")
        response = MagicMock()
        response.headers = {}
        response.iter_content.return_value = [b"video"]
        response.__enter__.return_value = response
        session = MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = response
        with (
            patch.object(video_extractor.subprocess, "Popen", return_value=process),
            patch.object(video_extractor, "_get_ffmpeg_path", return_value="ffmpeg"),
            patch.object(requests, "Session", return_value=session),
            patch.object(video_extractor, "_asr_audio_file") as asr,
        ):
            with self.assertRaises(video_extractor.NoAudioError):
                video_extractor.extract_media_url_transcript("https://cdn.example/video", "key")
        asr.assert_not_called()


class NoAudioPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[
            User.__table__, Note.__table__, MediaExtractionOutcome.__table__,
            LibraryExtractionBatch.__table__, LibraryExtractionBatchItem.__table__,
        ])
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            db.add_all([User(id="owner", email="noaudio@example.com", hashed_password="x"),
                        User(id="other", email="other-noaudio@example.com", hashed_password="x")])
            db.commit()
        self.item = {"aweme_id": "123456789", "title": "无声视频", "can_extract": True,
                     "caption": "这条长发布文案不能伪装成已识别的音频文稿", "source_url": "https://www.douyin.com/video/123456789"}
        self.sessions = patch.object(library, "SessionLocal", self.Session)
        self.sessions.start()

    def tearDown(self):
        self.sessions.stop()
        self.engine.dispose()

    def test_persists_no_audio_without_fake_note_and_reuses_across_batches(self):
        with (
            patch.object(library.douyin_binding_service, "get_or_create", return_value=SimpleNamespace(id="b", session_scope="s" * 32)),
            patch.object(library.settings_service, "get_asr_config", return_value={"api_key": "key", "api_base_url": "", "model": "test"}),
            patch.object(video_extractor, "extract_media_url_transcript", side_effect=video_extractor.NoAudioError()) as extract,
        ):
            first = library.extract_library_item(user_id="owner", aweme_id="123456789", item=self.item)
            second = library.extract_library_item(user_id="owner", aweme_id="123456789", item=self.item)
        self.assertEqual(first["state"], "no_audio")
        self.assertTrue(second["already_existed"])
        extract.assert_called_once()
        with self.Session() as db:
            self.assertEqual(db.query(Note).count(), 0)
            self.assertTrue(outcomes.has_no_audio(db, user_id="owner", video_id="123456789"))
            self.assertFalse(outcomes.has_no_audio(db, user_id="other", video_id="123456789"))
            items = [{"aweme_id": "123456789", "can_extract": True}]
            outcomes.annotate_items(db, user_id="owner", items=items)
            self.assertEqual(items[0]["transcript_status"], "no_audio")
            self.assertFalse(items[0]["can_extract"])
            self.assertFalse(items[0]["needs_extraction"])
            ready = [{"video_id": "123456789", "transcript_ready": True, "can_extract": True}]
            outcomes.annotate_items(db, user_id="owner", items=ready)
            self.assertTrue(ready[0]["can_extract"])
            other_platform = [{"video_id": "123456789", "platform": "bilibili", "can_extract": True}]
            outcomes.annotate_items(db, user_id="owner", items=other_platform)
            self.assertNotIn("transcript_status", other_platform[0])

    def test_no_audio_batch_finishes_as_skipped_not_failed_or_transcribed(self):
        with patch.object(library, "_submit_batch"):
            job = library.create_batch_job(user_id="owner", aweme_ids=["123456789"], asr_concurrency=1, llm_concurrency=1)
        with patch.object(library, "extract_library_item", return_value=outcomes.no_audio_result()):
            library._run_job_item(job["job_id"], "owner", "123456789", "full", threading.Semaphore(1), threading.Semaphore(1))
        finished = library.get_batch_job(job["job_id"], "owner")
        self.assertEqual(finished["status"], "success")
        self.assertEqual((finished["success"], finished["failed"], finished["skipped"]), (0, 0, 1))
        self.assertEqual(finished["items"][0]["state"], "no_audio")
        self.assertFalse(library._update_item(job["job_id"], "123456789", state="transcribing"))

    def test_network_404_does_not_persist_no_audio(self):
        response = requests.Response()
        response.status_code = 404
        with (
            patch.object(library.douyin_binding_service, "get_or_create", return_value=SimpleNamespace(id="b", session_scope="s" * 32)),
            patch.object(library.settings_service, "get_asr_config", return_value={"api_key": "key", "api_base_url": "", "model": "test"}),
            patch.object(video_extractor, "extract_media_url_transcript", side_effect=requests.HTTPError(response=response)),
        ):
            with self.assertRaises(requests.HTTPError):
                library.extract_library_item(user_id="owner", aweme_id="123456789", item=self.item)
        with self.Session() as db:
            self.assertEqual(db.query(MediaExtractionOutcome).count(), 0)


if __name__ == "__main__":
    unittest.main()
