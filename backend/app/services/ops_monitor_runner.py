"""Low-frequency readiness/error aggregation loop."""

from __future__ import annotations

import threading

from app.core.config import settings
from app.core.database import SessionLocal
from app.services import operational_alert_service


class OpsMonitorRunner:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not settings.OPS_MONITOR_ENABLED or (self._thread and self._thread.is_alive()):
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="ops-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def _run(self) -> None:
        # Let startup migrations and workers settle before probing dependencies.
        if self._stop.wait(10):
            return
        while not self._stop.is_set():
            try:
                with SessionLocal() as db:
                    operational_alert_service.refresh_alerts(db)
            except Exception:
                pass
            self._stop.wait(max(30, settings.OPS_MONITOR_POLL_SECONDS))


runner = OpsMonitorRunner()
