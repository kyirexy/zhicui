"""Strict, metadata-only adapters for saved creator sources.

All URLs accepted here are either canonical platform profile URLs or bounded
redirects from official short-link hosts.  Platform responses are normalized
immediately; cookies, signed media URLs and raw response bodies never leave
the connector boundary.
"""

from __future__ import annotations

import ipaddress
import json
import re
import secrets
import socket
import subprocess
import sys
import threading
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

import requests

from app.services import douyin_library, xhs_downloader_client, yutto_catalog_client


class CreatorConnectorError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


PLATFORM_HOSTS = {
    "bilibili": {"space.bilibili.com", "b23.tv"},
    "douyin": {"www.douyin.com", "douyin.com", "v.douyin.com"},
    "xiaohongshu": {
        "www.xiaohongshu.com",
        "xiaohongshu.com",
        "xhslink.com",
        "www.xhslink.com",
    },
}
SHORT_HOSTS = {"b23.tv", "v.douyin.com", "xhslink.com", "www.xhslink.com"}
_BILI_ID = re.compile(r"^[1-9][0-9]{0,19}$")
_DOUYIN_ID = re.compile(r"^[A-Za-z0-9_-]{12,192}$")
_XHS_ID = re.compile(r"^[A-Za-z0-9_-]{8,192}$")
_ACTIVE_CATALOG_CANCELS: dict[str, Callable[[], bool]] = {}
_ACTIVE_CATALOG_CANCELS_LOCK = threading.Lock()


def _register_catalog_cancel(run_id: str, cancel: Callable[[], bool]) -> None:
    clean_run_id = str(run_id or "").strip()
    if not clean_run_id:
        return
    with _ACTIVE_CATALOG_CANCELS_LOCK:
        _ACTIVE_CATALOG_CANCELS[clean_run_id] = cancel


def _clear_catalog_cancel(run_id: str) -> None:
    clean_run_id = str(run_id or "").strip()
    if not clean_run_id:
        return
    with _ACTIVE_CATALOG_CANCELS_LOCK:
        _ACTIVE_CATALOG_CANCELS.pop(clean_run_id, None)


def cancel_catalog(run_id: str) -> bool:
    """Best-effort cancellation bridge used by the durable run service."""
    clean_run_id = str(run_id or "").strip()
    if not clean_run_id:
        return False
    with _ACTIVE_CATALOG_CANCELS_LOCK:
        cancel = _ACTIVE_CATALOG_CANCELS.get(clean_run_id)
    if cancel is None:
        return False
    try:
        return bool(cancel())
    except Exception:
        return False


