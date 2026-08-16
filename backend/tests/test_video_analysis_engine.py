from __future__ import annotations

import json
import sys
import os
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import video_analysis_engine as engine


class _FakeTimecode:
    def __init__(self, seconds: float) -> None:
        self._seconds = seconds

    def get_seconds(self) -> float:
        return self._seconds


class VideoAnalysisEngineTests(unittest.TestCase):
    def test_adaptive_detector_uses_locked_defaults(self) -> None:
        captured: dict[str, object] = {}

        class FakeVideo:
            frame_rate = 10.0

            def close(self) -> None:
                captured["closed"] = True

        class FakeAdaptiveDetector:
            def __init__(self, **kwargs: object) -> None:
                captured["detector_kwargs"] = kwargs

        class FakeSceneManager:
            def add_detector(self, detector: object) -> None:
                captured["detector"] = detector

            def detect_scenes(self, **kwargs: object) -> None:
                captured["detect_kwargs"] = kwargs

            def get_scene_list(self, **kwargs: object) -> list[tuple[_FakeTimecode, _FakeTimecode]]:
                captured["scene_list_kwargs"] = kwargs
                return [(_FakeTimecode(0), _FakeTimecode(4)), (_FakeTimecode(4), _FakeTimecode(10))]

        fake_scenedetect = types.ModuleType("scenedetect")
        fake_scenedetect.SceneManager = FakeSceneManager
        fake_scenedetect.open_video = lambda _path: FakeVideo()
        fake_detectors = types.ModuleType("scenedetect.detectors")
        fake_detectors.AdaptiveDetector = FakeAdaptiveDetector
        media = engine.DownloadedMedia(Path("fixture.mp4"), 10_000, "fingerprint", 100)

        with patch.object(engine, "_probe_media", return_value=(10_000, 10.0)), patch.dict(
            sys.modules,
            {"scenedetect": fake_scenedetect, "scenedetect.detectors": fake_detectors},
        ):
            result = engine.detect_scenes(media)

        self.assertEqual(result.method, "pyscenedetect")
        self.assertEqual(len(result.scenes), 2)
        self.assertEqual(
            captured["detector_kwargs"],
            {
                "adaptive_threshold": 3.5,
                "min_scene_len": 6,
                "window_width": 3,
                "min_content_val": 15.0,
            },
        )
        self.assertEqual(captured["detect_kwargs"]["frame_skip"], 0)
        self.assertEqual(captured["scene_list_kwargs"], {"start_in_scene": True})
        self.assertTrue(captured["closed"])

    def test_scene_detection_failure_falls_back_to_uniform_sampling(self) -> None:
        fake_scenedetect = types.ModuleType("scenedetect")
        fake_scenedetect.SceneManager = object
        fake_scenedetect.open_video = lambda _path: (_ for _ in ()).throw(RuntimeError("boom"))
        fake_detectors = types.ModuleType("scenedetect.detectors")
        fake_detectors.AdaptiveDetector = object
        media = engine.DownloadedMedia(Path("fixture.mp4"), 12_000, "fingerprint", 100)

        with patch.object(engine, "_probe_media", return_value=(12_000, 25.0)), patch.dict(
            sys.modules,
            {"scenedetect": fake_scenedetect, "scenedetect.detectors": fake_detectors},
        ):
            detection = engine.detect_scenes(media)

        self.assertEqual(detection.method, "uniform_fallback")
        self.assertEqual(detection.degraded_reason, "scene_detection_failed")
        self.assertEqual(len(engine.select_frame_timestamps(detection, 8)), 8)

    def test_real_scenedetect_and_opencv_smoke(self) -> None:
        import cv2
        import numpy as np

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "cuts.mp4"
            writer = cv2.VideoWriter(
                str(path),
                cv2.VideoWriter_fourcc(*"mp4v"),
                10.0,
                (160, 90),
            )
            self.assertTrue(writer.isOpened())
            try:
                for color in (0, 255, 40):
                    frame = np.full((90, 160, 3), color, dtype=np.uint8)
                    for _ in range(10):
                        writer.write(frame)
            finally:
                writer.release()

            detection = engine.detect_scenes(
                engine.DownloadedMedia(path, 3_000, "smoke", path.stat().st_size)
            )

        self.assertEqual(detection.method, "pyscenedetect")
        self.assertGreaterEqual(len(detection.scenes), 1)
        self.assertGreater(detection.duration_ms, 0)

    def test_temporary_workspace_is_removed_on_exception(self) -> None:
        workspace_path: Path | None = None
        with self.assertRaisesRegex(RuntimeError, "stop"):
            with engine.temporary_media_workspace() as workspace:
                workspace_path = workspace
                nested = workspace / "frames" / "frame.jpg"
                nested.parent.mkdir()
                nested.write_bytes(b"not-a-real-frame")
                raise RuntimeError("stop")

        self.assertIsNotNone(workspace_path)
        self.assertFalse(workspace_path.exists())

    def test_stale_workspace_cleaner_only_removes_owned_prefix(self) -> None:
        temp_root = Path(tempfile.gettempdir())
        owned = Path(tempfile.mkdtemp(prefix="zhicui-video-analysis-"))
        unrelated = Path(tempfile.mkdtemp(prefix="zhicui-unrelated-"))
        old = 1
        os.utime(owned, (old, old))
        os.utime(unrelated, (old, old))
        try:
            removed = engine.cleanup_stale_media_workspaces(max_age_minutes=5)
            self.assertGreaterEqual(removed, 1)
            self.assertFalse(owned.exists())
            self.assertTrue(unrelated.exists())
            self.assertEqual(unrelated.resolve().parent, temp_root.resolve())
        finally:
            if owned.exists():
                owned.rmdir()
            if unrelated.exists():
                unrelated.rmdir()

    def test_byok_never_falls_back_to_platform_credentials(self) -> None:
        context = {
            "use_byok": True,
            "platform_provider_config": {
                "credential_source": "platform",
                "driver": "litellm_image",
                "model": "platform-vision",
                "api_key": "platform-secret",
            },
            "runtime_provider_config": {
                "credential_source": "platform",
                "driver": "litellm_image",
                "model": "platform-vision",
                "api_key": "platform-secret",
            },
        }

        with self.assertRaises(engine.ByokConfigurationError):
            engine._provider_config(context, use_byok=True)

    def test_cache_fingerprint_ignores_summary_update_timestamp(self) -> None:
        first = SimpleNamespace(
            video_id="video-1",
            transcript_raw="同一份稳定文稿",
            updated_at="2026-08-01T00:00:00Z",
            ai_summary='{"source_meta":{"platform":"douyin","media_version":"v1"}}',
        )
        refreshed = SimpleNamespace(
            video_id="video-1",
            transcript_raw="同一份稳定文稿",
            updated_at="2026-08-06T00:00:00Z",
            ai_summary=(
                '{"source_meta":{"platform":"douyin","media_version":"v1"},'
                '"detailed_video_analysis":{"status":"succeeded"}}'
            ),
        )

        self.assertEqual(
            engine.build_source_fingerprint(first, duration_ms=60_000),
            engine.build_source_fingerprint(refreshed, duration_ms=60_000),
        )
        refreshed.transcript_raw = "文稿发生了真实变化"
        self.assertNotEqual(
            engine.build_source_fingerprint(first, duration_ms=60_000),
            engine.build_source_fingerprint(refreshed, duration_ms=60_000),
        )

    def test_detailed_result_refreshes_visible_summary_section_without_duplicates(self) -> None:
        original = json.dumps(
            {
                "title": "原摘要",
                "sections": [{"title": "原有要点", "content": "保留我"}],
                "conclusion": "原结论",
            },
            ensure_ascii=False,
        )
        payload = {
            "scene_count": 4,
            "frame_count": 2,
            "visual_observations": [
                {
                    "timestamp_ms": 83_000,
                    "summary": "讲解者展示了设备接口",
                    "ocr_text": ["USB-C"],
                }
            ],
        }

        first = json.loads(
            engine.merge_detailed_analysis_summary(
                original,
                payload,
                analysis_id="analysis-1",
                status="succeeded",
            )
        )
        second = json.loads(
            engine.merge_detailed_analysis_summary(
                first,
                payload,
                analysis_id="analysis-2",
                status="succeeded",
            )
        )

        self.assertEqual(second["conclusion"], "原结论")
        self.assertEqual(second["sections"][0]["content"], "保留我")
        visual_sections = [
            section
            for section in second["sections"]
            if section.get("source") == "detailed_video_analysis"
        ]
        self.assertEqual(len(visual_sections), 1)
        self.assertIn("01:23", visual_sections[0]["content"])
        self.assertIn("USB-C", visual_sections[0]["content"])
        self.assertEqual(second["detailed_video_analysis"]["analysis_id"], "analysis-2")

    def test_failed_visual_batch_records_configured_integer_micros(self) -> None:
        class FailingDriver:
            def analyze_frames(self, *_args: object, **_kwargs: object) -> object:
                raise engine.VisionProviderCallError("上游失败")

        frames = [
            engine.FrameSample(index=index, scene_index=0, timestamp_ms=index * 1000, jpeg_bytes=b"jpeg")
            for index in range(2)
        ]
        context = {
            "platform_provider_config": {
                "credential_source": "platform",
                "driver": "metered-test",
                "model": "vision-test",
                "api_key": "secret",
                "metering": {"unit": "image"},
                "cost": {"cost_class": "metered", "micros_per_unit": 7},
            }
        }
        with patch.dict(engine._IMAGE_DRIVERS, {"metered-test": FailingDriver()}):
            observations, usage, succeeded, failed, failures = engine._run_image_analysis(
                frames,
                context=context,
                use_byok=False,
                video_title="测试",
                transcript="文稿",
                cancel_check=None,
            )

        self.assertEqual(observations, [])
        self.assertEqual((succeeded, failed), (0, 1))
        self.assertEqual(failures, ["vision_provider_failed"])
        self.assertEqual(usage.calls, 1)
        self.assertEqual(usage.image_count, 2)
        self.assertEqual(usage.platform_cost_micros, 14)

    def test_successful_image_call_counts_one_provider_unit(self) -> None:
        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content='{"frames":[{"frame_index":0,"summary":"画面"}]}'
                    )
                )
            ],
            usage=SimpleNamespace(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
            ),
        )
        fake_litellm = types.ModuleType("litellm")
        fake_litellm.completion = lambda **_kwargs: response
        frame = engine.FrameSample(
            index=0,
            scene_index=0,
            timestamp_ms=0,
            jpeg_bytes=b"jpeg",
        )
        with patch.dict(sys.modules, {"litellm": fake_litellm}):
            result = engine.LiteLLMImageDriver().analyze_frames(
                [frame],
                provider_config={
                    "runtime_model": "openai/test-vision",
                    "api_key": "secret",
                    "credential_source": "platform",
                    "metering": {"unit": "call"},
                    "cost": {
                        "cost_class": "metered",
                        "per_provider_unit_micros": 11,
                    },
                },
                video_title="测试",
                transcript="",
                batch_index=0,
                batch_count=1,
            )

        self.assertEqual(result.usage.calls, 1)
        self.assertEqual(result.usage.provider_units, 1)
        self.assertEqual(result.usage.platform_cost_micros, 11)

    def test_cached_payload_drops_media_credentials_and_binary_fields(self) -> None:
        payload = {
            "method": "scene_frames_vlm",
            "download_url": "https://signed.example/video.mp4?secret=1",
            "cookie": "session=top-secret",
            "visual_observations": [
                {
                    "timestamp_ms": 1000,
                    "summary": "安全观察",
                    "jpeg_bytes": "binary-secret",
                    "source_url": "https://private.example/frame.jpg",
                    "nested": {"api_key": "sk-secret", "path": "C:/tmp/frame.jpg"},
                }
            ],
            "evidence": [
                {"source": "visual", "timestamp_ms": 1000, "quote": "安全观察"}
            ],
        }

        serialized = json.dumps(engine.cached_result_payload(payload), ensure_ascii=False)

        self.assertIn("安全观察", serialized)
        for forbidden in (
            "signed.example",
            "top-secret",
            "binary-secret",
            "private.example",
            "sk-secret",
            "C:/tmp",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_duration_probe_prefers_explicit_note_metadata(self) -> None:
        note = SimpleNamespace(
            video_url="https://www.bilibili.com/video/BV1test/",
            ai_summary='{"source_meta":{"platform":"bilibili","duration_ms":12345}}',
        )

        with patch("app.services.video_extractor._parse_bilibili") as remote_probe:
            self.assertEqual(engine.probe_note_duration_ms(note), 12_345)

        remote_probe.assert_not_called()

    def test_duration_probe_reports_unknown_without_media_download(self) -> None:
        note = SimpleNamespace(
            video_url="https://www.bilibili.com/video/BV1test/",
            ai_summary='{"source_meta":{"platform":"bilibili"}}',
        )
        with patch(
            "app.services.video_extractor._parse_bilibili",
            return_value={"duration": None, "download_url": "https://media.invalid/video.mp4"},
        ):
            self.assertEqual(engine.probe_note_duration_ms(note), 0)

    def test_douyin_router_duration_uses_milliseconds(self) -> None:
        payload = {
            "loaderData": {
                "video_(id)/page": {
                    "videoInfoRes": {
                        "item_list": [{"video": {"duration": 62_345}}]
                    }
                }
            }
        }

        self.assertEqual(engine._douyin_router_duration_ms(payload), 62_345)

    def test_public_download_rejects_private_dns_resolution(self) -> None:
        with patch.object(
            engine.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("10.0.0.8", 443))],
        ):
            with self.assertRaises(engine.MediaDownloadError):
                engine._validate_download_url(
                    "https://media.example.test/video.mp4",
                    allow_private_network=False,
                )

        # The explicitly registered local companion remains available.
        engine._validate_download_url(
            "http://127.0.0.1:9000/media/video.mp4",
            allow_private_network=True,
        )


if __name__ == "__main__":
    unittest.main()
