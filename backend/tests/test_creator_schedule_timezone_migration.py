"""旧调度时间类型修复范围与并发启动幂等回归。"""
import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy import DateTime, create_engine, text

from app.services import creator_schedule_timezone_migration as migration


class CreatorScheduleTimezoneMigrationTests(unittest.TestCase):
    def test_sqlite_dates_are_unchanged(self):
        engine = create_engine('sqlite://')
        with engine.begin() as connection:
            connection.execute(text('CREATE TABLE creator_sync_runs (next_retry_at TIMESTAMP)'))
            connection.execute(text("INSERT INTO creator_sync_runs VALUES ('2026-09-10 10:00:30')"))
        migration.ensure_schema(engine)
        with engine.connect() as connection:
            self.assertEqual(connection.execute(text('SELECT next_retry_at FROM creator_sync_runs')).scalar_one(),
                             '2026-09-10 10:00:30')
        engine.dispose()

    def _postgres_plan(self, refreshed_timezone):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = 'postgresql'
        engine.begin.return_value.__enter__.return_value = connection
        before, after, missing = MagicMock(), MagicMock(), MagicMock()
        before.has_table.return_value = True
        before.get_columns.return_value = [
            {'name': 'next_retry_at', 'type': DateTime(timezone=False)},
            {'name': 'lease_until', 'type': DateTime(timezone=True)},
            {'name': 'published_at', 'type': DateTime(timezone=False)},
        ]
        after.get_columns.return_value = [
            {'name': 'next_retry_at', 'type': DateTime(timezone=refreshed_timezone)},
        ]
        missing.has_table.return_value = False
        with patch.object(migration, 'inspect', side_effect=[before, after, missing, missing]):
            migration.ensure_schema(engine)
        return [str(call.args[0]) for call in connection.execute.call_args_list]

    def test_only_legacy_schedule_column_uses_original_session_timezone(self):
        statements = self._postgres_plan(False)
        self.assertEqual(len(statements), 2)
        self.assertIn('LOCK TABLE creator_sync_runs', statements[0])
        self.assertIn("USING next_retry_at AT TIME ZONE current_setting('TimeZone')", statements[1])
        self.assertNotIn('published_at', statements[1])

    def test_concurrent_startup_does_not_convert_twice(self):
        statements = self._postgres_plan(True)
        self.assertEqual(len(statements), 1)
