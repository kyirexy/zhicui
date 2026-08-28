from __future__ import annotations

import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("JWT_SECRET", "test-douyin-share-input-secret")

from app.api import routes
from app.services import video_extractor


SHARE_URL = "https://v.douyin.com/Example123/"
AWEME_ID = "7672579366093622537"
BINDING_ID = "dyb-0123456789abcdefabcd"
SESSION_SCOPE = "s" * 32
SHARE_TEXT = (
    "1.51 复制打开抖音，看看【测试作者的作品】#测试 "
    f"{SHARE_URL} 复制此链接，打开抖音搜索，直接观看视频！"
)


async def _stream_text(response) -> str:
    chunks: list[str] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)


class _FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        url: str = SHARE_URL,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.url = url
        self._body = body
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self._body), chunk_size):
            yield self._body[offset : offset + chunk_size]

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self) -> None:
        self.closed = True


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []
        self.trust_env = True
        self.closed = False

    def get(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)

    def close(self) -> None:
        self.closed = True


class DouyinShareInputTests(unittest.TestCase):
    def test_share_message_extracts_only_supported_url(self) -> None:
        self.assertEqual(video_extractor.normalize_share_url(SHARE_TEXT), SHARE_URL)
        self.assertEqual(video_extractor._detect_platform(SHARE_TEXT), "douyin")

    def test_platform_detection_uses_hostname_boundary(self) -> None:
        malicious = "https://evil-douyin.com/video/123?next=douyin.com"
        self.assertEqual(video_extractor._detect_platform(malicious), "unknown")

    def test_parse_video_info_passes_normalized_url_to_connector(self) -> None:
        processor = MagicMock()
        processor.parse_share_url.return_value = {
            "video_id": "123",
            "title": "测试作品",
            "url": "https://media.example/video.mp4",
        }
        with patch.object(video_extractor, "DouyinProcessor", return_value=processor):
            result = video_extractor.parse_video_info(SHARE_TEXT)

        processor.parse_share_url.assert_called_once_with(SHARE_URL)
        self.assertEqual(result["video_id"], "123")
        self.assertEqual(result["source_url"], SHARE_URL)

    def test_loader_data_shape_is_probed_without_fixed_page_key(self) -> None:
        payload = {
            "loaderData": {
                "arbitrary-page-key": {
                    "videoInfoRes": {
                        "item_list": [
                            {
                                "aweme_id": "456",
                                "desc": "结构探测作品",
                                "author": {"nickname": "测试作者"},
                                "video": {
                                    "play_addr": {
                                        "url_list": ["https://media.example/456.mp4"],
                                    },
                                    "cover": {
                                        "url_list": ["https://image.example/456.jpg"],
                                    },
                                },
                            }
                        ]
                    }
                }
            }
        }
        result = video_extractor._normalize_douyin_info(payload)
        self.assertEqual(result["video_id"], "456")
        self.assertEqual(result["title"], "结构探测作品")
        self.assertEqual(result["author_name"], "测试作者")
        self.assertEqual(result["url"], "https://media.example/456.mp4")

    def test_bounded_router_fallback_recovers_loader_data(self) -> None:
        payload = {
            "loaderData": {
                "new-page-key": {
                    "videoInfoRes": {
                        "item_list": [
                            {
                                "aweme_id": "789",
                                "desc": "页面兜底作品",
                                "video": {
                                    "play_addr": {
                                        "url_list": ["https://media.example/789.mp4"],
                                    }
                                },
                            }
                        ]
                    }
                }
            }
        }
        html = (
            "<script>window._ROUTER_DATA = "
            + json.dumps(payload, ensure_ascii=False)
            + "</script>"
        ).encode()
        response = _FakeResponse(
            body=html,
            headers={"Content-Length": str(len(html))},
        )
        session = _FakeSession([response])
        with patch("requests.Session", return_value=session):
            recovered = video_extractor._fetch_douyin_router_payload(SHARE_URL)

        self.assertEqual(recovered, payload)
        self.assertFalse(session.trust_env)
        self.assertTrue(session.closed)
        self.assertTrue(response.closed)
        self.assertFalse(session.calls[0][1]["allow_redirects"])
        self.assertTrue(session.calls[0][1]["stream"])

    def test_router_fallback_rejects_redirect_outside_allowlist(self) -> None:
        response = _FakeResponse(
            status_code=302,
            headers={"Location": "https://evil.example/internal"},
        )
        session = _FakeSession([response])
        with patch("requests.Session", return_value=session):
            recovered = video_extractor._fetch_douyin_router_payload(SHARE_URL)

        self.assertIsNone(recovered)
        self.assertEqual(len(session.calls), 1)

    def test_router_page_retains_aweme_id_when_ssr_has_no_item(self) -> None:
        aweme_id = "7672579366093622537"
        redirect = _FakeResponse(
            status_code=302,
            headers={
                "Location": (
                    f"https://www.iesdouyin.com/share/video/{aweme_id}/"
                    "?region=CN&mid=example"
                )
            },
        )
        ssr_html = (
            '<script>window._ROUTER_DATA = {"loaderData":{"env":{"ssr":true}}}'
            "</script>"
        ).encode()
        page = _FakeResponse(
            url=f"https://www.douyin.com/video/{aweme_id}",
            body=ssr_html,
        )
        canonical = _FakeResponse(
            url=f"https://www.iesdouyin.com/share/video/{aweme_id}",
            body=ssr_html,
        )
        session = _FakeSession([redirect, page, canonical])
        with patch("requests.Session", return_value=session):
            resolved_id, payload = video_extractor._fetch_douyin_router_page(
                SHARE_URL
            )

        self.assertEqual(resolved_id, aweme_id)
        self.assertIsNone(payload)

    def test_aweme_id_parser_accepts_ies_share_video_and_note_paths(self) -> None:
        self.assertEqual(
            video_extractor._douyin_aweme_id_from_url(
                f"https://www.iesdouyin.com/share/video/{AWEME_ID}/?region=CN"
            ),
            AWEME_ID,
        )
        self.assertEqual(
            video_extractor._douyin_aweme_id_from_url(
                f"https://www.iesdouyin.com/share/note/{AWEME_ID}/"
            ),
            AWEME_ID,
        )

    def test_missing_video_info_becomes_safe_user_error(self) -> None:
        processor = MagicMock()
        processor.parse_share_url.side_effect = KeyError("videoInfoRes")
        with (
            patch.object(
                video_extractor,
                "_fetch_douyin_router_page",
                return_value=("", None),
            ),
            self.assertRaises(video_extractor.VideoMetadataUnavailableError) as raised,
        ):
            video_extractor._parse_douyin_share_info(processor, SHARE_TEXT)

        message = str(raised.exception)
        self.assertIn("抖音暂时未返回", message)
        self.assertNotIn("videoInfoRes", message)
        self.assertNotIn(SHARE_URL, message)

    def test_missing_fixed_key_uses_router_fallback(self) -> None:
        processor = MagicMock()
        processor.parse_share_url.side_effect = KeyError("videoInfoRes")
        payload = {
            "item_list": [
                {
                    "aweme_id": "fallback-1",
                    "desc": "兜底成功",
                    "video": {
                        "play_addr": {
                            "url_list": ["https://media.example/fallback.mp4"],
                        }
                    },
                }
            ]
        }
        with patch.object(
            video_extractor,
            "_fetch_douyin_router_page",
            return_value=("", payload),
        ):
            result = video_extractor._parse_douyin_share_info(processor, SHARE_TEXT)

        self.assertEqual(result["video_id"], "fallback-1")
        self.assertEqual(result["title"], "兜底成功")

    def test_transcript_reuses_already_parsed_metadata(self) -> None:
        processor = MagicMock()
        processor.download_video.return_value = "video.mp4"
        processor.extract_audio.return_value = "audio.mp3"
        processor.extract_text_from_audio.return_value = "完整文稿"
        with patch.object(video_extractor, "DouyinProcessor", return_value=processor):
            result = video_extractor.extract_transcript(
                SHARE_TEXT,
                "asr-key",
                video_info={
                    "video_id": "123",
                    "title": "测试作品",
                    "download_url": "https://media.example/123.mp4",
                },
            )

        self.assertEqual(result, "完整文稿")
        processor.parse_share_url.assert_not_called()
        processor.download_video.assert_called_once()

    def test_video_info_route_does_not_leak_connector_exception(self) -> None:
        with patch.object(
            routes.video_extractor,
            "parse_video_info",
            side_effect=KeyError("videoInfoRes?signature=secret"),
        ) as parse:
            response = routes.get_video_info(
                routes.VideoURLRequest(url=SHARE_TEXT),
                current_user=None,
            )

        parse.assert_called_once_with(SHARE_URL)
        self.assertFalse(response["success"])
        self.assertIn("暂时无法解析", response["error"])
        self.assertNotIn("videoInfoRes", response["error"])
        self.assertNotIn("signature", response["error"])

    def test_extract_route_uses_normalized_url_and_safe_error(self) -> None:
        safe_error = video_extractor.VideoMetadataUnavailableError(
            "抖音暂时未返回该作品的公开信息，请稍后重试。"
        )
        with patch.object(
            routes.video_extractor,
            "parse_video_info",
            side_effect=safe_error,
        ) as parse:
            response = routes.extract(
                routes.ExtractRequest(url=SHARE_TEXT),
                db=MagicMock(),
                current_user=SimpleNamespace(id="user-1"),
            )

        parse.assert_called_once_with(SHARE_URL)
        self.assertFalse(response["success"])
        self.assertIn("抖音暂时未返回", response["error"])
        self.assertNotIn("videoInfoRes", response["error"])

    def test_extract_route_reuses_parsed_info_for_transcription(self) -> None:
        parsed = {
            "video_id": "123",
            "title": "测试作品",
            "download_url": "https://media.example/123.mp4",
        }
        with (
            patch.object(routes.video_extractor, "parse_video_info", return_value=parsed) as parse,
            patch.object(
                routes.settings_service,
                "get_asr_config",
                return_value={
                    "api_key": "asr-key",
                    "api_base_url": "https://asr.example/v1",
                    "model": "test-asr",
                },
            ),
            patch.object(
                routes.video_extractor,
                "extract_transcript",
                return_value="完整文稿",
            ) as transcribe,
            patch.object(
                routes.ai_juicer,
                "classify_intent",
                return_value={"card_type": "general", "is_plan": False},
            ),
            patch.object(routes.ai_juicer, "generate_card", return_value={"sections": []}),
            patch.object(routes, "_save_generated_note", return_value=({"id": "note-1"}, False)),
        ):
            response = routes.extract(
                routes.ExtractRequest(url=SHARE_TEXT),
                db=MagicMock(),
                current_user=SimpleNamespace(id="user-1"),
            )

        parse.assert_called_once_with(SHARE_URL)
        self.assertTrue(response["success"])
        self.assertIs(transcribe.call_args.kwargs["video_info"], parsed)
        self.assertEqual(parsed["source_url"], SHARE_URL)

    def test_stream_route_uses_normalized_url_and_safe_error_event(self) -> None:
        safe_error = video_extractor.VideoMetadataUnavailableError(
            "抖音暂时未返回该作品的公开信息，请稍后重试。"
        )
        with patch.object(
            routes.video_extractor,
            "parse_video_info",
            side_effect=safe_error,
        ) as parse:
            response = routes.extract_stream(
                url=SHARE_TEXT,
                db=MagicMock(),
                current_user=SimpleNamespace(id="user-1"),
            )
            body = asyncio.run(_stream_text(response))

        parse.assert_called_once_with(SHARE_URL)
        self.assertIn("抖音暂时未返回", body)
        self.assertNotIn("videoInfoRes", body)
        self.assertNotIn("signature=", body)

    def test_extract_route_recovers_bound_douyin_through_sidecar(self) -> None:
        unavailable = video_extractor.VideoMetadataUnavailableError(
            "抖音暂时未返回该作品的公开信息，请稍后重试。",
            item_id=AWEME_ID,
        )
        binding = SimpleNamespace(
            id=BINDING_ID,
            session_scope=SESSION_SCOPE,
            status="connected",
            cookie_count=3,
        )
        loopback = f"http://127.0.0.1:9000/api/v1/media/{AWEME_ID}"
        headers = {"X-Zhicui-Scope": SESSION_SCOPE}
        with (
            patch.object(
                routes.video_extractor,
                "parse_video_info",
                side_effect=unavailable,
            ) as parse,
            patch.object(
                routes.douyin_binding_service,
                "get_by_user",
                return_value=binding,
            ),
            patch.object(routes.douyin_library, "get_item", return_value=None) as manifest,
            patch.object(routes.douyin_library, "public_media_url", return_value="/signed-media"),
            patch.object(routes.douyin_library, "public_cover_url", return_value="/signed-cover"),
            patch.object(routes.douyin_library, "companion_media_url", return_value=loopback),
            patch.object(routes.douyin_library, "companion_headers", return_value=headers),
            patch.object(
                routes.settings_service,
                "get_asr_config",
                return_value={
                    "api_key": "asr-key",
                    "api_base_url": "https://asr.example/v1",
                    "model": "test-asr",
                },
            ),
            patch.object(
                routes.video_extractor,
                "extract_media_url_transcript",
                return_value="通过绑定账号提取的完整文稿",
            ) as transcribe,
            patch.object(routes.video_extractor, "extract_transcript") as public_asr,
            patch.object(routes.video_extractor, "fallback_local_asr") as local_asr,
            patch.object(
                routes.ai_juicer,
                "classify_intent",
                return_value={"card_type": "general", "is_plan": False},
            ),
            patch.object(routes.ai_juicer, "generate_card", return_value={"sections": []}),
            patch.object(routes, "_save_generated_note", return_value=({"id": "note-1"}, False)),
        ):
            response = routes.extract(
                routes.ExtractRequest(url=SHARE_TEXT),
                db=MagicMock(),
                current_user=SimpleNamespace(id="user-1"),
            )

        self.assertTrue(response["success"])
        parse.assert_called_once_with(SHARE_URL)
        manifest.assert_called_once_with(SESSION_SCOPE, BINDING_ID, AWEME_ID)
        transcribe.assert_called_once_with(
            loopback,
            "asr-key",
            "https://asr.example/v1",
            "test-asr",
            request_headers=headers,
        )
        public_asr.assert_not_called()
        local_asr.assert_not_called()

    def test_stream_recovery_exposes_only_signed_preview_capabilities(self) -> None:
        unavailable = video_extractor.VideoMetadataUnavailableError(
            "抖音暂时未返回该作品的公开信息，请稍后重试。",
            item_id=AWEME_ID,
        )
        binding = SimpleNamespace(
            id=BINDING_ID,
            session_scope=SESSION_SCOPE,
            status="connected",
            cookie_count=3,
        )
        loopback = f"http://127.0.0.1:9000/api/v1/media/{AWEME_ID}"
        headers = {"X-Zhicui-Scope": SESSION_SCOPE}
        with (
            patch.object(routes.video_extractor, "parse_video_info", side_effect=unavailable),
            patch.object(routes.douyin_binding_service, "get_by_user", return_value=binding),
            patch.object(
                routes.douyin_library,
                "get_item",
                return_value={
                    "aweme_id": AWEME_ID,
                    "title": "清单中的真实标题",
                    "author_name": "测试作者",
                    "media_type": "video",
                },
            ),
            patch.object(routes.douyin_library, "public_media_url", return_value="/signed-media"),
            patch.object(routes.douyin_library, "public_cover_url", return_value="/signed-cover"),
            patch.object(routes.douyin_library, "companion_media_url", return_value=loopback),
            patch.object(routes.douyin_library, "companion_headers", return_value=headers),
            patch.object(
                routes.settings_service,
                "get_asr_config",
                return_value={
                    "api_key": "asr-key",
                    "api_base_url": "https://asr.example/v1",
                    "model": "test-asr",
                },
            ),
            patch.object(
                routes.video_extractor,
                "extract_media_url_transcript",
                return_value="通过绑定账号提取的完整文稿",
            ) as transcribe,
            patch.object(
                routes.ai_juicer,
                "classify_intent",
                return_value={"card_type": "general", "is_plan": False},
            ),
            patch.object(routes.ai_juicer, "generate_card", return_value={"sections": []}),
            patch.object(routes, "_save_generated_note", return_value=({"id": "note-1"}, False)),
        ):
            response = routes.extract_stream(
                url=SHARE_TEXT,
                db=MagicMock(),
                current_user=SimpleNamespace(id="user-1"),
            )
            body = asyncio.run(_stream_text(response))

        transcribe.assert_called_once_with(
            loopback,
            "asr-key",
            "https://asr.example/v1",
            "test-asr",
            request_headers=headers,
        )
        self.assertIn("douyin-sidecar", body)
        self.assertIn("/signed-media", body)
        self.assertIn("/signed-cover", body)
        self.assertNotIn(loopback, body)
        self.assertNotIn(SESSION_SCOPE, body)

    def test_missing_local_cover_still_gets_signed_cover_capability(self) -> None:
        item = {
            "aweme_id": AWEME_ID,
            "cover_url": "",
            "media_type": "video",
        }
        with (
            patch.object(routes.douyin_library, "public_media_url", return_value="/signed-media"),
            patch.object(routes.douyin_library, "public_cover_url", return_value="/signed-cover") as cover,
        ):
            result = routes._mint_douyin_item_capabilities(item, BINDING_ID)

        self.assertEqual(result["media_url"], "/signed-media")
        self.assertEqual(result["cover_proxy_url"], "/signed-cover")
        cover.assert_called_once_with(AWEME_ID, BINDING_ID)


if __name__ == "__main__":
    unittest.main()
