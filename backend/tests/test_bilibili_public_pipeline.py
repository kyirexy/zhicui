from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import video_extractor


class _FakeStreamResponse:
    headers = {"Content-Length": "8"}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int):
        del chunk_size
        yield b"audio123"


class _FakeSession:
    trust_env = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def get(self, *_args, **_kwargs):
        return _FakeStreamResponse()


class BilibiliPublicPipelineTests(unittest.TestCase):
    def test_public_info_is_normalized_without_signed_media(self) -> None:
        payload = {
            "title": "公开视频",
            "desc": "发布简介",
            "pic": "http://i0.hdslb.com/cover.jpg",
            "pubdate": 1_700_000_000,
            "duration": 90,
            "owner": {"name": "UP主", "mid": 42},
            "pages": [
                {"cid": 111, "page": 1, "part": "第一P", "duration": 40},
                {"cid": 222, "page": 2, "part": "第二P", "duration": 50},
            ],
        }
        with patch.object(video_extractor, "_bilibili_api_data", return_value=payload):
            info = video_extractor._bilibili_public_info(
                "https://www.bilibili.com/video/BV1TEST/?p=2&spm_id_from=test",
            )

        self.assertEqual(info["video_id"], "BV1TEST")
        self.assertEqual(info["cid"], "222")
        self.assertEqual(info["page"], 2)
        self.assertEqual(info["author_name"], "UP主")
        self.assertEqual(info["cover_url"], "https://i0.hdslb.com/cover.jpg")
        self.assertEqual(info["source_url"], "https://www.bilibili.com/video/BV1TEST/?p=2")
        self.assertEqual(info["media_url"], "")

    def test_parse_prefers_public_api_and_does_not_spawn_ytdlp(self) -> None:
        expected = {"video_id": "BV1TEST", "title": "公开视频"}
        with (
            patch.object(video_extractor, "_bilibili_public_info", return_value=expected),
            patch.object(video_extractor.subprocess, "run") as process,
        ):
            result = video_extractor._parse_bilibili(
                "https://www.bilibili.com/video/BV1TEST/",
            )

        self.assertEqual(result, expected)
        process.assert_not_called()

    def test_empty_public_subtitle_result_does_not_retry_blocked_webpage(self) -> None:
        info = {"video_id": "BV1TEST", "bvid": "BV1TEST", "cid": "123"}
        with (
            patch.object(
                video_extractor,
                "_bilibili_api_data",
                return_value={"subtitle": {"subtitles": []}},
            ),
            patch.object(video_extractor.subprocess, "run") as process,
        ):
            with self.assertRaisesRegex(RuntimeError, "没有可用的字幕"):
                video_extractor._bilibili_subtitles_with_source(
                    "https://www.bilibili.com/video/BV1TEST/",
                    info,
                )

        process.assert_not_called()

    def test_audio_download_uses_public_play_api_and_converts_locally(self) -> None:
        info = {"video_id": "BV1TEST", "bvid": "BV1TEST", "cid": "123"}
        play = {
            "dash": {
                "audio": [
                    {
                        "bandwidth": 64000,
                        "baseUrl": "https://upos-sz.example/audio.m4s",
                        "backupUrl": [],
                    }
                ]
            }
        }

        def convert(command, **_kwargs):
            Path(command[-1]).write_bytes(b"mp3")
            return SimpleNamespace(returncode=0, stderr="")

        with tempfile.TemporaryDirectory() as output_dir:
            with (
                patch.object(video_extractor, "_parse_bilibili", return_value=info),
                patch.object(video_extractor, "_bilibili_api_data", return_value=play),
                patch("requests.Session", return_value=_FakeSession()),
                patch.object(video_extractor, "_get_ffmpeg_path", return_value="ffmpeg"),
                patch.object(video_extractor.subprocess, "run", side_effect=convert) as process,
            ):
                result = video_extractor._bilibili_download_audio(
                    "https://www.bilibili.com/video/BV1TEST/",
                    output_dir,
                )
                self.assertEqual(Path(result).read_bytes(), b"mp3")

        self.assertIn("-b:a", process.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
