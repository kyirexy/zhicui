import os
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

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

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
        with patch.object(client_download_service, "record_download", side_effect=RuntimeError("db unavailable")):
            response = client_download("windows", self.db)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], "/download/Zhicui-Setup-1.0.3-x64.exe")

    def test_unknown_platform_is_rejected_by_counter(self) -> None:
        with self.assertRaises(ValueError):
            client_download_service.record_download(self.db, "macos")


if __name__ == "__main__":
    unittest.main()
