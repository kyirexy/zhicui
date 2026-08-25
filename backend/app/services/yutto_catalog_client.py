"""Loopback-only client for yutto's metadata-only resolve protocol.

The yutto process is deliberately isolated from FastAPI.  This adapter sends
only a public Bilibili space URL, consumes ``resolve.start`` / ``item_listed``
events, and projects the response onto a small persistence-safe allowlist.
It never invokes ``download.start`` and never exposes yutto paths, auth data,
raw payloads, or media stream URLs to the caller.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:  # websockets >= 14 (installed by uvicorn[standard])
    from websockets.asyncio.client import connect as _websocket_connect
except ImportError:  # pragma: no cover - compatibility with older local envs
    try:
        from websockets import connect as _websocket_connect
    except ImportError:  # pragma: no cover - reported as a bounded connector error
        _websocket_connect = None


YUTTO_VERSION = "2.2.0"
YUTTO_COMMIT = "ba90a95bd89e416059ee5559b52197531d5d8998"
_DEFAULT_URL = "ws://127.0.0.1:11223"
_DEFAULT_TOKEN_FILE = "/opt/yutto-sidecar/server.token"
_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
_MAX_CATALOG_ITEMS = 50_000
_BVID = re.compile(r"^BV[0-9A-Za-z]{8,16}$", re.IGNORECASE)
_AVID = re.compile(r"^(?:av)?[1-9][0-9]{0,19}$", re.IGNORECASE)
_CID = re.compile(r"^[1-9][0-9]{0,19}$")
_BILIBILI_COVER_HOSTS = {
    "i0.hdslb.com",
    "i1.hdslb.com",
    "i2.hdslb.com",
    "archive.biliimg.com",
}


class YuttoCatalogError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class YuttoCatalogCancelled(YuttoCatalogError):
    def __init__(self):
        super().__init__("cancelled", "B站目录同步已取消")


def _enabled() -> bool:
    configured = os.getenv("YUTTO_CATALOG_ENABLED")
    if configured is None and os.name == "nt":
        return _token_file().is_file()
    return str(configured or "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _token_file() -> Path:
    configured = os.getenv("YUTTO_CATALOG_TOKEN_FILE")
    if configured:
        return Path(configured)
    if os.name == "nt" and os.getenv("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "Zhicui" / "yutto-sidecar" / "server.token"
    return Path(_DEFAULT_TOKEN_FILE)


def _server_url() -> str:
    value = os.getenv("YUTTO_CATALOG_URL", _DEFAULT_URL).strip()
    parsed = urlparse(value)
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise YuttoCatalogError("unsafe_sidecar_url", "yutto 连接器必须使用回环 WebSocket")
    return value


def _read_token() -> str:
    token_path = _token_file()
    try:
        if token_path.is_symlink() or not token_path.is_file():
            raise YuttoCatalogError("connector_unavailable", "yutto token 文件不可用")
        mode = token_path.stat().st_mode
        if os.name == "posix" and stat.S_IMODE(mode) & 0o077:
            raise YuttoCatalogError("unsafe_token_permissions", "yutto token 文件权限必须为 0600")
        token = token_path.read_text(encoding="utf-8").strip()
    except YuttoCatalogError:
        raise
    except OSError as exc:
        raise YuttoCatalogError("connector_unavailable", "yutto token 文件不可用") from exc
    if not token or len(token) > 4096 or any(ord(char) < 0x20 for char in token):
        raise YuttoCatalogError("connector_unavailable", "yutto token 文件内容无效")
    return token


def _clean_text(value: object, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _stable_external_id(raw: dict[str, Any]) -> str:
    value = _clean_text(raw.get("avid"), 32)
    if _BVID.fullmatch(value):
        return "BV" + value[2:]
    if _AVID.fullmatch(value):
        digits = value[2:] if value.lower().startswith("av") else value
        return f"av{digits}"
    return ""


def _page_from_url(value: object, fallback: int) -> int:
    try:
        parsed = urlparse(str(value or ""))
        page = int((parse_qs(parsed.query).get("p") or [fallback])[0])
    except (TypeError, ValueError):
        page = fallback
    return max(1, min(page, 10_000))


def _published_at(raw: dict[str, Any]) -> str | None:
    value = raw.get("published_at")
    if value is None:
        value = raw.get("pubdate")
    if value is None:
        value = raw.get("publish_timestamp")
    try:
        numeric = int(value)
        if numeric > 10_000_000_000:
            numeric //= 1000
        if 0 < numeric < 32_503_680_000:
            return datetime.fromtimestamp(numeric, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    text = _clean_text(value, 64)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def _duration_seconds(raw: dict[str, Any]) -> int:
    try:
        if raw.get("duration_seconds") is not None:
            duration = int(raw["duration_seconds"])
        elif raw.get("duration_ms") is not None:
            duration = int(raw["duration_ms"]) // 1000
        else:
            duration = int(raw.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    return max(0, min(duration, 7 * 24 * 60 * 60))


def _cover_url(value: object) -> str:
    raw = _clean_text(value, 2048)
    parsed = urlparse(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or (parsed.hostname or "").lower() not in _BILIBILI_COVER_HOSTS
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return raw


def _normalize_groups(raw_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for raw in raw_items[:_MAX_CATALOG_ITEMS]:
        if not isinstance(raw, dict):
            continue
        external_id = _stable_external_id(raw)
        cid = _clean_text(raw.get("cid"), 24)
        if not external_id or not _CID.fullmatch(cid):
            continue
        group = groups.get(external_id)
        if group is None:
            group = {
                "external_id": external_id,
                "source_url": f"https://www.bilibili.com/video/{external_id}",
                "title": _clean_text(raw.get("title") or raw.get("name"), 300),
                "cover_url": _cover_url(raw.get("cover_url")),
                "description": _clean_text(raw.get("description"), 5000),
                "author_name": _clean_text(raw.get("uploader"), 160),
                "published_at": _published_at(raw),
                "duration_seconds": _duration_seconds(raw),
                "order_index": len(groups),
                "parts": [],
            }
            groups[external_id] = group
        part_number = _page_from_url(raw.get("url"), len(group["parts"]) + 1)
        if any(part["cid"] == cid for part in group["parts"]):
            continue
        group["parts"].append(
            {
                "cid": cid,
                "page": part_number,
                "title": _clean_text(raw.get("name") or raw.get("title"), 300),
                "source_url": (
                    f"https://www.bilibili.com/video/{external_id}?p={part_number}"
                ),
            }
        )
    for group in groups.values():
        group["parts"].sort(key=lambda part: (part["page"], part["cid"]))
    return list(groups.values())


def _normalize_failures(raw_failures: object) -> list[dict[str, str]]:
    if not isinstance(raw_failures, list):
        return []
    result: list[dict[str, str]] = []
    for raw in raw_failures[:1000]:
        if not isinstance(raw, dict):
            continue
        result.append(
            {
                "external_id": "",
                "error_code": _clean_text(raw.get("code") or raw.get("type"), 96)
                or "resolve_failed",
            }
        )
    return result


def _rpc_error_code(payload: object) -> str:
    if not isinstance(payload, dict):
        return "connector_unavailable"
    combined = " ".join(
        _clean_text(payload.get(key), 256).lower()
        for key in ("code", "type", "message")
    )
    if any(marker in combined for marker in ("captcha", "challenge", "risk", "风控", "验证码")):
        return "bilibili_verification_required"
    if any(marker in combined for marker in ("login", "auth", "credential", "登录")):
        return "bilibili_login_required"
    if "capacity" in combined or "busy" in combined or "-32020" in combined:
        return "connector_busy"
    return "bilibili_catalog_failed"


async def _receive_rpc(
    websocket: Any,
    request_id: int,
    on_notification: Callable[[dict[str, Any]], None],
    *,
    timeout: float = 30.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise YuttoCatalogError("connector_timeout", "yutto 连接器响应超时")
        try:
            message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            payload = json.loads(message)
        except TimeoutError as exc:
            raise YuttoCatalogError("connector_timeout", "yutto 连接器响应超时") from exc
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise YuttoCatalogError("invalid_upstream_response", "yutto 返回格式异常") from exc
        if not isinstance(payload, dict):
            continue
        if payload.get("method") == "task.event":
            params = payload.get("params")
            if isinstance(params, dict):
                on_notification(params)
            continue
        if payload.get("id") != request_id:
            continue
        if payload.get("error") is not None:
            code = _rpc_error_code(payload.get("error"))
            raise YuttoCatalogError(code, "yutto 拒绝了目录解析请求")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise YuttoCatalogError("invalid_upstream_response", "yutto 返回格式异常")
        return result


async def _send_rpc(
    websocket: Any,
    request_id: int,
    method: str,
    params: dict[str, Any],
    on_notification: Callable[[dict[str, Any]], None],
    *,
    timeout: float = 30.0,
) -> dict[str, Any]:
    await websocket.send(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )
    return await _receive_rpc(
        websocket,
        request_id,
        on_notification,
        timeout=timeout,
    )


async def _discover_async(
    profile_url: str,
    *,
    on_item: Callable[[dict[str, Any], int, int | None], None] | None,
    should_cancel: Callable[[], bool] | None,
    task_started: Callable[[str], None] | None,
) -> dict[str, Any]:
    if _websocket_connect is None:
        raise YuttoCatalogError("connector_unavailable", "后端缺少 WebSocket 运行依赖")
    token = _read_token()
    seen_events: set[str] = set()
    task_id = ""

    def handle_event(event: dict[str, Any]) -> None:
        if task_id and _clean_text(event.get("task_id"), 64) != task_id:
            return
        if event.get("kind") != "item_listed" or not isinstance(event.get("data"), dict):
            return
        raw = event["data"]
        external_id = _stable_external_id(raw)
        if not external_id:
            return
        if external_id in seen_events:
            return
        seen_events.add(external_id)
        if on_item is not None:
            normalized = _normalize_groups([raw])
            if normalized:
                normalized[0]["order_index"] = len(seen_events) - 1
                on_item(normalized[0], len(seen_events), None)

    try:
        async with _websocket_connect(
            _server_url(),
            open_timeout=8,
            close_timeout=5,
            ping_interval=20,
            ping_timeout=20,
            max_size=_MAX_MESSAGE_BYTES,
            compression=None,
        ) as websocket:
            auth = await _send_rpc(
                websocket,
                1,
                "server.authenticate",
                {"token": token},
                handle_event,
                timeout=8,
            )
            if auth.get("authenticated") is not True:
                raise YuttoCatalogError("connector_auth_failed", "yutto 连接器认证失败")
            info = await _send_rpc(websocket, 2, "server.info", {}, handle_event, timeout=8)
            capabilities = info.get("capabilities") or []
            if info.get("version") != YUTTO_VERSION or "resolve.start" not in capabilities:
                raise YuttoCatalogError("connector_version_mismatch", "yutto 连接器版本或能力不匹配")

            started = await _send_rpc(
                websocket,
                3,
                "resolve.start",
                {
                    "request": {
                        "source": {"url": profile_url},
                        "scope": {"batch": True},
                        "resources": {
                            "video": False,
                            "audio": False,
                            "danmaku": False,
                            "subtitle": False,
                            "metadata": False,
                            "cover": False,
                            "chapter_info": False,
                            "save_cover": False,
                        },
                    }
                },
                handle_event,
                timeout=15,
            )
            task_id = _clean_text(started.get("task_id"), 64)
            if not task_id:
                raise YuttoCatalogError("invalid_upstream_response", "yutto 未返回任务标识")
            if task_started is not None:
                task_started(task_id)
            subscribed = await _send_rpc(
                websocket,
                4,
                "task.subscribe",
                {"task_id": task_id, "after_seq": 0},
                handle_event,
                timeout=8,
            )
            for replay_event in subscribed.get("events") or []:
                if isinstance(replay_event, dict):
                    handle_event(replay_event)

            request_id = 5
            deadline = time.monotonic() + 60 * 30
            snapshot = started
            while snapshot.get("state") not in {"completed", "failed", "cancelled"}:
                if should_cancel is not None and should_cancel():
                    await _send_rpc(
                        websocket,
                        request_id,
                        "task.cancel",
                        {"task_id": task_id},
                        handle_event,
                        timeout=8,
                    )
                    raise YuttoCatalogCancelled()
                if time.monotonic() >= deadline:
                    try:
                        await _send_rpc(
                            websocket,
                            request_id,
                            "task.cancel",
                            {"task_id": task_id},
                            handle_event,
                            timeout=8,
                        )
                    finally:
                        raise YuttoCatalogError("connector_timeout", "B站全量目录解析超时")
                snapshot = await _send_rpc(
                    websocket,
                    request_id,
                    "task.get",
                    {"task_id": task_id},
                    handle_event,
                    timeout=30,
                )
                request_id += 1
                if snapshot.get("state") not in {"completed", "failed", "cancelled"}:
                    await asyncio.sleep(0.4)

            if snapshot.get("state") == "cancelled":
                raise YuttoCatalogCancelled()
            if snapshot.get("state") == "failed":
                code = _rpc_error_code(snapshot.get("error"))
                raise YuttoCatalogError(code, "B站全量目录解析失败")
            result = snapshot.get("result")
            if not isinstance(result, dict):
                raise YuttoCatalogError("invalid_upstream_response", "yutto 任务结果格式异常")
            raw_items = result.get("items")
            if not isinstance(raw_items, list):
                raise YuttoCatalogError("invalid_upstream_response", "yutto 任务结果缺少作品列表")
            items = _normalize_groups(raw_items)
            failures = _normalize_failures(result.get("failures"))
            if len(raw_items) > _MAX_CATALOG_ITEMS:
                failures.append({"external_id": "", "error_code": "catalog_safety_limit"})
            complete = not failures
            return {
                "items": items,
                "complete": complete,
                "total_count": len(items) if complete else None,
                "failures": failures,
            }
    except YuttoCatalogError:
        raise
    except (OSError, asyncio.TimeoutError) as exc:
        raise YuttoCatalogError("connector_unavailable", "yutto 连接器暂不可用") from exc
    except Exception as exc:
        # websockets exposes several version-specific exception classes.  Do
        # not echo their messages because a server error may include payloads.
        raise YuttoCatalogError("connector_unavailable", "yutto 连接器连接中断") from exc


def discover_bilibili_catalog(
    profile_url: str,
    *,
    on_item: Callable[[dict[str, Any], int, int | None], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    task_started: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if not _enabled():
        raise YuttoCatalogError("connector_disabled", "B站全量目录连接器尚未启用")
    return asyncio.run(
        _discover_async(
            profile_url,
            on_item=on_item,
            should_cancel=should_cancel,
            task_started=task_started,
        )
    )


async def _cancel_async(task_id: str) -> bool:
    if _websocket_connect is None:
        return False

    def ignore_event(_event: dict[str, Any]) -> None:
        return None

    async with _websocket_connect(
        _server_url(),
        open_timeout=5,
        close_timeout=3,
        max_size=1024 * 1024,
        compression=None,
    ) as websocket:
        auth = await _send_rpc(
            websocket,
            1,
            "server.authenticate",
            {"token": _read_token()},
            ignore_event,
            timeout=5,
        )
        if auth.get("authenticated") is not True:
            return False
        result = await _send_rpc(
            websocket,
            2,
            "task.cancel",
            {"task_id": task_id},
            ignore_event,
            timeout=5,
        )
        return result.get("state") in {"cancelling", "cancelled", "completed", "failed"}


def cancel_task(task_id: str) -> bool:
    clean_task_id = _clean_text(task_id, 64)
    if not clean_task_id:
        return False
    try:
        return asyncio.run(_cancel_async(clean_task_id))
    except Exception:
        return False


def health() -> dict[str, Any]:
    """Return a safe deployment readiness summary without exposing the token."""
    if not _enabled():
        return {"enabled": False, "healthy": False, "version": YUTTO_VERSION}

    async def probe() -> dict[str, Any]:
        if _websocket_connect is None:
            raise YuttoCatalogError("connector_unavailable", "后端缺少 WebSocket 运行依赖")

        def ignore_event(_event: dict[str, Any]) -> None:
            return None

        async with _websocket_connect(
            _server_url(),
            open_timeout=3,
            close_timeout=2,
            max_size=1024 * 1024,
            compression=None,
        ) as websocket:
            auth = await _send_rpc(
                websocket,
                1,
                "server.authenticate",
                {"token": _read_token()},
                ignore_event,
                timeout=3,
            )
            if auth.get("authenticated") is not True:
                raise YuttoCatalogError("connector_auth_failed", "yutto 连接器认证失败")
            return await _send_rpc(websocket, 2, "server.info", {}, ignore_event, timeout=3)

    try:
        info = asyncio.run(probe())
        return {
            "enabled": True,
            "healthy": (
                info.get("version") == YUTTO_VERSION
                and "resolve.start" in (info.get("capabilities") or [])
            ),
            "version": _clean_text(info.get("version"), 32),
        }
    except YuttoCatalogError as exc:
        return {
            "enabled": True,
            "healthy": False,
            "version": YUTTO_VERSION,
            "error_code": exc.code,
        }
    except Exception:
        return {
            "enabled": True,
            "healthy": False,
            "version": YUTTO_VERSION,
            "error_code": "connector_unavailable",
        }
