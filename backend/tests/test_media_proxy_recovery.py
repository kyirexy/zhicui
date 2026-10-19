"""失效封面和媒体的受控恢复：身份、凭据边界、重试上限与错误可观测性。"""

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import requests
from fastapi import HTTPException

from app.api import routes
from app.services import media_proxy_recovery as recovery, video_extractor


VIDEO_ID = "7572042304085708038"
SCOPE = "s" * 32
COMPANION = "http://127.0.0.1:9000/api/v1/"
COVER = "https://p3.douyinpic.com/refreshed.jpg?signature=DO_NOT_LOG"
MEDIA = "https://v3.douyinvod.com/refreshed.mp4?signature=DO_NOT_LOG"


def upstream(status=200, content_type="image/jpeg", chunks=None, headers=None):
    value = Mock()
    value.status_code = status
    value.headers = {"Content-Type": content_type, **(headers or {})}
    value.is_redirect = status in {301, 302, 303, 307, 308}
    value.is_permanent_redirect = status in {301, 308}
    value.iter_content.return_value = iter(chunks if chunks is not None else [b"media"])
    if status >= 400:
        value.raise_for_status.side_effect = requests.HTTPError("SECRET_UPSTREAM_URL", response=value)
    return value


class MediaProxyRecoveryTests(unittest.TestCase):
    def setUp(self):
        recovery._cover_failures.clear()
        recovery._public_cache.clear()
        self.addCleanup(recovery._cover_failures.clear)
        self.addCleanup(recovery._public_cache.clear)
        self.stack = []
        for target, name, kwargs in [
            (routes.image_memory_cache, "get", {"return_value": None}),
            (routes.image_memory_cache, "put", {}),
            (routes.douyin_library, "is_trusted_companion_url", {"side_effect": lambda value: value.startswith(COMPANION)}),
            (routes.platform_library_service, "validated_douyin_image_target", {"side_effect": lambda value: value if value.startswith("https://p3.douyinpic.com/") else ""}),
            (routes.platform_library_service, "validated_media_target", {"side_effect": lambda value, platform: value if value.startswith("https://v3.douyinvod.com/") else ""}),
        ]:
            context = patch.object(target, name, **kwargs)
            self.stack.append(context)
            context.start()
            self.addCleanup(context.stop)

    def cover(self):
        return routes._proxy_douyin_image(COMPANION + "cover/" + VIDEO_ID, SCOPE, stable_cache_key="test-cover")

    def media(self):
        return routes._proxy_short_lived_media(
            SimpleNamespace(headers={"range": "bytes=0-1023"}), COMPANION + "media/" + VIDEO_ID,
            {"X-Zhicui-Scope": SCOPE}, platform="douyin", trusted_loopback=True,
        )

    def test_missing_cover_recovers_only_same_public_work_without_scope_leak(self):
        missing, fresh = upstream(404), upstream(chunks=[b"fresh-cover"])
        with patch.object(routes.http_requests, "get", side_effect=[missing, fresh]) as get, patch.object(
            recovery.video_extractor, "parse_video_info", return_value={
                "video_id": VIDEO_ID, "platform": "douyin", "cover_url": COVER, "download_url": MEDIA,
            },
        ):
            result = self.cover()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.body, b"fresh-cover")
        self.assertEqual(get.call_args_list[0].kwargs["headers"]["X-Zhicui-Scope"], SCOPE)
        self.assertNotIn("X-Zhicui-Scope", get.call_args_list[1].kwargs["headers"])
        missing.close.assert_called()
        fresh.close.assert_called()

    def test_failed_cover_cools_down_and_keeps_real_failure_status(self):
        with patch.object(routes.http_requests, "get", return_value=upstream(404)) as get, patch.object(
            recovery.video_extractor, "parse_video_info", side_effect=video_extractor.VideoMetadataUnavailableError("private"),
        ) as parse:
            first, second = self.cover(), self.cover()
        self.assertEqual([first.status_code, second.status_code], [503, 503])
        self.assertEqual(get.call_count, 1)
        self.assertEqual(parse.call_count, 1)
        self.assertGreater(int(second.headers["retry-after"]), 1)
        self.assertEqual(second.headers["x-zhicui-media-error"], "source_unavailable")

    def test_platform_auth_failure_is_not_bypassed_by_public_recovery(self):
        with patch.object(routes.http_requests, "get", return_value=upstream(401)), patch.object(
            recovery.video_extractor, "parse_video_info",
        ) as parse:
            result = self.cover()
            with self.assertRaises(HTTPException) as error:
                self.media()
        parse.assert_not_called()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(error.exception.headers["X-Zhicui-Media-Error"], "session_required")

    def test_transient_cover_error_has_only_one_retry(self):
        with patch.object(routes.http_requests, "get", side_effect=[requests.Timeout("PRIVATE"), upstream()]) as get:
            result = self.cover()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(get.call_count, 2)

    def test_public_image_redirect_is_validated_before_request(self):
        for destination, expected_calls, expected_status in [(COVER, 2, 200), ("http://127.0.0.1/private", 1, 503)]:
            with self.subTest(destination=destination):
                recovery._cover_failures.clear()
                redirect = upstream(302, headers={"Location": destination})
                with patch.object(routes.http_requests, "get", side_effect=[redirect, upstream()]) as get:
                    result = routes._proxy_douyin_image("", "", fallback_url="https://p3.douyinpic.com/old", stable_cache_key="redirect")
                self.assertEqual(result.status_code, expected_status)
                self.assertEqual(get.call_count, expected_calls)

    def test_companion_redirect_does_not_send_scope_to_cdn(self):
        with patch.object(routes.http_requests, "get", return_value=upstream(302, headers={"Location": COVER})) as get:
            result = self.cover()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(get.call_count, 1)

    def test_media_missing_in_companion_recovers_and_preserves_range(self):
        missing, fresh = upstream(404), upstream(206, "video/mp4", headers={"Content-Range": "bytes 0-1023/5000"})
        with patch.object(routes.http_requests, "get", side_effect=[missing, fresh]) as get, patch.object(
            recovery.video_extractor, "parse_video_info", return_value={
                "video_id": VIDEO_ID, "platform": "douyin", "download_url": MEDIA,
            },
        ):
            result = self.media()
        self.assertEqual(result.status_code, 206)
        self.assertEqual(result.headers["content-range"], "bytes 0-1023/5000")
        public_headers = get.call_args_list[1].kwargs["headers"]
        self.assertEqual(public_headers["Range"], "bytes=0-1023")
        self.assertNotIn("X-Zhicui-Scope", public_headers)
        async def consume():
            return [chunk async for chunk in result.body_iterator]
        asyncio.run(consume())
        fresh.close.assert_called_once()

    def test_media_recovery_identity_mismatch_never_streams_other_work(self):
        with patch.object(routes.http_requests, "get", return_value=upstream(404)) as get, patch.object(
            recovery.video_extractor, "parse_video_info", return_value={
                "video_id": "1234567890", "platform": "douyin", "download_url": MEDIA,
            },
        ):
            with self.assertRaises(HTTPException) as error:
                self.media()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(error.exception.headers["X-Zhicui-Media-Error"], "identity_mismatch")

    def test_media_transient_failure_retries_once(self):
        with patch.object(routes.http_requests, "get", side_effect=[upstream(503), upstream(206, "video/mp4")]) as get:
            result = self.media()
        self.assertEqual(result.status_code, 206)
        self.assertEqual(get.call_count, 2)

    def test_repeated_media_failure_logs_reason_without_upstream_secrets(self):
        with patch.object(routes.http_requests, "get", return_value=upstream(503)) as get, self.assertLogs(
            "uvicorn.error.media_proxy", level="WARNING",
        ) as logs:
            with self.assertRaises(HTTPException):
                self.media()
        self.assertEqual(get.call_count, 2)
        self.assertIn("upstream_busy", " ".join(logs.output))
        self.assertNotIn("SECRET", " ".join(logs.output))
        self.assertNotIn(SCOPE, " ".join(logs.output))

    def test_range_unsatisfiable_remains_416(self):
        value = upstream(416, headers={"Content-Range": "bytes */5000"})
        with patch.object(routes.http_requests, "get", return_value=value) as get:
            result = self.media()
        self.assertEqual(result.status_code, 416)
        self.assertEqual(result.headers["content-range"], "bytes */5000")
        self.assertEqual(get.call_count, 1)
        value.close.assert_called_once()

    def test_interrupted_stream_closes_response_and_redacts_exception(self):
        value = upstream(206, "video/mp4")
        def interrupted(**_kwargs):
            yield b"first-chunk"
            raise requests.Timeout("SECRET_UPSTREAM_URL")
        value.iter_content.side_effect = interrupted
        with patch.object(routes.http_requests, "get", return_value=value):
            result = self.media()
        async def consume():
            return [chunk async for chunk in result.body_iterator]
        with self.assertLogs("uvicorn.error.media_proxy", level="WARNING") as logs:
            with self.assertRaises(RuntimeError) as error:
                asyncio.run(consume())
        self.assertNotIn("SECRET", str(error.exception))
        self.assertNotIn("SECRET", " ".join(logs.output))
        self.assertIn("timeout", " ".join(logs.output))
        value.close.assert_called_once()

    def test_public_resolution_cache_is_user_scoped(self):
        with patch.object(recovery.video_extractor, "parse_video_info", return_value={
            "video_id": VIDEO_ID, "platform": "douyin", "download_url": MEDIA,
        }) as parse:
            recovery.resolve_public_douyin(VIDEO_ID, scope="user-a")
            recovery.resolve_public_douyin(VIDEO_ID, scope="user-a")
            recovery.resolve_public_douyin(VIDEO_ID, scope="user-b")
        self.assertEqual(parse.call_count, 2)

    def test_busy_recovery_does_not_queue_more_platform_requests(self):
        self.assertTrue(recovery._resolve_slots.acquire(blocking=False))
        self.assertTrue(recovery._resolve_slots.acquire(blocking=False))
        try:
            with patch.object(recovery.video_extractor, "parse_video_info") as parse:
                info, reason = recovery.resolve_public_douyin(VIDEO_ID, scope=SCOPE)
            parse.assert_not_called()
            self.assertIsNone(info)
            self.assertEqual(reason, "recovery_busy")
        finally:
            recovery._resolve_slots.release()
            recovery._resolve_slots.release()

    def test_router_deadline_stops_redirect_and_fallback_requests(self):
        redirect = upstream(302, headers={"Location": "https://www.douyin.com/video/" + VIDEO_ID})
        session = Mock()
        session.get.return_value = redirect
        with patch("requests.Session", return_value=session), patch.object(video_extractor.time, "monotonic", side_effect=[0, 0, 21]):
            _, info = video_extractor._fetch_douyin_router_page("https://v.douyin.com/example/")
        self.assertIsNone(info)
        self.assertEqual(session.get.call_count, 1)
        redirect.close.assert_called()
        session.close.assert_called()


if __name__ == "__main__":
    unittest.main()
