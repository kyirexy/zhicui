from __future__ import annotations

import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from app.services import douyin_library


class DouyinCoverSignatureTests(unittest.TestCase):
    aweme_id = "1234567890"
    binding_ref = "dyb-0123456789abcdef0123"

    @staticmethod
    def _query(url: str) -> tuple[int, str]:
        query = parse_qs(urlsplit(url).query)
        return int(query["expires"][0]), query["signature"][0]

    def test_capabilities_are_bound_to_exact_resource_kind_and_gallery_index(self) -> None:
        media_expires, media_signature = self._query(
            douyin_library.public_media_url(self.aweme_id, self.binding_ref)
        )
        cover_expires, cover_signature = self._query(
            douyin_library.public_cover_url(self.aweme_id, self.binding_ref)
        )
        gallery_expires, gallery_signature = self._query(
            douyin_library.public_gallery_image_url(
                self.aweme_id, self.binding_ref, 2,
            )
        )

        self.assertTrue(douyin_library.verify_media_signature(
            self.aweme_id, self.binding_ref, media_expires, media_signature,
        ))
        self.assertTrue(douyin_library.verify_cover_signature(
            self.aweme_id, self.binding_ref, cover_expires, cover_signature,
        ))
        self.assertTrue(douyin_library.verify_gallery_signature(
            self.aweme_id, self.binding_ref, 2, gallery_expires, gallery_signature,
        ))
        self.assertFalse(douyin_library.verify_media_signature(
            self.aweme_id, self.binding_ref, cover_expires, cover_signature,
        ))
        self.assertFalse(douyin_library.verify_cover_signature(
            self.aweme_id, self.binding_ref, media_expires, media_signature,
        ))
        self.assertFalse(douyin_library.verify_gallery_signature(
            self.aweme_id, self.binding_ref, 3, gallery_expires, gallery_signature,
        ))

    def test_expired_capability_is_rejected_without_renewal_mode(self) -> None:
        expires = 1_700_000_000
        with (
            patch.object(douyin_library.settings, "JWT_SECRET", "cover-test-secret"),
            patch.object(douyin_library.time, "time", return_value=expires + 30),
        ):
            cover_signature = douyin_library._capability_signature(
                "cover", self.aweme_id, self.binding_ref, expires,
            )
            media_signature = douyin_library._capability_signature(
                "media", self.aweme_id, self.binding_ref, expires,
            )
            self.assertFalse(douyin_library.verify_cover_signature(
                self.aweme_id, self.binding_ref, expires, cover_signature,
            ))
            self.assertFalse(douyin_library.verify_media_signature(
                self.aweme_id, self.binding_ref, expires, media_signature,
            ))

    def test_future_signature_outside_issued_window_is_rejected(self) -> None:
        now = int(time.time())
        expires = now + douyin_library._MEDIA_URL_TTL_SECONDS + 61
        with patch.object(douyin_library.time, "time", return_value=now):
            signature = douyin_library._capability_signature(
                "cover", self.aweme_id, self.binding_ref, expires,
            )
            self.assertFalse(douyin_library.verify_cover_signature(
                self.aweme_id, self.binding_ref, expires, signature,
            ))


if __name__ == "__main__":
    unittest.main()
