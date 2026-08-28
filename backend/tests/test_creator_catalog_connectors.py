from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import creator_connectors, yutto_catalog_client


class _FakeYuttoWebSocket:
    def __init__(self, *, failures: list[dict] | None = None):
        self.messages: list[str] = []
        self.methods: list[str] = []
        self.failures = failures or []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def send(self, message: str) -> None:
        request = json.loads(message)
        method = request["method"]
        request_id = request["id"]
        self.methods.append(method)
        if method == "server.authenticate":
            result = {"authenticated": True}
        elif method == "server.info":
            result = {
                "version": "2.2.0",
                "protocol_version": 1,
                "capabilities": [
                    "resolve.start", "task.subscribe", "task.get", "task.cancel",
                ],
            }
        elif method == "resolve.start":
            result = {"task_id": "resolve-task-1", "state": "queued"}
        elif method == "task.subscribe":
            result = {
                "events": [
                    {
                        "task_id": "resolve-task-1",
                        "kind": "item_listed",
                        "data": {
                            "avid": "BV1Safe12345",
                            "cid": "102",
                            "url": "https://www.bilibili.com/video/BV1Safe12345?p=2",
                            "name": "第二 P",
                            "title": "多 P 测试",
                            "uploader": "测试 UP",
                            "description": "公开简介",
                            "cover_url": "https://i0.hdslb.com/bfs/archive/safe.jpg",
                        },
                    }
                ]
            }
        elif method == "task.get":
            result = {
                "task_id": "resolve-task-1",
                "state": "completed",
                "result": {
                    "items": [
                        {
                            "avid": "BV1Safe12345",
                            "cid": "102",
                            "url": "https://www.bilibili.com/video/BV1Safe12345?p=2",
                            "name": "第二 P",
                            "title": "多 P 测试",
                            "uploader": "测试 UP",
                            "description": "公开简介",
                            "cover_url": "https://i0.hdslb.com/bfs/archive/safe.jpg",
                            "pubdate": 1_700_000_000,
                            "duration": 22,
                            "planned_path": "/must/not/escape.mp4",
                            "cookie": "must-not-escape",
                        },
                        {
                            "avid": "BV1Safe12345",
                            "cid": "101",
                            "url": "https://www.bilibili.com/video/BV1Safe12345?p=1&token=secret",
                            "name": "第一 P",
                            "title": "多 P 测试",
                            "uploader": "测试 UP",
                            "description": "公开简介",
                            "cover_url": "https://i0.hdslb.com/bfs/archive/safe.jpg",
                        },
                    ],
                    "failures": self.failures,
                },
            }
        elif method == "task.cancel":
            result = {"task_id": "resolve-task-1", "state": "cancelled"}
        else:  # pragma: no cover - catches protocol drift in the fake itself
            raise AssertionError(f"unexpected method {method}")
        self.messages.append(
            json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result})
        )

    async def recv(self) -> str:
        for _ in range(100):
            if self.messages:
                return self.messages.pop(0)
            await asyncio.sleep(0)
        raise AssertionError("fake websocket had no response")


