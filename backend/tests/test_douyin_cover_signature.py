from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services import douyin_library


class DouyinCoverSignatureTests(unittest.TestCase):
    def test_expired_authentic_signature_can_only_be_renewed_explicitly(self) -> None:
        aweme_id = "1234567890"
        binding_ref = "dyb-0123456789abcdef0123"
        expires = 1_700_000_000

        with (
            patch.object(douyin_library.settings, "JWT_SECRET", "cover-test-secret"),
            patch.object(douyin_library.time, "time", return_value=expires + 30),
        ):
            signature = douyin_library._media_signature(
                aweme_id,
                binding_ref,
                expires,
            )

            self.assertFalse(douyin_library.verify_media_signature(
                aweme_id,
                binding_ref,
                expires,
                signature,
            ))
            self.assertTrue(douyin_library.verify_media_signature(
                aweme_id,
                binding_ref,
                expires,
                signature,
                allow_expired=True,
            ))
            self.assertFalse(douyin_library.verify_media_signature(
                aweme_id,
                binding_ref,
                expires,
                "0" * 64,
                allow_expired=True,
            ))

    def test_future_signature_outside_issued_window_is_rejected(self) -> None:
        aweme_id = "1234567890"
        binding_ref = "dyb-0123456789abcdef0123"
        now = 1_700_000_000
        expires = now + douyin_library._MEDIA_URL_TTL_SECONDS + 61

        with (
            patch.object(douyin_library.settings, "JWT_SECRET", "cover-test-secret"),
            patch.object(douyin_library.time, "time", return_value=now),
        ):
            signature = douyin_library._media_signature(
                aweme_id,
                binding_ref,
                expires,
            )

            self.assertFalse(douyin_library.verify_media_signature(
                aweme_id,
                binding_ref,
                expires,
                signature,
                allow_expired=True,
            ))


if __name__ == "__main__":
    unittest.main()
