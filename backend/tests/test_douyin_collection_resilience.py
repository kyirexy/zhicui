from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services import douyin_library


class DouyinCollectionResilienceTests(unittest.TestCase):
    def test_job_diagnostics_are_normalized_and_bounded(self):
        result = douyin_library._safe_job_diagnostics(
            {
                "mode": "collection",
                "error_code": "source_blocked",
                "channel": "circuit_breaker",
                "fallback_attempted": True,
                "retry_after_seconds": 999999,
                "needs_action": False,
                "cookie": "must-not-escape",
            }
        )

        self.assertEqual(result["source_mode"], "collect")
        self.assertEqual(result["error_code"], "source_blocked")
        self.assertEqual(result["channel"], "circuit_breaker")
        self.assertEqual(result["retry_after_seconds"], 21600)
        self.assertNotIn("cookie", result)

    def test_connection_status_keeps_account_and_source_capability_separate(self):
        responses = [
            {
                "status": "ok",
                "storage_mode": "metadata_only",
                "max_sync_count": 100,
                "capabilities": ["creator_catalog", "collection_resilience", "unsafe"],
                "collection_resilience": {
                    "enabled": True,
                    "api_first": True,
                    "browser_fallback": True,
                    "browser_headless": True,
                    "cooldown_seconds": 900,
                    "cooldown_cap_seconds": 21600,
                },
            },
            {
                "valid": True,
                "count": 12,
                "private_list_readiness": {
                    "like_ready": True,
                    "collection_ready": False,
                    "missing_requirements": ["UIFID", "cookie-value-must-not-pass"],
                },
            },
        ]
        with patch.object(douyin_library, "_request", side_effect=responses):
            status = douyin_library.connection_status("scope-safe")

        self.assertTrue(status["connected"])
        self.assertTrue(status["cookie_valid"])
        self.assertEqual(
            status["capabilities"],
            ["creator_catalog", "collection_resilience"],
        )
        self.assertTrue(status["collection_resilience"]["browser_headless"])
        self.assertEqual(
            status["private_list_readiness"],
            {
                "reported": True,
                "like_ready": True,
                "collection_ready": False,
                "missing_requirements": ["UIFID"],
            },
        )

    def test_get_job_preserves_only_safe_diagnostics(self):
        payload = {
            "job_id": "safe-job",
            "status": "failed",
            "mode": "collection",
            "error": "收藏暂不可读取",
            "error_code": "source_blocked",
            "channel": "browser",
            "fallback_attempted": True,
            "retry_after_seconds": 900,
            "needs_action": False,
            "authorization": "secret",
        }
        with patch.object(douyin_library, "_request", return_value=payload):
            result = douyin_library.get_job("scope-safe", "safe-job")

        self.assertEqual(result["source_mode"], "collect")
        self.assertEqual(result["channel"], "browser")
        self.assertEqual(result["retry_after_seconds"], 900)
        self.assertNotIn("authorization", result)

    def test_structured_sidecar_error_is_allowlisted_and_user_friendly(self):
        error = douyin_library._connector_error_from_response(
            {
                "code": "argus_uifid_missing",
                "message": "unsafe upstream details",
                "needs_action": True,
                "source_mode": "collection",
                "cookie": "must-not-escape",
            },
            409,
        )

        self.assertEqual(error.code, "argus_uifid_missing")
        self.assertEqual(error.source_mode, "collect")
        self.assertTrue(error.needs_action)
        self.assertIn("重新连接抖音账号", str(error))
        self.assertNotIn("unsafe upstream details", str(error))
        self.assertNotIn("must-not-escape", str(error))

    def test_collection_readiness_blocks_only_collection_mode(self):
        cookie_state = {
            "valid": True,
            "private_list_readiness": {
                "like_ready": True,
                "collection_ready": False,
                "missing_requirements": ["UIFID"],
            },
        }
        with patch.object(
            douyin_library,
            "_request",
            return_value=cookie_state,
        ) as request:
            with self.assertRaises(douyin_library.DouyinLibraryError) as raised:
                douyin_library.trigger_collect("scope-safe", 50, "collect")

        self.assertEqual(raised.exception.code, "argus_uifid_missing")
        self.assertTrue(raised.exception.needs_action)
        self.assertEqual(request.call_count, 1)

        with patch.object(
            douyin_library,
            "_request",
            side_effect=[
                cookie_state,
                {"job_id": "like-job", "status": "pending"},
            ],
        ):
            result = douyin_library.trigger_collect("scope-safe", 20, "like")

        self.assertEqual(result["job_id"], "like-job")
        self.assertEqual(result["mode"], "like")


if __name__ == "__main__":
    unittest.main()
