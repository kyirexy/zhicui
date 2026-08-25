"""Adapter for the optional local douyin-downloader companion service.

The companion owns Douyin login cookies and media collection. Zhicui only
consumes its HTTP API and turns selected media into user-scoped Notes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import requests

from app.core.config import settings

_MAX_BOUNDED_LIBRARY_ITEMS = 10000
_MAX_SYNC_COUNT = 100
_MAX_QR_IMAGE_BYTES = 512 * 1024
_MAX_VISUAL_IMAGE_BYTES = 4 * 1024 * 1024
_MAX_VISUAL_TOTAL_BYTES = 16 * 1024 * 1024
_MEDIA_URL_TTL_SECONDS = 60 * 60
_HANDOFF_TOKEN_TTL_SECONDS = 10 * 60
_SESSION_SCOPE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
_BINDING_REF_PATTERN = re.compile(r"^dyb-[0-9a-f]{20}$")


class DouyinLibraryError(RuntimeError):
    """Raised when the companion service is unavailable or returns bad data."""


def _base_url() -> str:
    return settings.DOUYIN_DOWNLOADER_URL.strip().rstrip("/")


def _scope_headers(session_scope: str) -> dict[str, str]:
    clean_scope = str(session_scope or "").strip()
    if not _SESSION_SCOPE_PATTERN.fullmatch(clean_scope):
        raise DouyinLibraryError("抖音账号会话标识无效")
    return {"X-Zhicui-Scope": clean_scope}


def _request(
    method: str,
    path: str,
    *,
    session_scope: str | None = None,
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
                headers=(
                    _scope_headers(session_scope)
                    if session_scope is not None
                    else None
                ),
                timeout=timeout,
            )
            if not response.ok:
                try:
                    detail = str(response.json().get("detail") or "").strip()
                except (AttributeError, ValueError):
                    detail = ""
                if detail:
                    raise DouyinLibraryError(f"抖音收藏连接器拒绝操作：{detail}")
            response.raise_for_status()
            return response.json()
    except DouyinLibraryError:
        raise
    except (requests.RequestException, ValueError) as exc:
        raise DouyinLibraryError(f"抖音收藏连接器暂不可用：{exc}") from exc


def _request_qr(path: str, session_scope: str) -> dict[str, Any]:
    base_url = _base_url()
    if not base_url:
        raise DouyinLibraryError("未配置抖音收藏连接器")
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(
                f"{base_url}{path}",
                headers=_scope_headers(session_scope),
                timeout=8.0,
            )
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0]
            if content_type != "image/png":
                raise DouyinLibraryError("登录二维码格式无效")
            image = response.content
            if not image or len(image) > _MAX_QR_IMAGE_BYTES:
                raise DouyinLibraryError("登录二维码大小无效")
            try:
                version = int(response.headers.get("x-qr-version") or 0)
            except ValueError:
                version = 0
            return {
                "image_data_url": (
                    "data:image/png;base64,"
                    + base64.b64encode(image).decode("ascii")
                ),
                "qr_version": version,
            }
    except DouyinLibraryError:
        raise
    except requests.RequestException as exc:
        raise DouyinLibraryError(f"抖音登录二维码暂不可用：{exc}") from exc


def connection_status(session_scope: str) -> dict[str, Any]:
    """Return safe health and login information without exposing cookies."""
    base_url = _base_url()
    try:
        health = _request("GET", "/api/v1/health", timeout=3.0)
    except DouyinLibraryError as exc:
        return {
            "connected": False,
            "base_url": base_url,
            "cookie_valid": False,
            "cookie_count": 0,
            "storage_mode": "unknown",
            "login_browser_mode": "unavailable",
            "max_sync_count": _MAX_SYNC_COUNT,
            "error": str(exc),
        }

    connected = health.get("status") == "ok"
    cookie_valid = False
    cookie_count = 0
    cookie_error: str | None = None
    if connected:
        try:
            cookie_state = _request(
                "GET",
                "/api/v1/cookies",
                session_scope=session_scope,
                timeout=3.0,
            )
            cookie_valid = bool(cookie_state.get("valid"))
            cookie_count = int(cookie_state.get("count") or 0)
        except DouyinLibraryError as exc:
            # 连接器健康与某个账号的会话读取是两件事。会话目录刚创建、
            # 正在换绑或短暂被占用时，仍应允许用户继续扫码，而不是把整套
            # 抖音视频库误报为离线。
            cookie_error = str(exc)

    return {
        "connected": connected,
        "base_url": base_url,
        "cookie_valid": cookie_valid,
        "cookie_count": cookie_count,
        "storage_mode": str(health.get("storage_mode") or "unknown"),
        "login_browser_mode": str(
            health.get("login_browser_mode") or "unavailable"
        ),
        "max_sync_count": min(
            int(health.get("max_sync_count") or _MAX_SYNC_COUNT),
            _MAX_SYNC_COUNT,
        ),
        "capabilities": [
            str(value)[:64]
            for value in (health.get("capabilities") or [])
            if str(value) in {"creator_catalog", "collection_resilience"}
        ],
        "collection_resilience": _safe_collection_resilience(
            health.get("collection_resilience")
        ),
        "error": cookie_error,
    }


def _safe_collection_resilience(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    return {
        "enabled": bool(raw.get("enabled", False)),
        "api_first": bool(raw.get("api_first", True)),
        "browser_fallback": bool(raw.get("browser_fallback", False)),
        "browser_headless": bool(raw.get("browser_headless", True)),
        "cooldown_seconds": max(0, min(int(raw.get("cooldown_seconds") or 0), 21600)),
        "cooldown_cap_seconds": max(
            0, min(int(raw.get("cooldown_cap_seconds") or 0), 21600)
        ),
    }


_SAFE_SYNC_ERROR_CODES = {
    "",
    "source_blocked",
    "verification_required",
    "session_expired",
    "network_error",
    "connector_error",
}
_SAFE_SYNC_CHANNELS = {"api", "browser", "circuit_breaker"}


def _safe_job_diagnostics(job: dict[str, Any]) -> dict[str, Any]:
    error_code = str(job.get("error_code") or "")
    if error_code not in _SAFE_SYNC_ERROR_CODES:
        error_code = "connector_error" if error_code else ""
    raw_mode = str(job.get("source_mode") or job.get("mode") or "")
    source_mode = "collect" if raw_mode == "collection" else raw_mode
    if source_mode not in {"collect", "like", "post"}:
        source_mode = "collect"
    channel = str(job.get("channel") or "api")
    if channel not in _SAFE_SYNC_CHANNELS:
        channel = "api"
    try:
        retry_after = max(0, min(int(job.get("retry_after_seconds") or 0), 21600))
    except (TypeError, ValueError):
        retry_after = 0
    return {
        "error_code": error_code,
        "source_mode": source_mode,
        "channel": channel,
        "fallback_attempted": bool(job.get("fallback_attempted", False)),
        "retry_after_seconds": retry_after,
        "needs_action": bool(job.get("needs_action", False)),
    }


_SAFE_JOB_FIELDS = {
    "job_id",
    "url",
    "status",
    "created_at",
    "started_at",
    "finished_at",
    "total",
    "success",
    "failed",
    "skipped",
    "target",
    "processed",
    "error",
    "mode",
}


def _safe_job_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = {key: job.get(key) for key in _SAFE_JOB_FIELDS if key in job}
    payload.update(_safe_job_diagnostics(job))
    payload["mode"] = payload["source_mode"]
    return payload


def _local_media_url(path: str) -> str:
    clean = str(path or "").replace("\\", "/").lstrip("/")
    return f"{_base_url()}/files/{quote(clean, safe='/')}"


def companion_media_url(aweme_id: str) -> str:
    """Loopback-only, ephemeral media stream used by the backend ASR."""
    return f"{_base_url()}/api/v1/media/{quote(aweme_id.strip(), safe='')}"


def companion_cover_url(aweme_id: str) -> str:
    """Loopback-only cover stream resolved from fresh Douyin metadata."""
    return f"{_base_url()}/api/v1/cover/{quote(aweme_id.strip(), safe='')}"


def companion_gallery_image_url(aweme_id: str, image_index: int) -> str:
    """Loopback-only image stream for a Douyin gallery item."""
    return (
        f"{_base_url()}/api/v1/gallery/{quote(aweme_id.strip(), safe='')}"
        f"/{max(0, int(image_index))}"
    )


def companion_headers(session_scope: str) -> dict[str, str]:
    """Headers for loopback-only sidecar requests."""
    return _scope_headers(session_scope)


def gallery_image_data_urls(
    session_scope: str,
    aweme_id: str,
    image_count: int,
    *,
    max_images: int = 8,
) -> list[str]:
    """读取有界图集图片并转换成视觉模型可直接消费的 data URL。"""
    bounded_count = max(0, min(int(image_count or 0), int(max_images or 0), 8))
    if bounded_count == 0:
        return []

    total_bytes = 0
    images: list[str] = []
    headers = _scope_headers(session_scope)
    try:
        with requests.Session() as session:
            session.trust_env = False
            for image_index in range(bounded_count):
                response = session.get(
                    companion_gallery_image_url(aweme_id, image_index),
                    headers=headers,
                    stream=True,
                    timeout=(5, 20),
                )
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type not in {
                    "image/jpeg", "image/png", "image/webp", "image/gif",
                }:
                    continue
                try:
                    declared_size = int(response.headers.get("content-length") or 0)
                except ValueError:
                    declared_size = 0
                if declared_size > _MAX_VISUAL_IMAGE_BYTES:
                    continue

                chunks: list[bytes] = []
                image_bytes = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    image_bytes += len(chunk)
                    if (
                        image_bytes > _MAX_VISUAL_IMAGE_BYTES
                        or total_bytes + image_bytes > _MAX_VISUAL_TOTAL_BYTES
                    ):
                        chunks = []
                        break
                    chunks.append(chunk)
                if not chunks:
                    continue
                payload = b"".join(chunks)
                total_bytes += len(payload)
                images.append(
                    f"data:{content_type};base64,"
                    + base64.b64encode(payload).decode("ascii")
                )
    except requests.RequestException as exc:
        if not images:
            raise DouyinLibraryError(f"图文图片暂时无法读取：{exc}") from exc
    return images


def _media_signature(aweme_id: str, binding_ref: str, expires: int) -> str:
    payload = f"{aweme_id}:{binding_ref}:{expires}".encode("utf-8")
    return hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def public_media_url(aweme_id: str, binding_ref: str) -> str:
    """Create a short-lived same-origin URL suitable for a browser video tag."""
    expires = int(time.time()) + _MEDIA_URL_TTL_SECONDS
    clean_binding_ref = str(binding_ref or "").strip()
    if not _BINDING_REF_PATTERN.fullmatch(clean_binding_ref):
        raise DouyinLibraryError("抖音账号绑定标识无效")
    signature = _media_signature(aweme_id, clean_binding_ref, expires)
    return (
        f"/api/library/douyin/media/{quote(aweme_id, safe='')}"
        f"?binding={quote(clean_binding_ref, safe='')}"
        f"&expires={expires}&signature={signature}"
    )


def public_cover_url(aweme_id: str, binding_ref: str) -> str:
    """Create a short-lived same-origin URL for a browser-safe cover image."""
    expires = int(time.time()) + _MEDIA_URL_TTL_SECONDS
    clean_binding_ref = str(binding_ref or "").strip()
    if not _BINDING_REF_PATTERN.fullmatch(clean_binding_ref):
        raise DouyinLibraryError("抖音账号绑定标识无效")
    signature = _media_signature(aweme_id, clean_binding_ref, expires)
    return (
        f"/api/library/douyin/cover/{quote(aweme_id, safe='')}"
        f"?binding={quote(clean_binding_ref, safe='')}"
        f"&expires={expires}&signature={signature}"
    )


def public_gallery_image_url(
    aweme_id: str,
    binding_ref: str,
    image_index: int,
) -> str:
    """Create a signed same-origin URL for one gallery image."""
    expires = int(time.time()) + _MEDIA_URL_TTL_SECONDS
    clean_binding_ref = str(binding_ref or "").strip()
    if not _BINDING_REF_PATTERN.fullmatch(clean_binding_ref):
        raise DouyinLibraryError("抖音账号绑定标识无效")
    signature = _media_signature(aweme_id, clean_binding_ref, expires)
    return (
        f"/api/library/douyin/gallery/{quote(aweme_id, safe='')}"
        f"/{max(0, int(image_index))}"
        f"?binding={quote(clean_binding_ref, safe='')}"
        f"&expires={expires}&signature={signature}"
    )


def verify_media_signature(
    aweme_id: str,
    binding_ref: str,
    expires: int,
    signature: str,
    *,
    allow_expired: bool = False,
) -> bool:
    now = int(time.time())
    if (
        (not allow_expired and expires < now)
        or expires > now + _MEDIA_URL_TTL_SECONDS + 60
    ):
        return False
    if not _BINDING_REF_PATTERN.fullmatch(str(binding_ref or "").strip()):
        return False
    expected = _media_signature(aweme_id, binding_ref, expires)
    return hmac.compare_digest(expected, signature)


def create_local_handoff_token(
    binding_id: str,
    user_id: str,
    session_scope: str,
) -> str:
    """Create a short-lived capability for a local connector callback."""
    payload = {
        "binding_id": str(binding_id),
        "user_id": str(user_id),
        "session_scope": str(session_scope),
        "expires": int(time.time()) + _HANDOFF_TOKEN_TTL_SECONDS,
        "nonce": secrets.token_urlsafe(12),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).decode("ascii").rstrip("=")
    signature = hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def verify_local_handoff_token(token: str) -> dict[str, Any] | None:
    """Validate a local-connector callback without exposing the JWT session."""
    try:
        encoded, signature = str(token or "").split(".", 1)
        expected = hmac.new(
            settings.JWT_SECRET.encode("utf-8"),
            encoded.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        padding = "=" * (-len(encoded) % 4)
        payload = json.loads(
            base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
        )
        expires = int(payload.get("expires") or 0)
        now = int(time.time())
        if expires < now or expires > now + _HANDOFF_TOKEN_TTL_SECONDS + 60:
            return None
        if not _SESSION_SCOPE_PATTERN.fullmatch(
            str(payload.get("session_scope") or "")
        ):
            return None
        if not str(payload.get("binding_id") or ""):
            return None
        if not str(payload.get("user_id") or ""):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def import_session_cookies(
    session_scope: str,
    cookies: dict[str, str],
) -> dict[str, Any]:
    """Send handoff cookies straight to the scoped sidecar, never the DB."""
    normalized = {
        str(name).strip(): str(value)
        for name, value in cookies.items()
        if str(name).strip() and str(value)
    }
    if not normalized:
        raise DouyinLibraryError("本机连接器没有返回有效登录会话")
    return _request(
        "POST",
        "/api/v1/cookies",
        session_scope=session_scope,
        json_body={"cookie": json.dumps(normalized, ensure_ascii=False)},
        timeout=8.0,
    )


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


def _normalize_item(
    raw: dict[str, Any],
    binding_ref: str,
) -> dict[str, Any]:
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

    raw_source_mode = str(raw.get("source_mode") or "").strip().lower()
    if raw_source_mode == "collection":
        raw_source_mode = "collect"
    source_mode = (
        raw_source_mode
        if raw_source_mode in {"like", "collect", "post"}
        else _infer_source_mode(paths)
    )
    media_type = str(raw.get("media_type") or "video").strip()
    can_extract = bool(aweme_id and media_type == "video")
    try:
        gallery_count = int(raw.get("gallery_count") or 0)
    except (TypeError, ValueError):
        gallery_count = 0
    if media_type == "gallery":
        gallery_count = max(1, min(gallery_count, 30))
    else:
        gallery_count = 0
    remote_cover = str(raw.get("cover_url") or "").strip()
    cover_url = (
        remote_cover
        if remote_cover.startswith(("http://", "https://"))
        else _local_media_url(cover_path) if cover_path else ""
    )

    return {
        "id": aweme_id,
        "aweme_id": aweme_id,
        "title": title,
        "caption": caption,
        "author_name": str(raw.get("author_name") or "").strip(),
        "media_type": media_type,
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
        "source_mode": source_mode,
        "source_url": (
            (
                f"https://www.douyin.com/note/{aweme_id}"
                if media_type == "gallery"
                else f"https://www.douyin.com/video/{aweme_id}"
            )
            if aweme_id
            else ""
        ),
        "media_url": (
            public_media_url(aweme_id, binding_ref)
            if can_extract
            else ""
        ),
        "cover_url": cover_url,
        "cover_proxy_url": (
            public_cover_url(aweme_id, binding_ref)
            if aweme_id
            else ""
        ),
        "gallery_images": [
            public_gallery_image_url(aweme_id, binding_ref, image_index)
            for image_index in range(gallery_count)
        ],
        "can_extract": can_extract,
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


def _load_normalized_items(
    session_scope: str,
    binding_ref: str,
) -> list[dict[str, Any]]:
    raw = _request(
        "GET",
        "/api/v1/items",
        session_scope=session_scope,
        timeout=15.0,
    )
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise DouyinLibraryError("下载器返回了无法识别的作品列表")
    return [
        _normalize_item(item, binding_ref)
        for item in items
        if isinstance(item, dict)
    ]


def refresh_source_order(
    session_scope: str,
    mode: str,
    count: int = 50,
) -> dict[str, Any]:
    """只刷新收藏或喜欢接口返回顺序，不触发媒体下载。"""
    safe_count = max(1, min(count, _MAX_SYNC_COUNT))
    safe_mode = "like" if mode == "like" else "collection"
    return _request(
        "POST",
        "/api/v1/source-order/refresh",
        session_scope=session_scope,
        json_body={"mode": safe_mode, "count": safe_count},
        timeout=35.0,
    )


def list_items(
    session_scope: str,
    binding_ref: str,
    limit: int = 0,
    mode: str | None = None,
    sort_by: str = "collection",
    refresh_order: bool = False,
) -> list[dict[str, Any]]:
    """返回标准化下载器条目；``limit=0`` 表示读取全部 manifest。"""
    if refresh_order and sort_by == "collection" and mode in {"collect", "like"}:
        refresh_source_order(session_scope, mode, _MAX_SYNC_COUNT)

    normalized = _load_normalized_items(session_scope, binding_ref)
    if mode in {"like", "collect", "post"}:
        normalized = [
            item for item in normalized
            if item["source_mode"] == mode
        ]

    normalized.sort(key=_item_sort_key, reverse=True)
    if sort_by == "collection" and mode in {"collect", "like"}:
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


def get_item(
    session_scope: str,
    binding_ref: str,
    aweme_id: str,
) -> dict[str, Any] | None:
    """Look up one item by Douyin aweme id."""
    clean_id = aweme_id.strip()
    if not clean_id:
        return None
    for item in list_items(session_scope, binding_ref, limit=0):
        if item["aweme_id"] == clean_id:
            return item
    return None


def trigger_collect(
    session_scope: str,
    count: int = 50,
    mode: str = "like",
) -> dict[str, Any]:
    """启动 1–100 条的元数据同步任务。"""
    safe_mode = mode if mode in {"like", "post", "collect"} else "like"
    companion_mode = "collection" if safe_mode == "collect" else safe_mode
    try:
        safe_count = max(1, min(int(count), _MAX_SYNC_COUNT))
    except (TypeError, ValueError):
        safe_count = 50
    job = _request(
        "POST",
        "/api/v1/auto-collect",
        session_scope=session_scope,
        json_body={"mode": companion_mode, "count": safe_count},
        timeout=15.0,
    )
    # Older companion builds returned only job_id/status/url here. Keep the
    # browser contract complete while rolling out real page-by-page progress.
    job.setdefault("target", safe_count)
    job.setdefault("processed", 0)
    job.setdefault("total", 0)
    job.setdefault("success", 0)
    job.setdefault("failed", 0)
    job.setdefault("skipped", 0)
    job.setdefault("mode", safe_mode)
    return _safe_job_payload(job)


def resolve_creator(session_scope: str, profile_url: str) -> dict[str, Any]:
    """Resolve a Douyin profile through the scoped companion session.

    The companion response is deliberately reduced to display metadata.  It
    must not return cookies, signed media URLs or an upstream response body.
    """
    clean_url = str(profile_url or "").strip()
    try:
        data = _request(
            "POST",
            "/api/v1/creators/resolve",
            session_scope=session_scope,
            json_body={"profile_url": clean_url},
            timeout=20.0,
        )
    except DouyinLibraryError:
        # The pinned companion already accepts an explicit profile URL through
        # auto-collect. During a rolling sidecar upgrade, keep profile saving
        # available and let the run perform the real authenticated discovery.
        state = connection_status(session_scope)
        if not state.get("connected") or not state.get("cookie_valid"):
            raise DouyinLibraryError("抖音账号连接已失效，请重新连接")
        marker = "/user/"
        creator_id = clean_url.split(marker, 1)[1].split("?", 1)[0].split("/", 1)[0] if marker in clean_url else ""
        if not creator_id:
            raise DouyinLibraryError("抖音博主主页格式无效")
        return {
            "creator_id": creator_id[:192],
            "display_name": "抖音博主",
            "avatar_url": "",
            "profile_url": f"https://www.douyin.com/user/{creator_id}",
        }
    creator_id = str(data.get("creator_id") or data.get("sec_user_id") or "").strip()
    if not creator_id:
        raise DouyinLibraryError("抖音博主解析结果缺少用户标识")
    return {
        "creator_id": creator_id[:192],
        "display_name": str(data.get("display_name") or data.get("nickname") or "抖音博主").strip()[:160],
        "avatar_url": str(data.get("avatar_url") or "").strip()[:2048],
        "profile_url": f"https://www.douyin.com/user/{creator_id}",
    }


def list_creator_works(
    session_scope: str,
    binding_ref: str,
    creator_id: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Discover recent creator works and register them in the scoped manifest."""
    safe_limit = max(1, min(int(limit), _MAX_SYNC_COUNT))
    clean_creator_id = str(creator_id or "").strip()
    try:
        body = _request(
            "POST",
            "/api/v1/creators/works",
            session_scope=session_scope,
            json_body={"creator_id": clean_creator_id, "limit": safe_limit},
            timeout=45.0,
        )
        raw_items = body.get("items") if isinstance(body, dict) else None
        if not isinstance(raw_items, list):
            raise DouyinLibraryError("抖音博主作品接口未返回作品列表")
    except DouyinLibraryError:
        # Backward-compatible path for the pinned production patch: its
        # metadata-only auto-collect already supports req.url + mode=post.
        profile_url = f"https://www.douyin.com/user/{clean_creator_id}"
        job = _request(
            "POST",
            "/api/v1/auto-collect",
            session_scope=session_scope,
            json_body={"mode": "post", "count": safe_limit, "url": profile_url},
            timeout=15.0,
        )
        job_id = str(job.get("job_id") or "").strip()
        if not job_id:
            raise DouyinLibraryError("抖音博主同步任务没有启动")
        for _ in range(180):
            state = get_job(session_scope, job_id)
            if state.get("status") == "success":
                break
            if state.get("status") == "failed":
                raise DouyinLibraryError("抖音博主作品读取失败")
            time.sleep(1)
        else:
            raise DouyinLibraryError("抖音博主作品读取超时")
        raw_items = _request(
            "GET",
            "/api/v1/items",
            session_scope=session_scope,
            timeout=15.0,
        ).get("items", [])
        raw_items = [
            item for item in raw_items
            if isinstance(item, dict)
            and str(item.get("source_mode") or _infer_source_mode(item.get("file_paths") or [])) == "post"
        ][:safe_limit]
    normalized = [
        _normalize_item(raw, binding_ref)
        for raw in raw_items[:safe_limit]
        if isinstance(raw, dict)
    ]
    return [item for item in normalized if item.get("aweme_id")]


