import os
import json
from pathlib import Path
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "test-client-download-secret")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes import client_download
from app.models.client_download_daily import ClientDownloadDaily
from app.services import client_download_service


class ClientDownloadAnalyticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        ClientDownloadDaily.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.temporary = tempfile.TemporaryDirectory()
        self.manifest_path = Path(self.temporary.name) / "beta.json"
        self.manifest_patch = patch.object(client_download_service, "_WINDOWS_MANIFEST_PATHS", (self.manifest_path,))
        self.manifest_patch.start()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()
        self.manifest_patch.stop()
        self.temporary.cleanup()

    def write_manifest(self, **changes) -> dict:
        manifest = {
            "schema_version": 2, "platform": "windows", "architecture": "x64",
            "channel": "beta", "availability": "available", "release_status": "beta_download",
            "version": "1.2.3", "download_url": "https://luxai.cn/download/windows/Zhicui-Setup-1.2.3-x64.exe",
            "size_bytes": 90000000, "sha256": "a" * 64, "source_commit": "b" * 40,
        }
        manifest.update(changes)
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def test_record_download_aggregates_by_day_and_platform(self) -> None:
        target_day = date(2026, 8, 24)
        client_download_service.record_download(self.db, "android", day=target_day)
        client_download_service.record_download(self.db, "android", day=target_day)
        client_download_service.record_download(self.db, "windows", day=target_day)

        rows = self.db.query(ClientDownloadDaily).order_by(ClientDownloadDaily.platform).all()
        self.assertEqual([(row.platform, row.count) for row in rows], [("android", 2), ("windows", 1)])

    def test_stats_include_zero_filled_fourteen_day_trend(self) -> None:
        today = date(2026, 8, 24)
        client_download_service.record_download(self.db, "android", day=today)
        client_download_service.record_download(self.db, "windows", day=today - timedelta(days=6))
        client_download_service.record_download(self.db, "android", day=today - timedelta(days=20))

        stats = client_download_service.download_stats(self.db, today=today)
        self.assertEqual(stats["total"], 3)
        self.assertEqual(stats["today"], 1)
        self.assertEqual(stats["last_7_days"], 2)
        self.assertEqual(stats["by_platform"], {"android": 2, "windows": 1})
        self.assertEqual(len(stats["daily"]), 14)
        self.assertEqual(stats["daily"][-1], {"date": "2026-08-24", "count": 1})

    def test_redirect_uses_only_allowlisted_package_target(self) -> None:
        response = client_download("android", self.db)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], "/download/zhicui.apk")

    def test_count_failure_does_not_block_download(self) -> None:
        with patch.object(client_download_service, "record_download", side_effect=RuntimeError("db unavailable")), patch("app.api.routes.error_log_service.record_error_safely"):
            response = client_download("windows", self.db)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "/download/windows/Zhicui-Setup-latest-x64.exe",
        )

    def test_unknown_platform_is_rejected_by_counter(self) -> None:
        with self.assertRaises(ValueError):
            client_download_service.record_download(self.db, "macos")

    def test_windows_redirect_pins_manifest_version_and_remains_uncached(self) -> None:
        self.write_manifest()
        response = client_download("windows", self.db)
        self.assertEqual(response.headers["location"], "/download/windows/Zhicui-Setup-1.2.3-x64.exe")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.db.query(ClientDownloadDaily).one().count, 1)

    def test_next_download_observes_published_manifest_without_target_cache(self) -> None:
        self.write_manifest()
        first = client_download_service.download_target("windows")
        self.write_manifest(version="1.2.4", download_url="https://luxai.cn/download/windows/Zhicui-Setup-1.2.4-x64.exe")
        second = client_download_service.download_target("windows")
        self.assertNotEqual(first, second)
        self.assertTrue(first.endswith("1.2.3-x64.exe"))
        self.assertTrue(second.endswith("1.2.4-x64.exe"))

    def test_invalid_manifest_cannot_redirect_to_unverified_target(self) -> None:
        cases = [
            {"download_url": "https://example.test/Zhicui-Setup-1.2.3-x64.exe"},
            {"download_url": "https://luxai.cn/download/windows/Zhicui-Setup-1.2.2-x64.exe"},
            {"download_url": "https://luxai.cn/download/windows/Zhicui-Setup-1.2.3-x64.exe?old=1"},
            {"version": "../old"}, {"platform": "android"}, {"architecture": "arm64"},
            {"channel": "stable"}, {"availability": "unavailable"}, {"release_status": "stable_download"},
            {"sha256": "bad"}, {"source_commit": "bad"}, {"size_bytes": True}, {"size_bytes": 0},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.write_manifest(**changes)
                self.assertEqual(client_download_service.download_target("windows"), client_download_service.DOWNLOAD_TARGETS["windows"])

    def test_malformed_or_oversized_manifest_keeps_legacy_download_available(self) -> None:
        for content in [b"not json", b"[]", b"\xff", b"x" * 65537]:
            with self.subTest(size=len(content)):
                self.manifest_path.write_bytes(content)
                self.assertEqual(client_download_service.download_target("windows"), client_download_service.DOWNLOAD_TARGETS["windows"])

    def test_invalid_persistent_manifest_does_not_select_older_runtime_manifest(self) -> None:
        local = self.manifest_path.with_name("local-beta.json")
        manifest = self.write_manifest()
        local.write_text(json.dumps(manifest), encoding="utf-8")
        self.manifest_path.write_text("broken", encoding="utf-8")
        with patch.object(client_download_service, "_WINDOWS_MANIFEST_PATHS", (self.manifest_path, local)):
            self.assertEqual(client_download_service.download_target("windows"), client_download_service.DOWNLOAD_TARGETS["windows"])

    def test_download_counter_failure_still_resolves_current_version(self) -> None:
        self.write_manifest()
        with patch.object(client_download_service, "record_download", side_effect=RuntimeError("db unavailable")), patch("app.api.routes.error_log_service.record_error_safely"):
            response = client_download("windows", self.db)
        self.assertEqual(response.headers["location"], "/download/windows/Zhicui-Setup-1.2.3-x64.exe")


if __name__ == "__main__":
    unittest.main()