class YuttoCatalogContractTests(unittest.TestCase):
    def _run_fake(self, fake: _FakeYuttoWebSocket, **kwargs):
        with (
            patch.object(yutto_catalog_client, "_websocket_connect", lambda *args, **options: fake),
            patch.object(yutto_catalog_client, "_read_token", return_value="safe-test-token"),
            patch.object(yutto_catalog_client, "_server_url", return_value="ws://127.0.0.1:11223"),
        ):
            return asyncio.run(
                yutto_catalog_client._discover_async(
                    "https://space.bilibili.com/123/video",
                    on_item=kwargs.get("on_item"),
                    should_cancel=kwargs.get("should_cancel"),
                    task_started=kwargs.get("task_started"),
                )
            )

    def test_streams_resolve_items_groups_multi_p_and_never_downloads(self) -> None:
        fake = _FakeYuttoWebSocket()
        streamed: list[tuple[str, int, int | None]] = []
        result = self._run_fake(
            fake,
            on_item=lambda item, count, total: streamed.append(
                (item["external_id"], count, total)
            ),
        )

        self.assertEqual(result["total_count"], 1)
        self.assertTrue(result["complete"])
        self.assertEqual(streamed, [("BV1Safe12345", 1, None)])
        self.assertNotIn("download.start", fake.methods)
        self.assertIn("resolve.start", fake.methods)
        item = result["items"][0]
        self.assertEqual([part["page"] for part in item["parts"]], [1, 2])
        self.assertEqual(item["published_at"], "2023-11-14T22:13:20+00:00")
        self.assertEqual(item["duration_seconds"], 22)
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("planned_path", serialized)
        self.assertNotIn("must-not-escape", serialized)
        self.assertNotIn("cookie", serialized)
        self.assertNotIn("token=secret", serialized)

    def test_partial_yutto_failure_keeps_items_but_marks_incomplete(self) -> None:
        result = self._run_fake(
            _FakeYuttoWebSocket(
                failures=[{"code": "VIDEO_UNAVAILABLE", "message": "raw private detail"}]
            )
        )
        self.assertFalse(result["complete"])
        self.assertIsNone(result["total_count"])
        self.assertEqual(result["failures"], [{"external_id": "", "error_code": "VIDEO_UNAVAILABLE"}])
        self.assertNotIn("raw private detail", json.dumps(result))

    def test_cancellation_is_forwarded_to_task_cancel(self) -> None:
        fake = _FakeYuttoWebSocket()
        with self.assertRaises(yutto_catalog_client.YuttoCatalogCancelled):
            self._run_fake(fake, should_cancel=lambda: True)
        self.assertIn("task.cancel", fake.methods)
        self.assertNotIn("download.start", fake.methods)

    def test_token_file_requires_private_permissions_on_posix(self) -> None:
        if os.name != "posix":
            self.skipTest("POSIX permission semantics only")
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "server.token")
            with open(path, "w", encoding="utf-8") as token_file:
                token_file.write("token")
            os.chmod(path, 0o644)
            with (
                patch.dict(os.environ, {"YUTTO_CATALOG_TOKEN_FILE": path}),
                self.assertRaises(yutto_catalog_client.YuttoCatalogError) as raised,
            ):
                yutto_catalog_client._read_token()
        self.assertEqual(raised.exception.code, "unsafe_token_permissions")

    def test_empty_yutto_result_falls_back_to_metadata_only_ytdlp(self) -> None:
        source = SimpleNamespace(
            platform="bilibili",
            profile_url="https://space.bilibili.com/123/video",
            display_name="测试 UP",
        )
        fallback_result = {
            "items": [{"external_id": "BV1Fallback1"}],
            "complete": True,
            "total_count": 1,
            "failures": [],
            "connector": "yt-dlp-metadata-fallback",
        }
        with (
            patch.object(
                yutto_catalog_client,
                "discover_bilibili_catalog",
                return_value={
                    "items": [],
                    "complete": True,
                    "total_count": 0,
                    "failures": [],
                },
            ),
            patch.object(
                creator_connectors,
                "_discover_bilibili_catalog_fallback",
                return_value=fallback_result,
            ) as fallback,
        ):
            result = creator_connectors.discover_catalog(source)

        fallback.assert_called_once()
        self.assertEqual(result["connector"], "yt-dlp-metadata-fallback")
        self.assertEqual(result["total_count"], 1)

    def test_ytdlp_fallback_is_flat_metadata_only_and_allowlisted(self) -> None:
        captured_command: list[str] = []

        class FakeProcess:
            returncode = 0

            def poll(self):
                return self.returncode

            def communicate(self, timeout=None):
                del timeout
                return "BV1Fallback1\nBV1Fallback1\nnot-a-video\nBV1Fallback2\n", "secret stderr"

            def terminate(self):
                self.returncode = -1

        def popen(command, **_kwargs):
            captured_command.extend(command)
            return FakeProcess()

        source = SimpleNamespace(
            platform="bilibili",
            profile_url="https://space.bilibili.com/123/video",
            display_name="测试 UP",
        )
        with patch.object(creator_connectors.subprocess, "Popen", side_effect=popen):
            result = creator_connectors._discover_bilibili_catalog_fallback(
                source,
                on_item=None,
                should_cancel=None,
                run_id="fallback-test",
            )

        self.assertIn("--flat-playlist", captured_command)
        self.assertIn("--skip-download", captured_command)
        self.assertNotIn("download.start", captured_command)
        self.assertEqual(
            [item["external_id"] for item in result["items"]],
            ["BV1Fallback1", "BV1Fallback2"],
        )
        serialized = json.dumps(result)
        for forbidden in ("secret stderr", "cookie", "local_path", "media_url"):
            self.assertNotIn(forbidden, serialized)

    def test_unverified_empty_catalog_is_not_reported_as_complete(self) -> None:
        class EmptyProcess:
            returncode = 0

            def poll(self):
                return self.returncode

            def communicate(self, timeout=None):
                del timeout
                return "", "upstream raw detail"

            def terminate(self):
                self.returncode = -1

        source = SimpleNamespace(
            platform="bilibili",
            profile_url="https://space.bilibili.com/123/video",
            display_name="测试 UP",
        )
        with (
            patch.object(
                yutto_catalog_client,
                "discover_bilibili_catalog",
                return_value={
                    "items": [],
                    "complete": True,
                    "total_count": 0,
                    "failures": [],
                },
            ),
            patch.object(
                creator_connectors.subprocess,
                "Popen",
                return_value=EmptyProcess(),
            ),
            self.assertRaises(creator_connectors.CreatorConnectorError) as raised,
        ):
            creator_connectors.discover_catalog(source)

        self.assertEqual(raised.exception.code, "empty_catalog_unverified")
        self.assertNotIn("raw detail", str(raised.exception))

    def test_bilibili_risk_control_is_user_friendly_and_sanitized(self) -> None:
        error = creator_connectors._bilibili_command_error(
            "ERROR: private upstream detail; Request is rejected by server (352)",
            catalog=True,
        )
        self.assertEqual(error.code, "bilibili_risk_control")
        self.assertIn("暂时限制", str(error))
        self.assertNotIn("private upstream detail", str(error))