def clear_session(session_scope: str) -> dict[str, Any]:
    """Clear downloader cookies and QR state without deleting library data."""
    state = _request(
        "DELETE",
        "/api/v1/cookies",
        session_scope=session_scope,
        timeout=8.0,
    )
    return {
        "disconnected": bool(state.get("cleared", True)),
        "cookie_valid": bool(state.get("valid", False)),
        "cookie_count": int(state.get("count") or 0),
    }


def start_login(
    session_scope: str,
    browser: str = "chromium",
) -> dict[str, Any]:
    """Open the companion's visible browser and begin QR-login polling."""
    safe_browser = browser if browser in {"chromium", "firefox", "webkit"} else "chromium"
    return _request(
        "POST",
        "/api/v1/fetch-cookie",
        session_scope=session_scope,
        json_body={"browser": safe_browser},
        timeout=15.0,
    )


def login_status(session_scope: str) -> dict[str, Any]:
    """Return QR-login progress without returning cookie values."""
    state = _request(
        "GET",
        "/api/v1/fetch-cookie",
        session_scope=session_scope,
        timeout=5.0,
    )
    return {
        "running": bool(state.get("running")),
        "message": str(state.get("message") or ""),
        "error": str(state.get("error") or ""),
        "browser_opened": bool(state.get("browser_opened")),
        "browser_mode": str(state.get("browser_mode") or "idle"),
        "qr_ready": bool(state.get("qr_ready")),
        "qr_version": int(state.get("qr_version") or 0),
        "observed_cookie_count": int(state.get("observed_cookie_count") or 0),
        "authenticated": bool(state.get("authenticated")),
    }


