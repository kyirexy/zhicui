"""持久 B站导入队列：HTTP 只提交，两个后台槽按任务轮转处理，重启后续读未完成项。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import case, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.library_sync import LibrarySyncRun
from app.models.note import Note
from app.models.platform_import_job import PlatformImportJob, PlatformImportJobItem
from app.models.user import User
from app.services import library_sync_service, platform_library_service

logger = logging.getLogger(__name__)
_ACTIVE = {"queued", "running"}
_SLOTS = 2
_SCAN_SECONDS = 2.0
_BV_URL = re.compile(r"https://www\.bilibili\.com/video/(BV[0-9A-Za-z]{3,30})/?\Z")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat() if value else None


def _url(video_id: str) -> str:
    return f"https://www.bilibili.com/video/{video_id}"


def _rows(db: Session, job_id: str) -> list[PlatformImportJobItem]:
    return list(db.scalars(select(PlatformImportJobItem).where(
        PlatformImportJobItem.job_id == job_id,
    ).order_by(PlatformImportJobItem.position)))


def _snapshot(db: Session, job: PlatformImportJob) -> dict[str, Any]:
    rows = _rows(db, job.id)
    note_ids = [row.note_id for row in rows if row.note_id]
    notes = {note.id: note for note in db.scalars(select(Note).where(
        Note.user_id == job.user_id, Note.id.in_(note_ids),
    ))} if note_ids else {}
    items: list[dict[str, Any]] = []
    for row in rows:
        done = row.state == "done"
        entry: dict[str, Any] = {
            "input": _url(row.video_id), "platform": "bilibili", "success": done,
            "status": row.result_status if row.state not in _ACTIVE else "pending",
        }
        note = notes.get(row.note_id)
        if done and note is not None:
            entry["item"] = platform_library_service.serialize_item(note, include_note=False)
        if row.error:
            entry["error"] = row.error
        items.append(entry)
    imported = sum(row.state == "done" and row.result_status == "imported" for row in rows)
    reused = sum(row.state == "done" and row.result_status == "reused" for row in rows)
    skipped = sum(row.state == "done" and row.result_status == "skipped" for row in rows)
    failed = sum(row.state == "error" for row in rows)
    pending = sum(row.state in _ACTIVE for row in rows)
    return {
        "id": job.id, "job_id": job.id, "sync_run_id": job.sync_run_id,
        "platform": "bilibili", "source_mode": job.source_mode,
        "source_synced_at": _iso(job.source_synced_at), "source_rank_offset": job.source_rank_offset,
        "source_snapshot_size": job.source_snapshot_size, "coverage": job.coverage,
        "order_reliable": job.order_reliable, "status": job.status, "total": len(rows),
        "completed": len(rows) - pending, "success": imported + reused,
        "imported": imported, "reused": reused, "skipped": skipped,
        "failed": failed, "pending": pending, "items": items,
        "created_at": _iso(job.created_at), "updated_at": _iso(job.updated_at),
        "finished_at": _iso(job.finished_at),
    }


def create_job(
    db: Session, *, user_id: str, values: list[str], source_mode: str,
    source_synced_at: datetime | str | None, source_rank_offset: int = 0,
    source_snapshot_size: int | None = None, source_order_reliable: bool = True,
    source_coverage: str = "partial",
) -> dict[str, Any]:
    """纯数据库接收；同一快照重放返回同一任务，提交响应丢失也不会新建一轮提取。"""
    if source_mode not in {"collect", "like", "post"}:
        raise ValueError("持久同步仅支持 B站收藏、喜欢和作品分类")
    if not isinstance(values, list) or not 1 <= len(values) <= 10:
        raise ValueError("每个同步批次需要 1–10 条 B站作品链接")
    ids: list[str] = []
    for value in values:
        match = _BV_URL.fullmatch(value) if isinstance(value, str) else None
        if match is None:
            raise ValueError("同步任务只接受不含查询参数的规范 B站 BV 链接")
        ids.append(match.group(1))
    if len(set(ids)) != len(ids):
        raise ValueError("同一同步批次不能包含重复作品")
    if isinstance(source_rank_offset, bool) or not isinstance(source_rank_offset, int) or not 0 <= source_rank_offset <= 1_000_000:
        raise ValueError("来源排名偏移无效")
    size = source_snapshot_size if source_snapshot_size is not None else source_rank_offset + len(ids)
    if isinstance(size, bool) or not isinstance(size, int) or not source_rank_offset + len(ids) <= size <= 1_000_000:
        raise ValueError("来源快照总数无效")
    if source_coverage not in {"complete", "limited", "partial", "unknown"} or not isinstance(source_order_reliable, bool):
        raise ValueError("同步范围或顺序标记无效")
    stamp = library_sync_service._snapshot(source_synced_at)
    urls = [_url(video_id) for video_id in ids]
    # 与旧同步 HTTP 路径分域，并把快照大小纳入身份，不能共用另一执行者的 Run。
    fingerprint = hashlib.sha256(b"bilibili-import-job-v1\0" + json.dumps(
        {"urls": urls, "source_snapshot_size": size}, ensure_ascii=False, separators=(",", ":"),
    ).encode()).hexdigest()
    identity = [user_id, source_mode, _iso(stamp), source_rank_offset, size, source_coverage, source_order_reliable, ids]
    key = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    existing = db.scalar(select(PlatformImportJob).where(PlatformImportJob.idempotency_key == key))
    if existing is not None:
        return _snapshot(db, existing)
    # start_run 已持久提交。若进程恰在它与 job 创建之间退出，下次仍可为该 running run 补齐任务。
    run = library_sync_service.start_run(
        db, user_id=user_id, platform="bilibili", source_mode=source_mode,
        source_synced_at=stamp, source_rank_offset=source_rank_offset,
        requested_count=len(ids), coverage=source_coverage, order_reliable=source_order_reliable,
        request_fingerprint=fingerprint,
    )
    db.execute(select(User.id).where(User.id == user_id).with_for_update()).scalar_one()
    existing = db.scalar(select(PlatformImportJob).where(PlatformImportJob.sync_run_id == run.id))
    if existing is not None:
        db.commit()
        return _snapshot(db, existing)
    job = PlatformImportJob(
        user_id=user_id, sync_run_id=run.id, idempotency_key=key,
        source_mode=source_mode, source_synced_at=stamp, source_rank_offset=source_rank_offset,
        source_snapshot_size=size, coverage=source_coverage, order_reliable=source_order_reliable,
        status="queued",
    )
    db.add(job)
    try:
        db.flush()
        db.add_all([PlatformImportJobItem(job_id=job.id, position=index, video_id=video_id)
                    for index, video_id in enumerate(ids)])
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(PlatformImportJob).where(PlatformImportJob.sync_run_id == run.id))
        if existing is None:
            raise
        return _snapshot(db, existing)
    return _snapshot(db, job)


def get_job(db: Session, *, user_id: str, job_id: str) -> dict[str, Any] | None:
    job = db.scalar(select(PlatformImportJob).where(PlatformImportJob.id == job_id, PlatformImportJob.user_id == user_id))
    return _snapshot(db, job) if job else None


def list_jobs(db: Session, *, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
    jobs = db.scalars(select(PlatformImportJob).where(PlatformImportJob.user_id == user_id)
                      .order_by(case((PlatformImportJob.status.in_(_ACTIVE), 0), else_=1),
                                PlatformImportJob.created_at.desc(), PlatformImportJob.id.desc())
                      .limit(max(1, min(int(limit), 50))))
    return [_snapshot(db, job) for job in jobs]


def _finish_if_ready(db: Session, job: PlatformImportJob) -> None:
    rows = _rows(db, job.id)
    if any(row.state in _ACTIVE for row in rows):
        db.commit()
        return
    failed = sum(row.state == "error" for row in rows)
    job.status = "failed" if failed == len(rows) else "partial" if failed else "succeeded"
    job.finished_at = job.updated_at = _utcnow()
    run = db.get(LibrarySyncRun, job.sync_run_id)
    if run is not None:
        # 只用安全标识汇总，文稿/封面/媒体能力不进入任务表或同步记录。
        results = [{"success": row.state == "done", "status": row.result_status,
                    "item": {"video_id": row.video_id} if row.state == "done" else None}
                   for row in rows]
        imported = sum(row.result_status == "imported" for row in rows)
        reused = sum(row.result_status == "reused" for row in rows)
        skipped = sum(row.result_status == "skipped" for row in rows)
        library_sync_service.finish_run(db, run, {
            "items": results, "total": len(rows), "success": imported + reused,
            "imported": imported, "reused": reused, "skipped": skipped, "failed": failed,
        })
    else:
        db.commit()


def process_job_item(job_id: str) -> bool:
    """在跨进程任务锁下只处理一项；完成后让出槽位，避免一个大批次霸占所有视频。"""
    with SessionLocal() as db:
        job = db.get(PlatformImportJob, job_id)
        if job is None or job.status not in _ACTIVE:
            return False
        owner = job.user_id
        db.rollback()
        try:
            with library_sync_service.import_lease(
                db, user_id=owner, platform="bilibili", video_id=job_id, timeout_seconds=0,
            ):
                # 锁在独立 PG 会话上，事务提交不会释放；进程退出由 PG 自动释放，不依赖时间租约猜测。
                job = db.get(PlatformImportJob, job_id)
                if job is None or job.status not in _ACTIVE:
                    return False
                row = db.scalar(select(PlatformImportJobItem).where(
                    PlatformImportJobItem.job_id == job_id,
                    PlatformImportJobItem.state.in_(_ACTIVE),
                ).order_by(PlatformImportJobItem.position).limit(1))
                if row is None:
                    _finish_if_ready(db, job)
                    return True
                row_id = row.id
                value = _url(row.video_id)
                kwargs = {"user_id": owner, "value": value, "source_mode": job.source_mode,
                          "source_rank_offset": job.source_rank_offset + row.position,
                          "source_synced_at": _iso(job.source_synced_at),
                          "source_order_reliable": job.order_reliable, "source_coverage": job.coverage}
                row.state = job.status = "running"
                row.error = ""
                row.updated_at = job.updated_at = _utcnow()
                db.commit()
                try:
                    result = platform_library_service.import_one(db, **kwargs)
                except library_sync_service.LibraryImportBusyError:
                    # 另一入口正在处理相同 BV，保留排队等待其结果，不能变成永久失败或重复付费。
                    db.rollback()
                    row = db.get(PlatformImportJobItem, row_id)
                    job = db.get(PlatformImportJob, job_id)
                    if row is not None and job is not None:
                        row.state = "queued"
                        row.updated_at = job.updated_at = _utcnow()
                        db.commit()
                    return True
                except Exception:
                    db.rollback()
                    # 外部解析器异常可能含临时地址或请求信息，任务表只持固定公开错误。
                    result = {"status": "failed", "error": "B站资料导入失败，请检查视频访问权限后重试"}
                row = db.get(PlatformImportJobItem, row_id)
                job = db.get(PlatformImportJob, job_id)
                if row is None or job is None:
                    return True
                status = result.get("status")
                if status not in {"imported", "reused", "skipped", "failed"}:
                    status = "failed"
                    result = {"error": "服务端未返回完整导入结果，请重试"}
                row.state = "error" if status == "failed" else "done"
                row.result_status = status
                row.error = str(result.get("error") or "")[:240]
                row.note_id = (result.get("item") or {}).get("id")
                row.updated_at = job.updated_at = _utcnow()
                # 必须先落每项终态；随后汇总失败或重启也不会重做成功项。
                db.commit()
                _finish_if_ready(db, job)
                return True
        except library_sync_service.LibraryImportBusyError:
            return False


def _due_job_ids() -> list[str]:
    with SessionLocal() as db:
        return list(db.scalars(select(PlatformImportJob.id).where(PlatformImportJob.status.in_(_ACTIVE))
                               .order_by(PlatformImportJob.updated_at, PlatformImportJob.created_at, PlatformImportJob.id)
                               .limit(100)))


class PlatformImportRunner:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        with self._guard:
            if any(thread.is_alive() for thread in self._threads) and not self._stop.is_set():
                return
            # 生命周期重复启动时新旧线程各自持有停止事件；不能清除旧线程收到的停止信号。
            self._stop = threading.Event()
            self._wake = threading.Event()
            self._threads = [threading.Thread(target=self._loop, args=(slot, self._stop, self._wake), daemon=True,
                                               name=f"bilibili-import-{slot}") for slot in range(_SLOTS)]
            for thread in self._threads:
                thread.start()

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        # 不 join 正在外部 ASR 的线程；守护线程不参加 ThreadPoolExecutor 的退出等待。
        # 已提交 running 状态将在新进程取得咨询锁后恢复，成功结果始终先逐项提交。
        self._stop.set()
        self._wake.set()

    def _run_slot_once(self, slot: int, stop_event: threading.Event | None = None) -> bool:
        stop_event = stop_event or self._stop
        with SessionLocal() as db:
            try:
                # 固定两个独立咨询锁限定整个 PostgreSQL 集群并发；SQLite 为单进程开发锁。
                with library_sync_service.import_lease(
                    db, user_id="__platform_import_worker__", platform="bilibili",
                    video_id=f"global-slot-{slot}", timeout_seconds=0,
                ):
                    for job_id in _due_job_ids():
                        if stop_event.is_set():
                            return False
                        if process_job_item(job_id):
                            return True
            except library_sync_service.LibraryImportBusyError:
                pass
        return False

    def _loop(self, slot: int, stop_event: threading.Event, wake_event: threading.Event) -> None:
        while not stop_event.is_set():
            worked = False
            try:
                worked = self._run_slot_once(slot, stop_event)
            except Exception:
                # 只记录异常类型；平台错误/外部地址等不进入后台日志。
                logger.warning("B站导入任务暂未完成，将由持久队列继续恢复", exc_info=False)
            if worked:
                stop_event.wait(0.05)
            else:
                wake_event.wait(_SCAN_SECONDS)
                wake_event.clear()


runner = PlatformImportRunner()
