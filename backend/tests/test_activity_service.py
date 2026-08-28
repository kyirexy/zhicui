from __future__ import annotations

import unittest

from app.services import activity_service


class ActivityServiceTests(unittest.TestCase):
    def test_local_sync_observability_keeps_only_bounded_public_counts(self) -> None:
        detail = activity_service.sanitize_detail({
            "outcome": "completed",
            "source_mode": "like",
            "accepted": 27,
            "created": 7,
            "reused": 20,
            "ready": 20,
            "quarantined": 7,
            "client_version": "1.0.9",
            "channel": "desktop-local",
            "cookie": "must-not-survive",
            "media_url": "https://example.invalid/private",
        })

        self.assertEqual(detail["accepted"], 27)
        self.assertEqual(detail["ready"], 20)
        self.assertEqual(detail["quarantined"], 7)
        self.assertEqual(detail["client_version"], "1.0.9")
        self.assertEqual(detail["channel"], "desktop-local")
        self.assertNotIn("cookie", detail)
        self.assertNotIn("media_url", detail)
        self.assertIn(
            "完整 20，隔离 7",
            activity_service.summarize_detail("douyin_local_sync", detail),
        )


if __name__ == "__main__":
    unittest.main()
