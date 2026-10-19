"""媒体代理的有界恢复与脱敏诊断；不保存媒体地址到数据库或日志。"""

from __future__ import annotations

from collections import OrderedDict
import logging
import re
from threading import BoundedSemaphore, Lock
import time
from typing import Any

import requests

from app.services import video_extractor


_MAX_ENTRIES = 512
_COVER_RETRY_SECONDS = 30
_PUBLIC_SUCCESS_TTL = 180
_PUBLIC_FAILURE_TTL = 60
_lock = Lock()
_resolve_slots = BoundedSemaphore(2)
_inflight: set[tuple[str, str]] = set()
_public_cache: OrderedDict[tuple[str, str], tuple[float, dict[str, Any] | None, str]] = OrderedDict()
_cover_failures: OrderedDict[str, tuple[float, str]] = OrderedDict()
_logger = logging.getLogger("uvicorn.error.media_proxy")


def failure_reason(exc: Exception | None = None, status: int = 0) -> str:
    """只输出枚举，不读取供应商正文、签名地址或异常字符串。"""
    if status in {401, 419}:
        return "session_required"
    if status in {403, 429}:
        return "verification_required"
    if status in {404, 410}:
        return "source_unavailable"
    if status == 416:
        return "range_unsatisfiable"
    if status in {408, 425, 500, 502, 503, 504}:
        return "upstream_busy"
    if isinstance(exc, requests.Timeout):
        return "timeout"
    if isinstance(exc, requests.ConnectionError):
        return "connection_error"
    return "upstream_http_error" if status >= 400 else "invalid_response"


def log_failure(*, kind: str, source: str, reason: str, status: int = 0) -> None:
    _logger.warning(
        "media_proxy_failure kind=%s source=%s reason=%s status=%d",
        kind, source, reason, status,
    )


def cover_cooldown(key: str) -> tuple[int, str] | None:
    if not key:
        return None
    with _lock:
        value = _cover_failures.get(key)
        if value is None:
            return None
        remaining = value[0] - time.monotonic()
        if remaining <= 0:
            _cover_failures.pop(key, None)
            return None
        return max(1, int(remaining + 0.999)), value[1]


def remember_cover_failure(key: str, reason: str) -> None:
    if not key:
        return
    with _lock:
        _cover_failures[key] = (time.monotonic() + _COVER_RETRY_SECONDS, reason)
        _cover_failures.move_to_end(key)
        while len(_cover_failures) > _MAX_ENTRIES:
            _cover_failures.popitem(last=False)


def forget_cover_failure(key: str) -> None:
    with _lock:
        _cover_failures.pop(key, None)


def resolve_public_douyin(video_id: str, *, scope: str) -> tuple[dict[str, Any] | None, str]:
    """旧连接器缺作品时只恢复同一公开作品，并合并短时间内的重复请求。

    身份不符或解析失败也有短时缓存；最多两条并发公开读取，列表中的大量
    失效封面不会同时打满解析器。每个账号的缓存互相隔离。
    """
    if not re.fullmatch(r"[0-9]{5,32}", video_id):
        return None, "invalid_identity"
    key = (scope, video_id)
    with _lock:
        cached = _public_cache.get(key)
        if cached is not None and cached[0] > time.monotonic():
            _public_cache.move_to_end(key)
            return dict(cached[1]) if cached[1] else None, cached[2]
        _public_cache.pop(key, None)
        if key in _inflight or not _resolve_slots.acquire(blocking=False):
            return None, "recovery_busy"
        _inflight.add(key)
    value: dict[str, Any] | None = None
    reason = "source_unavailable"
    try:
        info = video_extractor.parse_video_info(f"https://www.douyin.com/video/{video_id}")
        if str(info.get("video_id") or "") != video_id or info.get("platform") != "douyin":
            reason = "identity_mismatch"
        else:
            value = {name: str(info.get(name) or "") for name in ("download_url", "cover_url")}
            reason = "recovered"
    except video_extractor.VideoMetadataUnavailableError:
        pass
    except Exception as exc:
        reason = failure_reason(exc)
    finally:
        with _lock:
            _inflight.discard(key)
            ttl = _PUBLIC_SUCCESS_TTL if value else _PUBLIC_FAILURE_TTL
            _public_cache[key] = (time.monotonic() + ttl, value, reason)
            _public_cache.move_to_end(key)
            while len(_public_cache) > _MAX_ENTRIES:
                _public_cache.popitem(last=False)
        _resolve_slots.release()
    return dict(value) if value else None, reason
