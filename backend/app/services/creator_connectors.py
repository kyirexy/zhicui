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
import socket
import subprocess
import sys
from typing import Any
from urllib.parse import urljoin, urlparse

import requests

from app.services import douyin_library, xhs_downloader_client


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
