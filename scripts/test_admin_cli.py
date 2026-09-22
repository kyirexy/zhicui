#!/usr/bin/env python3
"""Contract tests for the dependency-free administrator CLI."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("admin_cli.py")
SPEC = importlib.util.spec_from_file_location("zhicui_admin_cli", MODULE_PATH)
assert SPEC and SPEC.loader
admin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admin
SPEC.loader.exec_module(admin)


class AdminCliContractTests(unittest.TestCase):
    def test_inventory_contains_management_surfaces(self) -> None:
        names = {item.name for item in admin.ENDPOINTS}
        self.assertIn("users.list", names)
        self.assertIn("llm-config.get", names)
        self.assertIn("video-analysis.credits", names)
        self.assertIn("catalog-quality.run-cancel", names)
        self.assertIn("showcase.create", names)

    def test_secret_redaction_is_recursive(self) -> None:
        payload = {
            "api_key_masked": "safe",
            "nested": [{"password": "do-not-print", "name": "kept"}],
        }
        redacted = admin._redact(payload)
        self.assertEqual(redacted["api_key_masked"], "***redacted***")
        self.assertEqual(redacted["nested"][0]["password"], "***redacted***")
        self.assertEqual(redacted["nested"][0]["name"], "kept")
        self.assertEqual(admin._redact("password=top-secret"), "password=***redacted***")

    def test_generic_request_rejects_non_admin_path(self) -> None:
        with self.assertRaises(admin.UsageError):
            admin._safe_admin_path("/api/users")
        with self.assertRaises(admin.UsageError):
            admin._safe_admin_path("/api/admin/users?page=1")
        with self.assertRaises(admin.UsageError):
            admin._safe_admin_path("/api/admin/../users")
        with self.assertRaises(admin.UsageError):
            admin._safe_admin_path("/api/admin/%2e%2e/users")

    def test_http_base_url_allows_localhost_but_rejects_lookalike(self) -> None:
        admin.AdminClient(base_url="http://127.0.0.1:8000", token="t", timeout=1)
        with self.assertRaises(admin.UsageError):
            admin.AdminClient(base_url="http://localhost.evil", token="t", timeout=1)

    def test_destructive_shortcut_requires_confirmation_before_network(self) -> None:
        parser = admin._build_parser()
        args = parser.parse_args(["users-delete", "u-1"])
        with patch.dict(os.environ, {admin.TOKEN_ENV: "test-token"}), patch.object(
            admin.AdminClient, "request", side_effect=AssertionError("network must not run")
        ):
            with self.assertRaises(admin.UsageError):
                admin._run(args)

    def test_generic_destructive_batch_request_requires_confirmation(self) -> None:
        parser = admin._build_parser()
        args = parser.parse_args(["request", "POST", "/api/admin/notes/batch-delete", "--body-json", '{"ids":[]}'])
        with patch.dict(os.environ, {admin.TOKEN_ENV: "test-token"}):
            with self.assertRaises(admin.UsageError):
                admin._run(args)

    def test_multipart_uses_file_mime_type(self) -> None:
        payload, content_type = admin._multipart_file(str(MODULE_PATH), None)
        self.assertIn("multipart/form-data; boundary=", content_type)
        self.assertIn(b"Content-Type: text/x-python", payload)

    def test_multipart_and_json_body_cannot_be_combined(self) -> None:
        client = admin.AdminClient(base_url="https://luxai.cn", token="t", timeout=1)
        with self.assertRaises(admin.UsageError):
            client.request("POST", "/api/admin/showcase-cases/1/media", body={}, file_path=str(MODULE_PATH))

    def test_http_request_sends_bearer_and_json_without_printing_token(self) -> None:
        captured: dict[str, object] = {}

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"success": True, "data": {"api_key": "secret"}}).encode()

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse()

        client = admin.AdminClient(base_url="https://luxai.cn", token="token-value", timeout=4)
        with patch.object(admin, "urlopen", side_effect=fake_urlopen):
            result = client.request("POST", "/api/admin/ops", body={"ok": True})
        request = captured["request"]
        self.assertEqual(request.get_header("Authorization"), "Bearer token-value")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(result["data"]["api_key"], "***redacted***")
        self.assertNotIn("token-value", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
