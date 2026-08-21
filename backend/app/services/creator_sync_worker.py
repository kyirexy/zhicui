"""Small persistent worker for manual saved-creator runs."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor

from app.services import creator_sync_service


logger = logging.getLogger(__name__)
_SCAN_INTERVAL_SECONDS = 5.0


class CreatorSyncRunner:
    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()
        self._futures: dict[str, Future[None]] = {}
        self._scanner: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._accepting = False

    def start(self) -> None:
        with self._lock:
            self._accepting = True
            self._stop_event.clear()
            if self._executor is None:
                # Platform semaphores enforce the admin-configured per-platform
                # limits; this pool only prevents unbounded local threads.
                self._executor = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="creator-sync"
                )
            if self._scanner is None or not self._scanner.is_alive():
                self._scanner = threading.Thread(
                    target=self._scan_loop,
                    name="creator-sync-scanner",
                    daemon=True,
                )
                self._scanner.start()
        for run_id in creator_sync_service.recover_incomplete_runs():
            self.submit(run_id)
        self._submit_due_runs()

    def stop(self) -> None:
        with self._lock:
            self._accepting = False
            self._stop_event.set()
            scanner = self._scanner
            self._scanner = None
            executor = self._executor
            self._executor = None
        if scanner is not None and scanner is not threading.current_thread():
            scanner.join(timeout=_SCAN_INTERVAL_SECONDS + 1.0)
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=False)

    def submit(self, run_id: str) -> None:
        with self._lock:
            if not self._accepting:
                return
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="creator-sync"
                )
            current = self._futures.get(run_id)
            if current is not None and not current.done():
                return
            future = self._executor.submit(creator_sync_service.process_run, run_id)
            self._futures[run_id] = future
            future.add_done_callback(
                lambda completed, key=run_id: self._forget(key, completed)
            )

    def _forget(self, run_id: str, future: Future[None]) -> None:
        with self._lock:
            if self._futures.get(run_id) is future:
                self._futures.pop(run_id, None)

    def _submit_due_runs(self) -> None:
        try:
            run_ids = creator_sync_service.due_run_ids()
        except Exception:
            # A transient database outage must not kill the daemon scanner.
            logger.exception("扫描到期博主任务失败")
            return
        for run_id in run_ids:
            self.submit(run_id)

    def _scan_loop(self) -> None:
        while not self._stop_event.wait(_SCAN_INTERVAL_SECONDS):
            self._submit_due_runs()


runner = CreatorSyncRunner()
