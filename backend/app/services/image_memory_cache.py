"""有界的两级封面缓存。

热数据保留在内存；成功代理的公开封面同时写入服务器磁盘，因此后端重启或
原子发布后不需要重新向平台 CDN 拉取同一张缩略图。
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
from threading import Lock
import time

from app.core.config import settings


_MAX_CACHE_BYTES = 48 * 1024 * 1024
_MAX_ITEM_BYTES = 8 * 1024 * 1024
_TTL_SECONDS = 30 * 60
_DISK_TTL_SECONDS = 30 * 24 * 60 * 60
_MAX_DISK_CACHE_BYTES = 512 * 1024 * 1024
_DISK_PRUNE_INTERVAL_SECONDS = 10 * 60


def _default_disk_dir() -> Path:
    configured = str(settings.COVER_CACHE_DIR or "").strip()
    if configured:
        return Path(configured).expanduser()
    if str(settings.DATABASE_URL or "").startswith("postgresql"):
        return Path("/var/lib/zhicui-cover-cache")
    return Path(__file__).resolve().parents[2] / ".cover-cache"


_DISK_CACHE_DIR = _default_disk_dir()


@dataclass(frozen=True)
class CachedImage:
    content_type: str
    content: bytes


_cache: OrderedDict[str, tuple[float, CachedImage]] = OrderedDict()
_cache_bytes = 0
_lock = Lock()
_disk_lock = Lock()
_last_disk_prune = 0.0


def _remove(key: str) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= len(entry[1].content)


def _put_memory(key: str, content_type: str, content: bytes) -> None:
    global _cache_bytes
    size = len(content)
    if not key or not content or size > _MAX_ITEM_BYTES:
        return
    expires_at = time.monotonic() + _TTL_SECONDS
    image = CachedImage(content_type=content_type, content=content)
    with _lock:
        _remove(key)
        while _cache and _cache_bytes + size > _MAX_CACHE_BYTES:
            _remove(next(iter(_cache)))
        _cache[key] = (expires_at, image)
        _cache_bytes += size


def _disk_paths(key: str) -> tuple[Path, Path]:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return (
        _DISK_CACHE_DIR / f"{digest}.img",
        _DISK_CACHE_DIR / f"{digest}.json",
    )


def _remove_disk_files(data_path: Path, meta_path: Path) -> None:
    for path in (data_path, meta_path):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _get_disk(key: str) -> CachedImage | None:
    data_path, meta_path = _disk_paths(key)
    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        created_at = float(metadata.get("created_at") or 0)
        content_type = str(metadata.get("content_type") or "")
        size = int(metadata.get("size") or 0)
        if (
            not content_type.startswith("image/")
            or not 0 < size <= _MAX_ITEM_BYTES
            or created_at + _DISK_TTL_SECONDS <= time.time()
            or data_path.stat().st_size != size
        ):
            _remove_disk_files(data_path, meta_path)
            return None
        content = data_path.read_bytes()
        now = time.time()
        os.utime(data_path, (now, now))
        os.utime(meta_path, (now, now))
        return CachedImage(content_type=content_type, content=content)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        _remove_disk_files(data_path, meta_path)
        return None


def get(key: str) -> CachedImage | None:
    """读取仍有效的内存或磁盘缓存，并更新最近使用时间。"""
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            image = None
        else:
            expires_at, image = entry
            if expires_at <= now:
                _remove(key)
                image = None
            else:
                _cache.move_to_end(key)
                return image
    with _disk_lock:
        disk_image = _get_disk(key)
    if disk_image is not None:
        _put_memory(key, disk_image.content_type, disk_image.content)
    return disk_image


def _prune_disk_if_needed() -> None:
    global _last_disk_prune
    now = time.monotonic()
    if now - _last_disk_prune < _DISK_PRUNE_INTERVAL_SECONDS:
        return
    _last_disk_prune = now
    try:
        entries = sorted(
            _DISK_CACHE_DIR.glob("*.img"),
            key=lambda path: path.stat().st_mtime,
        )
        total = sum(path.stat().st_size for path in entries)
    except OSError:
        return
    for data_path in entries:
        if total <= _MAX_DISK_CACHE_BYTES:
            break
        try:
            size = data_path.stat().st_size
        except OSError:
            size = 0
        _remove_disk_files(data_path, data_path.with_suffix(".json"))
        total -= size


def _put_disk(key: str, content_type: str, content: bytes) -> None:
    data_path, meta_path = _disk_paths(key)
    try:
        _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        suffix = f".tmp-{os.getpid()}-{time.time_ns()}"
        data_temp = data_path.with_name(data_path.name + suffix)
        meta_temp = meta_path.with_name(meta_path.name + suffix)
        data_temp.write_bytes(content)
        meta_temp.write_text(
            json.dumps({
                "content_type": content_type,
                "created_at": time.time(),
                "size": len(content),
            }, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(data_temp, data_path)
        os.replace(meta_temp, meta_path)
        _prune_disk_if_needed()
    except OSError:
        # 磁盘缓存不可用时退化为原有内存缓存，不影响封面响应。
        return


def put(key: str, content_type: str, content: bytes) -> None:
    """写入图片；内存与磁盘都实行容量上限和自动淘汰。"""
    size = len(content)
    if not key or not content or size > _MAX_ITEM_BYTES:
        return
    _put_memory(key, content_type, content)
    with _disk_lock:
        _put_disk(key, content_type, content)
