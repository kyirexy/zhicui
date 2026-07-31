"""Lifecycle-managed poller for persistent Agent automations."""

from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.request_context import reset_request_context, set_request_context
from app.models.agent_automation import AgentAutomationRun
from app.services import automation_service, error_log_service


class AutomationRunner:
    MAX_WORKERS = 2

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._futures: set[Future[None]] = set()
        self._lock = threading.Lock()
        self._last_error = ""

    def start(self) -> None:
        if not settings.AGENT_AUTOMATION_ENABLED:
            return
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._executor = ThreadPoolExecutor(
                max_workers=self.MAX_WORKERS,
                thread_name_prefix="agent-digest",
            )
            self._thread = threading.Thread(
                target=self._loop,
                name="agent-automation-poller",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stop.set()
            thread = self._thread
            executor = self._executor
            futures = list(self._futures)
            self._futures.clear()
            self._thread = None
            self._executor = None
        if thread and thread.is_alive():
            thread.join(timeout=5)
        if executor:
            executor.shutdown(wait=False, cancel_futures=True)
        for future in futures:
            future.cancel()

    def _loop(self) -> None:
        try:
            with SessionLocal() as db:
                automation_service.mark_stale_runs(db)
        except Exception as exc:
            self._record_error(exc, "automation_recovery")

        poll_seconds = max(
            5,
            min(int(settings.AGENT_AUTOMATION_POLL_SECONDS), 300),
        )
        while not self._stop.is_set():
            try:
                executor = self._executor
                self._futures = {
                    future
                    for future in self._futures
                    if not future.done()
                }
                free_slots = max(
                    0,
                    self.MAX_WORKERS - len(self._futures),
                )
                with SessionLocal() as db:
                    automation_service.mark_stale_runs(db)
                    run_ids = (
                        automation_service.claim_due_runs(
                            db,
                            limit=free_slots,
                        )
                        if free_slots
                        else []
                    )
                if executor and run_ids:
                    for run_id in run_ids:
                        self._futures.add(
                            executor.submit(self._execute_run, run_id)
                        )
            except Exception as exc:
                self._record_error(exc, "automation_poll")
            self._stop.wait(poll_seconds)

    def _execute_run(self, run_id: str) -> None:
        user_id: str | None = None
        with SessionLocal() as lookup_db:
            run = (
                lookup_db.query(AgentAutomationRun)
                .filter(AgentAutomationRun.id == run_id)
                .first()
            )
            if run:
                user_id = run.user_id
        tokens = set_request_context(
            user_id,
            f"/system/agent-automations/{run_id}",
        )
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat_loop,
            args=(run_id, heartbeat_stop),
            name=f"agent-digest-heartbeat-{run_id[:8]}",
            daemon=True,
        )
        heartbeat.start()
        try:
            with SessionLocal() as db:
                automation_service.execute_run(
                    db,
                    run_id=run_id,
                    deliver=True,
                )
        except Exception as exc:
            self._record_error(exc, "automation_execute")
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=2)
            reset_request_context(tokens)

    def _heartbeat_loop(
        self,
        run_id: str,
        stop: threading.Event,
    ) -> None:
        interval = max(
            5,
            min(int(settings.AGENT_AUTOMATION_POLL_SECONDS), 60),
        )
        while not stop.wait(interval):
            try:
                with SessionLocal() as db:
                    if not automation_service.heartbeat_run(db, run_id):
                        return
            except Exception as exc:
                self._record_error(exc, "automation_heartbeat")

    def _record_error(self, exc: Exception, operation: str) -> None:
        self._last_error = f"{type(exc).__name__}: {str(exc)[:240]}"
        error_log_service.record_exception_safely(
            exc,
            source="automation",
            status_code=500,
            metadata={"operation": operation},
        )

    def status(self) -> dict[str, Any]:
        thread = self._thread
        return {
            "enabled": bool(settings.AGENT_AUTOMATION_ENABLED),
            "running": bool(thread and thread.is_alive()),
            "poll_seconds": max(
                5,
                min(int(settings.AGENT_AUTOMATION_POLL_SECONDS), 300),
            ),
            "email": "smtp" if settings.SMTP_HOST else "preview",
            "last_error": self._last_error,
        }


runner = AutomationRunner()
