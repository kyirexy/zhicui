from __future__ import annotations

import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.database import Base
from app.models.library_extraction_batch import LibraryExtractionBatch, LibraryExtractionBatchItem
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import library_extraction_service as service


class RecordingExecutor(ThreadPoolExecutor):
    def __init__(self) -> None:
        super().__init__(max_workers=8, thread_name_prefix="test-library-parallel")
        self.submitted = []
        self.guard = threading.Lock()

    def submit(self, *args, **kwargs):
        future = super().submit(*args, **kwargs)
        with self.guard:
            self.submitted.append(future)
        return future

    def wait_until_drained(self, expected: int) -> None:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            with self.guard:
                futures = list(self.submitted)
            if len(futures) == expected and all(future.done() for future in futures):
                for future in futures:
                    future.result()
                return
            time.sleep(0.01)
        raise AssertionError(f"并发任务未排空：预期 {expected}，实际 {len(futures)}")


class LibraryExtractionParallelTests(unittest.TestCase):
    """真实线程池与独立 SQLite 连接；仅替换外部 ASR，不发起付费请求。"""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="zhicui-parallel-test-")
        self.engine = create_engine(
            f"sqlite:///{Path(self.temp.name) / 'jobs.db'}",
            connect_args={"check_same_thread": False, "timeout": 10},
        )
        self.sessions: list[Session] = []
        sessions = self.sessions

        class OwnedSession(Session):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.owner_thread = threading.get_ident()
                sessions.append(self)

        @event.listens_for(OwnedSession, "before_flush")
        def check_session_owner(session, *_args):
            if session.owner_thread != threading.get_ident():
                raise AssertionError("工作线程共享了数据库 Session")

        Base.metadata.create_all(self.engine, tables=[
            User.__table__, Note.__table__, VideoSourceLedger.__table__,
            LibraryExtractionBatch.__table__, LibraryExtractionBatchItem.__table__,
        ])
        self.Session = sessionmaker(bind=self.engine, class_=OwnedSession)
        with self.Session() as db:
            user = User(email="parallel@example.com", hashed_password="unused")
            db.add(user)
            db.commit()
            self.user_id = user.id
        self.items = {
            f"video-{index}": {
                "aweme_id": f"video-{index}", "title": f"并发样例 {index}",
                "source_url": f"https://www.douyin.com/video/video-{index}",
                "cover_url": "", "caption": "", "author_name": "",
                "recorded_at": "2026-09-10T00:00:00Z", "can_extract": True,
                "provider": "desktop-local", "source_mode": "collect", "source_rank": index,
            }
            for index in range(8)
        }
        self.executor = RecordingExecutor()
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(service, "SessionLocal", self.Session))
        self.stack.enter_context(patch.object(service, "_EXECUTOR", self.executor))
        self.stack.enter_context(patch.object(service, "_prefetch_items", return_value=self.items))
        self.stack.enter_context(patch.object(
            service.douyin_binding_service, "get_or_create",
            return_value=SimpleNamespace(session_scope="s" * 32, id="binding"),
        ))
        self.stack.enter_context(patch.object(service.settings_service, "get_asr_config", return_value={
            "api_key": "test", "api_base_url": "https://asr.invalid", "model": "test",
        }))

    def tearDown(self) -> None:
        self.executor.shutdown(wait=True)
        self.stack.close()
        self.engine.dispose()
        self.temp.cleanup()

    def create(self, ids: list[str], concurrency: int = 4) -> dict:
        return service.create_batch_job(
            user_id=self.user_id, aweme_ids=ids, operation="transcript",
            asr_concurrency=concurrency, llm_concurrency=1,
        )

    def test_four_asr_calls_overlap_with_reuse_failure_isolation_and_independent_sessions(self) -> None:
        existing = self.items["video-0"]
        with self.Session() as db:
            service.note_service.create_transcript_note(
                db, video_info=service._video_info(existing), transcript="已经保存的原始文稿",
                source_meta=service._source_meta(existing), user_id=self.user_id,
            )
        gate = threading.Lock()
        reached = threading.Event()
        release = threading.Event()
        active = peak = 0
        threads: set[int] = set()

        def transcribe(media_url, *_args, **_kwargs):
            nonlocal active, peak
            with gate:
                active += 1
                peak = max(peak, active)
                threads.add(threading.get_ident())
                if active == 4:
                    reached.set()
            try:
                if not release.wait(5):
                    raise AssertionError("文稿没有同时进入四个 ASR 工作线程")
                if media_url.endswith("video-6"):
                    raise RuntimeError("此条媒体暂不可用")
                return f"独立文稿：{media_url.rsplit('/', 1)[-1]}"
            finally:
                with gate:
                    active -= 1

        with patch.object(service.video_extractor, "extract_media_url_transcript", side_effect=transcribe) as asr:
            job = self.create(list(self.items) + ["video-1"])
            try:
                self.assertTrue(reached.wait(3), "必须同时启动多条，而不是逐条调用")
                running = service.get_batch_job(job["job_id"], self.user_id)
                self.assertEqual(running["active"], 4)
                self.assertEqual(running["concurrency"]["asr"], 4)
                self.assertEqual(self.engine.pool.checkedout(), 0, "等待 ASR 时必须释放数据库连接")
            finally:
                release.set()
            self.executor.wait_until_drained(8)
            self.assertEqual(asr.call_count, 7, "已有文稿与批内重复项不得再次调用 ASR")

        final = service.get_batch_job(job["job_id"], self.user_id)
        self.assertEqual(peak, 4)
        self.assertGreaterEqual(len(threads), 4)
        self.assertEqual(final["status"], "partial")
        self.assertEqual((final["total"], final["success"], final["failed"], final["active"], final["queued"]),
                         (8, 7, 1, 0, 0))
        self.assertEqual(sum(item["already_existed"] for item in final["items"]), 1)
        with self.Session() as db:
            self.assertEqual(db.query(Note).count(), 7)
            self.assertEqual(db.query(Note).filter(Note.video_id == "video-0").one().transcript_raw,
                             "已经保存的原始文稿")
        self.assertGreaterEqual(len({session.owner_thread for session in self.sessions}), 5)

    def test_overlapping_batches_share_the_same_video_lock_and_only_call_asr_once(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def transcribe(*_args, **_kwargs):
            started.set()
            if not release.wait(5):
                raise AssertionError("未释放测试 ASR")
            return "同一作品只提取一次"

        with patch.object(service.video_extractor, "extract_media_url_transcript", side_effect=transcribe) as asr:
            first = self.create(["video-1"])
            try:
                self.assertTrue(started.wait(3))
                second = self.create(["video-1"])
            finally:
                release.set()
            self.executor.wait_until_drained(2)
            self.assertEqual(asr.call_count, 1)
        results = [service.get_batch_job(job["job_id"], self.user_id) for job in (first, second)]
        self.assertEqual([result["status"] for result in results], ["success", "success"])
        self.assertEqual(sum(result["items"][0]["already_existed"] for result in results), 1)
        with self.Session() as db:
            self.assertEqual(db.query(Note).count(), 1)

    def test_cancellation_stops_queued_asr_and_keeps_completed_paid_work(self) -> None:
        reached = threading.Event()
        release = threading.Event()
        guard = threading.Lock()
        started = 0

        def transcribe(*_args, **_kwargs):
            nonlocal started
            with guard:
                started += 1
                if started == 4:
                    reached.set()
            if not release.wait(5):
                raise AssertionError("未释放测试 ASR")
            return "取消前已经发出的识别结果可以保留，不再次付费"

        with patch.object(service.video_extractor, "extract_media_url_transcript", side_effect=transcribe) as asr:
            job = self.create(list(self.items))
            try:
                self.assertTrue(reached.wait(3))
                canceled = service.cancel_batch_job(job["job_id"], self.user_id)
                self.assertEqual(canceled["status"], "canceled")
            finally:
                release.set()
            self.executor.wait_until_drained(8)
            self.assertEqual(asr.call_count, 4)
        final = service.get_batch_job(job["job_id"], self.user_id)
        self.assertEqual(final["status"], "canceled")
        self.assertEqual({item["state"] for item in final["items"]}, {"canceled"})
        self.assertEqual(final["active"], 0)
        with self.Session() as db:
            self.assertEqual(db.query(Note).count(), 4)

    def test_late_progress_cannot_overwrite_cancellation(self) -> None:
        with patch.object(service, "_submit_batch"):
            job = self.create(["video-1"])
        updating = threading.Event()
        resume_update = threading.Event()
        real_now = service._utcnow

        def delayed_now():
            if threading.current_thread().name == "race-update":
                updating.set()
                if not resume_update.wait(5):
                    raise AssertionError("未释放测试进度提交")
            return real_now()

        errors: list[Exception] = []

        def update():
            try:
                service._update_item(job["job_id"], "video-1", state="transcribing")
            except Exception as exc:
                errors.append(exc)

        with patch.object(service, "_utcnow", side_effect=delayed_now):
            worker = threading.Thread(target=update, name="race-update")
            worker.start()
            try:
                self.assertTrue(updating.wait(3))
                with ThreadPoolExecutor(max_workers=1) as canceller:
                    future = canceller.submit(service.cancel_batch_job, job["job_id"], self.user_id)
                    # 正在提交的短事务有任务锁；取消只能排在它之后，不能被它覆盖。
                    with self.assertRaises(TimeoutError):
                        future.result(timeout=0.15)
                    resume_update.set()
                    self.assertEqual(future.result(timeout=3)["status"], "canceled")
            finally:
                resume_update.set()
                worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        service._update_item(job["job_id"], "video-1", state="done")
        final = service.get_batch_job(job["job_id"], self.user_id)
        self.assertEqual(final["status"], "canceled")
        self.assertEqual(final["items"][0]["state"], "canceled")


if __name__ == "__main__":
    unittest.main()