class DouyinCatalogContractTests(unittest.TestCase):
    source = SimpleNamespace(
        platform="douyin",
        creator_id="MS4wLjABAAAAcreator-test",
        profile_url="https://www.douyin.com/user/MS4wLjABAAAAcreator-test",
    )

    @staticmethod
    def _raw(aweme_id: str, title: str) -> dict:
        return {
            "aweme_id": aweme_id,
            "title": title,
            "desc": f"{title} 的简介",
            "author_name": "测试博主",
            "create_time": 1_700_000_000,
            "duration_ms": 61_000,
            "media_type": "video",
            "cover_url": "https://signed.example/cover.jpg?token=secret",
            "play_url": "https://signed.example/video.mp4?token=secret",
            "cookie": "must-not-escape",
            "local_path": "/must/not/escape.mp4",
        }

    def test_douyin_pages_are_deduplicated_and_allowlisted(self) -> None:
        calls = 0

        def request(method, path, **kwargs):
            nonlocal calls
            self.assertEqual(method, "POST")
            self.assertEqual(path, "/api/v1/creators/catalog")
            calls += 1
            if calls == 1:
                gallery = self._raw("10000", "图文")
                gallery["media_type"] = "gallery"
                return {
                    "catalog_id": "a" * 40,
                    "items": [gallery, self._raw("10001", "一"), self._raw("10002", "二")],
                    "next_cursor": "next-page",
                    "has_more": True,
                    "total_count": 4,
                }
            return {
                "catalog_id": "a" * 40,
                "items": [self._raw("10002", "二"), self._raw("10003", "三")],
                "next_cursor": None,
                "has_more": False,
                "total_count": 4,
                "complete": True,
            }

        streamed: list[tuple[int, int | None]] = []
        with patch.object(creator_connectors.douyin_library, "_request", side_effect=request):
            result = creator_connectors.discover_catalog(
                self.source,
                douyin_session_scope="s" * 32,
                run_id="run-douyin-pages",
                on_item=lambda _item, count, total: streamed.append((count, total)),
            )

        self.assertEqual([item["external_id"] for item in result["items"]], ["10001", "10002", "10003"])
        self.assertEqual(streamed, [(1, None), (2, None), (3, None)])
        self.assertTrue(result["complete"])
        self.assertEqual(result["total_count"], 3)
        self.assertEqual(result["items"][0]["duration_seconds"], 61)
        self.assertEqual(result["items"][0]["cover_url"], "")
        serialized = json.dumps(result)
        for forbidden in ("play_url", "cookie", "local_path", "token=secret", "must/not/escape"):
            self.assertNotIn(forbidden, serialized)

    def test_douyin_verification_preserves_streamed_progress_then_needs_action(self) -> None:
        def request(_method, _path, **_kwargs):
            return {
                "catalog_id": "b" * 40,
                "items": [self._raw("20001", "已发现")],
                "has_more": False,
                "needs_action": "verification",
            }

        streamed: list[str] = []
        with (
            patch.object(creator_connectors.douyin_library, "_request", side_effect=request),
            self.assertRaises(creator_connectors.CreatorConnectorError) as raised,
        ):
            creator_connectors.discover_catalog(
                self.source,
                douyin_session_scope="s" * 32,
                on_item=lambda item, _count, _total: streamed.append(item["external_id"]),
            )
        self.assertEqual(streamed, ["20001"])
        self.assertEqual(raised.exception.code, "douyin_verification_required")

    def test_douyin_cancel_stops_before_next_page_and_calls_sidecar(self) -> None:
        cancelled = {"value": False}
        delete_calls: list[str] = []

        def request(method, path, **_kwargs):
            if method == "DELETE":
                delete_calls.append(path)
                return {"cancelled": True}
            return {
                "catalog_id": "c" * 40,
                "items": [self._raw("30001", "第一页")],
                "next_cursor": "next-page",
                "has_more": True,
            }

        with (
            patch.object(creator_connectors.douyin_library, "_request", side_effect=request),
            self.assertRaises(creator_connectors.CreatorConnectorError) as raised,
        ):
            creator_connectors.discover_catalog(
                self.source,
                douyin_session_scope="s" * 32,
                run_id="run-douyin-cancel",
                on_item=lambda *_args: cancelled.update(value=True),
                should_cancel=lambda: cancelled["value"],
            )
        self.assertEqual(raised.exception.code, "cancelled")
        self.assertEqual(delete_calls, [f"/api/v1/creators/catalog/{'c' * 40}"])
        self.assertFalse(creator_connectors.cancel_catalog("run-douyin-cancel"))


