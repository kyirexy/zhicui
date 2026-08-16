"""Small HTTP adapter for the separately licensed XHS-Downloader sidecar."""

from __future__ import annotations

from typing import Any

import requests

from app.core.config import settings


class XhsDownloaderUnavailable(RuntimeError):
    """Raised when the optional sidecar cannot provide a usable response."""


def _value(data: dict[str, Any], *keys: str, default: Any = "") -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, "", [], {}):
            return value
    return default


def _urls(value: Any) -> list[str]:
    if isinstance(value, str):
        candidates = value.split()
    elif isinstance(value, (list, tuple)):
        candidates = [str(item) for item in value]
    else:
        candidates = []
    return [item.strip() for item in candidates if item.strip().startswith(("http://", "https://"))]


def _tags(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(item).strip().lstrip("#") for item in value if str(item).strip()]
    return [item.lstrip("#") for item in str(value or "").split() if item.strip()]


def normalize_xhs_detail(data: dict[str, Any], requested_url: str) -> dict[str, Any]:
    """Map XHS-Downloader's localized response fields to Zhicui fields."""
    work_type = str(_value(data, "作品类型", "type", "note_type", default="未知")).strip()
    normalized_type = "video" if work_type.lower() == "video" or "视频" in work_type else "image"
    download_urls = _urls(_value(data, "下载地址", "download_urls", "downloads", default=[]))
    animated_urls = _urls(_value(data, "动图地址", "live_photo_urls", default=[]))
    source_url = str(_value(data, "作品链接", "url", "source_url", default=requested_url)).strip()
    media_url = download_urls[0] if normalized_type == "video" and download_urls else ""
    cover_url = str(_value(data, "封面地址", "cover", "cover_url", default="")).strip()
    if not cover_url and normalized_type != "video" and download_urls:
        cover_url = download_urls[0]

    return {
        "note_id": str(_value(data, "作品ID", "id", "note_id", default="")).strip(),
        "title": str(_value(data, "作品标题", "title", default="小红书作品")).strip() or "小红书作品",
        "desc": str(_value(data, "作品描述", "desc", "description", default="")).strip(),
        "type": normalized_type,
        "source_type": work_type,
        "author_name": str(_value(data, "作者昵称", "author_name", "nickname", default="")).strip(),
        "author_id": str(_value(data, "作者ID", "author_id", "user_id", default="")).strip(),
        "source_url": source_url or requested_url,
        "cover_url": cover_url,
        "media_url": media_url,
        "download_urls": download_urls,
        "animated_urls": animated_urls,
        "tags": _tags(_value(data, "作品标签", "tags", default=[])),
        "published_at": str(_value(data, "发布时间", "published_at", default="")).strip(),
        "provider": "xhs-downloader",
    }


def fetch_xhs_detail(
    url: str,
    *,
    cookie: str = "",
    api_base: str | None = None,
    timeout_seconds: int | None = None,
) -> dict[str, Any]:
    """Fetch one note without asking the sidecar to save any media files."""
    base = (settings.XHS_DOWNLOADER_API_BASE if api_base is None else api_base).strip().rstrip("/")
    if not base:
        raise XhsDownloaderUnavailable("小红书增强解析服务未配置")
    timeout = max(3, min(int(timeout_seconds or settings.XHS_DOWNLOADER_TIMEOUT_SECONDS), 60))
    payload: dict[str, Any] = {"url": url, "download": False, "skip": False}
    if cookie:
        payload["cookie"] = cookie

    session = requests.Session()
    session.trust_env = False
    try:
        response = session.post(f"{base}/xhs/detail", json=payload, timeout=timeout)
        response.raise_for_status()
        body = response.json()
    except Exception as exc:
        # Never include the response body: XHS-Downloader echoes request params,
        # including the optional cookie, in its JSON response model.
        raise XhsDownloaderUnavailable("小红书增强解析服务暂不可用") from exc
    finally:
        session.close()

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict) or not data:
        raise XhsDownloaderUnavailable("小红书增强解析未返回作品数据")
    normalized = normalize_xhs_detail(data, url)
    if not normalized["note_id"]:
        raise XhsDownloaderUnavailable("小红书增强解析缺少作品标识")
    return normalized


def _post_creator(
    path: str,
    payload: dict[str, Any],
    *,
    cookie: str,
    api_base: str | None = None,
) -> Any:
    base = (settings.XHS_DOWNLOADER_API_BASE if api_base is None else api_base).strip().rstrip("/")
    if not base:
        raise XhsDownloaderUnavailable("小红书博主同步服务未配置")
    request_body = {**payload, "download": False}
    if cookie:
        request_body["cookie"] = cookie
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.post(
            f"{base}{path}",
            json=request_body,
            timeout=max(5, min(int(settings.XHS_DOWNLOADER_TIMEOUT_SECONDS), 60)),
        )
        response.raise_for_status()
        body = response.json()
    except Exception as exc:
        # Never include an upstream body because it can echo the service cookie.
        raise XhsDownloaderUnavailable("小红书博主同步服务暂不可用") from exc
    finally:
        session.close()
    return body.get("data") if isinstance(body, dict) else None


def resolve_xhs_creator(
    profile_url: str,
    *,
    cookie: str,
    api_base: str | None = None,
) -> dict[str, Any]:
    data = _post_creator(
        "/xhs/creator",
        {"profile_url": str(profile_url or "").strip()},
        cookie=cookie,
        api_base=api_base,
    )
    if not isinstance(data, dict):
        raise XhsDownloaderUnavailable("小红书博主解析未返回资料")
    creator_id = str(_value(data, "creator_id", "user_id", "用户ID", default="")).strip()
    if not creator_id:
        raise XhsDownloaderUnavailable("小红书博主解析缺少用户标识")
    return {
        "creator_id": creator_id[:192],
        "display_name": str(_value(data, "display_name", "nickname", "用户昵称", default="小红书博主")).strip()[:160],
        "avatar_url": str(_value(data, "avatar_url", "avatar", "头像", default="")).strip()[:2048],
        "profile_url": f"https://www.xiaohongshu.com/user/profile/{creator_id}",
    }


def list_xhs_creator_works(
    creator_id: str,
    *,
    limit: int,
    cookie: str,
    api_base: str | None = None,
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), 100))
    data = _post_creator(
        "/xhs/creator/works",
        {"creator_id": str(creator_id or "").strip(), "limit": safe_limit},
        cookie=cookie,
        api_base=api_base,
    )
    raw_items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(raw_items, list):
        raise XhsDownloaderUnavailable("小红书博主作品接口未返回列表")
    result: list[dict[str, Any]] = []
    for raw in raw_items[:safe_limit]:
        if not isinstance(raw, dict):
            continue
        normalized = normalize_xhs_detail(raw, str(raw.get("source_url") or raw.get("url") or ""))
        normalized["fetch_url"] = str(
            raw.get("fetch_url") or normalized["source_url"]
        ).strip()
        # First release intentionally excludes image notes.
        if normalized.get("note_id") and normalized.get("type") == "video":
            result.append(normalized)
    return result
