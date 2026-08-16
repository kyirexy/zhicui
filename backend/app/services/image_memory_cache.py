"""有界、短生命周期的图片内存缓存。

只保存已经代理成功的图片字节，不写入磁盘或数据库；进程退出后缓存自动清空。
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
import time


_MAX_CACHE_BYTES = 48 * 1024 * 1024
_MAX_ITEM_BYTES = 8 * 1024 * 1024
_TTL_SECONDS = 30 * 60


@dataclass(frozen=True)
class CachedImage:
    content_type: str
    content: bytes


_cache: OrderedDict[str, tuple[float, CachedImage]] = OrderedDict()
_cache_bytes = 0
_lock = Lock()


def _remove(key: str) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= len(entry[1].content)


def get(key: str) -> CachedImage | None:
    """读取一个仍有效的缓存项，并更新其最近使用顺序。"""
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        expires_at, image = entry
        if expires_at <= now:
            _remove(key)
            return None
        _cache.move_to_end(key)
        return image


def put(key: str, content_type: str, content: bytes) -> None:
    """写入图片；超过单图或总容量限制时自动跳过或淘汰旧项。"""
    global _cache_bytes
    size = len(content)
    if not key or not content or size > _MAX_ITEM_BYTES:
        return

    expires_at = time.monotonic() + _TTL_SECONDS
    image = CachedImage(content_type=content_type, content=content)
    with _lock:
        _remove(key)
        while _cache and _cache_bytes + size > _MAX_CACHE_BYTES:
            oldest_key = next(iter(_cache))
            _remove(oldest_key)
        _cache[key] = (expires_at, image)
        _cache_bytes += size

