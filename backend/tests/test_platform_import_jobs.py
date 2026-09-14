"""用隔离数据库和合成文稿验证持久导入，不访问平台或真实账号。"""

from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.library_sync import LibrarySyncRun
from app.models.note import Note
from app.models.plan import Plan
from app.models.platform_import_job import PlatformImportJob, PlatformImportJobItem
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import library_sync_service, platform_import_job_service as service, platform_library_service


class SimulatedCrash(BaseException):
    pass


class PlatformImportJobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="zhicui-import-jobs-")
        self.engine = create_engine(f"sqlite:///{Path(self.tmp.name) / 'jobs.db'}", connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine, tables=[User.__table__, Note.__table__, Plan.__table__,
            LibrarySyncRun.__table__, VideoSourceLedger.__table__, PlatformImportJob.__table__, PlatformImportJobItem.__table__])
        self.Session = sessionmaker(bind=self.engine)
        self.session_patch = patch.object(service, "SessionLocal", self.Session)
        self.session_patch.start()
        with self.Session() as db:
            users = [User(email=f"job-{index}@example.com", hashed_password="x") for index in range(2)]
            db.add_all(users)
            db.commit()
            self.owner, self.other = [user.id for user in users]
        self.stamp = datetime.now(timezone.utc) - timedelta(minutes=2)

    def tearDown(self) -> None:
        self.session_patch.stop()
        self.engine.dispose()
        self.tmp.cleanup()

    @staticmethod
    def url(index: int) -> str:
        return f"https://www.bilibili.com/video/BV1TEST{index}"

    @staticmethod
    def extract(url: str, _db) -> tuple[dict, str, dict]:
        video_id = url.rsplit("/", 1)[-1]
        return ({"video_id": video_id, "title": f"合成视频 {video_id}", "description": "简介"},
                "不能出现在任务快照内的完整合成文稿", {
                    "source_kind": "platform-import", "platform": "bilibili", "source_url": url,
                    "cover_url": "https://example.com/cover.jpg", "author_name": "合成作者",
                    "caption": "简介", "media_type": "video", "speech_ready": True,
                    "transcript_source": "manual-subtitle"})

    def create(self, ids=(1, 2), **kwargs) -> dict:
        with self.Session() as db:
            return service.create_job(db, user_id=kwargs.pop("user_id", self.owner),
                values=[self.url(index) for index in ids], source_mode=kwargs.pop("source_mode", "collect"),
                source_synced_at=kwargs.pop("source_synced_at", self.stamp), **kwargs)

    def get(self, job_id: str) -> dict:
        with self.Session() as db:
            result = service.get_job(db, user_id=self.owner, job_id=job_id)
            self.assertIsNotNone(result)
            return result

    def finish(self, job_id: str) -> dict:
        for _ in range(12):
            if self.get(job_id)["status"] not in {"queued", "running"}:
                return self.get(job_id)
            service.process_job_item(job_id)
        self.fail("任务未在限定步骤内完成")

    def test_submit_persists_all_inputs_without_extraction_and_replay_is_idempotent(self):
        with patch.object(platform_library_service, "import_one", side_effect=AssertionError("提交不能提取")):
            first = self.create()
            replay = self.create()
        self.assertEqual(first["id"], replay["id"])
        self.assertEqual(first["status"], "queued")
        self.assertEqual(first["pending"], 2)
        self.assertEqual([row["input"] for row in first["items"]], [self.url(1), self.url(2)])
        self.assertTrue(all(row["platform"] == "bilibili" and row["status"] == "pending" for row in first["items"]))
        with self.Session() as db:
            self.assertEqual(db.query(PlatformImportJob).count(), 1)
            self.assertEqual(db.query(LibrarySyncRun).count(), 1)

    def test_scope_validation_and_only_canonical_bv_input_is_persisted(self):
        job = self.create()
        with self.Session() as db:
            self.assertIsNone(service.get_job(db, user_id=self.other, job_id=job["id"]))
            self.assertEqual(service.list_jobs(db, user_id=self.other), [])
            self.assertEqual(len(service.list_jobs(db, user_id=self.owner)), 1)
            for invalid in [self.url(1) + "?token=secret", "http://www.bilibili.com/video/BV1TEST", "https://evil.invalid/BV1TEST"]:
                with self.assertRaises(ValueError):
                    service.create_job(db, user_id=self.owner, values=[invalid], source_mode="collect", source_synced_at=self.stamp)
        for kwargs in [{"source_mode": "import"}, {"source_rank_offset": -1}, {"source_snapshot_size": 1}, {"source_order_reliable": 1}]:
            with self.assertRaises(ValueError):
                self.create(**kwargs)
        with self.assertRaises(ValueError):
            self.create(ids=(1, 1))

    def test_active_job_is_not_hidden_by_twenty_more_recent_completed_jobs(self):
        active = self.create(ids=(1,))
        for index in range(20):
            finished = self.create(ids=(index + 2,), source_synced_at=self.stamp + timedelta(seconds=index + 1))
            with self.Session() as db:
                row = db.get(PlatformImportJob, finished["id"])
                row.status = "succeeded"
                for item in db.scalars(select(PlatformImportJobItem).where(PlatformImportJobItem.job_id == row.id)):
                    item.state = "done"
                    item.result_status = "skipped"
                db.commit()
        with self.Session() as db:
            restored = service.list_jobs(db, user_id=self.owner, limit=20)
        self.assertEqual(len(restored), 20)
        self.assertEqual(restored[0]["id"], active["id"])
        self.assertEqual(restored[0]["status"], "queued")
        self.assertTrue(all(job["status"] == "succeeded" for job in restored[1:]))

    def test_progress_and_sync_run_are_persisted_without_note_body(self):
        job = self.create(source_rank_offset=10, source_snapshot_size=12)
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            self.assertTrue(service.process_job_item(job["id"]))
            progress = self.get(job["id"])
            self.assertEqual((progress["completed"], progress["imported"], progress["pending"]), (1, 1, 1))
            completed = self.finish(job["id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual([entry["item"]["source_rank"] for entry in completed["items"]], [10, 11])
        self.assertNotIn("完整合成文稿", json.dumps(completed, ensure_ascii=False))
        self.assertTrue(all("note" not in row["item"] for row in completed["items"]))
        with self.Session() as db:
            run = db.get(LibrarySyncRun, completed["sync_run_id"])
            self.assertEqual((run.status, run.accepted, run.created), ("succeeded", 2, 2))

    def test_crash_after_note_commit_before_item_completion_reuses_full_transcript(self):
        job = self.create(ids=(1,))
        real_import = platform_library_service.import_one

        def crash_after_save(db, **kwargs):
            real_import(db, **kwargs)
            raise SimulatedCrash()

        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract) as extracted:
            with patch.object(platform_library_service, "import_one", side_effect=crash_after_save):
                with self.assertRaises(SimulatedCrash):
                    service.process_job_item(job["id"])
            self.assertEqual(self.get(job["id"])["pending"], 1)
            resumed = self.finish(job["id"])
        self.assertEqual(extracted.call_count, 1)
        self.assertEqual((resumed["status"], resumed["reused"]), ("succeeded", 1))

    def test_crash_after_item_commit_repairs_summary_without_reimporting(self):
        job = self.create(ids=(1,))
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            with patch.object(service, "_finish_if_ready", side_effect=SimulatedCrash()):
                with self.assertRaises(SimulatedCrash):
                    service.process_job_item(job["id"])
        self.assertEqual(self.get(job["id"])["completed"], 1)
        with patch.object(platform_library_service, "import_one", side_effect=AssertionError("成功项不能重做")):
            repaired = self.finish(job["id"])
        self.assertEqual((repaired["status"], repaired["imported"]), ("succeeded", 1))

    def test_orphan_running_sync_run_can_acquire_missing_durable_job(self):
        with self.Session() as db:
            run = library_sync_service.start_run(db, user_id=self.owner, platform="bilibili", source_mode="collect",
                source_synced_at=self.stamp, source_rank_offset=0, requested_count=2, coverage="partial", order_reliable=True,
                request_fingerprint=hashlib.sha256(b"bilibili-import-job-v1\0" + json.dumps(
                    {"urls": [self.url(1), self.url(2)], "source_snapshot_size": 2},
                    ensure_ascii=False, separators=(",", ":"),
                ).encode()).hexdigest())
            run_id = run.id
        job = self.create()
        self.assertEqual(job["sync_run_id"], run_id)
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            self.finish(job["id"])
        with self.Session() as db:
            self.assertEqual(db.get(LibrarySyncRun, run_id).status, "succeeded")

    def test_async_job_cannot_share_legacy_run_or_different_snapshot_size(self):
        with self.Session() as db:
            old = library_sync_service.start_run(db, user_id=self.owner, platform="bilibili", source_mode="collect",
                source_synced_at=self.stamp, source_rank_offset=0, requested_count=2, coverage="partial", order_reliable=True,
                request_fingerprint=hashlib.sha256(json.dumps([self.url(1), self.url(2)], ensure_ascii=False).encode()).hexdigest())
            legacy_run_id = old.id
        first = self.create()
        different_size = self.create(source_snapshot_size=3)
        self.assertNotEqual(first["sync_run_id"], legacy_run_id)
        self.assertNotEqual(first["id"], different_size["id"])
        self.assertNotEqual(first["sync_run_id"], different_size["sync_run_id"])
        self.assertEqual((first["source_snapshot_size"], different_size["source_snapshot_size"]), (2, 3))
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            self.finish(first["id"])
        with self.Session() as db:
            self.assertEqual(db.get(LibrarySyncRun, legacy_run_id).status, "running")

    def test_same_video_different_categories_reuses_content_and_preserves_ranks(self):
        collect = self.create(ids=(1,), source_rank_offset=3, source_snapshot_size=4)
        like = self.create(ids=(1,), source_mode="like", source_rank_offset=8, source_snapshot_size=9)
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract) as extracted:
            self.finish(collect["id"])
            latest = self.finish(like["id"])
        self.assertEqual(extracted.call_count, 1)
        self.assertEqual(latest["reused"], 1)
        item = latest["items"][0]["item"]
        self.assertEqual(item["source_ranks"], {"collect": 3, "like": 8})

    def test_newer_snapshot_processed_first_cannot_be_reordered_by_old_queue(self):
        old = self.create(ids=(1, 2))
        new = self.create(ids=(2, 1), source_synced_at=self.stamp + timedelta(seconds=1))
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract) as extracted:
            self.finish(new["id"])
            older = self.finish(old["id"])
        self.assertEqual(extracted.call_count, 2)
        self.assertEqual(older["skipped"], 2)
        newest = self.get(new["id"])
        self.assertEqual([row["item"]["source_rank"] for row in newest["items"]], [0, 1])

    def test_failures_are_individual_and_do_not_persist_external_secrets(self):
        job = self.create()

        def extract(url, db):
            if url == self.url(1):
                raise RuntimeError("token=secret https://cdn.invalid/media?secret=1")
            return self.extract(url, db)

        with patch.object(platform_library_service, "_extract_bilibili", side_effect=extract):
            result = self.finish(job["id"])
        self.assertEqual((result["status"], result["failed"], result["imported"]), ("partial", 1, 1))
        self.assertNotIn("secret", json.dumps(result))
        with self.Session() as db:
            errors = list(db.scalars(select(PlatformImportJobItem.error)))
            self.assertNotIn("secret", json.dumps(errors))

    def test_busy_video_remains_queued_and_then_reuses_result(self):
        job = self.create(ids=(1,))
        with patch.object(platform_library_service, "import_one", side_effect=library_sync_service.LibraryImportBusyError()):
            self.assertTrue(service.process_job_item(job["id"]))
        self.assertEqual((self.get(job["id"])["pending"], self.get(job["id"])["failed"]), (1, 0))
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            self.assertEqual(self.finish(job["id"])["status"], "succeeded")

    def test_task_lock_prevents_two_workers_claiming_same_running_item(self):
        job = self.create(ids=(1,))
        with self.Session() as db, library_sync_service.import_lease(db, user_id=self.owner,
                platform="bilibili", video_id=job["id"], timeout_seconds=0):
            self.assertFalse(service.process_job_item(job["id"]))
        self.assertEqual(self.get(job["id"])["status"], "queued")

    def test_global_slot_lock_prevents_another_runner_from_processing(self):
        job = self.create(ids=(1,))
        worker = service.PlatformImportRunner()
        with self.Session() as db, library_sync_service.import_lease(db,
                user_id="__platform_import_worker__", platform="bilibili", video_id="global-slot-0", timeout_seconds=0):
            with patch.object(platform_library_service, "import_one", side_effect=AssertionError("其他进程占有槽位")):
                self.assertFalse(worker._run_slot_once(0))
        self.assertEqual(self.get(job["id"])["status"], "queued")

    def test_workers_yield_after_one_item_for_fairness_across_jobs(self):
        first = self.create(ids=(1, 2), source_snapshot_size=3)
        second = self.create(ids=(3,), source_rank_offset=2, source_snapshot_size=3)
        worker = service.PlatformImportRunner()
        with patch.object(platform_library_service, "_extract_bilibili", side_effect=self.extract):
            self.assertTrue(worker._run_slot_once(0))
            self.assertEqual(self.get(first["id"])["completed"], 1)
            self.assertTrue(worker._run_slot_once(0))
            self.assertEqual(self.get(first["id"])["completed"], 1)
            self.assertEqual(self.get(second["id"])["status"], "succeeded")

    def test_daemon_workers_are_bounded_and_stop_does_not_wait_for_asr(self):
        jobs = [self.create(ids=(index,), source_rank_offset=index, source_snapshot_size=3) for index in range(3)]
        release = threading.Event()
        two_started = threading.Event()
        guard = threading.Lock()
        active = peak = 0

        def extract(url, db):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
                if active == 2:
                    two_started.set()
            try:
                release.wait(5)
                return self.extract(url, db)
            finally:
                with guard:
                    active -= 1

        worker = service.PlatformImportRunner()
        try:
            with patch.object(platform_library_service, "_extract_bilibili", side_effect=extract):
                worker.start()
                worker.start()
                self.assertTrue(two_started.wait(4), "两个持久任务必须能够并行处理")
                self.assertEqual(len(worker._threads), 2)
                self.assertTrue(all(thread.daemon for thread in worker._threads))
                started = time.monotonic()
                worker.stop()
                self.assertLess(time.monotonic() - started, 0.2)
                release.set()
                for thread in worker._threads:
                    thread.join(timeout=5)
                self.assertTrue(all(not thread.is_alive() for thread in worker._threads))
        finally:
            release.set()
            worker.stop()
            for thread in worker._threads:
                thread.join(timeout=5)
        self.assertEqual(peak, 2)
        self.assertTrue(any(self.get(job["id"])["status"] == "queued" for job in jobs), "停止后不能取出第三个任务")


if __name__ == "__main__":
    unittest.main()
