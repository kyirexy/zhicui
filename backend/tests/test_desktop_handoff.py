"""桌面端网页登录交接的跨数据库时间兼容回归测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from app.services.desktop_handoff_service import _is_expired, _naive_utc


class DesktopHandoffTimeTest(unittest.TestCase):
    def test_normalizes_aware_postgres_timestamp_to_naive_utc(self) -> None:
        value = datetime(2026, 8, 26, 23, 0, tzinfo=timezone(timedelta(hours=8)))
        self.assertEqual(_naive_utc(value), datetime(2026, 8, 26, 15, 0))

    def test_compares_postgres_aware_expiry_with_sqlite_naive_now(self) -> None:
        expires_at = datetime(2026, 8, 26, 15, 5, tzinfo=timezone.utc)
        naive_now = datetime(2026, 8, 26, 15, 4)
        self.assertFalse(_is_expired(expires_at, now=naive_now))

    def test_compares_sqlite_naive_expiry_with_aware_now(self) -> None:
        expires_at = datetime(2026, 8, 26, 15, 5)
        aware_now = datetime(2026, 8, 26, 15, 6, tzinfo=timezone.utc)
        self.assertTrue(_is_expired(expires_at, now=aware_now))


if __name__ == "__main__":
    unittest.main()
