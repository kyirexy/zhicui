from __future__ import annotations

import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import video_analysis_catalog_service as catalog


class VideoAnalysisSecurityTests(unittest.TestCase):
    def test_user_byok_rejects_private_and_loopback_resolution(self) -> None:
        resolutions = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.2", 443)),
        ]
        with patch.object(catalog.socket, "getaddrinfo", return_value=resolutions):
            with self.assertRaises(catalog.VideoAnalysisCatalogError) as raised:
                catalog._validate_public_user_api_base("https://vision.example.test/v1")

        self.assertEqual(raised.exception.code, "unsafe_byok_api_base")

    def test_user_byok_requires_https(self) -> None:
        with self.assertRaises(catalog.VideoAnalysisCatalogError) as raised:
            catalog._validate_public_user_api_base("http://api.example.com/v1")

        self.assertEqual(raised.exception.code, "unsafe_byok_api_base")

    def test_secret_cannot_be_saved_without_encryption_key(self) -> None:
        with patch.object(catalog, "settings", SimpleNamespace(ENCRYPTION_KEY="")):
            with self.assertRaises(catalog.VideoAnalysisCatalogError) as raised:
                catalog._require_secret_encryption()

        self.assertEqual(raised.exception.code, "encryption_key_required")
        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
