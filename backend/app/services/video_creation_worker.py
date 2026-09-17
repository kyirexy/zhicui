"""「创作工坊」串行渲染 worker:queued job → hypit build → 导出 MP4。

数据库 video_creation_jobs 是唯一状态真相。worker 线程池大小固定为 1
(渲染占内存大,服务器一次只跑一个),进程重启后自动恢复:
- rendering 且已有 build_id:继续轮询那个 build(runtime 侧任务仍在);
- rendering 且没有 build_id:提交中断,置为 failed。
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.request_context import reset_request_context, set_request_context
from app.models.video_creation import VideoCreationJob
from app.services import error_log_service, hypit_service
from app.services.hypit_service import HypitError

POLL_SECONDS = 5
STATUS_POLL_WAIT_MS = 15000
STATUS_POLL_SLEEP_SECONDS = 2


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _dump_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)[:8000]


class VideoCreationWorker:
    """单线程串行消费 queued job;main.py startup/shutdown 挂载。"""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="video-creation-worker", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)

    def _loop(self) -> None:
        try:
            self._recover_interrupted()
        except Exception as exc:  # noqa: BLE001 - worker 必须存活
            error_log_service.record_exception_safely(
                exc, source="video_creation_worker", metadata={"stage": "recover"}
            )
        while not self._stop.is_set():
            try:
                job_id = self._claim_next()
            except Exception as exc:  # noqa: BLE001 - worker 必须存活
                error_log_service.record_exception_safely(
                    exc, source="video_creation_worker", metadata={"stage": "claim"}
                )
                job_id = ""
            if job_id:
                self._run_job(job_id)
                continue
            self._stop.wait(POLL_SECONDS)

    # ------------------------------------------------------------------
    # 数据库操作

    def _recover_interrupted(self) -> None:
        with SessionLocal() as db:
            rows = db.scalars(
                select(VideoCreationJob).where(VideoCreationJob.status == "rendering")
            ).all()
            for job in rows:
                if job.build_id:
                    # runtime 侧 build 仍在,恢复轮询即可。
                    continue
                job.status = "failed"
                job.error = "服务重启时渲染提交被中断,请重新确认创作"
            db.commit()

    def _claim_next(self) -> str:
        """取最早的 queued job 并置为 rendering;单线程消费,无竞争。"""
        with SessionLocal() as db:
            job = db.scalars(
                select(VideoCreationJob)
                .where(VideoCreationJob.status == "queued")
                .order_by(VideoCreationJob.created_at)
                .limit(1)
            ).first()
            if job is None:
                return ""
            job.status = "rendering"
            job.updated_at = _utcnow()
            db.commit()
            return job.id

    def _load_job(self, job_id: str) -> VideoCreationJob | None:
        with SessionLocal() as db:
            return db.get(VideoCreationJob, job_id)

    def _update(self, job_id: str, **fields: Any) -> None:
        with SessionLocal() as db:
            job = db.get(VideoCreationJob, job_id)
            if job is None:
                return
            for key, value in fields.items():
                setattr(job, key, value)
            job.updated_at = _utcnow()
            db.commit()

    # ------------------------------------------------------------------
    # 渲染执行

    def _run_job(self, job_id: str) -> None:
        set_request_context(user_id=None)
        started = time.monotonic()
        directory = hypit_service.job_dir(job_id)
        try:
            job = self._load_job(job_id)
            if job is None:
                return
            svrun_text = job.svrun_text or None
            directory = hypit_service.write_project(
                job_id, svml_text=job.svml_text, svrun_text=svrun_text
            )
            if not job.build_id:
                self._submit(job_id, directory)
            self._follow(job_id, directory, started)
        except HypitError as exc:
            self._fail(job_id, exc.message, started)
        except Exception as exc:  # noqa: BLE001 - 任何异常都不能杀死 worker
            error_log_service.record_exception_safely(
                exc, source="video_creation_worker", metadata={"job_id": job_id}
            )
            self._fail(job_id, "渲染过程中发生意外错误,请稍后重试", started)
        finally:
            reset_request_context()

    def _submit(self, job_id: str, directory) -> None:
        """先估价(记录真实生成成本)再提交渲染。"""
        pricing = hypit_service.price_project(directory)
        self._update(job_id, pricing_json=_dump_json(pricing))
        build_id = hypit_service.submit_build(directory)
        self._update(job_id, build_id=build_id)

    def _follow(self, job_id: str, directory, started: float) -> None:
        deadline_s = settings.HYPIT_BUILD_TIMEOUT_MINUTES * 60
        while True:
            job = self._load_job(job_id)
            if job is None:
                return
            build_id = job.build_id
            if job.status == "cancelled":
                if build_id:
                    hypit_service.cancel_build(directory, build_id)
                return
            payload = hypit_service.poll_status(
                directory, build_id, max_wait_ms=STATUS_POLL_WAIT_MS
            )
            state = hypit_service.status_result_state(payload)
            if state == "complete":
                self._complete(job_id, directory, build_id, started)
                return
            if state == "failed":
                detail = hypit_service.status_failure(payload)
                logs = hypit_service.fetch_logs(directory, build_id)
                self._fail(job_id, detail, started, logs=logs)
                return
            if state == "cancelled":
                self._update(job_id, status="cancelled", completed_at=_utcnow())
                return
            if time.monotonic() - started > deadline_s:
                hypit_service.cancel_build(directory, build_id)
                self._fail(
                    job_id, "渲染超时,已自动取消;请缩短时长或简化画面后重试", started
                )
                return

    def _prune_capacity(self, keep_job_id: str) -> None:
        """产物总量与磁盘余量守护(计划 A.9):超限时最旧终态 job 的项目目录先删。

        只动 completed/failed/cancelled job 的目录;腾不出空间抛 HypitError,
        由调用方把当前 job 置为 failed——宁可失败也不写爆磁盘。
        """
        root = hypit_service.project_root()
        root.mkdir(parents=True, exist_ok=True)
        max_total = settings.HYPIT_RESULT_MAX_TOTAL_MB * 1024 * 1024
        min_free = settings.HYPIT_RESULT_MIN_FREE_MB * 1024 * 1024
        usage = hypit_service.directory_size(root)
        free = shutil.disk_usage(root).free
        if usage <= max_total and free >= min_free:
            return

        with SessionLocal() as db:
            victims = db.scalars(
                select(VideoCreationJob)
                .where(
                    VideoCreationJob.status.in_(("completed", "failed", "cancelled"))
                )
                .where(VideoCreationJob.id != keep_job_id)
                .order_by(VideoCreationJob.updated_at.asc())
            ).all()
            for victim in victims:
                if usage <= max_total and free >= min_free:
                    break
                hypit_service.remove_project(victim.id)
                usage = hypit_service.directory_size(root)
                free = shutil.disk_usage(root).free
        if usage > max_total or free < min_free:
            raise HypitError(
                "hypit_capacity_exceeded", "服务器产物空间不足,请联系管理员清理后重试"
            )

    def _complete(self, job_id: str, directory, build_id: str, started: float) -> None:
        try:
            self._prune_capacity(job_id)
        except HypitError as exc:
            self._fail(job_id, exc.message, started)
            return
        destination = directory / f"{job_id}.mp4"
        hypit_service.export_result(directory, build_id, destination)
        self._update(
            job_id,
            status="completed",
            output_filename=destination.name,
            render_seconds=int(time.monotonic() - started),
            completed_at=_utcnow(),
        )

    def _fail(self, job_id: str, message: str, started: float, *, logs: str = "") -> None:
        detail = message if not logs else f"{message}\n渲染日志(截断):\n{logs[-1500:]}"
        self._update(
            job_id,
            status="failed",
            error=detail[:4000],
            render_seconds=int(time.monotonic() - started),
            completed_at=_utcnow(),
        )


runner = VideoCreationWorker()
