from __future__ import annotations

import hashlib
import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine, event, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.library_sync import LibrarySyncRun
from app.models.user import User
from app.services import library_sync_service as sync


class LibrarySyncPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine, tables=[User.__table__, LibrarySyncRun.__table__])
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.db.add_all([User(id="user-a", email="sync-a@example.com", hashed_password="x"),
                         User(id="user-b", email="sync-b@example.com", hashed_password="x")])
        self.db.commit()
        self.stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def start(self, **overrides):
        arguments = dict(user_id="user-a", platform="bilibili", source_mode="collect",
                         source_synced_at=self.stamp, requested_count=3, coverage="limited",
                         order_reliable=True, request_fingerprint=hashlib.sha256(b"BV1TEST,BV2TEST,BV3TEST").hexdigest())
        arguments.update(overrides)
        return sync.start_run(self.db, **arguments)

    def test_identity_includes_user_source_batch_and_payload(self):
        run = self.start()
        self.assertEqual(run.id, self.start(source_synced_at="2026-01-01T08:00:00+08:00").id)
        distinct = [self.start(user_id="user-b"), self.start(source_mode="like"),
                    self.start(source_rank_offset=10),
                    self.start(request_fingerprint=hashlib.sha256(b"other payload").hexdigest())]
        self.assertTrue(all(item.id != run.id for item in distinct))
        self.assertEqual(len(sync.list_runs(self.db, user_id="user-b")), 1)
        self.assertEqual(len(sync.list_runs(self.db, user_id="user-a")), 4)

    def test_missing_fingerprint_does_not_merge_unknown_payloads(self):
        self.assertNotEqual(self.start(request_fingerprint="").id, self.start(request_fingerprint="").id)
        with self.assertRaises(ValueError):
            self.start(request_fingerprint="Bearer secret")

    def test_new_and_replayed_snapshots_lock_owner_before_run(self):
        statements: list[str] = []

        def capture(orm_state):
            if orm_state.is_select and not orm_state.is_column_load:
                # SQLite 不实施行锁；检查生产方言收到的实际 ORM 锁顺序。
                statements.append(str(orm_state.statement.compile(
                    dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True},
                )))

        event.listen(self.db, "do_orm_execute", capture)
        try:
            for _ in range(2):
                statements.clear()
                self.start()
                self.assertIn("FROM users", statements[0])
                self.assertIn("users.id = 'user-a'", statements[0])
                self.assertIn("FOR UPDATE", statements[0])
                self.assertIn("FROM library_sync_runs", statements[1])
                self.assertIn("FOR UPDATE", statements[1])
        finally:
            event.remove(self.db, "do_orm_execute", capture)

    def test_new_started_run_is_watermark_except_invalid_or_rejected(self):
        old = self.start()
        newer = self.start(source_synced_at=self.stamp + timedelta(hours=1))
        self.assertEqual(sync.latest_source_timestamp(self.db, user_id="user-a", platform="bilibili", source_mode="collect"), (self.stamp + timedelta(hours=1)).timestamp())
        sync.finish_run(self.db, newer, {}, status="rejected", error_code="stale_snapshot")
        self.assertEqual(sync.latest_source_timestamp(self.db, user_id="user-a", platform="bilibili", source_mode="collect"), self.stamp.timestamp())
        self.assertEqual(sync.latest_source_timestamp(self.db, user_id="user-b", platform="bilibili", source_mode="collect"), 0)
        self.assertEqual(sync.latest_source_timestamp(self.db, user_id="user-a", platform="bilibili", source_mode="like"), 0)
        sync.finish_run(self.db, old, {}, status="failed", error_code="connection_failed")
        self.assertEqual(sync.latest_source_timestamp(self.db, user_id="user-a", platform="bilibili", source_mode="collect"), self.stamp.timestamp())

    def test_counts_ids_and_safe_error_are_persisted_without_payload(self):
        run = self.start(requested_count=5)
        sync.finish_run(self.db, run, {
            "success": 3, "imported": 2, "reused": 1, "skipped": 1, "failed": 1,
            "video_ids": ["BV2TEST", "https://secret.test/?token=private", "BV1TEST", "BV2TEST"],
            "transcript": "private transcript", "error": "Bearer private key",
        }, error_code="Bearer private key")
        public = sync.list_runs(self.db, user_id="user-a")[0]
        self.assertEqual((public["created"], public["reused"], public["skipped"], public["failed"]), (2, 1, 1, 1))
        self.assertEqual(public["video_ids"], ["BV2TEST", "BV1TEST"])
        self.assertEqual(public["error_code"], "internal_error")
        self.assertEqual(public["status"], "partial")
        self.assertNotIn("fingerprint", json.dumps(public))
        self.assertNotIn("private", json.dumps(public))
        self.assertIn("source_rank_offset", public)

    def test_partial_coverage_and_skips_do_not_mean_processing_failed(self):
        run = self.start(coverage="partial")
        sync.finish_run(self.db, run, {"items": [
            {"success": True, "status": "reused", "item": {"video_id": "BV1TEST"}},
            {"success": False, "status": "skipped"},
        ]})
        self.assertEqual(run.status, "succeeded")
        self.assertEqual(run.failed_count, 0)
        self.assertEqual(run.skipped, 1)
        self.assertEqual(run.coverage, "partial")

    def test_success_boolean_is_not_a_count_and_empty_result_is_safe(self):
        run = self.start(requested_count=0)
        sync.finish_run(self.db, run, {"success": True, "items": None, "video_ids": None})
        self.assertEqual(run.accepted, 0)
        self.assertEqual(run.to_dict()["video_ids"], [])
        self.assertEqual(run.status, "succeeded")

    def test_success_replay_preserves_original_new_count(self):
        run = self.start()
        sync.finish_run(self.db, run, {"success": 3, "imported": 3})
        replay = self.start()
        sync.finish_run(self.db, replay, {"success": 3, "reused": 3})
        self.assertEqual(replay.id, run.id)
        self.assertEqual(replay.created, 3)
        self.assertEqual(replay.reused, 0)
        self.assertEqual(replay.attempt_count, 1)
        self.assertFalse(replay._sync_duplicate_running)

    def test_running_replay_is_not_executor_and_cannot_record_premature_failure(self):
        first = self.start(requested_count=1)
        self.assertFalse(first._sync_duplicate_running)
        with self.Session() as duplicate_db:
            duplicate = sync.start_run(
                duplicate_db, user_id="user-a", platform="bilibili", source_mode="collect",
                source_synced_at=self.stamp, requested_count=1, coverage="limited",
                order_reliable=True,
                request_fingerprint=hashlib.sha256(b"BV1TEST,BV2TEST,BV3TEST").hexdigest(),
            )
            self.assertEqual(first.id, duplicate.id)
            self.assertTrue(duplicate._sync_duplicate_running)
            self.assertFalse(first._sync_duplicate_running)
            # 即使调用方错误地试图结束重复请求，也不能抢先记录原执行者失败。
            ignored = sync.finish_run(duplicate_db, duplicate, {"failed": 1}, error_code="import_busy")
            self.assertEqual(ignored.status, "running")
            self.assertIsNone(ignored.finished_at)
            self.assertTrue(duplicate._sync_duplicate_running)
            self.assertFalse(first._sync_duplicate_running)
        completed = sync.finish_run(self.db, first, {
            "success": 1, "failed": 0, "imported": 1, "video_ids": ["BV1TEST"],
        })
        self.assertEqual(completed.status, "succeeded")
        self.assertEqual(completed.created, 1)
        self.assertEqual(completed.failed_count, 0)

    def test_failed_attempt_can_retry_and_old_response_cannot_finish_new_attempt(self):
        run = self.start()
        sync.finish_run(self.db, run, {"failed": 3})
        stale = SimpleNamespace(id=run.id, user_id=run.user_id, attempt_count=1, _sync_attempt=1)
        retry = self.start()
        self.assertEqual(retry.attempt_count, 2)
        self.assertEqual(retry.status, "running")
        self.assertFalse(retry._sync_duplicate_running)
        sync.finish_run(self.db, stale, {"failed": 3})
        self.assertEqual(retry.status, "running")
        sync.finish_run(self.db, retry, {"success": 3, "reused": 3})
        self.assertEqual(retry.status, "succeeded")

    def test_invalid_future_time_is_not_a_watermark(self):
        with self.assertRaises(ValueError):
            self.start(source_synced_at=datetime.now(timezone.utc) + timedelta(hours=1))
        self.assertEqual(list(self.db.scalars(select(LibrarySyncRun))), [])

    def test_sqlite_development_mutex_is_scoped_and_released_on_error(self):
        key = dict(user_id="user-a", platform="bilibili", video_id="BV1TEST", timeout_seconds=0)
        with sync.import_lease(self.db, **key):
            with self.assertRaises(sync.LibraryImportBusyError):
                with sync.import_lease(self.db, **key):
                    self.fail("重复获取不应成功")
            with sync.import_lease(self.db, **{**key, "user_id": "user-b"}):
                pass
        with self.assertRaisesRegex(RuntimeError, "extract failed"):
            with sync.import_lease(self.db, **key):
                raise RuntimeError("extract failed")
        with sync.import_lease(self.db, **key):
            pass
        self.assertEqual(sync._SQLITE_LOCKS, {})


