"""Adapter for the optional local douyin-downloader companion service.

The companion owns Douyin login cookies and media collection. Zhicui only
consumes its HTTP API and turns selected media into user-scoped Notes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import requests

from app.core.config import settings

_MAX_BOUNDED_LIBRARY_ITEMS = 10000
_MAX_SYNC_COUNT = 500


class DouyinLibraryError(RuntimeError):
    """Raised when the companion service is unavailable or returns bad data."""


def _base_url() -> str:
    return settings.DOUYIN_DOWNLOADER_URL.strip().rstrip("/")


def _request(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: float = 8.0,
) -> Any:
    base_url = _base_url()
    if not base_url:
        raise DouyinLibraryError("未配置抖音收藏连接器")
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.request(
                method,
                f"{base_url}{path}",
                json=json_body,
                timeout=timeout,
            )
            response.raise_for_status()
            return response.json()
    except (requests.RequestException, ValueError) as exc:
        raise DouyinLibraryError(f"抖音收藏连接器暂不可用：{exc}") from exc


def connection_status() -> dict[str, Any]:
    """Return safe health and login information without exposing cookies."""
    base_url = _base_url()
    try:
        health = _request("GET", "/api/v1/health", timeout=3.0)
        cookie_state = _request("GET", "/api/v1/cookies", timeout=3.0)
        return {
            "connected": health.get("status") == "ok",
            "base_url": base_url,
            "cookie_valid": bool(cookie_state.get("valid")),
            "cookie_count": int(cookie_state.get("count") or 0),
            "error": None,
        }
    except DouyinLibraryError as exc:
        return {
            "connected": False,
            "base_url": base_url,
            "cookie_valid": False,
            "cookie_count": 0,
            "error": str(exc),
        }


def _media_url(path: str) -> str:
    clean = str(path or "").replace("\\", "/").lstrip("/")
    return f"{_base_url()}/files/{quote(clean, safe='/')}"


def _pick_path(paths: list[str], suffixes: tuple[str, ...]) -> str:
    for raw_path in paths:
        path = str(raw_path or "")
        if path.lower().endswith(suffixes):
            return path
    return ""


def _infer_source_mode(paths: list[str]) -> str:
    """Infer the downloader mode from its mode-specific output directory."""
    supported = {"like", "collect", "post"}
    for raw_path in paths:
        segments = str(raw_path or "").replace("\\", "/").lower().split("/")
        for segment in segments:
            if segment in supported:
                return segment
            if segment in {"collection", "collectmix"}:
                return "collect"
    return "unknown"


def _normalize_item(raw: dict[str, Any]) -> dict[str, Any]:
    paths = [
        str(path)
        for path in (raw.get("file_paths") or [])
        if isinstance(path, str)
    ]
    video_path = _pick_path(paths, (".mp4", ".mov", ".m4v", ".webm"))
    cover_path = _pick_path(paths, (".jpg", ".jpeg", ".png", ".webp"))
    aweme_id = str(raw.get("aweme_id") or "").strip()
    caption = str(raw.get("desc") or "").strip()
    title = caption.splitlines()[0].strip() if caption else f"抖音作品 {aweme_id}"
    if len(title) > 120:
        title = f"{title[:117]}..."
    try:
        source_rank = int(raw["source_rank"])
        if source_rank < 0:
            source_rank = None
    except (KeyError, TypeError, ValueError):
        source_rank = None

    return {
        "id": aweme_id,
        "aweme_id": aweme_id,
        "title": title,
        "caption": caption,
        "author_name": str(raw.get("author_name") or "").strip(),
        "media_type": str(raw.get("media_type") or "video").strip(),
        "tags": [
            str(tag).strip()
            for tag in (raw.get("tags") or [])
            if str(tag).strip()
        ][:12],
        "date": str(raw.get("date") or "").strip(),
        "recorded_at": str(raw.get("recorded_at") or "").strip(),
        "publish_timestamp": raw.get("publish_timestamp"),
        "source_rank": source_rank,
        "source_synced_at": str(raw.get("source_synced_at") or "").strip(),
        "source_mode": _infer_source_mode(paths),
        "source_url": (
            f"https://www.douyin.com/video/{aweme_id}" if aweme_id else ""
        ),
        "media_url": _media_url(video_path) if video_path else "",
        "cover_url": _media_url(cover_path) if cover_path else "",
        "can_extract": bool(aweme_id and video_path),
    }


def _item_sort_key(item: dict[str, Any]) -> tuple[float, str, str, str]:
    """优先按发布时间排序，并使用日期与采集时间稳定回退。"""
    try:
        publish_timestamp = float(item.get("publish_timestamp") or 0)
    except (TypeError, ValueError):
        publish_timestamp = 0
    if publish_timestamp <= 0:
        for raw_value in (item.get("date"), item.get("recorded_at")):
            value = str(raw_value or "").strip()
            if not value:
                continue
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                publish_timestamp = parsed.timestamp()
                break
            except ValueError:
                continue
    return (
        publish_timestamp,
        str(item.get("date") or ""),
        str(item.get("recorded_at") or ""),
        str(item.get("aweme_id") or ""),
    )


def _load_normalized_items() -> list[dict[str, Any]]:
    raw = _request("GET", "/api/v1/items", timeout=15.0)
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise DouyinLibraryError("下载器返回了无法识别的作品列表")
    return [
        _normalize_item(item)
        for item in items
        if isinstance(item, dict)
    ]


def refresh_collection_order(count: int = 50) -> dict[str, Any]:
    """只刷新收藏接口返回顺序，不触发媒体下载。"""
    safe_count = max(1, min(count, _MAX_SYNC_COUNT))
    return _request(
        "POST",
        "/api/v1/source-order/refresh",
        json_body={"mode": "collection", "count": safe_count},
        timeout=35.0,
    )


def list_items(
    limit: int = 0,
    mode: str | None = None,
    sort_by: str = "collection",
) -> list[dict[str, Any]]:
    """返回标准化下载器条目；``limit=0`` 表示读取全部 manifest。"""
    normalized = _load_normalized_items()
    if mode in {"like", "collect", "post"}:
        normalized = [
            item for item in normalized
            if item["source_mode"] == mode
        ]

    if (
        sort_by == "collection"
        and mode == "collect"
        and normalized
        and not any(item.get("source_rank") is not None for item in normalized)
    ):
        status = connection_status()
        if status["connected"] and status["cookie_valid"]:
            try:
                refresh_collection_order(
                    min(max(len(normalized), 50), _MAX_SYNC_COUNT)
                )
                normalized = [
                    item for item in _load_normalized_items()
                    if item["source_mode"] == "collect"
                ]
            except DouyinLibraryError:
                # 顺序元数据失败不应让本地视频库不可用；下面回退发布时间。
                pass

    normalized.sort(key=_item_sort_key, reverse=True)
    if sort_by == "collection" and mode == "collect":
        normalized.sort(
            key=lambda item: (
                0,
                int(item["source_rank"]),
            )
            if item.get("source_rank") is not None
            else (1, 0)
        )
    unique_items: list[dict[str, Any]] = []
    seen_aweme_ids: set[str] = set()
    for item in normalized:
        aweme_id = item["aweme_id"]
        if not aweme_id or aweme_id in seen_aweme_ids:
            continue
        seen_aweme_ids.add(aweme_id)
        unique_items.append(item)
    if limit <= 0:
        return unique_items
    return unique_items[: min(limit, _MAX_BOUNDED_LIBRARY_ITEMS)]


def get_item(aweme_id: str) -> dict[str, Any] | None:
    """Look up one item by Douyin aweme id."""
    clean_id = aweme_id.strip()
    if not clean_id:
        return None
    for item in list_items(limit=0):
        if item["aweme_id"] == clean_id:
            return item
    return None


def trigger_collect(count: int = 50, mode: str = "like") -> dict[str, Any]:
    """启动有数量上限的下载器同步任务。"""
    safe_mode = mode if mode in {"like", "post", "collect"} else "like"
    companion_mode = "collection" if safe_mode == "collect" else safe_mode
    safe_count = max(1, min(count, _MAX_SYNC_COUNT))
    return _request(
        "POST",
        "/api/v1/auto-collect",
        json_body={"mode": companion_mode, "count": safe_count},
        timeout=15.0,
    )


def start_login(browser: str = "chromium") -> dict[str, Any]:
    """Open the companion's visible browser and begin QR-login polling."""
    safe_browser = browser if browser in {"chromium", "firefox", "webkit"} else "chromium"
    return _request(
        "POST",
        "/api/v1/fetch-cookie",
        json_body={"browser": safe_browser},
        timeout=15.0,
    )


def login_status() -> dict[str, Any]:
    """Return QR-login progress without returning cookie values."""
    state = _request("GET", "/api/v1/fetch-cookie", timeout=5.0)
    return {
        "running": bool(state.get("running")),
        "message": str(state.get("message") or ""),
        "error": str(state.get("error") or ""),
    }


def get_job(job_id: str) -> dict[str, Any]:
    """Return one downloader collection job."""
    clean_id = job_id.strip()
    if not clean_id or len(clean_id) > 64:
        raise DouyinLibraryError("采集任务标识无效")
    job = _request(
        "GET",
        f"/api/v1/jobs/{quote(clean_id, safe='')}",
        timeout=8.0,
    )
    if not isinstance(job, dict):
        raise DouyinLibraryError("下载器返回了无法识别的采集任务")
    return job
