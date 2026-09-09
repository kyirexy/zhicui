"""增量同步记录及提取互斥；空结果、失败和缺失成员都不会删除历史资料。"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.library_sync import LibrarySyncRun
from app.models.user import User

_PLATFORMS = {"douyin", "bilibili", "xiaohongshu", "mixed"}
_MODES = {"collect", "like", "post", "import", "unknown"}
_COVERAGES = {"complete", "limited", "partial", "unknown"}
_TERMINAL_STATUSES = {"succeeded", "partial", "failed", "invalid", "rejected"}
_ERROR_CODES = {
    "", "import_busy", "sync_failed", "import_failed", "invalid_request", "rejected",
    "stale_snapshot", "partial_failure", "metadata_incomplete", "transcript_failed",
    "connection_failed", "cancelled", "internal_error", "invalid_snapshot",
}
_SQLITE_LOCKS: dict[tuple[str, str, str], tuple[threading.Lock, int]] = {}
_SQLITE_LOCKS_GUARD = threading.Lock()


class LibraryImportBusyError(RuntimeError):
    code = "import_busy"

    def __init__(self) -> None:
        super().__init__("这条视频正在处理中，请稍后重试")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _snapshot(value: datetime | str | None) -> datetime:
    try:
        stamp = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else _utcnow()
    except (ValueError, TypeError) as exc:
        raise ValueError("同步快照时间无效") from exc
    stamp = stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).astimezone(timezone.utc)
    if stamp > _utcnow() + timedelta(minutes=5):
        raise ValueError("同步时间超出允许范围，请校准设备时间")
    return stamp


def _identity(user_id: str, platform: str, source_mode: str) -> tuple[str, str, str]:
    user = str(user_id or "").strip()
    mode = "collect" if source_mode == "collection" else str(source_mode or "import")
    if not user or len(user) > 64 or platform not in _PLATFORMS or mode not in _MODES:
        raise ValueError("同步用户、平台或来源无效")
    return user, platform, mode


def _existing_attempt(db: Session, run: LibrarySyncRun) -> LibrarySyncRun:
    duplicate_running = run.status == "running"
    # 已失败或部分失败的相同批次允许重试；成功重放保留第一次的新增计数。
    if run.status in {"failed", "partial"}:
        run.attempt_count += 1
        run.status = "running"
        run.finished_at = None
        run.started_at = _utcnow()
        run.updated_at = run.started_at
        run.error_code = ""
    db.commit()
    run._sync_attempt = run.attempt_count
    # 仅原执行请求可完成当前尝试；各 HTTP 请求使用自己的 Session/ORM 对象。
    run._sync_duplicate_running = duplicate_running
    return run


def start_run(
    db: Session, *, user_id: str, platform: str, source_mode: str,
    source_synced_at: datetime | str | None, source_rank_offset: int = 0,
    requested_count: int, coverage: str, order_reliable: bool,
    request_fingerprint: str = "",
) -> LibrarySyncRun:
    """固定快照与请求摘要去重；未提供摘要时不猜测两个请求的内容相同。"""
    user, platform, mode = _identity(user_id, platform, source_mode)
    if (isinstance(source_rank_offset, bool) or not isinstance(source_rank_offset, int)
            or source_rank_offset < 0 or source_rank_offset > 1_000_000):
        raise ValueError("同步排名偏移无效")
    if isinstance(requested_count, bool) or not isinstance(requested_count, int) or not 0 <= requested_count <= 1000:
        raise ValueError("同步条数无效")
    if coverage not in _COVERAGES or not isinstance(order_reliable, bool):
        raise ValueError("同步范围或顺序标记无效")
    if request_fingerprint and (not isinstance(request_fingerprint, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", request_fingerprint)):
        raise ValueError("同步请求摘要必须是 SHA256")
    stamp = _snapshot(source_synced_at)
    # 仅摘要入库；调用方误传含凭据的内容也不会成为持久明文。
    fingerprint = request_fingerprint.lower() if request_fingerprint else hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    key_data = [user, platform, mode, stamp.isoformat(), source_rank_offset,
                requested_count, coverage, order_reliable, fingerprint]
    key = hashlib.sha256(json.dumps(key_data, separators=(",", ":")).encode()).hexdigest()
    # 与来源登记的短事务采用相同的 User → Run 锁顺序，避免旧批次通过
    # 水位检查后，新水位先提交、旧资料才落库的竞争窗口。SQLite 开发库忽略行锁。
    db.execute(select(User.id).where(User.id == user).with_for_update()).scalar_one()
    existing = db.scalar(select(LibrarySyncRun).where(LibrarySyncRun.idempotency_key == key).with_for_update())
    if existing is not None:
        return _existing_attempt(db, existing)
    run = LibrarySyncRun(
        user_id=user, platform=platform, source_mode=mode, source_synced_at=stamp,
        source_rank_offset=source_rank_offset, requested_count=requested_count,
        coverage=coverage, order_reliable=order_reliable,
        request_fingerprint=fingerprint, idempotency_key=key, status="running",
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(LibrarySyncRun).where(LibrarySyncRun.idempotency_key == key).with_for_update())
        if existing is None:
            raise
        return _existing_attempt(db, existing)
    run._sync_attempt = run.attempt_count
    run._sync_duplicate_running = False
    return run


def _count(value: Any, maximum: int) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, min(int(value), maximum))
    except (TypeError, ValueError, OverflowError):
        return 0


def _video_ids(platform: str, result: dict[str, Any], maximum: int) -> list[str]:
    patterns = {"douyin": r"[0-9]{5,32}", "bilibili": r"BV[0-9A-Za-z]{3,30}", "xiaohongshu": r"[0-9a-fA-F]{16,32}"}
    pattern = "(?:" + "|".join(patterns.values()) + ")" if platform == "mixed" else patterns[platform]
    values = result.get("video_ids")
    if not isinstance(values, list):
        entries = result.get("items") if isinstance(result.get("items"), list) else []
        values = [entry.get("item", {}).get("video_id") for entry in entries
                  if isinstance(entry, dict) and isinstance(entry.get("item"), dict)]
    output: list[str] = []
    seen: set[str] = set()
    for value in values[:1000]:
        candidate = str(value or "").strip()
        if not re.fullmatch(pattern, candidate) or candidate in seen:
            continue
        seen.add(candidate)
        output.append(candidate)
        if len(output) >= maximum:
            break
    return output if maximum else []


def finish_run(
    db: Session, run: LibrarySyncRun, result: dict[str, Any], *,
    status: str | None = None, error_code: str | None = None,
) -> LibrarySyncRun:
    """仅采纳计数、规范作品 ID 和安全错误码，不复制原始结果正文。"""
    if status is not None and status not in _TERMINAL_STATUSES:
        raise ValueError("同步结束状态无效")
    if not isinstance(result, dict):
        raise ValueError("同步结果无效")
    attempt = getattr(run, "_sync_attempt", run.attempt_count)
    duplicate_running = getattr(run, "_sync_duplicate_running", False)
    current = db.scalar(select(LibrarySyncRun).where(
        LibrarySyncRun.id == run.id, LibrarySyncRun.user_id == run.user_id,
    ).with_for_update().execution_options(populate_existing=True))
    if current is None:
        raise ValueError("同步记录不存在")
    # 同一幂等请求的迟到回包不得改写已经记录的最终结果。
    if duplicate_running or current.finished_at is not None or current.attempt_count != attempt:
        db.commit()
        return current
    limit = current.requested_count
    entries = [entry for entry in result.get("items", []) if isinstance(entry, dict)] if isinstance(result.get("items"), list) else []
    succeeded = sum(entry.get("success") is True for entry in entries)
    failed = _count(result.get("failed", sum(entry.get("success") is not True and entry.get("status") != "skipped" for entry in entries)), limit)
    accepted = _count(result.get("accepted", result.get("success", succeeded)), limit)
    current.accepted = accepted
    current.created = _count(result.get("created", result.get("imported", sum(entry.get("status") == "imported" for entry in entries))), limit)
    current.reused = _count(result.get("reused", sum(entry.get("status") == "reused" for entry in entries)), limit)
    current.skipped = _count(result.get("skipped", sum(entry.get("status") == "skipped" for entry in entries)), limit)
    current.ready = _count(result.get("ready", accepted), limit)
    current.failed_count = failed
    current.quarantined = _count(result.get("quarantined", 0), limit)
    current.video_ids_json = json.dumps(_video_ids(current.platform, result, limit), separators=(",", ":"))
    stale = result.get("stale_snapshot") is True
    current.status = status or ("rejected" if stale else "failed" if failed and not accepted
                                else "partial" if failed or current.quarantined
                                else "succeeded")
    code = error_code or ("stale_snapshot" if stale else "partial_failure" if failed else "")
    current.error_code = code if code in _ERROR_CODES else "internal_error"
    current.finished_at = _utcnow()
    current.updated_at = current.finished_at
    db.commit()
    return current


def list_runs(db: Session, *, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.scalars(select(LibrarySyncRun).where(LibrarySyncRun.user_id == user_id)
                      .order_by(LibrarySyncRun.started_at.desc(), LibrarySyncRun.id.desc())
                      .limit(max(1, min(int(limit), 100)))).all()
    return [run.to_dict() for run in rows]


def latest_source_timestamp(db: Session, *, user_id: str, platform: str, source_mode: str) -> float:
    user, platform, mode = _identity(user_id, platform, source_mode)
    stamp = db.scalar(select(func.max(LibrarySyncRun.source_synced_at)).where(
        LibrarySyncRun.user_id == user, LibrarySyncRun.platform == platform,
        LibrarySyncRun.source_mode == mode, LibrarySyncRun.status.not_in(["invalid", "rejected"]),
    ))
    return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).timestamp() if stamp else 0.0


@contextmanager
def import_lease(
    db: Session, *, user_id: str, platform: str, video_id: str,
    timeout_seconds: float = 30,
) -> Iterator[None]:
    """生产使用会话咨询锁；SQLite 仅在开发进程内互斥，不承诺跨进程。"""
    user, platform, _ = _identity(user_id, platform, "import")
    clean_id = str(video_id or "").strip()
    if not clean_id or len(clean_id) > 128 or not re.fullmatch(r"[A-Za-z0-9_-]+", clean_id):
        raise ValueError("提取锁作品标识无效")
    timeout = float(timeout_seconds)
    if not math.isfinite(timeout) or not 0 <= timeout <= 120:
        raise ValueError("提取锁等待时间无效")
    key = (user, platform, clean_id)
    bind = db.get_bind()
    if bind.dialect.name == "sqlite":
        with _SQLITE_LOCKS_GUARD:
            lock, references = _SQLITE_LOCKS.get(key, (threading.Lock(), 0))
            _SQLITE_LOCKS[key] = (lock, references + 1)
        acquired = False
        try:
            acquired = lock.acquire(timeout=timeout)
            if not acquired:
                raise LibraryImportBusyError()
            yield
        finally:
            if acquired:
                lock.release()
            with _SQLITE_LOCKS_GUARD:
                _, references = _SQLITE_LOCKS[key]
                if references == 1:
                    del _SQLITE_LOCKS[key]
                else:
                    _SQLITE_LOCKS[key] = (lock, references - 1)
        return
    if bind.dialect.name != "postgresql":
        raise RuntimeError("当前数据库不支持跨进程提取互斥")
    # 独立 AUTOCOMMIT 连接保留会话锁，避免在外部下载/ASR 期间持有数据库事务。
    engine = getattr(bind, "engine", bind)
    lock_id = int.from_bytes(hashlib.sha256(json.dumps(key).encode()).digest()[:8], "big", signed=True)
    connection = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
    acquired = False
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                acquired = bool(connection.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_id}).scalar())
            except Exception:
                # 请求异常时锁是否已授予不可知，关闭物理连接以防锁被带回连接池。
                connection.invalidate()
                raise
            if acquired:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LibraryImportBusyError()
            time.sleep(min(0.1, remaining))
        yield
    finally:
        if acquired:
            try:
                unlocked = connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock_id}).scalar()
                if not unlocked:
                    connection.invalidate()
            except Exception:
                # 解锁失败的连接不能归还连接池，否则后续请求可能继承未释放的锁。
                connection.invalidate()
        connection.close()