class CatalogHealthContractTests(unittest.TestCase):
    def test_yutto_health_connection_failure_is_safe(self) -> None:
        with (
            patch.object(yutto_catalog_client, "_enabled", return_value=True),
            patch.object(
                yutto_catalog_client,
                "_websocket_connect",
                side_effect=OSError("secret socket detail"),
            ),
        ):
            result = yutto_catalog_client.health()
        self.assertEqual(result["error_code"], "connector_unavailable")
        self.assertNotIn("secret socket detail", json.dumps(result))

    def test_bilibili_health_is_allowlisted(self) -> None:
        with patch.object(
            creator_connectors.yutto_catalog_client,
            "health",
            return_value={
                "enabled": True,
                "healthy": True,
                "version": "2.2.0",
                "token": "must-not-escape",
            },
        ):
            result = creator_connectors.catalog_health("bilibili")
        self.assertTrue(result["supports_catalog_all"])
        self.assertEqual(result["version"], "2.2.0")
        self.assertNotIn("token", json.dumps(result))

    def test_douyin_health_requires_metadata_catalog_capability(self) -> None:
        with patch.object(
            creator_connectors.douyin_library,
            "_request",
            return_value={
                "status": "ok",
                "storage_mode": "metadata_only",
                "capabilities": ["creator_catalog"],
                "cookie": "must-not-escape",
            },
        ):
            result = creator_connectors.catalog_health("douyin")
        self.assertTrue(result["healthy"])
        self.assertTrue(result["supports_catalog_all"])
        self.assertNotIn("cookie", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