def cancel_login(session_scope: str) -> dict[str, Any]:
    """Cancel only the current user's transient browser login task."""
    state = _request(
        "DELETE",
        "/api/v1/fetch-cookie",
        session_scope=session_scope,
        timeout=8.0,
    )
    return {
        "cancelled": bool(state.get("cancelled")),
        "running": bool(state.get("running")),
        "message": str(state.get("message") or "扫码登录已取消"),
        "error": str(state.get("error") or ""),
        "browser_opened": bool(state.get("browser_opened")),
        "browser_mode": str(state.get("browser_mode") or "idle"),
        "qr_ready": bool(state.get("qr_ready")),
        "qr_version": int(state.get("qr_version") or 0),
    }


def login_qr(session_scope: str) -> dict[str, Any]:
    """Return only the bounded QR PNG as a data URL, never Cookie data."""
    return _request_qr("/api/v1/fetch-cookie/qr", session_scope)


def get_job(session_scope: str, job_id: str) -> dict[str, Any]:
    """Return one downloader collection job."""
    clean_id = job_id.strip()
    if not clean_id or len(clean_id) > 64:
        raise DouyinLibraryError("采集任务标识无效")
    job = _request(
        "GET",
        f"/api/v1/jobs/{quote(clean_id, safe='')}",
        session_scope=session_scope,
        timeout=8.0,
    )
    if not isinstance(job, dict):
        raise DouyinLibraryError("下载器返回了无法识别的采集任务")
    return _safe_job_payload(job)