def _host(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise CreatorConnectorError("invalid_profile", "主页链接格式不正确")
    return (parsed.hostname or "").lower().rstrip(".")


def _assert_public_host(host: str) -> None:
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError as exc:
        raise CreatorConnectorError("profile_unreachable", "主页域名暂时无法解析") from exc
    for raw in addresses:
        ip = ipaddress.ip_address(raw)
        if not ip.is_global:
            raise CreatorConnectorError("ssrf_rejected", "主页地址未通过安全校验")


def _follow_official_short_link(url: str, platform: str) -> str:
    current = url
    allowed = PLATFORM_HOSTS[platform]
    session = requests.Session()
    session.trust_env = False
    try:
        for _ in range(4):
            host = _host(current)
            if host not in allowed:
                raise CreatorConnectorError("ssrf_rejected", "仅支持官方博主主页链接")
            _assert_public_host(host)
            response = session.get(
                current,
                allow_redirects=False,
                stream=True,
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0 ZhicuiCreatorResolver/1.0"},
            )
            if response.status_code not in {301, 302, 303, 307, 308}:
                return current
            location = response.headers.get("location") or ""
            if not location:
                break
            current = urljoin(current, location)
        raise CreatorConnectorError("invalid_profile", "短链接未跳转到有效博主主页")
    except requests.RequestException as exc:
        raise CreatorConnectorError("profile_unreachable", "主页短链接暂时无法解析") from exc
    finally:
        session.close()


def normalize_profile_ref(platform: str, profile_ref: str) -> dict[str, str]:
    value = str(profile_ref or "").strip()
    if platform not in PLATFORM_HOSTS:
        raise CreatorConnectorError("unsupported_platform", "暂不支持该平台")
    if not value or len(value) > 1024:
        raise CreatorConnectorError("invalid_profile", "请输入有效的博主主页")

    if "://" not in value:
        pattern = {
            "bilibili": _BILI_ID,
            "douyin": _DOUYIN_ID,
            "xiaohongshu": _XHS_ID,
        }[platform]
        if not pattern.fullmatch(value):
            raise CreatorConnectorError("invalid_profile", "博主 ID 格式不正确")
        creator_id = value
    else:
        host = _host(value)
        if host not in PLATFORM_HOSTS[platform]:
            raise CreatorConnectorError("ssrf_rejected", "仅支持官方博主主页链接")
        if host in SHORT_HOSTS:
            value = _follow_official_short_link(value, platform)
            host = _host(value)
            if host not in PLATFORM_HOSTS[platform] - SHORT_HOSTS:
                raise CreatorConnectorError("invalid_profile", "短链接不是博主主页")
        parsed = urlparse(value)
        segments = [part for part in parsed.path.split("/") if part]
        creator_id = ""
        if platform == "bilibili" and host == "space.bilibili.com" and segments:
            creator_id = segments[0]
        elif platform == "douyin" and len(segments) >= 2 and segments[0] == "user":
            creator_id = segments[1]
        elif platform == "xiaohongshu" and len(segments) >= 3 and segments[:2] == ["user", "profile"]:
            creator_id = segments[2]
        pattern = {
            "bilibili": _BILI_ID,
            "douyin": _DOUYIN_ID,
            "xiaohongshu": _XHS_ID,
        }[platform]
        if not creator_id or not pattern.fullmatch(creator_id):
            raise CreatorConnectorError("invalid_profile", "链接不是有效的博主主页")

    canonical = {
        "bilibili": f"https://space.bilibili.com/{creator_id}/video",
        "douyin": f"https://www.douyin.com/user/{creator_id}",
        "xiaohongshu": f"https://www.xiaohongshu.com/user/profile/{creator_id}",
    }[platform]
    return {"platform": platform, "creator_id": creator_id, "profile_url": canonical}


def _bilibili_playlist(profile_url: str, limit: int) -> dict[str, Any]:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-end",
        str(max(1, min(int(limit), 100))),
        "--no-warnings",
        profile_url,
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CreatorConnectorError("connector_unavailable", "B站博主连接器暂不可用") from exc
    if completed.returncode != 0:
        raise CreatorConnectorError("creator_unavailable", "无法读取该 B站博主主页")
    try:
        data = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as exc:
        raise CreatorConnectorError("invalid_upstream_response", "B站博主连接器返回格式异常") from exc
    if not isinstance(data, dict):
        raise CreatorConnectorError("invalid_upstream_response", "B站博主连接器返回格式异常")
    return data


def resolve_creator(
    platform: str,
    profile_ref: str,
    *,
    douyin_session_scope: str = "",
    xhs_cookie: str = "",
) -> dict[str, str]:
    normalized = normalize_profile_ref(platform, profile_ref)
    if platform == "bilibili":
        data = _bilibili_playlist(normalized["profile_url"], 1)
        return {
            **normalized,
            "display_name": str(data.get("uploader") or data.get("channel") or data.get("title") or f"B站用户 {normalized['creator_id']}")[:160],
            "avatar_url": str(data.get("thumbnail") or "")[:2048],
        }
    if platform == "douyin":
        if not douyin_session_scope:
            raise CreatorConnectorError("douyin_login_required", "请先连接自己的抖音账号")
        try:
            data = douyin_library.resolve_creator(douyin_session_scope, normalized["profile_url"])
        except douyin_library.DouyinLibraryError as exc:
            raise CreatorConnectorError("douyin_login_required", "抖音登录已失效或连接器不可用") from exc
        return {**normalized, **data, "platform": platform}
    if not xhs_cookie:
        raise CreatorConnectorError("xhs_service_unavailable", "小红书服务账号尚未配置")
    try:
        data = xhs_downloader_client.resolve_xhs_creator(
            normalized["profile_url"], cookie=xhs_cookie
        )
    except xhs_downloader_client.XhsDownloaderUnavailable as exc:
        raise CreatorConnectorError("xhs_service_unavailable", "小红书博主连接器暂不可用") from exc
    return {**normalized, **data, "platform": platform}


def discover_works(
    source: Any,
    limit: int,
    *,
    douyin_session_scope: str = "",
    douyin_binding_ref: str = "",
    xhs_cookie: str = "",
) -> list[dict[str, Any]]:
    if source.platform == "bilibili":
        data = _bilibili_playlist(source.profile_url, limit)
        entries = data.get("entries") or []
        result = []
        for raw in entries[:limit]:
            if not isinstance(raw, dict):
                continue
            external_id = str(raw.get("id") or "").strip()
            if not external_id:
                continue
            result.append({
                "external_id": external_id[:192],
                "source_url": f"https://www.bilibili.com/video/{external_id}",
                "media_type": "video",
            })
        return result
    if source.platform == "douyin":
        try:
            items = douyin_library.list_creator_works(
                douyin_session_scope,
                douyin_binding_ref,
                source.creator_id,
                limit,
            )
        except douyin_library.DouyinLibraryError as exc:
            raise CreatorConnectorError("douyin_login_required", "抖音登录已失效或连接器不可用") from exc
        return [
            {
                "external_id": str(item.get("aweme_id") or "")[:192],
                "source_url": str(item.get("source_url") or "")[:1024],
                "media_type": str(item.get("media_type") or "video"),
                "author_name": str(item.get("author_name") or "")[:160],
            }
            for item in items
            if item.get("aweme_id")
        ]
    try:
        items = xhs_downloader_client.list_xhs_creator_works(
            source.creator_id, limit=limit, cookie=xhs_cookie
        )
    except xhs_downloader_client.XhsDownloaderUnavailable as exc:
        raise CreatorConnectorError("xhs_service_unavailable", "小红书博主连接器暂不可用") from exc
    return [
        {
            "external_id": str(item.get("note_id") or "")[:192],
            "source_url": str(item.get("source_url") or "")[:1024],
            # This tokenized URL is in-memory only; the run persists the
            # canonical source_url and safe IDs, never this fetch address.
            "fetch_url": str(item.get("fetch_url") or item.get("source_url") or "")[:2048],
            "media_type": "video",
            "author_name": str(item.get("author_name") or "")[:160],
        }
        for item in items
        if item.get("note_id") and item.get("type") == "video"
    ]


def _safe_catalog_text(value: object, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _catalog_published_at(raw: dict[str, Any]) -> str | None:
    timestamp = raw.get("publish_timestamp")
    if timestamp is None:
        timestamp = raw.get("create_time")
    try:
        numeric = int(timestamp)
        if numeric > 10_000_000_000:
            numeric //= 1000
        if 0 < numeric < 32_503_680_000:
            return datetime.fromtimestamp(numeric, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    value = _safe_catalog_text(raw.get("published_at"), 64)
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def _normalize_douyin_catalog_item(
    raw: dict[str, Any],
    order_index: int,
) -> dict[str, Any] | None:
    external_id = _safe_catalog_text(raw.get("aweme_id") or raw.get("id"), 192)
    if not external_id or not re.fullmatch(r"[0-9A-Za-z_-]{5,192}", external_id):
        return None
    media_type = _safe_catalog_text(raw.get("media_type") or "video", 32).lower()
    if media_type != "video":
        # The product currently prepares video transcripts.  Photo posts may
        # still exist in the sidecar manifest, but they are not catalog rows.
        return None
    description = _safe_catalog_text(raw.get("description") or raw.get("desc"), 5000)
    title = _safe_catalog_text(raw.get("title"), 300)
    if not title:
        title = _safe_catalog_text(description.splitlines()[0] if description else "", 300)
    try:
        if raw.get("duration_ms") is not None:
            duration_seconds = int(raw.get("duration_ms") or 0) // 1000
        else:
            duration_seconds = int(raw.get("duration_seconds") or raw.get("duration") or 0)
    except (TypeError, ValueError):
        duration_seconds = 0
    return {
        "external_id": external_id,
        "source_url": f"https://www.douyin.com/video/{external_id}",
        "title": title or f"抖音作品 {external_id}",
        # Douyin CDN cover addresses are usually signed and short-lived.  They
        # must never be persisted by CreatorSourceItem, so the durable catalog
        # deliberately leaves this blank until a stable proxy is introduced.
        "cover_url": "",
        "description": description,
        "author_name": _safe_catalog_text(raw.get("author_name") or raw.get("nickname"), 160),
        "published_at": _catalog_published_at(raw),
        "duration_seconds": max(0, min(duration_seconds, 7 * 24 * 60 * 60)),
        "order_index": max(0, int(order_index)),
        "parts": [],
    }


def _douyin_catalog_error(exc: Exception) -> CreatorConnectorError:
    message = str(exc).lower()
    if any(marker in message for marker in ("验证码", "captcha", "challenge", "风控", "risk")):
        return CreatorConnectorError("douyin_verification_required", "抖音要求完成验证码或风控验证")
    if any(marker in message for marker in ("登录", "cookie", "login", "session")):
        return CreatorConnectorError("douyin_login_required", "抖音登录已失效，请重新连接")
    return CreatorConnectorError("connector_unavailable", "抖音全量目录连接器暂不可用")


def _discover_douyin_catalog(
    source: Any,
    *,
    douyin_session_scope: str,
    on_item: Callable[[dict[str, Any], int, int | None], None] | None,
    should_cancel: Callable[[], bool] | None,
    run_id: str,
) -> dict[str, Any]:
    if not douyin_session_scope:
        raise CreatorConnectorError("douyin_login_required", "请先连接自己的抖音账号")
    cursor = ""
    catalog_id = secrets.token_hex(20)
    seen_cursors: set[str] = set()
    seen_ids: set[str] = set()
    items: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    complete = False

    def cancel_sidecar() -> bool:
        if not catalog_id:
            return False
        try:
            state = douyin_library._request(
                "DELETE",
                f"/api/v1/creators/catalog/{catalog_id}",
                session_scope=douyin_session_scope,
                timeout=8.0,
            )
            return bool(not isinstance(state, dict) or state.get("cancelled", True))
        except Exception:
            return False

    _register_catalog_cancel(run_id, cancel_sidecar)

    try:
        for _page_index in range(1000):
            if should_cancel is not None and should_cancel():
                cancel_sidecar()
                raise CreatorConnectorError("cancelled", "抖音目录同步已取消")
            try:
                body = douyin_library._request(
                    "POST",
                    "/api/v1/creators/catalog",
                    session_scope=douyin_session_scope,
                    json_body={
                        "creator_id": str(source.creator_id),
                        "cursor": cursor or None,
                        "page_size": 50,
                        "catalog_id": catalog_id,
                        "metadata_only": True,
                    },
                    timeout=60.0,
                )
            except douyin_library.DouyinLibraryError as exc:
                error = _douyin_catalog_error(exc)
                if not items or error.code in {
                    "douyin_login_required",
                    "douyin_verification_required",
                }:
                    raise error from exc
                failures.append({"external_id": "", "error_code": error.code})
                break
            if not isinstance(body, dict) or not isinstance(body.get("items"), list):
                error = CreatorConnectorError(
                    "invalid_upstream_response",
                    "抖音全量目录连接器返回格式异常",
                )
                if not items:
                    raise error
                failures.append({"external_id": "", "error_code": error.code})
                break

            next_catalog_id = _safe_catalog_text(body.get("catalog_id"), 96)
            if next_catalog_id:
                catalog_id = next_catalog_id
                _register_catalog_cancel(run_id, cancel_sidecar)
            for raw in body["items"]:
                if not isinstance(raw, dict):
                    continue
                item = _normalize_douyin_catalog_item(raw, len(items))
                if item is None or item["external_id"] in seen_ids:
                    continue
                seen_ids.add(item["external_id"])
                items.append(item)
                if on_item is not None:
                    # 上游总数包含图文；过滤后只能在完整扫描结束时确定视频总数。
                    on_item(item, len(items), None)
                if len(items) >= 50_000:
                    failures.append({"external_id": "", "error_code": "catalog_safety_limit"})
                    return {
                        "items": items,
                        "complete": False,
                        "total_count": None,
                        "failures": failures,
                    }

            needs_action = _safe_catalog_text(body.get("needs_action"), 96)
            if needs_action:
                code = (
                    "douyin_verification_required"
                    if needs_action in {"captcha", "challenge", "risk_control", "verification"}
                    else "douyin_login_required"
                )
                raise CreatorConnectorError(code, "抖音需要用户处理后才能继续同步")

            has_more = bool(body.get("has_more"))
            next_cursor = _safe_catalog_text(body.get("next_cursor"), 256)
            if not has_more:
                complete = body.get("complete") is not False
                break
            if not next_cursor or next_cursor == cursor or next_cursor in seen_cursors:
                failures.append({"external_id": "", "error_code": "invalid_discovery_cursor"})
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        else:
            failures.append({"external_id": "", "error_code": "catalog_page_limit"})
    finally:
        _clear_catalog_cancel(run_id)

    if failures:
        complete = False
    return {
        "items": items,
        "complete": complete,
        # The sidecar may enumerate photo posts as well. This feature catalogs
        # transcript-capable videos only, so the exact terminal count is the
        # connector's allowlisted video count rather than the raw profile total.
        "total_count": len(items) if complete else None,
        "failures": failures,
    }


def discover_catalog(
    source: Any,
    *,
    douyin_session_scope: str = "",
    douyin_binding_ref: str = "",
    on_item: Callable[[dict[str, Any], int, int | None], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    run_id: str = "",
) -> dict[str, Any]:
    """Enumerate every currently readable public work without media download.

    The returned ``items`` use a strict persistence allowlist. ``complete`` is
    true only when the connector reached the end without partial failures;
    callers may mark previously-seen rows unavailable only in that case.
    """
    del douyin_binding_ref  # kept in the shared contract for future stable proxies
    if should_cancel is not None and should_cancel():
        raise CreatorConnectorError("cancelled", "博主目录同步已取消")
    if source.platform == "douyin":
        return _discover_douyin_catalog(
            source,
            douyin_session_scope=douyin_session_scope,
            on_item=on_item,
            should_cancel=should_cancel,
            run_id=run_id,
        )
    if source.platform == "bilibili":
        task_id_holder = {"value": ""}

        def task_started(task_id: str) -> None:
            task_id_holder["value"] = task_id
            _register_catalog_cancel(
                run_id,
                lambda: yutto_catalog_client.cancel_task(task_id_holder["value"]),
            )

        try:
            return yutto_catalog_client.discover_bilibili_catalog(
                source.profile_url,
                on_item=on_item,
                should_cancel=should_cancel,
                task_started=task_started,
            )
        except yutto_catalog_client.YuttoCatalogError as exc:
            raise CreatorConnectorError(exc.code, str(exc)) from exc
        finally:
            _clear_catalog_cancel(run_id)
    raise CreatorConnectorError(
        "catalog_not_supported",
        "该平台首版暂不支持全量作品目录",
    )


def catalog_health(
    platform: str,
    *,
    douyin_session_scope: str = "",
) -> dict[str, Any]:
    """Return a credential-free readiness summary for catalog capability."""
    if platform == "bilibili":
        state = yutto_catalog_client.health()
        return {
            "platform": platform,
            "enabled": bool(state.get("enabled")),
            "healthy": bool(state.get("healthy")),
            "supports_catalog_all": bool(state.get("healthy")),
            "version": _safe_catalog_text(state.get("version"), 32),
            "error_code": _safe_catalog_text(state.get("error_code"), 96) or None,
        }
    if platform == "douyin":
        try:
            raw = douyin_library._request("GET", "/api/v1/health", timeout=3.0)
            connected = isinstance(raw, dict) and raw.get("status") == "ok"
            storage_mode = _safe_catalog_text(
                raw.get("storage_mode") if isinstance(raw, dict) else "",
                32,
            )
            capabilities = raw.get("capabilities") if isinstance(raw, dict) else []
            supports_catalog = bool(
                (isinstance(capabilities, list) and "creator_catalog" in capabilities)
                or (isinstance(raw, dict) and raw.get("supports_creator_catalog"))
            )
            session_ready: bool | None = None
            if douyin_session_scope:
                session_state = douyin_library.connection_status(douyin_session_scope)
                session_ready = bool(session_state.get("cookie_valid"))
            healthy = connected and storage_mode == "metadata_only" and supports_catalog
            return {
                "platform": platform,
                "enabled": connected,
                "healthy": healthy,
                "supports_catalog_all": healthy,
                "storage_mode": storage_mode or "unknown",
                "session_ready": session_ready,
                "error_code": None if healthy else "catalog_capability_unavailable",
            }
        except douyin_library.DouyinLibraryError:
            return {
                "platform": platform,
                "enabled": False,
                "healthy": False,
                "supports_catalog_all": False,
                "storage_mode": "unknown",
                "session_ready": False if douyin_session_scope else None,
                "error_code": "connector_unavailable",
            }
    return {
        "platform": platform,
        "enabled": False,
        "healthy": False,
        "supports_catalog_all": False,
        "error_code": "catalog_not_supported",
    }
