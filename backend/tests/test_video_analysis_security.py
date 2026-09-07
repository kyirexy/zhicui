from __future__ import annotations

import socket
import struct
import zlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import video_analysis_catalog_service as catalog


class VideoAnalysisSecurityTests(unittest.TestCase):
    def test_image_probe_uses_visible_picture_and_checks_answer(self) -> None:
        self.assertEqual(struct.unpack(">II", catalog._TEST_PNG[16:24]), (96, 96))
        offset = 8
        image_data = b""
        while offset < len(catalog._TEST_PNG):
            size = struct.unpack(">I", catalog._TEST_PNG[offset:offset + 4])[0]
            kind = catalog._TEST_PNG[offset + 4:offset + 8]
            data = catalog._TEST_PNG[offset + 8:offset + 8 + size]
            checksum = struct.unpack(">I", catalog._TEST_PNG[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(zlib.crc32(kind + data), checksum)
            if kind == b"IDAT":
                image_data += data
            offset += size + 12
        self.assertEqual(len(zlib.decompress(image_data)), 96 * (1 + 96 * 3))
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"left":"cyan","right":"red"}'))])
        with patch("litellm.completion", return_value=response) as complete:
            catalog._test_image_completion(driver="openai_compatible", model="test-model", api_base="https://example.test/v1", api_key="unit-test-not-secret")
            self.assertEqual(complete.call_args.kwargs["num_retries"], 0)
            self.assertEqual(complete.call_args.kwargs["messages"][0]["content"][1]["type"], "image_url")
        response.choices[0].message.content = "图片可见"
        with patch("litellm.completion", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "未正确识别"):
                catalog._test_image_completion(driver="openai_compatible", model="test-model", api_base="https://example.test/v1", api_key="unit-test-not-secret")

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
