"""Stable media references for persisted video knowledge.

Upstream play URLs are short-lived bearer URLs.  They must only exist while a
request is being processed; database rows keep the public work page and its
stable platform identifier instead.
"""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import urlsplit


_TRANSIENT_SOURCE_KEYS = {
    "download_url",
    "fetch_url",
    "media_url",
    "play_url",
    "signed_url",
}


def _host_matches(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith(f".{domain}")


def platform_from_source_url(value: str) -> str:
    """Return a supported platform only for its public page domains."""
    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"}:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if _host_matches(hostname, "douyin.com") or _host_matches(hostname, "iesdouyin.com"):
        return "douyin"
    if _host_matches(hostname, "bilibili.com") or _host_matches(hostname, "b23.tv"):
        return "bilibili"
    if any(
        _host_matches(hostname, domain)
        for domain in ("xiaohongshu.com", "rednote.com", "xhslink.com")
    ):
        return "xiaohongshu"
    if hostname == "mp.weixin.qq.com":
        return "wechat"
    return ""


def canonical_source_url(
    *,
    video_id: str,
    platform: str = "",
    candidates: tuple[str, ...] = (),
) -> str:
    """Choose a stable public work page without accepting a CDN play URL."""
    clean_platform = str(platform or "").strip().lower()
    clean_id = str(video_id or "").strip()

    # Platform share links (for example ``v.douyin.com/...`` and ``b23.tv``)
    # are themselves short-lived redirect capabilities.  Once the stable work
    # identifier is known, persist the canonical public page instead so a note
    # remains refreshable on another device and after the share link expires.
    if clean_platform == "douyin" and clean_id.isdigit() and 8 <= len(clean_id) <= 32:
        return f"https://www.douyin.com/video/{clean_id}"
    if clean_platform == "bilibili" and clean_id.lower().startswith("bv"):
        return f"https://www.bilibili.com/video/{clean_id}"
    if (
        clean_platform == "xiaohongshu"
        and clean_id.replace("_", "").replace("-", "").isalnum()
    ):
        return f"https://www.xiaohongshu.com/explore/{clean_id}"

    for candidate in candidates:
        value = str(candidate or "").strip()
        candidate_platform = platform_from_source_url(value)
        if candidate_platform and (
            not clean_platform or clean_platform == candidate_platform
        ):
            return value
    if not clean_id:
        return ""
    return ""


def sanitized_source_meta(value: object) -> dict[str, Any]:
    """Copy durable metadata while dropping every known upstream play URL."""
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): item
        for key, item in value.items()
        if str(key).lower() not in _TRANSIENT_SOURCE_KEYS
    }


def stable_note_source(
    *,
    video_id: str,
    video_url: str,
    source_meta: object,
    platform: str = "",
) -> str:
    meta = sanitized_source_meta(source_meta)
    clean_platform = str(meta.get("platform") or platform or "").strip().lower()
    return canonical_source_url(
        video_id=video_id,
        platform=clean_platform,
        candidates=(str(meta.get("source_url") or ""), str(video_url or "")),
    )
