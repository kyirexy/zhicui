from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from app.services import library_extraction_service, video_extractor


def _response(status_code: int, *, text: str = "", retry_after: str = "") -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.headers = {"Retry-After": retry_after} if retry_after else {}
    response.json.return_value = {"text": text}
    return response


class CloudAsrRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.audio_path = Path(self.temp_dir.name) / "audio.mp3"
        self.audio_path.write_bytes(b"fake-audio")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_503_retries_then_returns_transcript(self) -> None:
        responses = [
            _response(503, retry_after="0"),
            _response(503),
            _response(200, text="识别成功"),
        ]
        with (
            patch.object(requests, "post", side_effect=responses) as request,
            patch.object(video_extractor.time, "sleep") as sleep,
        ):
            result = video_extractor._asr_single_audio_file(
                str(self.audio_path),
                "secret-key",
            )

        self.assertEqual(result, "识别成功")
        self.assertEqual(request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_auth_failure_is_not_retried_or_leaked(self) -> None:
        response = _response(401)
        response.text = "upstream secret request id"
        with (
            patch.object(requests, "post", return_value=response) as request,
            patch.object(video_extractor.time, "sleep") as sleep,
        ):
            with self.assertRaises(video_extractor.CloudAsrError) as raised:
                video_extractor._asr_single_audio_file(
                    str(self.audio_path),
                    "secret-key",
                )

        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.status_code, 401)
        self.assertNotIn("upstream secret", str(raised.exception))
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    def test_network_failure_retries_three_times_with_safe_error(self) -> None:
        with (
            patch.object(
                requests,
                "post",
                side_effect=requests.ConnectionError("private upstream host"),
            ) as request,
            patch.object(video_extractor.time, "sleep") as sleep,
        ):
            with self.assertRaises(video_extractor.CloudAsrError) as raised:
                video_extractor._asr_single_audio_file(
                    str(self.audio_path),
                    "secret-key",
                )

        self.assertTrue(raised.exception.retryable)
        self.assertEqual(raised.exception.attempts, 3)
        self.assertNotIn("private upstream host", str(raised.exception))
        self.assertEqual(request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(
            library_extraction_service._safe_error(raised.exception),
            str(raised.exception),
        )


if __name__ == "__main__":
    unittest.main()
