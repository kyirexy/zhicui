from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.api import routes


SESSION_SCOPE = "S" * 32
AWEME_ID = "7672579366093622537"


class DouyinCapabilitySecurityTests(unittest.TestCase):
    def test_cover_uses_public_hint_then_scoped_sidecar_fallback(self) -> None:
        failed = MagicMock()
        failed.is_redirect = False
        failed.is_permanent_redirect = False
        failed.raise_for_status.side_effect = RuntimeError("sidecar unavailable")
        companion_response = MagicMock()
        companion_response.is_redirect = False
        companion_response.is_permanent_redirect = False
        companion_response.headers = {"Content-Type": "image/jpeg"}
        companion_response.iter_content.return_value = [b"image"]
        companion_response.raise_for_status.return_value = None

        companion = "http://127.0.0.1:9000/api/v1/cover/" + AWEME_ID
        fallback = "https://p9.douyinpic.com/old-cover.jpeg"
        with (
            patch.object(routes.image_memory_cache, "get", return_value=None),
            patch.object(routes.image_memory_cache, "put"),
            patch.object(
                routes.platform_library_service,
                "validated_douyin_image_target",
                side_effect=lambda value: value if value == fallback else "",
            ),
            patch.object(
                routes.http_requests,
                "get",
                side_effect=[failed, companion_response],
            ) as request_get,
        ):
            response = routes._proxy_douyin_image(
                companion,
                SESSION_SCOPE,
                fallback_url=fallback,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(request_get.call_args_list[0].args[0], fallback)
        self.assertNotIn(
            "X-Zhicui-Scope",
            request_get.call_args_list[0].kwargs["headers"],
        )
        self.assertEqual(request_get.call_args_list[0].kwargs["allow_redirects"], False)
        self.assertEqual(request_get.call_args_list[1].args[0], companion)
        self.assertEqual(
            request_get.call_args_list[1].kwargs["headers"]["X-Zhicui-Scope"],
            SESSION_SCOPE,
        )
        self.assertEqual(request_get.call_args_list[1].kwargs["allow_redirects"], False)

    def test_desktop_visual_ask_uses_bound_companion_without_public_parse(self) -> None:
        binding = SimpleNamespace(
            id="dyb-0123456789abcdef0123",
            session_scope=SESSION_SCOPE,
        )
        item = {
            "aweme_id": AWEME_ID,
            "title": "作品",
            "caption": "说明",
            "media_type": "video",
            "provider": "desktop-local",
            "source_url": f"https://www.douyin.com/video/{AWEME_ID}",
        }
        with (
            patch.object(routes.library_hidden_service, "is_hidden", return_value=False),
            patch.object(routes.douyin_binding_service, "get_or_create", return_value=binding),
            patch.object(routes.douyin_library, "get_item", return_value=item),
            patch.object(routes.video_extractor, "parse_video_info") as parse_video,
            patch.object(routes.ai_juicer, "extract_video_frames", return_value=["data:image/jpeg;base64,AA=="]) as frames,
            patch.object(
                routes.ai_juicer,
                "answer_visual_question",
                return_value={"answer": "回答", "follow_up_questions": []},
            ),
            patch.object(
                routes.user_ai_provider_service,
                "effective_vision_config",
                return_value={},
            ),
        ):
            result = routes.ask_douyin_library_visual_item(
                routes.VisualAskRequest(question="画面是什么？"),
                AWEME_ID,
                MagicMock(),
                SimpleNamespace(id="user-1"),
            )

        self.assertTrue(result["success"])
        parse_video.assert_not_called()
        self.assertEqual(
            frames.call_args.args[0],
            routes.douyin_library.companion_media_url(AWEME_ID),
        )
        self.assertEqual(
            frames.call_args.kwargs["request_headers"]["X-Zhicui-Scope"],
            SESSION_SCOPE,
        )

    def test_extract_failure_response_does_not_expose_connector_exception(self) -> None:
        secret = "videoInfoRes?signature=do-not-leak"
        with patch.object(
            routes.library_extraction_service,
            "extract_library_item",
            side_effect=KeyError(secret),
        ):
            with self.assertRaises(HTTPException) as raised:
                routes.extract_douyin_library_item(
                    routes.LibraryExtractRequest(aweme_id=AWEME_ID),
                    SimpleNamespace(id="user-1"),
                )
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(
            raised.exception.detail,
            "视频文案提取暂时失败，请稍后重试",
        )
        self.assertNotIn(secret, raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
