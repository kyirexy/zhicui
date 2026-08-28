"""Persistent bounded worker for catalog quality repair runs."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor

from app.services import creator_catalog_quality_service as quality_service


logger = logging.getLogger(__name__)
_SCAN_INTERVAL_SECONDS = 1.0


class CreatorCatalogQualityRunner:
    """Resume due batches without tying their lifetime to an HTTP request."""

    def __init__(self) -> None:
        self._executor: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()
        self._futures: dict[str, Future[dict | None]] = {}
        self._scanner: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._accepting = False

    def start(self) -> None:
        with self._lock:
            self._accepting = True
            self._stop_event.clear()
            if self._executor is None:
                # A single batch mutates at most 200 rows with short commits;
                # one worker avoids putting repair load ahead of user syncs.
                self._executor = ThreadPoolExecutor(
                    max_workers=1, thread_name_prefix="creator-quality"
                )
            if self._scanner is None or not self._scanner.is_alive():
                self._scanner = threading.Thread(
                    target=self._scan_loop,
                    name="creator-quality-scanner",
                    daemon=True,
                )
                self._scanner.start()
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

    def submit(self, run_id: str) -> bool:
        with self._lock:
            if not self._accepting:
                return False
            if self._executor is None:
                return False
            current = self._futures.get(run_id)
            if current is not None and not current.done():
                return False
            future = self._executor.submit(quality_service.process_batch, run_id)
            self._futures[run_id] = future
            future.add_done_callback(
                lambda completed, key=run_id: self._forget(key, completed)
            )
            return True

    def _forget(self, run_id: str, future: Future[dict | None]) -> None:
        try:
            error = future.exception()
        except Exception:
            error = None
        if error is not None:
            # The lease expires and the scanner safely retries after a crash or
            # transient database outage; do not fail the durable run here.
            logger.error(
                "目录质量批次执行失败，将在租约到期后重试",
                exc_info=(type(error), error, error.__traceback__),
            )
        with self._lock:
            if self._futures.get(run_id) is future:
                self._futures.pop(run_id, None)

    def _submit_due_runs(self) -> None:
        try:
            run_ids = quality_service.due_run_ids()
        except Exception:
            logger.exception("扫描到期目录质量任务失败")
            return
        for run_id in run_ids:
            self.submit(run_id)

    def _scan_loop(self) -> None:
        while not self._stop_event.wait(_SCAN_INTERVAL_SECONDS):
            self._submit_due_runs()


runner = CreatorCatalogQualityRunner()