class FakePostgresConnection:
    def __init__(self, *, acquire=True, unlock=True, acquire_error=False):
        self.acquire, self.unlock, self.acquire_error = acquire, unlock, acquire_error
        self.calls = []
        self.invalidated = self.closed = False

    def execution_options(self, **options):
        self.options = options
        return self

    def execute(self, statement, params):
        sql = str(statement)
        self.calls.append((sql, params))
        if "pg_try" in sql and self.acquire_error:
            raise RuntimeError("connection lost")
        return SimpleNamespace(scalar=lambda: self.acquire if "pg_try" in sql else self.unlock)

    def invalidate(self):
        self.invalidated = True

    def close(self):
        self.closed = True


class PostgresImportLeaseTests(unittest.TestCase):
    def lease(self, connection):
        engine = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"), connect=lambda: connection)
        db = SimpleNamespace(get_bind=lambda: engine)
        return sync.import_lease(db, user_id="user-a", platform="bilibili", video_id="BV1TEST", timeout_seconds=0)

    def test_session_lock_uses_autocommit_and_unlocks_when_extraction_fails(self):
        connection = FakePostgresConnection()
        with self.assertRaisesRegex(ValueError, "failed"):
            with self.lease(connection):
                raise ValueError("failed")
        self.assertEqual(connection.options, {"isolation_level": "AUTOCOMMIT"})
        self.assertEqual(len(connection.calls), 2)
        self.assertEqual(connection.calls[0][1], connection.calls[1][1])
        self.assertTrue(connection.closed)
        self.assertFalse(connection.invalidated)

    def test_busy_has_explicit_error_and_no_unlock_of_someone_elses_lock(self):
        connection = FakePostgresConnection(acquire=False)
        with self.assertRaises(sync.LibraryImportBusyError) as caught:
            with self.lease(connection):
                self.fail("忙碌时不得进入下载阶段")
        self.assertEqual(caught.exception.code, "import_busy")
        self.assertEqual(len(connection.calls), 1)
        self.assertTrue(connection.closed)

    def test_uncertain_acquire_and_failed_unlock_discard_physical_connection(self):
        uncertain = FakePostgresConnection(acquire_error=True)
        with self.assertRaises(RuntimeError):
            with self.lease(uncertain):
                pass
        self.assertTrue(uncertain.invalidated)
        self.assertTrue(uncertain.closed)
        failed_unlock = FakePostgresConnection(unlock=False)
        with self.lease(failed_unlock):
            pass
        self.assertTrue(failed_unlock.invalidated)
        self.assertTrue(failed_unlock.closed)


if __name__ == "__main__":
    unittest.main()
