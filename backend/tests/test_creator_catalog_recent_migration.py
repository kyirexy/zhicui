"""验证近期目录迁移保留任务、引用和旧约束，且失败时可回滚。"""
import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError

from app.services import creator_catalog_recent_migration as migration


class CreatorCatalogRecentMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        with self.engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.commit()
            connection.exec_driver_sql("CREATE TABLE creator_sources (id TEXT PRIMARY KEY)")
            connection.exec_driver_sql("""CREATE TABLE creator_sync_runs (
                id TEXT PRIMARY KEY, source_id TEXT REFERENCES creator_sources(id),
                operation TEXT NOT NULL, requested_limit INTEGER NOT NULL,
                extra_future_column TEXT,
                CONSTRAINT ck_creator_run_operation CHECK
                    (operation IN ('recent_transcript','catalog_all','selected_transcript')),
                CONSTRAINT ck_creator_run_requested_limit CHECK (requested_limit IN (20,50,100))
            )""")
            connection.exec_driver_sql("""CREATE TABLE creator_source_items (
                id TEXT PRIMARY KEY, last_seen_run_id TEXT REFERENCES creator_sync_runs(id) ON DELETE SET NULL)""")
            connection.exec_driver_sql("CREATE INDEX saved_index ON creator_sync_runs(source_id)")
            connection.exec_driver_sql("INSERT INTO creator_sources VALUES ('source')")
            connection.exec_driver_sql("INSERT INTO creator_sync_runs VALUES ('run','source','catalog_all',100,'preserved')")
            connection.exec_driver_sql("INSERT INTO creator_source_items VALUES ('item','run')")
            connection.commit()

    def tearDown(self):
        self.engine.dispose()

    def test_existing_rows_references_and_limits_survive_idempotent_migration(self):
        migration.ensure_schema(self.engine)
        migration.ensure_schema(self.engine)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT * FROM creator_sync_runs").all(),
                             [("run", "source", "catalog_all", 100, "preserved")])
            self.assertEqual(connection.exec_driver_sql("SELECT * FROM creator_source_items").all(), [("item", "run")])
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar(), 1)
            self.assertIn("saved_index", [row["name"] for row in inspect(connection).get_indexes("creator_sync_runs")])
            connection.exec_driver_sql("INSERT INTO creator_sync_runs VALUES ('recent','source','catalog_recent',20,'new')")
            connection.commit()
            for operation, limit in (("arbitrary", 20), ("catalog_recent", 500)):
                with self.assertRaises(IntegrityError):
                    connection.exec_driver_sql("INSERT INTO creator_sync_runs VALUES ('invalid','source',?,?,NULL)", (operation, limit))
                connection.rollback()
            connection.exec_driver_sql("DELETE FROM creator_sync_runs WHERE id='run'")
            self.assertEqual(connection.exec_driver_sql("SELECT * FROM creator_source_items").all(), [("item", None)])

    def test_failure_rolls_back_and_preserves_foreign_keys(self):
        with self.engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE creator_sync_runs_recent_new (id TEXT)")
        with self.assertRaises(Exception):
            migration.ensure_schema(self.engine)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT id FROM creator_sync_runs").all(), [("run",)])
            self.assertEqual(connection.exec_driver_sql("SELECT * FROM creator_source_items").all(), [("item", "run")])
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar(), 1)
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("INSERT INTO creator_sync_runs VALUES ('recent','source','catalog_recent',20,NULL)")

    def test_postgres_checks_inside_lock_and_replaces_constraint_transactionally(self):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = "postgresql"
        engine.begin.return_value.__enter__.return_value = connection
        with patch.object(migration, "inspect") as inspect_mock, patch.object(migration, "_needs_migration", return_value=True):
            inspect_mock.return_value.has_table.return_value = True
            migration.ensure_schema(engine)
        statements = [str(call.args[0]) for call in connection.execute.call_args_list]
        self.assertIn("LOCK TABLE", statements[0])
        self.assertIn("DROP CONSTRAINT IF EXISTS ck_creator_run_operation", statements[1])
        self.assertIn("'catalog_recent'", statements[2])

    def test_postgres_concurrent_startup_already_migrated_is_noop_after_lock(self):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = "postgresql"
        engine.begin.return_value.__enter__.return_value = connection
        with patch.object(migration, "inspect") as inspect_mock, patch.object(migration, "_needs_migration", side_effect=[True, False]):
            inspect_mock.return_value.has_table.return_value = True
            migration.ensure_schema(engine)
        connection.execute.assert_called_once()

    def test_postgres_missing_legacy_constraint_is_added_and_validated(self):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = connection.dialect.name = "postgresql"
        engine.begin.return_value.__enter__.return_value = connection
        with patch.object(migration, "inspect") as inspect_mock:
            inspect_mock.return_value.has_table.return_value = True
            inspect_mock.return_value.get_check_constraints.return_value = []
            migration.ensure_schema(engine)
        statements = [str(call.args[0]) for call in connection.execute.call_args_list]
        self.assertEqual(len(statements), 3)
        self.assertIn("LOCK TABLE", statements[0])
        self.assertIn("DROP CONSTRAINT IF EXISTS", statements[1])
        self.assertIn("ADD CONSTRAINT ck_creator_run_operation CHECK", statements[2])
        self.assertNotIn("NOT VALID", statements[2])

    def test_postgres_invalid_existing_value_raises_inside_migration_transaction(self):
        engine, connection = MagicMock(), MagicMock()
        engine.dialect.name = connection.dialect.name = "postgresql"
        engine.begin.return_value.__enter__.return_value = connection
        connection.execute.side_effect = [None, None, IntegrityError("invalid operation", {}, Exception("check failed"))]
        with patch.object(migration, "inspect") as inspect_mock:
            inspect_mock.return_value.has_table.return_value = True
            inspect_mock.return_value.get_check_constraints.return_value = []
            with self.assertRaises(IntegrityError):
                migration.ensure_schema(engine)
        self.assertIs(engine.begin.return_value.__exit__.call_args.args[0], IntegrityError)


if __name__ == "__main__":
    unittest.main()
