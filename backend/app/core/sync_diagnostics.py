"""受限的客户端采集诊断；这些自报字段不构成授权、身份或新鲜度凭据。"""

from datetime import datetime, timezone
import re
from typing import Any

_ENDPOINTS = {
    "like": "/aweme/v1/web/aweme/favorite/",
    "collect": "/aweme/v1/web/aweme/listcollection/",
    "post": "/aweme/v1/web/aweme/post/",
}
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})")


def normalize_capture_diagnostics(value: object, *, platform: str, source_mode: str) -> dict[str, Any] | None:
    """逐字段重建白名单，不复制 URL 查询串、任意正文或秘密字段。

    诊断不完整或无效时仅丢弃诊断，不使兼容客户端的同步失败。
    此函数不参与可靠顺序判定、快照水位或请求身份计算。
    """
    if (not isinstance(value, dict) or platform != "douyin" or not isinstance(source_mode, str) or source_mode not in _ENDPOINTS
            or type(value.get("version")) is not int or value.get("version") != 1
            or value.get("platform") != platform or value.get("mode") != source_mode):
        return None
    clean: dict[str, Any] = {"version": 1, "platform": platform, "mode": source_mode}
    for key in ("fresh_document_committed", "http_cache_bypassed", "service_worker_bypassed"):
        if type(value.get(key)) is bool:
            clean[key] = value[key]
    for key in ("document_commit_count", "page_count"):
        if type(value.get(key)) is int and 0 <= value[key] <= 1000:
            clean[key] = value[key]
    for key in ("capture_started_at", "capture_finished_at"):
        raw = value.get(key)
        if not isinstance(raw, str) or len(raw) > 40 or not _ISO.fullmatch(raw):
            continue
        try:
            clean[key] = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError):
            continue
    if value.get("endpoint_path") == _ENDPOINTS[source_mode]:
        clean["endpoint_path"] = _ENDPOINTS[source_mode]
    if "first_page_cursor" in value and value["first_page_cursor"] in (None, "0"):
        clean["first_page_cursor"] = value["first_page_cursor"]
    methods = value.get("request_methods")
    if isinstance(methods, list):
        clean["request_methods"] = list(dict.fromkeys(
            method for method in methods[:2] if isinstance(method, str) and method in {"GET", "POST"}
        ))
    ids = value.get("first_video_ids")
    if isinstance(ids, list):
        clean["first_video_ids"] = list(dict.fromkeys(
            item for item in ids[:3] if isinstance(item, str) and re.fullmatch(r"[0-9]{5,32}", item)
        ))
    return clean
