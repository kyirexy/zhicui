"""Small persistent worker for manual saved-creator runs."""

from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor

from app.services import creator_sync_service


class CreatorSyncRunner:
    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()
        self._futures: dict[str, Future[None]] = {}

    def start(self) -> None:
        with self._lock:
            if self._executor is None:
                # Platform semaphores enforce the admin-configured per-platform
                # limits; this pool only prevents unbounded local threads.
                self._executor = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="creator-sync"
                )
        for run_id in creator_sync_service.recover_incomplete_runs():
            self.submit(run_id)

    def stop(self) -> None:
        with self._lock:
            executor = self._executor
            self._executor = None
            self._futures.clear()
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=False)

    def submit(self, run_id: str) -> None:
        with self._lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=4, thread_name_prefix="creator-sync"
                )
            current = self._futures.get(run_id)
            if current is not None and not current.done():
                return
            future = self._executor.submit(creator_sync_service.process_run, run_id)
            self._futures[run_id] = future
            future.add_done_callback(lambda _future, key=run_id: self._forget(key))

    def _forget(self, run_id: str) -> None:
        with self._lock:
            self._futures.pop(run_id, None)


runner = CreatorSyncRunner()
