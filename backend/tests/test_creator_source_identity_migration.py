"""验证唯一键迁移保留现有目录、子任务、删除记录和外键。"""
import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine, inspect
from sqlalchemy.dialects.postgresql import dialect
from sqlalchemy.exc import IntegrityError

from app.services import creator_source_identity_migration as migration


class PostgreSQLConstraintPlanTests(unittest.TestCase):
    def _run(self, before, locked=None):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = 'postgresql'
        connection.dialect = dialect()
        engine.begin.return_value.__enter__.return_value = connection
        initial, current = MagicMock(), MagicMock()
        initial.has_table.return_value = True
        initial.get_unique_constraints.return_value = before
        current.get_unique_constraints.return_value = before if locked is None else locked
        with patch.object(migration, 'inspect', side_effect=[initial, current]):
            migration.ensure_schema(engine)
        return [str(call.args[0]) for call in connection.execute.call_args_list]

    def test_renamed_legacy_is_quoted_and_existing_equivalent_new_is_reused(self):
        statements = self._run([
            {'name': 'old " quoted name', 'column_names': list(migration.OLD_COLUMNS)},
            {'name': 'existing_source_key', 'column_names': list(migration.NEW_COLUMNS)},
        ])
        self.assertEqual(len(statements), 2)
        self.assertIn('LOCK TABLE', statements[0])
        self.assertIn('DROP CONSTRAINT "old "" quoted name"', statements[1])

    def test_another_startup_already_migrated_before_lock_is_noop(self):
        statements = self._run(
            [{'name': migration.OLD, 'column_names': list(migration.OLD_COLUMNS)}],
            [{'name': migration.NEW, 'column_names': list(migration.NEW_COLUMNS)}],
        )
        self.assertEqual(len(statements), 1)

    def test_new_constraint_name_collision_fails_without_dropping_old(self):
        with self.assertRaisesRegex(RuntimeError, '字段不匹配'):
            self._run([
                {'name': migration.OLD, 'column_names': list(migration.OLD_COLUMNS)},
                {'name': migration.NEW, 'column_names': ['id']},
            ])


class CreatorSourceIdentityMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        with self.engine.connect() as connection:
            connection.exec_driver_sql('PRAGMA foreign_keys=ON')
            connection.commit()
            connection.exec_driver_sql('CREATE TABLE creator_sources (id TEXT PRIMARY KEY)')
            connection.exec_driver_sql('CREATE TABLE notes (id TEXT PRIMARY KEY)')
            connection.exec_driver_sql('''CREATE TABLE creator_source_items (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                source_id TEXT NOT NULL REFERENCES creator_sources(id),
                platform TEXT NOT NULL, external_id TEXT NOT NULL,
                note_id TEXT REFERENCES notes(id), state TEXT NOT NULL,
                removed_at TEXT, extra_future_column TEXT,
                CONSTRAINT uq_creator_item_user_platform_external
                  UNIQUE (user_id, platform, external_id),
                CONSTRAINT valid_state CHECK (state IN ('ready','removed'))
            )''')
            connection.exec_driver_sql('''CREATE TABLE creator_sync_run_items (
                id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL
                REFERENCES creator_source_items(id) ON DELETE CASCADE)''')
            connection.exec_driver_sql('CREATE INDEX saved_index ON creator_source_items(source_id)')
            connection.exec_driver_sql("INSERT INTO creator_sources VALUES ('a'),('b')")
            connection.exec_driver_sql("INSERT INTO notes VALUES ('note')")
            connection.exec_driver_sql("INSERT INTO creator_source_items VALUES ('item','user','a','douyin','12345','note','removed','2026-01-01','preserved')")
            connection.exec_driver_sql("INSERT INTO creator_sync_run_items VALUES ('child','item')")
            connection.commit()

    def tearDown(self):
        self.engine.dispose()

    def test_migration_preserves_data_and_references_and_is_idempotent(self):
        with self.engine.connect() as connection:
            before = connection.exec_driver_sql('SELECT * FROM creator_source_items').all()
        migration.ensure_schema(self.engine)
        migration.ensure_schema(self.engine)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql('SELECT * FROM creator_source_items').all(), before)
            self.assertEqual(connection.exec_driver_sql('SELECT * FROM creator_sync_run_items').all(), [('child', 'item')])
            self.assertEqual(connection.exec_driver_sql('PRAGMA foreign_keys').scalar(), 1)
            self.assertEqual(connection.exec_driver_sql('PRAGMA foreign_key_check').all(), [])
            connection.exec_driver_sql("INSERT INTO creator_source_items (id,user_id,source_id,platform,external_id,state) VALUES ('partner','user','b','douyin','12345','ready')")
            connection.commit()
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("INSERT INTO creator_source_items (id,user_id,source_id,platform,external_id,state) VALUES ('duplicate','user','b','douyin','12345','ready')")
            connection.rollback()
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("UPDATE creator_source_items SET state='invalid'")
            connection.rollback()
            self.assertIn('saved_index', [item['name'] for item in inspect(connection).get_indexes('creator_source_items')])
            # 子任务外键仍指向原表，删除时也保持原有级联行为。
            connection.exec_driver_sql("DELETE FROM creator_source_items WHERE id='item'")
            self.assertEqual(connection.exec_driver_sql('SELECT * FROM creator_sync_run_items').all(), [])

    def test_failure_rolls_back_table_and_restores_foreign_keys(self):
        with self.engine.begin() as connection:
            connection.exec_driver_sql('CREATE TABLE creator_source_items_identity_new (id TEXT)')
        with self.assertRaises(Exception):
            migration.ensure_schema(self.engine)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql('SELECT id FROM creator_source_items').all(), [('item',)])
            self.assertEqual(connection.exec_driver_sql('SELECT * FROM creator_sync_run_items').all(), [('child', 'item')])
            self.assertEqual(connection.exec_driver_sql('PRAGMA foreign_keys').scalar(), 1)
            self.assertIn(['user_id', 'platform', 'external_id'],
                          [item['column_names'] for item in inspect(connection).get_unique_constraints('creator_source_items')])


if __name__ == '__main__':
    unittest.main()
