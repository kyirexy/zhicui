"""
API route definitions for VideoCapsule.
"""

from __future__ import annotations

import io
import json
import importlib.util
import time
import traceback
import uuid
import wave
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import requests as http_requests
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.auth import get_current_user, get_current_user_optional, get_current_admin
from app.core.media_reference import sanitized_source_meta
from app.models.note import Note
from app.models.user import (
    User as UserModel,
    get_user_by_id,
    list_users,
    count_users,
)
from app.services import (
    ai_juicer,
    activity_service,
    app_release_service,
    audit_service,
    chat_credit_billing_service,
    chat_model_catalog_service,
    client_download_service,
    creator_connectors,
    creator_sync_service,
    creator_sync_worker,
    desktop_handoff_service,
    douyin_binding_service,
    douyin_library,
    error_log_service,
    feedback_service,
    image_memory_cache,
    library_extraction_service,
    library_hidden_service,
    local_douyin_library_service,
    llm_usage_service,
    knowledge_service,
    note_plan_agent_service,
    note_service,
    omniroute_workspace_service,
    platform_library_service,
    plan_service,
    privacy_account_service,
    settings_service,
    user_ai_provider_service,
    video_source_ledger_service,
    video_extractor,
)
from app.services import auth_service
from app.services.video_extractor import _detect_platform
from app.services.wechat_extractor import extract_wechat_article

router = APIRouter()

_COVER_MAX_BYTES = 8 * 1024 * 1024


def _safe_extraction_video_preview(
    video_info: dict[str, Any],
    *,
    source_url: str,
    platform: str,
) -> dict[str, str]:
    """Return only transient fields required by the in-progress preview UI."""
    return {
        "title": str(video_info.get("title") or "未知标题"),
        "video_id": str(video_info.get("video_id") or ""),
        "platform": platform,
        "source_url": source_url,
        "media_url": str(
            video_info.get("preview_media_url")
            or video_info.get("download_url")
            or video_info.get("url")
            or ""
        ),
        "cover_url": str(
            video_info.get("preview_cover_url")
            or video_info.get("cover_url")
            or video_info.get("thumbnail")
            or ""
        ),
        "author_name": str(video_info.get("author_name") or video_info.get("author") or ""),
    }


def _safe_video_parse_error(exc: Exception) -> str:
    """Map connector failures to messages that do not expose internals."""
    if isinstance(exc, (video_extractor.VideoExtractionError, NotImplementedError)):
        return str(exc)
    return "视频链接暂时无法解析，请检查链接是否正确，稍后重试。"


def _recover_bound_douyin_video(
    db: Session,
    *,
    user_id: str,
    error: video_extractor.VideoMetadataUnavailableError,
) -> tuple[dict[str, Any], str, dict[str, str]] | None:
    """Recover one public-page failure through the user's existing sidecar.

    Only stable metadata and signed same-origin preview capabilities leave this
    helper. The loopback media URL and scoped header stay request-local and are
    passed directly to ASR; neither is added to ``source_meta`` or persisted.
    """
    aweme_id = str(getattr(error, "item_id", "") or "").strip()
    if not aweme_id.isdigit() or not 8 <= len(aweme_id) <= 32:
        return None
    binding = douyin_binding_service.get_by_user(db, user_id)
    if (
        binding is None
        or str(binding.status or "") != "connected"
        or int(binding.cookie_count or 0) <= 0
    ):
        return None

    manifest_item: dict[str, Any] | None = None
    try:
        manifest_item = douyin_library.get_item(
            binding.session_scope,
            binding.id,
            aweme_id,
        )
    except douyin_library.DouyinLibraryError:
        # A work need not have been synchronized into the manifest. The media
        # endpoint can still resolve it with this user's bound session.
        manifest_item = None
    if str((manifest_item or {}).get("media_type") or "video") == "gallery":
        return None

    caption = str((manifest_item or {}).get("caption") or "").strip()
    title = str((manifest_item or {}).get("title") or "").strip()
    if not title:
        title = caption.splitlines()[0].strip() if caption else f"抖音作品 {aweme_id}"
    video_info: dict[str, Any] = {
        "video_id": aweme_id,
        "title": title[:512],
        "platform": "douyin",
        "source_url": f"https://www.douyin.com/video/{aweme_id}",
        "author_name": str((manifest_item or {}).get("author_name") or "").strip(),
        "preview_media_url": douyin_library.public_media_url(
            aweme_id,
            binding.id,
        ),
        "preview_cover_url": douyin_library.public_cover_url(
            aweme_id,
            binding.id,
        ),
    }
    return (
        video_info,
        douyin_library.companion_media_url(aweme_id),
        douyin_library.companion_headers(binding.session_scope),
    )


def _mint_douyin_item_capabilities(
    item: dict[str, Any],
    binding_ref: str,
) -> dict[str, Any]:
    """Attach fresh response-only capabilities for one Douyin catalog item."""
    aweme_id = str(item.get("aweme_id") or item.get("id") or "").strip()
    if not aweme_id:
        return item
    if str(item.get("media_type") or "video") != "gallery":
        item["media_url"] = douyin_library.public_media_url(
            aweme_id,
            binding_ref,
        )
    # The sidecar resolves a fresh cover by aweme id.  Older local snapshots
    # therefore get a usable cover even when they never stored an upstream URL.
    item["cover_proxy_url"] = douyin_library.public_cover_url(
        aweme_id,
        binding_ref,
    )
    return item


def _transcript_progress_payload(
    transcript: str,
    *,
    platform: str,
) -> dict[str, Any]:
    return {
        "phase": "transcribe_done",
        "platform": platform,
        "transcript_chars": len(transcript),
        "transcript": transcript,
    }


@router.get("/api/client-downloads/{platform}", include_in_schema=False)
def client_download(
    platform: Literal["android", "windows"],
    db: Session = Depends(get_db),
) -> RedirectResponse:
    """Count one official download start, then serve the allowlisted package."""
    try:
        client_download_service.record_download(db, platform)
    except Exception as exc:
        db.rollback()
        error_log_service.record_error_safely(
            source="client_download",
            severity="warning",
            error_type=type(exc).__name__,
            message="客户端下载计数失败",
            path=f"/api/client-downloads/{platform}",
        )
    return RedirectResponse(
        url=client_download_service.DOWNLOAD_TARGETS[platform],
        status_code=307,
        headers={"Cache-Control": "no-store"},
    )


def _cover_placeholder_response() -> Response:
    """Return a retryable image error when the remote cover is unavailable."""
    svg = """<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#eef5f1"/><stop offset="1" stop-color="#dcebe3"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/><rect x="270" y="130" width="100" height="100" rx="22" fill="#fff" fill-opacity=".72"/>
<path d="M309 164v32l27-16-27-16Z" fill="#43866a"/><path d="M286 215h68" stroke="#8aab9d" stroke-width="8" stroke-linecap="round"/>
</svg>"""
    return Response(
        content=svg.encode("utf-8"),
        status_code=503,
        media_type="image/svg+xml",
        headers={
            "Cache-Control": "private, no-store",
            "Retry-After": "1",
            "X-Content-Type-Options": "nosniff",
            "X-Zhicui-Cover-Fallback": "1",
        },
    )


def _proxy_douyin_image(
    target_url: str,
    session_scope: str,
    *,
    fallback_url: str = "",
    stable_cache_key: str = "",
) -> Response:
    """优先读取已持久化的公开封面，再尝试本机连接器的临时地址。

    连接器凭据只会发送给精确匹配的回环地址，并且不跟随重定向，避免凭据
    被带到上游 CDN。数据库中的公开 CDN 地址本身不包含任何凭据。
    """
    for candidate in dict.fromkeys((fallback_url, target_url)):
        if not candidate:
            continue
        trusted_loopback = douyin_library.is_trusted_companion_url(candidate)
        if (
            not trusted_loopback
            and not platform_library_service.validated_douyin_image_target(candidate)
        ):
            continue
        cache_key = stable_cache_key or (
            f"douyin-sidecar:{session_scope}:{candidate}"
            if trusted_loopback
            else f"douyin-public:{candidate}"
        )
        cached = image_memory_cache.get(cache_key)
        if cached is not None:
            return Response(
                content=cached.content,
                media_type=cached.content_type,
                headers={
                    "Cache-Control": "private, max-age=1800, stale-while-revalidate=60",
                    "X-Content-Type-Options": "nosniff",
                    "X-Zhicui-Image-Cache": "hit",
                },
            )
        headers = {
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Encoding": "identity",
            "Referer": "https://www.douyin.com/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        }
        if trusted_loopback:
            headers.update(douyin_library.companion_headers(session_scope))
        response = None
        try:
            response = http_requests.get(
                candidate,
                headers=headers,
                stream=True,
                timeout=(2, 10) if trusted_loopback else (2, 8),
                allow_redirects=False,
            )
            if response.is_redirect or response.is_permanent_redirect:
                continue
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "image/jpeg").split(";", 1)[0]
            if not content_type.lower().startswith("image/"):
                continue
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _COVER_MAX_BYTES:
                    chunks = []
                    break
                chunks.append(chunk)
            image_bytes = b"".join(chunks)
            if not image_bytes:
                continue
            image_memory_cache.put(cache_key, content_type, image_bytes)
            return Response(
                content=image_bytes,
                media_type=content_type,
                headers={
                    "Cache-Control": "private, max-age=1800, stale-while-revalidate=60",
                    "X-Content-Type-Options": "nosniff",
                    "X-Zhicui-Image-Cache": "miss",
                },
            )
        except Exception:
            continue
        finally:
            if response is not None:
                response.close()
    return _cover_placeholder_response()


def _proxy_bilibili_image(target_url: str, *, stable_cache_key: str = "") -> Response:
    """Proxy one allowlisted Bilibili cover with the required source headers."""
    parsed = urlparse(target_url)
    hostname = (parsed.hostname or "").lower()
    allowed = hostname in {"hdslb.com", "biliimg.com"} or hostname.endswith(
        (".hdslb.com", ".biliimg.com")
    )
    if parsed.scheme not in {"http", "https"} or not allowed:
        return _cover_placeholder_response()

    cache_key = stable_cache_key or f"bilibili:{target_url}"
    cached = image_memory_cache.get(cache_key)
    if cached is not None:
        return Response(
            content=cached.content,
            media_type=cached.content_type,
            headers={
                "Cache-Control": "private, max-age=1800, stale-while-revalidate=60",
                "X-Content-Type-Options": "nosniff",
                "X-Zhicui-Image-Cache": "hit",
            },
        )
    try:
        response = http_requests.get(
            target_url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                "Referer": "https://www.bilibili.com/",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Encoding": "identity",
            },
            stream=True,
            timeout=(2, 10),
        )
        response.raise_for_status()
    except Exception:
        return _cover_placeholder_response()

    content_type = response.headers.get("Content-Type", "image/jpeg")
    if not content_type.lower().startswith("image/"):
        response.close()
        return _cover_placeholder_response()
    try:
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > _COVER_MAX_BYTES:
                return _cover_placeholder_response()
            chunks.append(chunk)
        image_bytes = b"".join(chunks)
    except Exception:
        return _cover_placeholder_response()
    finally:
        response.close()
    if not image_bytes:
        return _cover_placeholder_response()
    image_memory_cache.put(cache_key, content_type, image_bytes)
    return Response(
        content=image_bytes,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=1800, stale-while-revalidate=60",
            "X-Content-Type-Options": "nosniff",
            "X-Zhicui-Image-Cache": "miss",
        },
    )


def _proxy_short_lived_media(
    request: Request,
    target_url: str,
    request_headers: dict[str, str],
    *,
    platform: str,
    trusted_loopback: bool = False,
) -> StreamingResponse:
    """Stream one freshly resolved target without exposing or persisting it."""
    headers = {
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        **request_headers,
    }
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    current_url = target_url
    response = None
    try:
        for _ in range(4):
            if trusted_loopback:
                if not douyin_library.is_trusted_companion_url(current_url):
                    raise RuntimeError("unexpected media proxy target")
            elif not platform_library_service.validated_media_target(
                current_url,
                platform,
            ):
                raise RuntimeError("unsupported media target")
            response = http_requests.get(
                current_url,
                headers=headers,
                stream=True,
                timeout=(10, 600),
                allow_redirects=False,
            )
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("Location", "")
            response.close()
            response = None
            # Loopback companions must stream the bytes themselves. External
            # redirects are followed only while every hop stays allowlisted.
            if trusted_loopback or not location:
                raise RuntimeError("unexpected media redirect")
            current_url = urljoin(current_url, location)
        if response is None:
            raise RuntimeError("media response unavailable")
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "video/mp4").split(";", 1)[0]
        if not content_type.startswith(("video/", "audio/")) and content_type != "application/octet-stream":
            raise RuntimeError("unexpected media content type")
    except Exception as exc:
        if response is not None:
            response.close()
        raise HTTPException(
            status_code=502,
            detail="视频临时流读取失败，请重新获取播放地址",
        ) from exc

    response_headers = {
        "Cache-Control": "private, no-store",
        "Accept-Ranges": response.headers.get("Accept-Ranges", "bytes"),
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
    }
    for name in ("Content-Length", "Content-Range"):
        value = response.headers.get(name)
        if value:
            response_headers[name] = value

    def body():
        try:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    yield chunk
        finally:
            response.close()

    return StreamingResponse(
        body(),
        status_code=response.status_code,
        media_type=content_type,
        headers=response_headers,
    )


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class Envelope(BaseModel):
    """Standard response envelope."""
    success: bool
    data: Any = None
    error: str | None = None


class VideoURLRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


class ExtractRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


class PlatformLibraryImportRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=10)
    source_mode: Literal["collect", "like", "post"] | None = None

    @field_validator("urls")
    @classmethod
    def validate_urls(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values if value and value.strip()]
        if not cleaned:
            raise ValueError("请至少填写一条 B站或小红书链接")
        if len(cleaned) > platform_library_service.MAX_IMPORT_URLS:
            raise ValueError("每次最多导入 10 条链接")
        return cleaned


class LocalDouyinLibraryItemRequest(BaseModel):
    """Public metadata only; unknown or sensitive-looking fields are rejected."""

    model_config = ConfigDict(extra="forbid")

    video_id: str = Field(..., min_length=5, max_length=32)
    source_url: str = Field(..., min_length=20, max_length=512)
    title: str = Field(default="", max_length=500)
    caption: str = Field(default="", max_length=20_000)
    author_name: str = Field(default="", max_length=200)
    cover_url: str = Field(default="", max_length=2048)
    published_at: str | int | float = ""
    duration_seconds: int = Field(default=0, ge=0, le=86_400)
    source_rank: int | None = Field(default=None, ge=0, lt=100)


class LocalDouyinLibrarySyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_mode: Literal["collect", "like", "post"]
    items: list[LocalDouyinLibraryItemRequest] = Field(
        ...,
        min_length=1,
        max_length=100,
    )
    client_version: str = Field(default="", max_length=32)


class CreatorSourceRequest(BaseModel):
    platform: Literal["douyin", "bilibili", "xiaohongshu"]
    profile_ref: str = Field(..., min_length=1, max_length=1024)


class CreatorSyncRunRequest(BaseModel):
    operation: Literal[
        "recent_transcript", "catalog_all", "selected_transcript"
    ] | None = None
    limit: Literal[20, 50, 100] | None = None
    item_ids: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("item_ids")
    @classmethod
    def validate_creator_item_ids(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(
            str(value or "").strip() for value in values if str(value or "").strip()
        ))
        if any(len(value) > 48 for value in normalized):
            raise ValueError("作品标识格式无效")
        return normalized


class NoteChatHistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=1000)


class NoteAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=600)
    history: list[NoteChatHistoryItem] = Field(default_factory=list, max_length=6)
    research_scope: Literal["auto", "video_only"] = "auto"


class VisualAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=600)
    history: list[NoteChatHistoryItem] = Field(default_factory=list, max_length=6)


class LibraryCollectRequest(BaseModel):
    count: int = Field(
        default=50,
        ge=1,
        le=100,
        description="本次同步最近 1–100 条，最多 100 条",
    )
    mode: Literal["like", "post", "collect"] = "like"


class LibraryLoginRequest(BaseModel):
    browser: Literal["chromium", "firefox", "webkit"] = "chromium"


class LibraryHandoffCompleteRequest(BaseModel):
    token: str = Field(..., min_length=32, max_length=4096)
    cookies: dict[str, str]

    @field_validator("cookies")
    @classmethod
    def validate_cookies(cls, value: dict[str, str]) -> dict[str, str]:
        if not 1 <= len(value) <= 100:
            raise ValueError("登录 Cookie 数量无效")
        normalized: dict[str, str] = {}
        for raw_name, raw_value in value.items():
            name = str(raw_name or "").strip()
            cookie_value = str(raw_value or "")
            if not name or len(name) > 128 or len(cookie_value) > 8192:
                raise ValueError("登录 Cookie 格式无效")
            normalized[name] = cookie_value
        return normalized


class LibraryExtractRequest(BaseModel):
    aweme_id: str = Field(..., min_length=1, max_length=128)
    operation: Literal["transcript", "ai", "full"] = "full"
    ephemeral_media_url: str = Field(default="", max_length=8192)


class LibraryRemoveRequest(BaseModel):
    aweme_ids: list[str] = Field(..., min_length=1, max_length=50)
    mode: Literal["temporary", "permanent"] = "temporary"

    @field_validator("aweme_ids")
    @classmethod
    def validate_aweme_ids(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_id in value:
            aweme_id = str(raw_id or "").strip()
            if not 1 <= len(aweme_id) <= 128:
                raise ValueError("视频标识长度无效")
            if any(
                not (
                    character.isascii()
                    and (character.isalnum() or character in {"_", "-"})
                )
                for character in aweme_id
            ):
                raise ValueError("视频标识格式无效")
            if aweme_id not in seen:
                seen.add(aweme_id)
                normalized.append(aweme_id)
        if not normalized:
            raise ValueError("至少选择一条视频")
        return normalized


class LibraryBatchExtractRequest(LibraryRemoveRequest):
    """Start concurrent transcript/card generation for selected work IDs."""
    aweme_ids: list[str] = Field(..., min_length=1, max_length=100)
    operation: Literal["transcript", "ai", "full"] = "full"
    ephemeral_media_sources: list[dict[str, str]] = Field(
        default_factory=list,
        max_length=100,
    )


class LibraryAskRequest(BaseModel):
    note_ids: list[str] = Field(..., min_length=1, max_length=50)
    question: str = Field(..., min_length=1, max_length=600)
    history: list[NoteChatHistoryItem] = Field(default_factory=list, max_length=6)
    research_mode: Literal["auto", "fast", "deep"] = "auto"
    output_style: Literal[
        "answer", "summary", "comparison", "action_plan", "custom"
    ] = "answer"
    custom_instruction: str = Field(default="", max_length=600)
    web_scope: Literal["auto", "video_only"] = "video_only"


class PlanAgentRequest(BaseModel):
    instruction: str = Field(..., min_length=2, max_length=1000)


class ClientErrorRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    stack: str = Field(default="", max_length=16000)
    path: str = Field(default="", max_length=512)
    error_type: str = Field(default="ClientError", max_length=128)
    environment: Literal["web", "capacitor"] = "web"
    component: str = Field(default="", max_length=128)
    digest: str = Field(default="", max_length=128)


class FeedbackCreateRequest(BaseModel):
    category: Literal["bug", "suggestion", "content", "account", "other"]
    subject: str = Field(..., min_length=2, max_length=160)
    content: str = Field(..., min_length=5, max_length=2000)
    page_path: str = Field(default="", max_length=512)
    platform: Literal["web", "android", "capacitor"] = "web"
    user_agent: str = Field(default="", max_length=512)
    viewport: str = Field(default="", max_length=64)
    app_version: str = Field(default="", max_length=64)


class KnowledgeEntryCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    summary: str = Field(default="", max_length=4_000)
    content: str = Field(..., min_length=1, max_length=100_000)
    source_label: str = Field(default="", max_length=256)


class KnowledgeEntryUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    summary: str | None = Field(default=None, max_length=4_000)
    content: str | None = Field(default=None, min_length=1, max_length=100_000)
    source_label: str | None = Field(default=None, max_length=256)


class UserAIProviderRequest(BaseModel):
    mode: Literal["platform", "custom"] = "platform"
    provider_name: str = Field(default="OpenAI Compatible", max_length=80)
    model: str = Field(default="", max_length=160)
    api_base: str = Field(default="", max_length=512)
    api_key: str = Field(default="", max_length=4096)


class UserChatModelRequest(BaseModel):
    offering_id: str = Field(..., min_length=36, max_length=36)


class UserCustomChatModelCreateRequest(BaseModel):
    name: str = Field(default="OpenAI Compatible", max_length=80)
    provider_name: str = Field(default="OpenAI Compatible", max_length=80)
    model: str = Field(..., min_length=1, max_length=160)
    api_base: str = Field(..., min_length=1, max_length=512)
    api_key: str = Field(..., min_length=1, max_length=4096)
    enabled: bool = True
    select: bool = False


class UserCustomChatModelUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    provider_name: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=160)
    api_base: str | None = Field(default=None, min_length=1, max_length=512)
    api_key: str | None = Field(default=None, max_length=4096)
    enabled: bool | None = None


class AdminChatModelRequest(BaseModel):
    code: str = Field(..., min_length=2, max_length=80)
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="", max_length=300)
    provider_mode: Literal["platform", "omniroute"] = "platform"
    model_id: str = Field(..., min_length=1, max_length=160)
    enabled: bool = True
    visible_to_users: bool = True
    is_default: bool = False
    is_free: bool = False
    free_daily_limit: int = Field(default=0, ge=0, le=100_000)
    points_per_request: int = Field(default=0, ge=0, le=100_000_000)
    supports_images: bool = False
    supports_tools: bool = False
    sort_order: int = Field(default=100, ge=0, le=100_000)


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)
    username: str = Field(..., min_length=2, max_length=128)
    accepted_terms: bool = False
    accepted_privacy: bool = False
    terms_version: str = Field(default="", max_length=24)
    privacy_version: str = Field(default="", max_length=24)
    client_type: Literal["web", "windows", "macos", "android", "ios"] = "web"


class LoginRequest(BaseModel):
    # 登录只校验凭据是否填写；长度规则只属于注册和重置密码流程。
    email: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=128)


class DesktopHandoffRequest(BaseModel):
    # 桌面客户端本地生成的随机会话票据（32 字节 base64url）。
    session_id: str = Field(..., min_length=32, max_length=64)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: Any) -> dict:
    return {"success": True, "data": data, "error": None}


def _err(msg: str) -> dict:
    return {"success": False, "data": None, "error": msg}


def _save_generated_note(
    db: Session,
    video_info: dict[str, Any],
    transcript: str,
    ai_result: dict[str, Any],
    user_id: str,
) -> tuple[dict[str, Any], bool]:
    """Persist one generated note and its optional plan in a single code path."""
    ai_result = dict(ai_result)
    existing_source_meta = sanitized_source_meta(ai_result.get("source_meta"))
    platform = str(video_info.get("platform") or "").strip()
    ai_result["source_meta"] = {
        "source_kind": "single-link",
        "platform": platform,
        "source_url": str(video_info.get("source_url") or "").strip(),
        "media_type": str(video_info.get("media_type") or "video").strip(),
        "cover_url": str(video_info.get("cover_url") or video_info.get("thumbnail") or "").strip(),
        "author_name": str(video_info.get("author_name") or video_info.get("author") or "").strip(),
        "source_mode": "import",
        **existing_source_meta,
    }
    durable_video_info = dict(video_info)
    durable_video_info.pop("preview_media_url", None)
    durable_video_info.pop("preview_cover_url", None)
    note = note_service.create_note(
        db,
        durable_video_info,
        transcript,
        ai_result,
        user_id,
    )

    plan_id: str | None = None
    plan = ai_result.get("plan")
    if isinstance(plan, dict) and plan.get("tasks"):
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
        plan_obj = plan_service.create_plan(
            db=db,
            note_id=note.id,
            title=plan.get("goal") or note.video_title,
            user_id=user_id,
            fields=fields,
            tasks=tasks,
            total_days=total_days,
            days=plan.get("days") or [],
        )
        plan_id = plan_obj.id

    result = note.to_dict()
    result["plan_id"] = plan_id
    return result, plan_id is not None


# ---------------------------------------------------------------------------
# Content type display labels (for progress messages)
# ---------------------------------------------------------------------------

_TYPE_LABELS: dict[str, str] = {
    "recipe": "食谱",
    "insight": "洞察",
    "history": "历史",
    "product": "产品",
    "plan": "计划",
    "general": "通用知识",
}

_PLATFORM_LABELS: dict[str, str] = {
    "douyin": "抖音",
    "bilibili": "B站",
    "wechat": "微信公众号",
    "xiaohongshu": "小红书",
    "unknown": "未知平台",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/health")
def health_check() -> dict:
    """Simple liveness probe."""
    return _ok({"status": "ok", "service": "zhicui-knowbrew"})


@router.get("/api/app/releases/latest")
def latest_android_release(response: Response) -> dict:
    """Return public, cache-resistant Android release metadata."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    try:
        return _ok(app_release_service.get_latest_android_release())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Auth endpoints — email + password + JWT
# ---------------------------------------------------------------------------

def _auth_error_category(error: str | None) -> str:
    return {
        "账号不存在": "account_not_found",
        "密码错误": "invalid_password",
        "账号已被禁用": "inactive_account",
        "该邮箱已注册，请直接登录": "email_already_registered",
        "该用户名已被使用": "username_already_registered",
    }.get(str(error or ""), "validation_failed")


@router.post("/api/auth/register")
def auth_register(
    body: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    user, error = privacy_account_service.register_with_consent(
        db,
        email=body.email,
        password=body.password,
        username=body.username,
        accepted_terms=body.accepted_terms,
        accepted_privacy=body.accepted_privacy,
        terms_version=body.terms_version,
        privacy_version=body.privacy_version,
        client_type=body.client_type,
    )
    if error:
        activity_service.log_activity_safely(
            user_id=None,
            action="account_register",
            method="POST",
            path="/api/auth/register",
            status_code=400,
            ip=request.client.host if request.client else None,
            detail={
                "outcome": "failed",
                "error_category": _auth_error_category(error),
            },
        )
        return _err(error)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_register",
        method="POST",
        path="/api/auth/register",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={"outcome": "success"},
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/login")
def auth_login(
    body: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    token, user, error = auth_service.login(db, body.email, body.password)
    if error:
        activity_service.log_activity_safely(
            user_id=user.id if user is not None else None,
            action="account_login",
            method="POST",
            path="/api/auth/login",
            status_code=401,
            ip=request.client.host if request.client else None,
            detail={
                "outcome": "failed",
                "error_category": _auth_error_category(error),
            },
        )
        return _err(error)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_login",
        method="POST",
        path="/api/auth/login",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={"outcome": "success"},
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/dev-session", include_in_schema=False)
def auth_dev_session(request: Request, db: Session = Depends(get_db)) -> dict:
    """Issue a normal JWT only for explicitly enabled loopback development."""
    if not settings.DEV_AUTH_BYPASS:
        raise HTTPException(status_code=404, detail="Not Found")

    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="开发会话仅允许本机访问")

    user = auth_service.get_or_create_dev_user(db)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_dev_session",
        method="POST",
        path="/api/auth/dev-session",
        status_code=200,
        ip=request.client.host if request.client else None,
    )
    return _ok({"token": token, "user": user.to_dict()})


# ---------------------------------------------------------------------------
# 桌面端 ↔ Web 联动登录（一次性票据交接）
# 流程：客户端生成 session_id → 打开浏览器 /login?desktop=1&session=…
#      → 网页登录成功后 claim → 客户端轮询 status 换取 JWT
# ---------------------------------------------------------------------------

@router.post("/api/auth/desktop-handoff/request", include_in_schema=False)
def desktop_handoff_request(
    body: DesktopHandoffRequest,
    db: Session = Depends(get_db),
) -> dict:
    """客户端发起联动登录：登记一个 pending 票据。"""
    session_id = desktop_handoff_service.normalize_session_id(body.session_id)
    if session_id is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    handoff = desktop_handoff_service.create_handoff(db, session_id)
    if handoff is None:
        raise HTTPException(status_code=409, detail="该登录票据已存在，请重新发起")
    return _ok({"status": handoff.status, "expires_at": handoff.expires_at.isoformat()})


@router.post("/api/auth/desktop-handoff/claim", include_in_schema=False)
def desktop_handoff_claim(
    body: DesktopHandoffRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """网页登录成功后声明票据，把登录身份交接给客户端。"""
    session_id = desktop_handoff_service.normalize_session_id(body.session_id)
    if session_id is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    result = desktop_handoff_service.claim_handoff(db, session_id, current_user.id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="登录票据不存在或已过期")
    if result == "expired":
        raise HTTPException(status_code=410, detail="登录票据已过期，请返回客户端重新发起")
    if result == "already_consumed":
        raise HTTPException(status_code=409, detail="登录票据已被使用")
    if result == "already_claimed":
        raise HTTPException(status_code=409, detail="登录票据已被其他账号声明")
    return _ok({"status": "claimed"})


@router.get("/api/auth/desktop-handoff/status/{session_id}", include_in_schema=False)
def desktop_handoff_status(
    session_id: str,
    db: Session = Depends(get_db),
) -> dict:
    """客户端轮询：pending → 继续等待；claimed → 签发 JWT 并消费票据。"""
    normalized = desktop_handoff_service.normalize_session_id(session_id)
    if normalized is None:
        raise HTTPException(status_code=400, detail="登录票据格式不正确")
    desktop_handoff_service.expire_stale(db)
    status, user_id = desktop_handoff_service.consume_handoff(db, normalized)
    if status == "not_found":
        return _err("登录票据不存在或已过期")
    if status == "pending":
        return _ok({"status": "pending"})
    if status in {"expired", "consumed"}:
        return _err("登录票据已过期或已被使用，请返回客户端重新发起")
    # status == "success"
    user = get_user_by_id(db, user_id) if user_id else None
    if user is None:
        return _err("登录用户不存在，请返回客户端重新发起")
    token = auth_service.create_access_token(user.id, user.email)
    return _ok({
        "status": "success",
        "token": token,
        "user": user.to_dict(),
    })


@router.get("/api/auth/me")
def auth_me(
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(current_user.to_dict())


@router.post("/api/client-errors")
def report_client_error(
    body: ClientErrorRequest,
    request: Request,
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Accept bounded runtime diagnostics from authenticated app clients."""
    error_log_service.record_error_safely(
        source="frontend",
        severity="error",
        error_type=body.error_type,
        message=body.message,
        traceback=body.stack or None,
        method="CLIENT",
        path=body.path,
        user_id=current_user.id,
        ip=request.client.host if request.client else None,
        metadata={
            "environment": body.environment,
            "component": body.component,
            "digest": body.digest,
        },
    )
    return _ok({"accepted": True})


@router.post("/api/feedback")
def submit_feedback(
    body: FeedbackCreateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """提交有边界的文字反馈，不接收文件、页面正文或认证信息。"""
    if len(body.subject.strip()) < 2:
        raise HTTPException(status_code=400, detail="反馈主题至少 2 个字符")
    if len(body.content.strip()) < 5:
        raise HTTPException(status_code=400, detail="请再具体描述一下问题或建议")
    if feedback_service.recent_submission_count(db, user_id=current_user.id) >= 5:
        raise HTTPException(status_code=429, detail="提交得有点频繁，请 10 分钟后再试")

    feedback = feedback_service.create_feedback(
        db,
        user_id=current_user.id,
        category=body.category,
        subject=body.subject,
        content=body.content,
        page_path=body.page_path,
        client_context={
            "platform": body.platform,
            "user_agent": body.user_agent,
            "viewport": body.viewport,
            "app_version": body.app_version,
        },
    )
    return _ok(feedback_service.to_dict(feedback))


@router.get("/api/feedback")
def list_my_feedback(
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    items, total = feedback_service.list_user_feedback(
        db,
        user_id=current_user.id,
        page=page,
        per_page=per_page,
    )
    return _ok({
        "items": [feedback_service.to_dict(item) for item in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.post("/api/video/info")
def get_video_info(
    body: VideoURLRequest,
    current_user: UserModel = Depends(get_current_user_optional),
) -> dict:
    """Parse a video link and return metadata without downloading."""
    try:
        source_url = video_extractor.normalize_share_url(body.url)
        info = video_extractor.parse_video_info(source_url)
        return _ok(info)
    except Exception as exc:
        if not isinstance(exc, (video_extractor.VideoExtractionError, NotImplementedError)):
            traceback.print_exc()
        return _err(_safe_video_parse_error(exc))


@router.post("/api/extract")
def extract(
    body: ExtractRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Full pipeline: parse -> transcribe -> AI -> save -> return note."""
    try:
        source_url = video_extractor.normalize_share_url(body.url)
        platform = _detect_platform(source_url)

        # ── Xiaohongshu path: note content IS the transcript ──────────────
        if platform == "xiaohongshu":
            from app.services.xhs_extractor import parse_xhs_note, extract_xhs_content
            import os as _os
            cookie = _os.environ.get('XHS_COOKIE', '')
            note_data = parse_xhs_note(source_url, cookie=cookie)
            video_info = {
                "video_id": note_data.get("note_id", ""),
                "title": note_data.get("title", "小红书笔记"),
                "download_url": "",
                "source_url": source_url,
                "media_type": note_data.get("type") or "image",
                "platform": "xiaohongshu",
            }
            transcript = extract_xhs_content(source_url, cookie=cookie)

            if not transcript or not transcript.strip():
                return _err("未能从小红书笔记中提取到文本内容。")

            # AI processing -- mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            result, _ = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
            return _ok(result)

        # ── WeChat path: article content IS the transcript ──────────────
        if platform == "wechat":
            article = extract_wechat_article(source_url)
            video_info = {
                "video_id": article["video_id"],
                "title": article["title"],
                "download_url": article["download_url"],
                "source_url": source_url,
                "platform": "wechat",
            }
            transcript = article["content"]

            if not transcript or not transcript.strip():
                return _err("未能从微信公众号文章中提取到文本内容。")

            # AI processing — mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            result, _ = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
            return _ok(result)

        # ── Video path (Douyin / Bilibili) ──────────────────────────────
        # 1. Parse video metadata
        sidecar_media_url = ""
        sidecar_media_headers: dict[str, str] | None = None
        try:
            video_info = video_extractor.parse_video_info(source_url)
        except video_extractor.VideoMetadataUnavailableError as exc:
            recovery = (
                _recover_bound_douyin_video(
                    db,
                    user_id=current_user.id,
                    error=exc,
                )
                if platform == "douyin"
                else None
            )
            if recovery is None:
                raise
            video_info, sidecar_media_url, sidecar_media_headers = recovery
        video_info.setdefault("source_url", source_url)
        video_info.setdefault("platform", platform)

        # 2. Extract transcript (with fallback)
        transcript = None

        # Try primary ASR (SiliconFlow/DashScope) — config from DB (admin-tunable)
        asr_cfg = settings_service.get_asr_config(db)
        if sidecar_media_url:
            try:
                transcript = video_extractor.extract_media_url_transcript(
                    sidecar_media_url,
                    asr_cfg["api_key"],
                    asr_cfg["api_base_url"],
                    asr_cfg["model"],
                    request_headers=sidecar_media_headers,
                )
            except Exception:
                traceback.print_exc()
                return _err(
                    "已通过绑定账号找到该作品，但视频流暂时无法读取。"
                    "请稍后重试，暂时不要连续解析。"
                )
        elif asr_cfg["api_key"]:
            try:
                transcript = video_extractor.extract_transcript(
                    source_url,
                    asr_cfg["api_key"],
                    asr_cfg["api_base_url"],
                    asr_cfg["model"],
                    video_info=video_info,
                )
            except Exception:
                traceback.print_exc()
                # Fall through to local ASR

        # Fallback: local yt-dlp + faster-whisper
        if not sidecar_media_url and (not transcript or not transcript.strip()):
            try:
                transcript = video_extractor.fallback_local_asr(
                    source_url,
                    video_info=video_info,
                )
            except Exception:
                traceback.print_exc()
                return _err("语音识别失败，请稍后重试或检查视频链接。")

        # 3. AI processing — mini agent chain
        use_images = False
        if not transcript or not transcript.strip():
            # Try image-based extraction as fallback
            video_url = video_info.get("download_url") or video_info.get("url", "")
            frames = ai_juicer.extract_video_frames(video_url)
            if frames:
                ai_result = ai_juicer.generate_card_from_images(
                    frames, video_info["title"],
                )
                if ai_result:
                    use_images = True
                    transcript = "[no audio transcript — analysed from video frames]"
                else:
                    return _err("未能从视频中提取到文本内容，截图分析也失败了。")
            else:
                return _err("未能从视频中提取到文本内容。")

        if not use_images:
            # Mini Agent 1: classify intent
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            # Mini Agent 2: generate plan (if applicable)
            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            # Mini Agent 3: generate card
            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            # Attach plan data to ai_result for persistence
            if plan_data:
                ai_result["plan"] = plan_data

        result, _ = _save_generated_note(
            db, video_info, transcript, ai_result, current_user.id,
        )
        return _ok(result)

    except (video_extractor.VideoExtractionError, NotImplementedError) as exc:
        return _err(str(exc))
    except Exception:
        # Log the full traceback on the server for debugging.
        traceback.print_exc()
        return _err("处理暂时失败，请稍后重试。")


@router.get("/api/extract/stream")
def extract_stream(
    url: str = Query(..., min_length=1, description="Douyin share link"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
):
    """Full pipeline with SSE progress events.

    Returns ``text/event-stream`` with one event per pipeline step.
    Each event is a JSON line::

        data: {"step":"parse","message":"...","status":"active"}

    Final event has ``step: "done"`` with ``data`` containing the note.
    """
    def _event(step: str, message: str, status: str = "active", data: Any = None) -> str:
        payload: dict[str, Any] = {"step": step, "message": message, "status": status}
        if data is not None:
            payload["data"] = data
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def _generate():
        started_at = time.monotonic()

        def _progress(
            step: str,
            message: str,
            status: str = "active",
            data: dict[str, Any] | None = None,
        ) -> str:
            event_data: dict[str, Any] = {**(data or {})}
            event_data.setdefault("elapsed_ms", int((time.monotonic() - started_at) * 1000))
            return _event(step, message, status, event_data)

        try:
            source_url = video_extractor.normalize_share_url(url)
            platform = _detect_platform(source_url)
            yield _progress(
                "parse",
                f"已识别平台：{_PLATFORM_LABELS.get(platform, platform)}",
                "active",
                {"phase": "platform_detected", "platform": platform},
            )

            # ═══ WeChat path: article content IS the transcript ═══════════
            if platform == "wechat":
                yield _event("parse", "正在获取微信公众号文章...", "active")
                article = extract_wechat_article(source_url)
                video_info = {
                    "video_id": article["video_id"],
                    "title": article["title"],
                    "download_url": article["download_url"],
                    "source_url": source_url,
                    "platform": "wechat",
                }
                transcript = article["content"]
                yield _event("parse", f"文章获取完成：{video_info.get('title', '未知标题')}", "done")

                if not transcript or not transcript.strip():
                    yield _event("transcribe", "未能从微信公众号文章中提取到文本内容", "error")
                    yield _event("error", "未能从微信公众号文章中提取到文本内容。", "error")
                    return

                char_count = len(transcript)
                yield _event("transcribe", f"文章文本提取完成，共 {char_count} 字", "done")

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

                # Save to database
                yield _event("save", "正在保存笔记...", "active")
                result, plan_created = _save_generated_note(
                    db, video_info, transcript, ai_result, current_user.id,
                )
                yield _event("save", "保存成功", "done")

                if plan_created:
                    yield _event("plan", "已为文章中的计划自动建立任务清单", "done")

                yield _event("done", "提取完成", "done", result)
                return

            # ═══ Video path (Douyin / Bilibili) ════════════════════════════
            # Step 1: Parse video metadata
            yield _progress(
                "parse",
                "正在解析视频链接...",
                "active",
                {"phase": "parse_start", "platform": platform},
            )
            sidecar_media_url = ""
            sidecar_media_headers: dict[str, str] | None = None
            recovered_from_binding = False
            try:
                try:
                    video_info = video_extractor.parse_video_info(source_url)
                except video_extractor.VideoMetadataUnavailableError as exc:
                    recovery = (
                        _recover_bound_douyin_video(
                            db,
                            user_id=current_user.id,
                            error=exc,
                        )
                        if platform == "douyin"
                        else None
                    )
                    if recovery is None:
                        raise
                    video_info, sidecar_media_url, sidecar_media_headers = recovery
                    recovered_from_binding = True
                video_info.setdefault("source_url", source_url)
                video_info.setdefault("platform", platform)
                yield _progress(
                    "parse",
                    (
                        f"已通过绑定的抖音账号读取：{video_info.get('title', '未知标题')}"
                        if recovered_from_binding
                        else f"解析完成：{video_info.get('title', '未知标题')}"
                    ),
                    "done",
                    {
                        "phase": "parse_done",
                        "platform": platform,
                        "source": (
                            "douyin-sidecar"
                            if recovered_from_binding
                            else "public-page"
                        ),
                        "video": _safe_extraction_video_preview(
                            video_info,
                            source_url=source_url,
                            platform=platform,
                        ),
                    },
                )
            except (video_extractor.VideoExtractionError, NotImplementedError) as exc:
                message = _safe_video_parse_error(exc)
                yield _progress("parse", message, "error", {"phase": "parse_error", "platform": platform})
                yield _progress("error", message, "error", {"phase": "fatal_error", "platform": platform})
                return
            except Exception:
                traceback.print_exc()
                message = "视频链接暂时无法解析，请检查链接是否正确，稍后重试。"
                yield _progress("parse", message, "error", {"phase": "parse_error", "platform": platform})
                yield _progress("error", message, "error", {"phase": "fatal_error", "platform": platform})
                return

            # Step 2: Extract transcript
            yield _progress(
                "transcribe",
                "正在准备语音识别配置...",
                "active",
                {"phase": "asr_prepare", "platform": platform},
            )
            transcript: str | None = None

            asr_cfg = settings_service.get_asr_config(db)
            remote_asr_started = time.monotonic()
            if sidecar_media_url:
                try:
                    yield _progress(
                        "transcribe",
                        "正在通过已绑定的抖音账号读取视频并提取文案...",
                        "active",
                        {
                            "phase": "sidecar_asr_start",
                            "platform": platform,
                            "provider": "douyin-sidecar",
                        },
                    )
                    transcript = video_extractor.extract_media_url_transcript(
                        sidecar_media_url,
                        asr_cfg["api_key"],
                        asr_cfg["api_base_url"],
                        asr_cfg["model"],
                        request_headers=sidecar_media_headers,
                    )
                    yield _progress(
                        "transcribe",
                        f"文案提取完成，共 {len(transcript or '')} 字",
                        "active",
                        {
                            "phase": "sidecar_asr_done",
                            "platform": platform,
                            "provider": "douyin-sidecar",
                            "duration_ms": int(
                                (time.monotonic() - remote_asr_started) * 1000
                            ),
                            "transcript_chars": len(transcript or ""),
                        },
                    )
                except Exception:
                    traceback.print_exc()
                    message = (
                        "已通过绑定账号找到该作品，但视频流暂时无法读取。"
                        "请稍后重试，暂时不要连续解析。"
                    )
                    yield _progress(
                        "transcribe",
                        message,
                        "error",
                        {
                            "phase": "sidecar_asr_error",
                            "platform": platform,
                            "provider": "douyin-sidecar",
                        },
                    )
                    yield _progress(
                        "error",
                        message,
                        "error",
                        {"phase": "fatal_error", "platform": platform},
                    )
                    return
            elif asr_cfg["api_key"]:
                try:
                    yield _progress(
                        "transcribe",
                        f"正在使用云端 ASR（{asr_cfg['model']}）识别音频，长视频可能需要数分钟...",
                        "active",
                        {
                            "phase": "remote_asr_start",
                            "platform": platform,
                            "provider": "siliconflow",
                            "model": asr_cfg["model"],
                        },
                    )
                    transcript = video_extractor.extract_transcript(
                        source_url,
                        asr_cfg["api_key"],
                        asr_cfg["api_base_url"],
                        asr_cfg["model"],
                        video_info=video_info,
                    )
                    if transcript and transcript.strip():
                        yield _progress(
                            "transcribe",
                            f"云端 ASR 完成，共 {len(transcript)} 字",
                            "active",
                            {
                                "phase": "remote_asr_done",
                                "platform": platform,
                                "provider": "siliconflow",
                                "model": asr_cfg["model"],
                                "duration_ms": int((time.monotonic() - remote_asr_started) * 1000),
                                "transcript_chars": len(transcript),
                            },
                        )
                    else:
                        yield _progress(
                            "transcribe",
                            "云端 ASR 未返回有效文本，正在切换本地识别...",
                            "active",
                            {
                                "phase": "remote_asr_empty",
                                "platform": platform,
                                "provider": "siliconflow",
                                "fallback": True,
                                "level": "warning",
                            },
                        )
                except Exception:
                    traceback.print_exc()
                    yield _progress(
                        "transcribe",
                        "云端 ASR 暂未成功，正在切换本地识别...",
                        "active",
                        {
                            "phase": "remote_asr_error",
                            "platform": platform,
                            "provider": "siliconflow",
                            "fallback": True,
                            "level": "warning",
                            "duration_ms": int((time.monotonic() - remote_asr_started) * 1000),
                        },
                    )
            else:
                yield _progress(
                    "transcribe",
                    "未配置云端 ASR，将直接使用本地识别...",
                    "active",
                    {
                        "phase": "remote_asr_skipped",
                        "platform": platform,
                        "fallback": True,
                        "level": "warning",
                    },
                )

            if not sidecar_media_url and (not transcript or not transcript.strip()):
                try:
                    local_asr_started = time.monotonic()
                    yield _progress(
                        "transcribe",
                        "本地语音识别启动：正在下载视频并提取音频，长视频请耐心等待...",
                        "active",
                        {
                            "phase": "local_asr_start",
                            "platform": platform,
                            "provider": "local",
                            "fallback": True,
                        },
                    )
                    transcript = video_extractor.fallback_local_asr(
                        source_url,
                        video_info=video_info,
                    )
                    if transcript and transcript.strip():
                        yield _progress(
                            "transcribe",
                            f"本地 ASR 完成，共 {len(transcript)} 字",
                            "active",
                            {
                                "phase": "local_asr_done",
                                "platform": platform,
                                "provider": "local",
                                "fallback": True,
                                "duration_ms": int((time.monotonic() - local_asr_started) * 1000),
                                "transcript_chars": len(transcript),
                            },
                        )
                except Exception:
                    traceback.print_exc()
                    yield _progress(
                        "transcribe",
                        "文案提取失败，请稍后重试或检查视频链接。",
                        "error",
                        {"phase": "local_asr_error", "platform": platform, "provider": "local"},
                    )
                    yield _progress(
                        "error",
                        "语音识别失败，请稍后重试或检查视频链接。",
                        "error",
                        {"phase": "fatal_error", "platform": platform},
                    )
                    return

            use_images = False
            if not transcript or not transcript.strip():
                # Try image-based extraction
                video_url = video_info.get("download_url") or video_info.get("url", "")
                yield _progress(
                    "ai",
                    "未识别到音频文本，正在尝试截图分析...",
                    "active",
                    {"phase": "image_fallback_start", "platform": platform, "fallback": True},
                )
                frames = ai_juicer.extract_video_frames(video_url)
                if frames:
                    yield _progress(
                        "ai",
                        f"已抽取 {len(frames)} 张关键帧，正在进行视觉分析...",
                        "active",
                        {"phase": "image_frames_done", "platform": platform, "fallback": True},
                    )
                    ai_result = ai_juicer.generate_card_from_images(frames, video_info["title"])
                    if ai_result:
                        use_images = True
                        transcript = "[no audio — analysed from video frames]"
                        yield _progress(
                            "transcribe",
                            f"截图分析完成，共 {len(frames)} 张",
                            "done",
                            {"phase": "image_fallback_done", "platform": platform, "fallback": True},
                        )
                    else:
                        yield _progress("transcribe", "未能从视频中提取到文本内容", "error", {"phase": "image_fallback_error", "platform": platform})
                        yield _progress("error", "未能从视频中提取到文本内容，截图分析也失败。", "error", {"phase": "fatal_error", "platform": platform})
                        return
                else:
                    yield _progress("transcribe", "未能从视频中提取到文本内容", "error", {"phase": "no_transcript", "platform": platform})
                    yield _progress("error", "未能从视频中提取到文本内容。", "error", {"phase": "fatal_error", "platform": platform})
                    return

            if not use_images:
                char_count = len(transcript)
                yield _progress(
                    "transcribe",
                    f"文案提取完成，共 {char_count} 字",
                    "done",
                    _transcript_progress_payload(transcript, platform=platform),
                )

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

            # Step 4: Save to database
            yield _event("save", "正在保存笔记...", "active")
            result, plan_created = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
            yield _event("save", "保存成功", "done")

            if plan_created:
                yield _event("plan", "已为视频中的计划自动建立任务清单", "done")

            yield _event("done", "提取完成", "done", result)

        except (video_extractor.VideoExtractionError, NotImplementedError) as exc:
            yield _event("error", _safe_video_parse_error(exc), "error")
        except Exception:
            traceback.print_exc()
            yield _event("error", "处理暂时失败，请稍后重试。", "error")

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Bilibili / Xiaohongshu video-library imports
# ---------------------------------------------------------------------------

# Cross-platform imports live on the primary router so every documented
# backend entry point exposes the same Bilibili/Xiaohongshu API surface.
@router.post("/api/library/imports")
def import_platform_library_items(
    body: PlatformLibraryImportRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Import up to ten Bilibili/Xiaohongshu links without implicit LLM work."""
    try:
        result = platform_library_service.import_many(
            db,
            user_id=current_user.id,
            values=body.urls,
            source_mode=body.source_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/api/library/imports")
def list_platform_library_items(
    platform: Literal["all", "bilibili", "xiaohongshu"] = Query("all"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    notes = platform_library_service.list_notes(
        db, user_id=current_user.id, platform=platform,
    )
    return _ok({
        # 列表首屏只需要封面、标题与处理状态。完整 Note（含文稿和 AI
        # 结果）在打开详情时按需读取，避免把数十万字节塞进每次资料页请求。
        "items": [
            platform_library_service.serialize_item(note, include_note=False)
            for note in notes
        ],
        "total": len(notes),
    })


@router.get("/api/library/imports/{note_id}/cover", include_in_schema=False)
def stream_platform_library_cover(
    note_id: str = Path(..., min_length=1, max_length=128),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    db: Session = Depends(get_db),
):
    """Serve an imported Bilibili cover without exposing upstream hotlinking."""
    if not platform_library_service.verify_cover_signature(
        note_id, expires, signature,
    ):
        raise HTTPException(status_code=403, detail="视频封面地址已失效，请刷新页面")
    note = db.query(Note).filter(Note.id == note_id).first()
    if note is None:
        raise HTTPException(status_code=404, detail="视频封面不存在")
    target_url = platform_library_service.cover_target(db, note_id)
    if not target_url:
        raise HTTPException(status_code=404, detail="视频封面不存在")
    if platform_library_service.media_platform(note) == "douyin":
        return _proxy_douyin_image(
            "",
            "",
            fallback_url=target_url,
            stable_cache_key=f"platform-cover:{note_id}",
        )
    return _proxy_bilibili_image(
        target_url,
        stable_cache_key=f"platform-cover:{note_id}",
    )


@router.get("/api/library/imports/{note_id}/media", include_in_schema=False)
def stream_platform_library_media(
    request: Request,
    note_id: str = Path(..., min_length=1, max_length=128),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    db: Session = Depends(get_db),
):
    """Serve a short-lived owned-Note capability usable by a native <video>."""
    if not platform_library_service.verify_media_signature(
        note_id,
        expires,
        signature,
    ):
        raise HTTPException(status_code=403, detail="视频播放地址已失效，请重新读取")
    note = db.query(Note).filter(Note.id == note_id).first()
    if note is None:
        raise HTTPException(status_code=404, detail="视频资料不存在")
    platform = platform_library_service.media_platform(note)
    if platform == "douyin":
        binding = douyin_binding_service.get_by_user(db, note.user_id)
        if binding is not None:
            try:
                return _proxy_short_lived_media(
                    request,
                    douyin_library.companion_media_url(note.video_id),
                    douyin_library.companion_headers(binding.session_scope),
                    platform="douyin",
                    trusted_loopback=True,
                )
            except HTTPException as exc:
                if exc.status_code != 502:
                    raise
                # Bound account metadata remains useful even if its local
                # companion restarted. Fall back to a fresh public resolver.
                pass
    try:
        target_url, media_headers = platform_library_service.resolve_media_target(note)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="视频播放地址暂时无法刷新，请稍后重试",
        ) from exc
    if not target_url:
        raise HTTPException(status_code=404, detail="这个作品暂时没有可播放的视频")
    return _proxy_short_lived_media(
        request,
        target_url,
        media_headers,
        platform=platform,
    )


@router.get("/api/library/imports/{note_id}")
def get_platform_library_item(
    note_id: str,
    refresh_media: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    workspace = platform_library_service.get_workspace(
        db,
        user_id=current_user.id,
        note_id=note_id,
        refresh_media=refresh_media,
    )
    if workspace is None:
        raise HTTPException(status_code=404, detail="视频资料不存在")
    return _ok(workspace)


@router.post("/api/library/imports/{note_id}/initialize")
def initialize_platform_library_item(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        note, reused = platform_library_service.initialize_ai(
            db, user_id=current_user.id, note_id=note_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=502, detail="摘要笔记生成失败，请稍后重试") from exc
    return _ok({"note": note.to_dict(), "already_existed": reused})


@router.delete("/api/library/imports/{note_id}")
def delete_platform_library_item(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    deleted = platform_library_service.delete_import(
        db, user_id=current_user.id, note_id=note_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="视频资料不存在")
    return _ok({"deleted": True, "database_media_deleted": False})


# ---------------------------------------------------------------------------
# Douyin batch library endpoints
# ---------------------------------------------------------------------------

@router.get("/api/library/douyin/status")
def get_douyin_library_status(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Report whether the optional local downloader is ready."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    status = douyin_library.connection_status(binding.session_scope)
    if status["connected"]:
        douyin_binding_service.update_connection(
            db,
            binding,
            connected=bool(status["cookie_valid"]),
            cookie_count=int(status["cookie_count"]),
        )
    status["binding"] = binding.safe_dict()
    return _ok(status)


@router.post("/api/library/douyin/login")
def start_douyin_library_login(
    body: LibraryLoginRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Open Chrome only when the connector is visible on this desktop."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        connection = douyin_library.connection_status(binding.session_scope)
        if connection.get("login_browser_mode") != "visible_chrome":
            raise HTTPException(
                status_code=409,
                detail=(
                    "异地服务器二维码已停用。请在这台电脑启动本地连接器，"
                    "再使用本机 Chrome 完成抖音绑定。"
                ),
            )
        current = douyin_library.login_status(binding.session_scope)
        if current["running"]:
            return _ok({**current, "started": False})
        result = douyin_library.start_login(binding.session_scope, body.browser)
        douyin_binding_service.mark_login_pending(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/logout")
def logout_douyin_library(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Clear the companion login session without deleting library data."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.clear_session(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/rebind")
def rebind_douyin_library(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Clear the current session before the client starts a new QR login."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.clear_session(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/local-handoff")
def create_douyin_local_handoff(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Issue a short-lived handoff for a connector on the user's computer."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    token = douyin_library.create_local_handoff_token(
        binding.id,
        current_user.id,
        binding.session_scope,
    )
    douyin_binding_service.mark_login_pending(db, binding)
    return _ok(
        {
            "token": token,
            "connector_url": "http://127.0.0.1:9000/api/v1/local-handoff",
            "expires_in": 600,
        }
    )


@router.post("/api/library/douyin/local-handoff/complete")
def complete_douyin_local_handoff(
    body: LibraryHandoffCompleteRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Accept a local Chrome result and forward it to the scoped sidecar."""
    payload = douyin_library.verify_local_handoff_token(body.token)
    if payload is None:
        raise HTTPException(status_code=401, detail="本机登录交接已失效，请重新发起")
    binding = douyin_binding_service.get_by_id(db, str(payload["binding_id"]))
    if (
        binding is None
        or binding.user_id != str(payload["user_id"])
        or binding.session_scope != str(payload["session_scope"])
    ):
        raise HTTPException(status_code=403, detail="本机登录交接与当前账号不匹配")
    try:
        result = douyin_library.import_session_cookies(
            binding.session_scope,
            body.cookies,
        )
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not result.get("valid"):
        douyin_binding_service.mark_disconnected(db, binding)
        raise HTTPException(status_code=400, detail="抖音未返回真实登录会话，请重新扫码")
    transition_token = (
        binding.updated_at.isoformat()
        if binding.updated_at is not None
        else binding.id
    )
    douyin_binding_service.update_connection(
        db,
        binding,
        connected=True,
        cookie_count=int(result.get("count") or 0),
    )
    activity_service.log_activity_safely(
        user_id=binding.user_id,
        action="douyin_connected",
        method="POST",
        path="/api/library/douyin/local-handoff/complete",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={
            "outcome": "connected",
            "binding_method": "local_handoff",
        },
        event_key=f"douyin-connected:{binding.id}:{transition_token}",
    )
    return _ok(
        {
            "connected": True,
            "cookie_count": int(result.get("count") or 0),
        }
    )


@router.get("/api/library/douyin/login")
def get_douyin_library_login(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return QR-login progress without exposing cookie values."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        state = douyin_library.login_status(binding.session_scope)
        state["cookie_valid"] = False
        state["cookie_count"] = 0
        if state["authenticated"] or not state["running"]:
            connection = douyin_library.connection_status(binding.session_scope)
            if connection["connected"]:
                was_connected = binding.status == "connected"
                transition_token = (
                    binding.updated_at.isoformat()
                    if binding.updated_at is not None
                    else binding.id
                )
                douyin_binding_service.update_connection(
                    db,
                    binding,
                    connected=bool(connection["cookie_valid"]),
                    cookie_count=int(connection["cookie_count"]),
                )
                if connection["cookie_valid"] and not was_connected:
                    activity_service.log_activity_safely(
                        user_id=current_user.id,
                        action="douyin_connected",
                        method="GET",
                        path="/api/library/douyin/login",
                        status_code=200,
                        ip=request.client.host if request.client else None,
                        detail={
                            "outcome": "connected",
                            "binding_method": "visible_chrome",
                        },
                        event_key=(
                            f"douyin-connected:{binding.id}:{transition_token}"
                        ),
                    )
            state["cookie_valid"] = bool(connection["cookie_valid"])
            state["cookie_count"] = int(connection["cookie_count"])
        return _ok(state)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/api/library/douyin/login")
def cancel_douyin_library_login(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Cancel only this user's transient browser login task."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.cancel_login(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/api/library/douyin/login/qr")
def get_douyin_library_login_qr(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Proxy the QR image without exposing the companion to the public."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        return _ok(douyin_library.login_qr(binding.session_scope))
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/collect")
def collect_douyin_library(
    body: LibraryCollectRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Ask the companion to refresh the user's Douyin collection."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        job = douyin_library.trigger_collect(
            binding.session_scope,
            body.count,
            body.mode,
        )
        douyin_binding_service.mark_sync_started(db, binding)
    except douyin_library.DouyinLibraryError as exc:
        error_status = 409 if exc.code in {
            "argus_uifid_missing",
            "risk_controlled",
            "verification_required",
            "session_expired",
        } else 502
        activity_service.log_activity_safely(
            user_id=current_user.id,
            action="douyin_sync_failed",
            method="POST",
            path="/api/library/douyin/collect",
            status_code=error_status,
            ip=request.client.host if request.client else None,
            detail={
                "outcome": "failed",
                "error_category": exc.code,
                "source_mode": exc.source_mode or body.mode,
                "requested_count": body.count,
                "needs_action": exc.needs_action,
                "retry_after_seconds": exc.retry_after_seconds,
            },
        )
        raise HTTPException(
            status_code=error_status,
            detail={
                "code": exc.code,
                "message": str(exc),
                "needs_action": exc.needs_action,
                "source_mode": exc.source_mode or body.mode,
                "retry_after_seconds": exc.retry_after_seconds,
            },
        ) from exc
    job_id = str(job.get("job_id") or "").strip()
    activity_service.log_activity_safely(
        user_id=current_user.id,
        action="douyin_sync",
        method="POST",
        path="/api/library/douyin/collect",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={
            "outcome": "started",
            "source_mode": body.mode,
            "requested_count": body.count,
            "job_id": job_id,
        },
        event_key=(
            f"douyin-sync:{current_user.id}:{job_id}:started"
            if job_id
            else None
        ),
    )
    return _ok(job)


@router.post("/api/library/douyin/local-sync")
def ingest_local_douyin_library(
    body: LocalDouyinLibrarySyncRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Accept bounded public metadata discovered by the Windows client."""
    try:
        result = local_douyin_library_service.ingest_items(
            db,
            user_id=current_user.id,
            source_mode=body.source_mode,
            items=[item.model_dump() for item in body.items],
        )
    except ValueError as exc:
        activity_service.log_activity_safely(
            user_id=current_user.id,
            action="douyin_local_sync_failed",
            method="POST",
            path="/api/library/douyin/local-sync",
            status_code=422,
            ip=request.client.host if request.client else None,
            detail={
                "outcome": "rejected",
                "source_mode": body.source_mode,
                "requested_count": len(body.items),
                "client_version": body.client_version,
            },
        )
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    activity_service.log_activity_safely(
        user_id=current_user.id,
        action="douyin_local_sync",
        method="POST",
        path="/api/library/douyin/local-sync",
        status_code=200,
        ip=request.client.host if request.client else None,
        detail={
            "outcome": "completed",
            "source_mode": result["source_mode"],
            "accepted": result["accepted"],
            "created": result["created"],
            "reused": result["reused"],
            "ready": result["ready"],
            "quarantined": result["quarantined"],
            "client_version": body.client_version,
            "channel": "desktop-local",
        },
    )
    return _ok(result)


@router.get("/api/library/douyin/jobs/{job_id}")
def get_douyin_library_job(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return one downloader collection job."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        job = douyin_library.get_job(binding.session_scope, job_id)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    restored = 0
    ledger_synced = 0
    ledger_warning = ""
    if job.get("status") == "success":
        raw_finished_at = job.get("finished_at")
        completed_at: datetime | None = None
        if isinstance(raw_finished_at, (int, float)):
            completed_at = datetime.fromtimestamp(
                raw_finished_at,
                tz=timezone.utc,
            )
        elif isinstance(raw_finished_at, str) and raw_finished_at.strip():
            try:
                completed_at = datetime.fromisoformat(
                    raw_finished_at.strip().replace("Z", "+00:00")
                )
            except ValueError:
                completed_at = None
        if completed_at is not None:
            restored = library_hidden_service.clear_temporary_hidden(
                db,
                current_user.id,
                completed_at,
            )
        source_mode = video_source_ledger_service.normalize_source_mode(
            job.get("mode")
        )
        try:
            sync_count = min(
                100,
                max(
                    int(job.get("total") or 0),
                    int(job.get("success") or 0),
                ),
            )
        except (TypeError, ValueError):
            sync_count = 0
        if source_mode != "unknown" and sync_count > 0:
            try:
                synced_items = douyin_library.list_items(
                    binding.session_scope,
                    binding.id,
                    sync_count,
                    mode=source_mode,
                    sort_by=(
                        "collection"
                        if source_mode == "collect"
                        else "published"
                    ),
                )
                notes_by_video_id = note_service.get_notes_by_video_ids(
                    db,
                    [item["aweme_id"] for item in synced_items],
                    user_id=current_user.id,
                )
                ledger_synced = video_source_ledger_service.upsert_items(
                    db,
                    user_id=current_user.id,
                    items=synced_items,
                    notes_by_video_id=notes_by_video_id,
                    observed_at=completed_at or datetime.now(timezone.utc),
                    source_synced_at=completed_at or datetime.now(timezone.utc),
                )
            except Exception:
                # The downloader job itself succeeded. A transient follow-up
                # metadata read must not turn that successful sync into a 5xx;
                # the extraction/save path can still populate the ledger.
                db.rollback()
                ledger_warning = "来源顺序稍后刷新"
    job_status = str(job.get("status") or "").strip().lower()
    if job_status in {"success", "failed"}:
        activity_service.log_activity_safely(
            user_id=current_user.id,
            action=(
                "douyin_sync_completed"
                if job_status == "success"
                else "douyin_sync_failed"
            ),
            method="GET",
            path="/api/library/douyin/jobs/{job_id}",
            status_code=200 if job_status == "success" else 502,
            ip=request.client.host if request.client else None,
            detail={
                "outcome": job_status,
                "error_category": (
                    str(job.get("error_code") or "").strip()
                    or ("upstream_sync_failed" if job_status == "failed" else None)
                ),
                "source_mode": job.get("mode"),
                "channel": job.get("channel"),
                "fallback_attempted": bool(job.get("fallback_attempted")),
                "retry_after_seconds": job.get("retry_after_seconds"),
                "needs_action": bool(job.get("needs_action")),
                "job_id": job_id,
                "total": job.get("total"),
                "success": job.get("success"),
                "failed": job.get("failed"),
                "skipped": job.get("skipped"),
                "temporary_restored": restored,
            },
            event_key=(
                f"douyin-sync:{current_user.id}:{job_id}:{job_status}"
            ),
        )
    return _ok({
        **job,
        "temporary_restored": restored,
        "source_ledger_synced": ledger_synced,
        "source_ledger_warning": ledger_warning,
    })


@router.get("/api/library/douyin/media/{aweme_id}")
def stream_douyin_library_media(
    request: Request,
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    binding: str = Query(
        ...,
        min_length=24,
        max_length=24,
        pattern=r"^dyb-[0-9a-f]{20}$",
    ),
    db: Session = Depends(get_db),
):
    """Proxy a short-lived Douyin stream without persisting it on the server."""
    if not douyin_library.verify_media_signature(
        aweme_id,
        binding,
        expires,
        signature,
    ):
        raise HTTPException(status_code=403, detail="视频播放地址已失效，请刷新页面")
    account_binding = douyin_binding_service.get_by_id(db, binding)
    if account_binding is None:
        raise HTTPException(status_code=404, detail="抖音账号绑定不存在")
    return _proxy_short_lived_media(
        request,
        douyin_library.companion_media_url(aweme_id),
        douyin_library.companion_headers(account_binding.session_scope),
        platform="douyin",
        trusted_loopback=True,
    )


@router.get("/api/library/douyin/cover/{aweme_id}")
def stream_douyin_library_cover(
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    binding: str = Query(
        ...,
        min_length=24,
        max_length=24,
        pattern=r"^dyb-[0-9a-f]{20}$",
    ),
    db: Session = Depends(get_db),
):
    """Proxy a cover image without exposing loopback URLs or storing files."""
    if not douyin_library.verify_cover_signature(
        aweme_id,
        binding,
        expires,
        signature,
    ):
        raise HTTPException(status_code=403, detail="视频封面地址已失效，请刷新页面")
    account_binding = douyin_binding_service.get_by_id(db, binding)
    if account_binding is None:
        raise HTTPException(status_code=404, detail="抖音账号绑定不存在")
    target_url = douyin_library.companion_cover_url(aweme_id)
    local_cover_url = local_douyin_library_service.get_cover_url(
        db,
        user_id=account_binding.user_id,
        video_id=aweme_id,
    )
    return _proxy_douyin_image(
        target_url,
        account_binding.session_scope,
        fallback_url=local_cover_url,
        stable_cache_key=f"douyin-cover:{binding}:{aweme_id}",
    )


@router.get("/api/library/douyin/gallery/{aweme_id}/{image_index}")
def stream_douyin_library_gallery_image(
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    image_index: int = Path(..., ge=0, le=29),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    binding: str = Query(
        ...,
        min_length=24,
        max_length=24,
        pattern=r"^dyb-[0-9a-f]{20}$",
    ),
    db: Session = Depends(get_db),
):
    """Proxy one gallery image without exposing the loopback sidecar."""
    if not douyin_library.verify_gallery_signature(
        aweme_id,
        binding,
        image_index,
        expires,
        signature,
    ):
        raise HTTPException(status_code=403, detail="图文地址已失效，请刷新页面")
    account_binding = douyin_binding_service.get_by_id(db, binding)
    if account_binding is None:
        raise HTTPException(status_code=404, detail="抖音账号绑定不存在")
    return _proxy_douyin_image(
        douyin_library.companion_gallery_image_url(aweme_id, image_index),
        account_binding.session_scope,
        stable_cache_key=f"douyin-gallery:{binding}:{aweme_id}:{image_index}",
    )


@router.get("/api/library/douyin/items")
def list_douyin_library_items(
    limit: int = Query(
        default=0,
        ge=0,
        le=10000,
        description="返回数量；0 表示返回下载器 manifest 中的全部条目",
    ),
    mode: Literal["like", "collect", "post"] | None = Query(default=None),
    sort: Literal["collection", "published"] = Query(
        default="collection",
        description="喜欢和收藏默认按来源顺序；也可切换为发布时间",
    ),
    refresh_order: bool = Query(
        default=False,
        description="显式选择来源顺序时刷新抖音返回的喜欢或收藏顺序",
    ),
    local_only: bool = Query(
        default=False,
        description="只读取已落库的桌面快照，不等待旧版连接器",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return the merged desktop snapshot and legacy downloader catalog."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    local_items = local_douyin_library_service.list_items(
        db,
        user_id=current_user.id,
        source_mode=mode,
    )
    sidecar_items: list[dict[str, Any]] = []
    catalog_warning = ""
    # 桌面端快照已经落库，是当前资料页的数据源；有本地数据时不再让首屏
    # 等待旧连接器最多 15 秒。只有尚无本地快照的旧版云端账号才走兼容回退。
    if not local_items and not local_only:
        try:
            sidecar_items = douyin_library.list_items(
                binding.session_scope,
                binding.id,
                0,
                mode=mode,
                sort_by=sort,
                refresh_order=refresh_order,
            )
        except douyin_library.DouyinLibraryError as exc:
            catalog_warning = str(exc)

    # The legacy companion may still contain old title-only manifest rows.
    # Apply the same durable public-metadata contract as the desktop channel
    # before the two catalogs are merged, otherwise a quarantined local row
    # would immediately reappear through the fallback channel.
    sidecar_items = [
        item
        for item in sidecar_items
        if local_douyin_library_service.is_displayable_snapshot(item)
    ]

    sidecar_by_id = {
        str(item.get("aweme_id") or "").strip(): dict(item)
        for item in sidecar_items
        if str(item.get("aweme_id") or "").strip()
    }
    items: list[dict[str, Any]] = []
    emitted: set[str] = set()
    for local_item in local_items:
        aweme_id = str(local_item.get("aweme_id") or "").strip()
        if not aweme_id or aweme_id in emitted:
            continue
        sidecar_item = sidecar_by_id.get(aweme_id)
        if sidecar_item is None:
            merged = _mint_douyin_item_capabilities(
                dict(local_item),
                binding.id,
            )
        else:
            # Keep the sidecar media capability when it exists, while using
            # the newest public metadata and ordering captured on the device.
            merged = dict(sidecar_item)
            for key in (
                "title",
                "caption",
                "author_name",
                "source_url",
                "cover_url",
                "published_at",
                "duration",
                "source_mode",
                "source_rank",
                "source_synced_at",
                "first_seen_at",
                "last_seen_at",
            ):
                value = local_item.get(key)
                if value not in (None, ""):
                    merged[key] = value
        emitted.add(aweme_id)
        items.append(merged)
    for sidecar_item in sidecar_items:
        aweme_id = str(sidecar_item.get("aweme_id") or "").strip()
        if aweme_id and aweme_id not in emitted:
            emitted.add(aweme_id)
            items.append(dict(sidecar_item))

    if sort == "published":
        items.sort(
            key=lambda item: str(item.get("published_at") or ""),
            reverse=True,
        )
    else:
        items.sort(key=lambda item: (
            item.get("source_rank") is None,
            int(item.get("source_rank") or 0),
        ))

    source_total = len(items)
    hidden_modes = library_hidden_service.list_hidden_modes(
        db,
        current_user.id,
        [item["aweme_id"] for item in items],
    )
    items = [
        item for item in items
        if item["aweme_id"] not in hidden_modes
    ]
    if limit > 0:
        items = items[:limit]

    note_map = note_service.get_notes_by_video_ids(
        db,
        [item["aweme_id"] for item in items],
        user_id=current_user.id,
    )
    ledger_map = video_source_ledger_service.list_by_video_ids(
        db,
        user_id=current_user.id,
        video_ids=[item["aweme_id"] for item in items],
    )
    for item in items:
        note = note_map.get(item["aweme_id"])
        ledger = video_source_ledger_service.preferred_for_item(
            ledger_map.get(item["aweme_id"], []),
            item.get("source_mode"),
        )
        if ledger is not None:
            ledger_data = ledger.to_dict()
            item["source_ledger"] = ledger_data
            item["first_seen_at"] = ledger_data["first_seen_at"]
            item["last_seen_at"] = ledger_data["last_seen_at"]
            item["source_synced_at"] = ledger_data["source_synced_at"]
        else:
            # Existing installs may only have source metadata embedded in the
            # card JSON. Read it as a compatibility fallback, never write it.
            legacy_meta = video_source_ledger_service.legacy_source_meta(note)
            item["first_seen_at"] = str(
                legacy_meta.get("first_seen_at") or ""
            )
            item["last_seen_at"] = str(
                legacy_meta.get("last_seen_at")
                or legacy_meta.get("source_synced_at")
                or ""
            )
            if not item.get("source_synced_at"):
                item["source_synced_at"] = str(
                    legacy_meta.get("source_synced_at")
                    or legacy_meta.get("first_seen_at")
                    or ""
                )
        item["extracted"] = note is not None
        item["extracted_note_id"] = note.id if note else None
        item["transcript_chars"] = len(note.transcript_raw or "") if note else 0
        item["ai_initialized"] = bool(note.ai_initialized) if note else False
        item["card_type"] = note.card_type if note else None
    return _ok({
        "items": items,
        "total": len(items),
        "source_total": source_total,
        "hidden": {
            "temporary": sum(
                1 for value in hidden_modes.values() if value == "temporary"
            ),
            "permanent": sum(
                1 for value in hidden_modes.values() if value == "permanent"
            ),
        },
        "permanent_hidden_total": library_hidden_service.count_hidden(
            db,
            current_user.id,
            "permanent",
        ),
        "catalog_warning": catalog_warning,
        "catalog_channels": {
            "desktop_local": len(local_items),
            "legacy_sidecar": len(sidecar_items),
        },
    })


@router.post("/api/library/douyin/items/remove")
def remove_douyin_library_items(
    body: LibraryRemoveRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Hide selected items for this user without deleting source or knowledge."""
    try:
        result = library_hidden_service.hide_aweme_ids(
            db,
            current_user.id,
            body.aweme_ids,
            body.mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/api/library/douyin/hidden-items")
def list_permanently_hidden_douyin_items(
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """List permanent visibility records, even if the catalog is unavailable."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    records = library_hidden_service.list_hidden_records(
        db,
        current_user.id,
        "permanent",
        limit,
    )
    catalog: dict[str, dict[str, Any]] = {}
    try:
        catalog.update({
            item["aweme_id"]: item
            for item in douyin_library.list_items(
                binding.session_scope,
                binding.id,
                0,
            )
        })
    except douyin_library.DouyinLibraryError:
        pass
    catalog.update({
        item["aweme_id"]: item
        for item in local_douyin_library_service.list_items(
            db,
            user_id=current_user.id,
        )
    })

    items: list[dict[str, Any]] = []
    for record in records:
        source = catalog.get(record.aweme_id, {})
        items.append({
            "aweme_id": record.aweme_id,
            "title": source.get("title") or f"抖音作品 {record.aweme_id}",
            "cover_url": source.get("cover_url") or "",
            "author_name": source.get("author_name") or "",
            "source_mode": source.get("source_mode") or "unknown",
            "hidden_mode": "permanent",
            "hidden_at": record.created_at.isoformat(),
        })
    return _ok({
        "items": items,
        "total": library_hidden_service.count_hidden(
            db,
            current_user.id,
            "permanent",
        ),
    })


@router.post("/api/library/douyin/hidden-items/restore")
def restore_permanently_hidden_douyin_items(
    body: LibraryRemoveRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Restore selected permanent visibility records without touching knowledge."""
    try:
        result = library_hidden_service.restore_permanent_aweme_ids(
            db,
            current_user.id,
            body.aweme_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/api/library/douyin/items/{aweme_id}")
def get_douyin_library_item(
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Compose live downloader media with this user's durable knowledge."""
    if library_hidden_service.is_hidden(db, current_user.id, aweme_id):
        raise HTTPException(status_code=404, detail="视频已从当前资料库移除")
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    item: dict[str, Any] | None = None
    try:
        item = douyin_library.get_item(
            binding.session_scope,
            binding.id,
            aweme_id,
        )
    except douyin_library.DouyinLibraryError as exc:
        item = None
    if item is None:
        item = local_douyin_library_service.get_item(
            db,
            user_id=current_user.id,
            video_id=aweme_id,
        )
    if item is None:
        raise HTTPException(status_code=404, detail="视频不存在或尚未同步")
    item = _mint_douyin_item_capabilities(dict(item), binding.id)

    note = note_service.get_note_by_video_id(
        db,
        aweme_id,
        user_id=current_user.id,
    )
    ledger = video_source_ledger_service.preferred_for_item(
        video_source_ledger_service.list_by_video_ids(
            db,
            user_id=current_user.id,
            video_ids=[aweme_id],
        ).get(aweme_id, []),
        item.get("source_mode"),
    )
    if ledger is not None:
        ledger_data = ledger.to_dict()
        item["source_ledger"] = ledger_data
        item["first_seen_at"] = ledger_data["first_seen_at"]
        item["last_seen_at"] = ledger_data["last_seen_at"]
        item["source_synced_at"] = ledger_data["source_synced_at"]
    else:
        legacy_meta = video_source_ledger_service.legacy_source_meta(note)
        item["first_seen_at"] = str(legacy_meta.get("first_seen_at") or "")
        item["last_seen_at"] = str(
            legacy_meta.get("last_seen_at")
            or legacy_meta.get("source_synced_at")
            or ""
        )
    plan = (
        plan_service.get_plan_by_note(db, note.id, user_id=current_user.id)
        if note is not None
        else None
    )
    item["extracted"] = note is not None
    item["extracted_note_id"] = note.id if note else None
    item["transcript_chars"] = len(note.transcript_raw or "") if note else 0
    item["ai_initialized"] = bool(note.ai_initialized) if note else False
    item["card_type"] = note.card_type if note else None
    return _ok({
        "item": item,
        "note": note.to_dict() if note else None,
        "plan": plan.to_dict() if plan else None,
        "media_storage": {
            "provider": "douyin-downloader",
            "mode": "external",
            "database_stores_media": False,
        },
    })


@router.post("/api/library/douyin/items/{aweme_id}/visual-ask")
def ask_douyin_library_visual_item(
    body: VisualAskRequest,
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """没有可用文案时，临时携带当前作品图片或抽样帧进行问答。"""
    if library_hidden_service.is_hidden(db, current_user.id, aweme_id):
        raise HTTPException(status_code=404, detail="作品不存在或尚未同步")

    binding = douyin_binding_service.get_or_create(db, current_user.id)
    item: dict[str, Any] | None = None
    try:
        item = douyin_library.get_item(
            binding.session_scope,
            binding.id,
            aweme_id,
        )
    except douyin_library.DouyinLibraryError as exc:
        item = None
    if item is None:
        item = local_douyin_library_service.get_item(
            db,
            user_id=current_user.id,
            video_id=aweme_id,
        )
    if item is None:
        raise HTTPException(status_code=404, detail="作品不存在或尚未同步")

    media_type = str(item.get("media_type") or "video")
    try:
        if media_type == "gallery":
            images = douyin_library.gallery_image_data_urls(
                binding.session_scope,
                aweme_id,
                len(item.get("gallery_images") or []),
                max_images=8,
            )
        elif item.get("provider") == "desktop-local":
            images = ai_juicer.extract_video_frames(
                douyin_library.companion_media_url(aweme_id),
                max_frames=8,
                request_headers=douyin_library.companion_headers(
                    binding.session_scope
                ),
            )
        else:
            images = ai_juicer.extract_video_frames(
                douyin_library.companion_media_url(aweme_id),
                max_frames=8,
                request_headers=douyin_library.companion_headers(
                    binding.session_scope
                ),
            )
        if not images:
            raise ValueError(
                "当前作品暂时没有可读取的图片或视频画面，请稍后重试"
            )
        result = ai_juicer.answer_visual_question(
            title=str(item.get("title") or ""),
            caption=str(item.get("caption") or ""),
            images=images,
            media_type=media_type,
            question=body.question,
            history=[entry.model_dump() for entry in body.history[-6:]],
            llm_config=user_ai_provider_service.effective_vision_config(
                db,
                current_user.id,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        error_log_service.record_exception_safely(
            exc,
            source="visual_content_qa",
            status_code=502,
            metadata={
                "aweme_id": aweme_id,
                "media_type": media_type,
                "user_id": current_user.id,
            },
        )
        raise HTTPException(
            status_code=502,
            detail="图片问答暂时不可用，请确认当前模型支持图片理解后重试",
        ) from exc

    return _ok({"item_id": aweme_id, **result})


@router.post("/api/library/douyin/extract")
def extract_douyin_library_item(
    body: LibraryExtractRequest,
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Temporarily stream one video, transcribe it, then persist text only."""
    try:
        result = library_extraction_service.extract_library_item(
            user_id=current_user.id,
            aweme_id=body.aweme_id,
            operation=body.operation,
            ephemeral_media_url=body.ephemeral_media_url,
        )
        return _ok(result)
    except (ValueError, douyin_library.DouyinLibraryError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except video_extractor.CloudAsrError as exc:
        raise HTTPException(
            status_code=503 if exc.retryable else 502,
            detail=exc.public_message,
            headers={"Retry-After": "15"} if exc.retryable else None,
        ) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail="视频文案提取暂时失败，请稍后重试",
        ) from exc


@router.post("/api/library/douyin/extractions/batch")
def start_douyin_library_batch_extraction(
    body: LibraryBatchExtractRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Start all selected items as one concurrent metadata-only job."""
    concurrency = settings_service.get_extraction_concurrency(db)
    try:
        ephemeral_media_sources = {
            str(item.get("aweme_id") or "").strip(): str(item.get("media_url") or "").strip()
            for item in body.ephemeral_media_sources
            if isinstance(item, dict)
        }
        job = library_extraction_service.create_batch_job(
            user_id=current_user.id,
            aweme_ids=body.aweme_ids,
            operation=body.operation,
            asr_concurrency=concurrency["asr"],
            llm_concurrency=concurrency["llm"],
            ephemeral_media_sources=ephemeral_media_sources,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(job)


@router.get("/api/library/douyin/extractions/batch/{job_id}")
def get_douyin_library_batch_extraction(
    job_id: str = Path(
        ...,
        min_length=8,
        max_length=64,
        pattern=r"^extract-[a-f0-9]+$",
    ),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Poll one current-user concurrent extraction job."""
    job = library_extraction_service.get_batch_job(job_id, current_user.id)
    if job is None:
        raise HTTPException(status_code=404, detail="批量提取任务不存在")
    return _ok(job)


@router.delete("/api/library/douyin/extractions/{note_id}")
def delete_douyin_library_extraction(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Delete one current-user library result, not the downloader media."""
    deleted, plans_deleted = note_service.delete_user_library_note(
        db,
        note_id,
        current_user.id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="视频知识结果不存在")
    return _ok({
        "deleted": True,
        "plans_deleted": plans_deleted,
        "media_preserved": True,
    })


@router.post("/api/library/ask")
def ask_video_library(
    body: LibraryAskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Answer using the requested, user-owned video Notes."""
    note_ids = list(dict.fromkeys(note_id.strip() for note_id in body.note_ids))
    notes = [
        note_service.get_note(db, note_id, user_id=current_user.id)
        for note_id in note_ids
    ]
    if any(note is None for note in notes):
        # Missing and cross-user IDs deliberately share one response.
        raise HTTPException(status_code=404, detail="所选视频不存在")

    try:
        result = ai_juicer.answer_library_question(
            sources=[
                {
                    "note_id": note.id,
                    "title": note.video_title,
                    "transcript": note.transcript_raw,
                    "ai_summary": note.ai_summary,
                }
                for note in notes
                if note is not None
            ],
            question=body.question,
            history=[item.model_dump() for item in body.history[-6:]],
            research_mode=body.research_mode,
            output_style=body.output_style,
            custom_instruction=body.custom_instruction,
            web_scope=body.web_scope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=502, detail="集合问答暂时不可用，请稍后重试") from exc

    return _ok({
        "note_ids": note_ids,
        "answer": result["answer"],
        "grounded": result["grounded"],
        "evidence": result["evidence"],
        "follow_up_questions": result["follow_up_questions"],
        "source_context": result["source_context"],
        "web_sources": result.get("web_sources", []),
        "web_scope": result.get("web_scope", body.web_scope),
    })


@router.get("/api/knowledge")
def list_personal_knowledge(
    view: Literal["pages", "inbox"] = Query("pages"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
    q: str = Query(default="", max_length=120),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(knowledge_service.list_knowledge(
        db,
        current_user.id,
        view=view,
        page=page,
        per_page=per_page,
        search=q,
    ))


@router.post("/api/knowledge/entries")
def create_knowledge_entry(
    body: KnowledgeEntryCreateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        entry = knowledge_service.create_entry(
            db,
            current_user.id,
            title=body.title,
            summary=body.summary,
            content=body.content,
            source_label=body.source_label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(knowledge_service.serialize_entry(entry))


@router.get("/api/knowledge/entries/{entry_id}")
def get_knowledge_entry(
    entry_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    item = knowledge_service.get_entry_item(db, current_user.id, entry_id)
    if item is None:
        raise HTTPException(status_code=404, detail="知识条目不存在")
    return _ok(item)


@router.patch("/api/knowledge/entries/{entry_id}")
def update_knowledge_entry(
    entry_id: str,
    body: KnowledgeEntryUpdateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    entry = knowledge_service.get_entry(db, current_user.id, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="知识条目不存在")
    if (
        body.title is None
        and body.summary is None
        and body.content is None
        and body.source_label is None
    ):
        raise HTTPException(status_code=422, detail="至少提供一个更新字段")
    try:
        updated = knowledge_service.update_entry(
            db,
            entry,
            title=body.title,
            summary=body.summary,
            content=body.content,
            source_label=body.source_label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(knowledge_service.get_entry_item(db, current_user.id, updated.id))


@router.get("/api/knowledge/candidates/{note_id}")
def get_knowledge_candidate(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    item = knowledge_service.get_candidate_item(db, current_user.id, note_id)
    if item is None:
        raise HTTPException(status_code=404, detail="待整理内容不存在")
    return _ok(item)


@router.post("/api/knowledge/candidates/{note_id}/save")
def save_knowledge_candidate(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        entry = knowledge_service.save_candidate(db, current_user.id, note_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    item = knowledge_service.get_entry_item(db, current_user.id, entry.id)
    return _ok(item)


@router.delete("/api/knowledge/entries/{entry_id}")
def delete_knowledge_entry(
    entry_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    entry = knowledge_service.get_entry(db, current_user.id, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="知识条目不存在")
    knowledge_service.delete_entry(db, entry)
    return _ok({"deleted": True})


# ---------------------------------------------------------------------------
# Saved creator sources — manual, user-triggered background sync only
# ---------------------------------------------------------------------------

def _creator_http_error(exc: creator_sync_service.CreatorSyncError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": str(exc)},
    )


@router.post("/api/creator-sources/resolve")
def resolve_creator_source(
    body: CreatorSourceRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        return _ok(creator_sync_service.resolve_source(
            db,
            user_id=current_user.id,
            platform=body.platform,
            profile_ref=body.profile_ref,
        ))
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc


@router.get("/api/creator-sources")
def get_creator_sources(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok({
        "catalog": creator_sync_service.catalog(db),
        "items": creator_sync_service.list_sources(db, user_id=current_user.id),
    })


@router.post("/api/creator-sources")
def create_creator_source(
    body: CreatorSourceRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        source, reused = creator_sync_service.save_source(
            db,
            user_id=current_user.id,
            platform=body.platform,
            profile_ref=body.profile_ref,
        )
        return _ok({"item": source.to_dict(), "reused": reused})
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc


@router.get("/api/creator-sources/{source_id}")
def get_creator_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        return _ok(creator_sync_service.get_source_detail(
            db, user_id=current_user.id, source_id=source_id,
        ))
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc


@router.get("/api/creator-sources/{source_id}/items")
def get_creator_source_items(
    source_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=50),
    search: str = Query("", max_length=100),
    status: Literal["all", "untranscribed", "imported", "failed"] = Query("all"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        return _ok(creator_sync_service.list_source_items(
            db,
            user_id=current_user.id,
            source_id=source_id,
            page=page,
            per_page=per_page,
            search=search,
            status=status,
        ))
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc


@router.delete("/api/creator-sources/{source_id}")
def delete_creator_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        deleted = creator_sync_service.disable_source(
            db, user_id=current_user.id, source_id=source_id
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="博主不存在")
    return _ok({"deleted": True, "materials_preserved": True})


@router.post("/api/creator-sources/{source_id}/runs")
def create_creator_sync_run(
    body: CreatorSyncRunRequest,
    source_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        run, reused = creator_sync_service.create_run(
            db,
            user_id=current_user.id,
            source_id=source_id,
            limit=body.limit,
            operation=body.operation,
            item_ids=body.item_ids,
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc
    creator_sync_worker.runner.submit(run.id)
    return _ok({"run": run.to_dict(), "reused": reused})


@router.get("/api/creator-sync-runs")
def get_creator_sync_runs(
    status: Literal["active", "recent"] = Query("active"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        runs = creator_sync_service.list_runs(db, user_id=current_user.id, status=status)
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc
    return _ok({"items": [run.to_dict() for run in runs]})


@router.get("/api/creator-sync-runs/{run_id}")
def get_creator_sync_run(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    run = creator_sync_service.get_run(db, user_id=current_user.id, run_id=run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="同步任务不存在")
    return _ok(run.to_dict())


@router.get("/api/creator-sync-runs/{run_id}/items")
def get_creator_sync_run_items(
    run_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=50),
    status: Literal["all", "pending", "succeeded", "failed"] = Query("all"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        return _ok(creator_sync_service.list_run_items(
            db,
            user_id=current_user.id,
            run_id=run_id,
            page=page,
            per_page=per_page,
            status=status,
        ))
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc


@router.post("/api/creator-sync-runs/{run_id}/retry")
def retry_creator_sync_run(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        run, reused = creator_sync_service.retry_run(
            db, user_id=current_user.id, run_id=run_id,
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_http_error(exc) from exc
    creator_sync_worker.runner.submit(run.id)
    return _ok({"run": run.to_dict(), "reused": reused})


@router.delete("/api/creator-sync-runs/{run_id}")
def cancel_creator_sync_run(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    run = creator_sync_service.request_cancel(
        db, user_id=current_user.id, run_id=run_id
    )
    if run is None:
        raise HTTPException(status_code=404, detail="同步任务不存在")
    return _ok(run.to_dict())


@router.get("/api/user/ai-provider")
def get_user_ai_provider(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(user_ai_provider_service.serialize(db, current_user.id))


@router.get("/api/user/chat-models")
def get_user_chat_models(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    models = chat_model_catalog_service.list_published(db)
    selected = chat_model_catalog_service.selected_offering(db, current_user.id)
    return _ok({
        "items": [
            chat_model_catalog_service.serialize_user(db, model, current_user.id)
            for model in models
        ],
        "selected_offering_id": selected.id,
        "account": chat_credit_billing_service.account_summary(db, current_user.id),
    })


@router.put("/api/user/chat-model")
def put_user_chat_model(
    body: UserChatModelRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        selected = chat_model_catalog_service.select_for_user(
            db, current_user.id, body.offering_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok({
        "selected_offering_id": selected.id,
        "item": chat_model_catalog_service.serialize_user(db, selected, current_user.id),
    })


@router.get("/api/user/ai-routing/workspace")
def get_user_ai_routing_workspace(
    refresh: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """兼容旧客户端：只返回管理员发布的明确模型，不返回智能路由。"""
    del refresh
    models = chat_model_catalog_service.list_published(db)
    return _ok({
        "status": {"configured": True, "online": True, "partial": False, "latency_ms": 0, "message": "模型目录已就绪"},
        "models": [
            {
                **chat_model_catalog_service.serialize_user(db, model, current_user.id),
                "provider": "知萃平台",
                "available": True,
                "free": bool(model.is_free),
                "free_type": "daily" if model.is_free else "",
                "monthly_tokens": 0,
                "credit_tokens": 0,
                "context_length": 0,
                "capabilities": [
                    capability
                    for capability, enabled in (
                        ("images", model.supports_images),
                        ("tools", model.supports_tools),
                    )
                    if enabled
                ],
            }
            for model in models
        ],
        "routes": [],
        "rankings": [],
        "summary": {"model_count": len(models)},
        "sections": {"models": True},
        "advanced_console_url": "",
    })


@router.put("/api/user/ai-provider")
def put_user_ai_provider(
    body: UserAIProviderRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        data = user_ai_provider_service.save(
            db,
            current_user.id,
            mode=body.mode,
            provider_name=body.provider_name,
            model=body.model,
            api_base=body.api_base,
            api_key=body.api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(data)


@router.delete("/api/user/ai-provider")
def reset_user_ai_provider(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(user_ai_provider_service.reset(db, current_user.id))


@router.post("/api/user/ai-provider/test")
def test_user_ai_provider(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    cfg = user_ai_provider_service.effective_config(db, current_user.id)
    try:
        from litellm import completion

        response = completion(
            model=cfg["runtime_model"],
            api_base=cfg["api_base"] or None,
            api_key=cfg["api_key"] or None,
            messages=[{"role": "user", "content": "只回复 OK"}],
            max_tokens=8,
            temperature=0,
            timeout=20,
        )
        message = response.choices[0].message
        content = str(message.content or "").strip()
        reasoning_content = str(
            getattr(message, "reasoning_content", "") or ""
        ).strip()
        # 部分推理模型会先把最小测试额度全部用于 reasoning_content，
        # content 暂时为空。连接测试只验证路由和模型是否真实响应，
        # 因此这种响应也应判定为连接成功。
        if not content and not reasoning_content and not getattr(message, "tool_calls", None):
            raise RuntimeError("模型没有返回可见内容")
    except Exception as exc:
        error_log_service.record_exception_safely(
            exc,
            source="llm",
            status_code=502,
            user_id=current_user.id,
            metadata={
                "provider": cfg.get("provider", ""),
                "model": cfg.get("model", ""),
                "operation": "user_provider_test",
            },
        )
        raise HTTPException(
            status_code=502,
            detail="连接测试失败，请检查网关状态、模型名称和访问权限",
        ) from exc
    return _ok({
        "connected": True,
        "provider": cfg["provider"],
        "model": cfg["model"],
    })


def _test_custom_model_config(
    db: Session,
    user_id: str,
    model_id: str,
) -> dict:
    cfg = user_ai_provider_service.effective_custom_config(db, user_id, model_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="自定义模型不存在或不可用")
    try:
        from litellm import completion

        response = completion(
            model=cfg["runtime_model"],
            api_base=cfg["api_base"] or None,
            api_key=cfg["api_key"] or None,
            messages=[{"role": "user", "content": "只回复 OK"}],
            max_tokens=8,
            temperature=0,
            timeout=20,
        )
        message = response.choices[0].message
        content = str(message.content or "").strip()
        reasoning_content = str(
            getattr(message, "reasoning_content", "") or ""
        ).strip()
        if not content and not reasoning_content and not getattr(message, "tool_calls", None):
            raise RuntimeError("模型没有返回可见内容")
    except Exception as exc:
        error_log_service.record_exception_safely(
            exc,
            source="llm",
            status_code=502,
            user_id=user_id,
            metadata={
                "provider": "custom",
                "model": cfg.get("model", ""),
                "operation": "custom_chat_model_test",
            },
        )
        raise HTTPException(
            status_code=502,
            detail="连接测试失败，请检查网关状态、模型名称和访问权限",
        ) from exc
    return _ok({
        "connected": True,
        "provider": "custom",
        "model": cfg["model"],
    })


@router.get("/api/user/custom-chat-models")
def list_user_custom_chat_models(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(user_ai_provider_service.list_custom_models(db, current_user.id))


@router.post("/api/user/custom-chat-models")
def create_user_custom_chat_model(
    body: UserCustomChatModelCreateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        data = user_ai_provider_service.create_custom_model(
            db,
            current_user.id,
            name=body.name,
            provider_name=body.provider_name,
            model=body.model,
            api_base=body.api_base,
            api_key=body.api_key,
            enabled=body.enabled,
            select=body.select,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(data)


@router.put("/api/user/custom-chat-models/select-platform")
def select_user_platform_model(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(user_ai_provider_service.select_platform(db, current_user.id))


@router.put("/api/user/custom-chat-models/{model_id}")
def update_user_custom_chat_model(
    model_id: str,
    body: UserCustomChatModelUpdateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        data = user_ai_provider_service.update_custom_model(
            db,
            current_user.id,
            model_id,
            name=body.name,
            provider_name=body.provider_name,
            model=body.model,
            api_base=body.api_base,
            api_key=body.api_key,
            enabled=body.enabled,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="自定义模型不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(data)


@router.delete("/api/user/custom-chat-models/{model_id}")
def delete_user_custom_chat_model(
    model_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        data = user_ai_provider_service.delete_custom_model(db, current_user.id, model_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="自定义模型不存在") from exc
    return _ok(data)


@router.put("/api/user/custom-chat-models/{model_id}/select")
def select_user_custom_chat_model(
    model_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        data = user_ai_provider_service.select_custom_model(db, current_user.id, model_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="自定义模型不存在") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(data)


@router.post("/api/user/custom-chat-models/{model_id}/test")
def test_user_custom_chat_model(
    model_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _test_custom_model_config(db, current_user.id, model_id)


@router.get("/api/notes")
def list_notes(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    q: str | None = Query(None, min_length=1, max_length=80, description="Search note title or summary"),
    card_type: Literal["recipe", "insight", "history", "product", "plan", "general"] | None = Query(
        None,
        description="Filter by card type",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return a paginated, user-scoped list of saved notes."""
    notes, total = note_service.list_notes(
        db,
        page=page,
        per_page=per_page,
        user_id=current_user.id,
        search=q,
        card_type=card_type,
    )
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [n.to_dict() for n in notes],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/notes/{note_id}")
def get_note(note_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    """Fetch a single note by ID. Includes plan_id if a plan exists."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    result = note.to_dict()
    plan = plan_service.get_plan_by_note(
        db,
        note_id,
        user_id=current_user.id,
    )
    result["plan_id"] = plan.id if plan else None
    return _ok(result)


@router.post("/api/notes/{note_id}/ask")
def ask_note(
    note_id: str,
    body: NoteAskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Answer a question using one user-owned note as the source."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        # Keep the same response for missing notes and notes owned by another
        # user so this endpoint does not reveal cross-user resource existence.
        raise HTTPException(status_code=404, detail="Note not found")

    try:
        result = ai_juicer.answer_note_question(
            title=note.video_title,
            transcript=note.transcript_raw,
            ai_summary=note.ai_summary,
            question=body.question,
            history=[item.model_dump() for item in body.history[-6:]],
            research_scope=body.research_scope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=502, detail="内容问答暂时不可用，请稍后重试") from exc

    return _ok({
        "note_id": note.id,
        "answer": result["answer"],
        "answer_mode": result["answer_mode"],
        "grounded": result["grounded"],
        "evidence": result["evidence"],
        "follow_up_questions": result["follow_up_questions"],
        "source_context": result.get("source_context"),
        "web_sources": result.get("web_sources", []),
        "research_scope": result.get("research_scope", body.research_scope),
        "agent_trace": result.get("agent_trace", []),
    })


@router.post("/api/notes/{note_id}/plan-agent")
def run_note_plan_agent(
    note_id: str,
    body: PlanAgentRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Create or revise one note-linked plan through a validated Agent target."""
    try:
        result = note_plan_agent_service.generate_or_revise_from_note(
            db,
            user_id=current_user.id,
            note_id=note_id,
            instruction=body.instruction,
        )
    except note_plan_agent_service.NotePlanAgentError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail="计划 Agent 暂时不可用，请稍后重试",
        ) from exc

    return _ok(result)


# ---------------------------------------------------------------------------
# Plan endpoints
# ---------------------------------------------------------------------------

class AddTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    day: int | None = Field(default=None, ge=1, le=3650)
    scheduled_at: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$",
    )
    reminder_at: str | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=10080)
    frequency: str | None = Field(default=None, max_length=120)
    priority: Literal["low", "medium", "high"] = "medium"


class CreatePlanRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    start_date: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    total_days: int = Field(default=0, ge=0, le=3650)
    first_task: AddTaskRequest | None = None


class UpdatePlanRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    status: Literal["active", "done"] | None = None
    start_date: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    total_days: int | None = Field(default=None, ge=0, le=3650)


class ReorderPlanTasksRequest(BaseModel):
    task_ids: list[str] = Field(..., max_length=2000)


class PlanFocusSelection(BaseModel):
    plan_id: str = Field(..., min_length=1, max_length=64)
    task_id: str = Field(..., min_length=1, max_length=96)


class ReplacePlanFocusRequest(BaseModel):
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    tasks: list[PlanFocusSelection] = Field(default_factory=list, max_length=3)


class PlanCoachPreviewRequest(BaseModel):
    instruction: str = Field(..., min_length=2, max_length=1000)


class PlanCoachApplyRequest(BaseModel):
    base_updated_at: str = Field(..., min_length=10, max_length=64)
    operations: list[dict[str, Any]] = Field(..., min_length=1, max_length=1)


class UpdateTaskRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    day: int | None = Field(default=None, ge=1, le=3650)
    scheduled_at: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$",
    )
    reminder_at: str | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=10080)
    frequency: str | None = Field(default=None, max_length=120)
    priority: Literal["low", "medium", "high"] | None = None


@router.post("/api/plans")
def create_manual_plan(
    body: CreatePlanRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    task_payloads: list[dict[str, Any]] = []
    if body.first_task is not None:
        task_payload = body.first_task.model_dump(exclude_none=True)
        task_payload["id"] = f"t-{uuid.uuid4().hex[:8]}"
        task_payload["done"] = False
        task_payloads.append(task_payload)
    try:
        plan = plan_service.create_plan(
            db,
            note_id=None,
            title=body.title,
            tasks=task_payloads,
            total_days=body.total_days,
            start_date=body.start_date,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(plan.to_dict())


@router.put("/api/plans/focus")
def replace_plan_focus(
    body: ReplacePlanFocusRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        overview = plan_service.replace_daily_focus(
            db,
            user_id=current_user.id,
            focus_date=body.date,
            selections=[item.model_dump() for item in body.tasks],
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(overview)


@router.get("/api/plans/review")
def get_plan_weekly_review(
    week_start: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        review = plan_service.get_weekly_review(
            db,
            user_id=current_user.id,
            week_start=week_start,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(review)


@router.get("/api/plans")
def list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    plans, total = plan_service.list_plans(
        db,
        page=page,
        per_page=per_page,
        user_id=current_user.id,
    )
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [p.to_dict() for p in plans],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/plans/stats")
def get_plan_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    stats = plan_service.get_plan_stats(db, user_id=current_user.id)
    return _ok(stats)


@router.get("/api/plans/overview")
def get_plan_overview(
    for_date: str | None = Query(
        default=None,
        alias="date",
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        overview = plan_service.get_plan_overview(
            db,
            user_id=current_user.id,
            for_date=for_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(overview)


@router.get("/api/plans/{plan_id}")
def get_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.get_plan(db, plan_id, user_id=current_user.id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}")
def update_plan(
    plan_id: str,
    body: UpdatePlanRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="至少提供一个计划更新字段")
    try:
        plan = plan_service.update_plan(
            db,
            plan_id,
            updates=updates,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.post("/api/plans/{plan_id}/coach/preview")
def preview_plan_coaching(
    plan_id: str,
    body: PlanCoachPreviewRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    plan = plan_service.get_plan(db, plan_id, user_id=current_user.id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    note = (
        note_service.get_note(db, plan.note_id, user_id=current_user.id)
        if plan.note_id
        else None
    )
    try:
        result = ai_juicer.generate_or_revise_plan(
            title=note.video_title if note else plan.title,
            transcript=note.transcript_raw if note else None,
            ai_summary=note.ai_summary if note else None,
            instruction=body.instruction,
            existing_plan=plan.to_dict(),
        )
        proposed = result["plan"]
        fields, tasks, total_days = ai_juicer.plan_to_storage(proposed)
        preview = plan_service.build_coaching_preview(
            plan,
            proposed_title=str(proposed.get("goal") or plan.title),
            proposed_fields=fields,
            proposed_tasks=tasks,
            proposed_days=(
                proposed.get("days")
                if isinstance(proposed.get("days"), list)
                else []
            ),
            proposed_total_days=total_days,
            change_summary=result["change_summary"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail="AI 暂时无法给出调整方案，请稍后重试",
        ) from exc
    preview["source_context"] = result.get("source_context") or {}
    return _ok(preview)


@router.post("/api/plans/{plan_id}/coach/apply")
def apply_plan_coaching(
    plan_id: str,
    body: PlanCoachApplyRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        plan = plan_service.apply_coaching_preview(
            db,
            plan_id=plan_id,
            user_id=current_user.id,
            base_updated_at=body.base_updated_at,
            operations=body.operations,
        )
    except plan_service.PlanConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.put("/api/plans/{plan_id}/tasks/order")
def reorder_plan_tasks(
    plan_id: str,
    body: ReorderPlanTasksRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    try:
        plan = plan_service.reorder_tasks(
            db,
            plan_id,
            task_ids=body.task_ids,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}/tasks/{task_id}")
def toggle_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.toggle_task(
        db,
        plan_id,
        task_id,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.put("/api/plans/{plan_id}/tasks/{task_id}")
def update_plan_task(
    plan_id: str,
    task_id: str,
    body: UpdateTaskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="至少提供一个任务更新字段")
    try:
        plan = plan_service.update_task(
            db,
            plan_id,
            task_id,
            updates=updates,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.post("/api/plans/{plan_id}/tasks")
def add_plan_task(plan_id: str, body: AddTaskRequest, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.add_task(
        db, plan_id,
        title=body.title,
        day=body.day,
        scheduled_at=body.scheduled_at,
        reminder_at=body.reminder_at,
        duration_minutes=body.duration_minutes,
        frequency=body.frequency,
        priority=body.priority,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}/tasks/{task_id}")
def delete_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.delete_task(
        db,
        plan_id,
        task_id,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    deleted = plan_service.delete_plan(db, plan_id, user_id=current_user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok({"deleted": True})


@router.get("/api/video/proxy")
def proxy_video(
    current_user: UserModel = Depends(get_current_user),
):
    """Retired: accepting an arbitrary upstream URL was an SSRF primitive."""
    raise HTTPException(
        status_code=410,
        detail="旧视频代理已停用，请从视频资料重新打开以获取短时播放地址",
    )


# ---------------------------------------------------------------------------
# Admin endpoints — manage users (admin only)
# ---------------------------------------------------------------------------
def _validate_http_url(value: str, field: str) -> None:
    """Validate http(s) URL or empty. Raises HTTPException(400) on invalid."""
    if not value:
        return
    from urllib.parse import urlparse
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{field} 必须是合法的 http/https URL")


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP (X-Forwarded-For or client host)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


class AdminUserPatch(BaseModel):
    is_active: bool | None = None
    is_admin: bool | None = None
    username: str | None = None
    email: str | None = None


class AdminFeedbackUpdateRequest(BaseModel):
    status: Literal["pending", "processing", "resolved", "closed"] | None = None
    admin_reply: str | None = Field(default=None, max_length=2000)


@router.get("/api/admin/chat-models")
def admin_list_chat_models(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    del current_user
    chat_model_catalog_service.ensure_default_offering(db)
    return _ok({
        "items": [
            chat_model_catalog_service.serialize_admin(item)
            for item in chat_model_catalog_service.list_admin(db)
        ]
    })


def _save_admin_chat_model(
    body: AdminChatModelRequest,
    *,
    offering_id: str | None,
    request: Request,
    db: Session,
    current_user: UserModel,
) -> dict:
    try:
        item = chat_model_catalog_service.save(
            db,
            offering_id=offering_id,
            **body.model_dump(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="chat_model_update" if offering_id else "chat_model_create",
        target_type="chat_model",
        target_id=item.id,
        detail={"name": item.name, "model_id": item.model_id, "enabled": item.enabled},
        ip=_client_ip(request),
    )
    return _ok(chat_model_catalog_service.serialize_admin(item))


@router.post("/api/admin/chat-models")
def admin_create_chat_model(
    body: AdminChatModelRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _save_admin_chat_model(
        body, offering_id=None, request=request, db=db, current_user=current_user
    )


@router.put("/api/admin/chat-models/{offering_id}")
def admin_update_chat_model(
    offering_id: str,
    body: AdminChatModelRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _save_admin_chat_model(
        body, offering_id=offering_id, request=request, db=db, current_user=current_user
    )


@router.delete("/api/admin/chat-models/{offering_id}")
def admin_delete_chat_model(
    offering_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    try:
        deleted = chat_model_catalog_service.delete(db, offering_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="聊天模型不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="chat_model_delete",
        target_type="chat_model",
        target_id=offering_id,
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


@router.get("/api/admin/omniroute-config")
def admin_get_omniroute_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    del current_user
    return _ok(settings_service.get_omniroute_config_masked(db))


@router.put("/api/admin/omniroute-config")
def admin_put_omniroute_config(
    body: OmniRouteConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if body.api_base:
        _validate_http_url(body.api_base, "API Base")
    if body.dashboard_url:
        _validate_http_url(body.dashboard_url, "控制台地址")
    value = settings_service.set_omniroute_config(
        db,
        api_base=body.api_base,
        api_key=body.api_key,
        model=body.model,
        dashboard_url=body.dashboard_url,
    )
    changed: dict = {}
    for field in ("api_base", "model", "dashboard_url"):
        if getattr(body, field):
            changed[field] = getattr(body, field)
    if body.api_key:
        changed["api_key"] = "***updated***"
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="omniroute_config_update",
            target_type="config",
            target_id="omniroute",
            detail=changed,
            ip=_client_ip(request),
        )
    omniroute_workspace_service.clear_cache()
    return _ok(value)


@router.get("/api/admin/omniroute/workspace")
def admin_get_omniroute_workspace(
    refresh: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    del current_user
    workspace = omniroute_workspace_service.get_workspace(
        refresh=refresh,
        include_admin=True,
        db=db,
    )
    return _ok(workspace)


@router.post("/api/admin/omniroute/test")
def admin_test_omniroute(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    del current_user
    config = settings_service.get_omniroute_config(db)
    if not config["api_base"] or not config["api_key"]:
        return _err("请先填写 OmniRoute API Base 与 API Key")
    workspace = omniroute_workspace_service.get_workspace(refresh=True, db=db)
    return _ok({
        "configured": True,
        "online": bool(workspace["status"]["online"]),
        "message": str(workspace["status"]["message"]),
        "latency_ms": int(workspace["status"]["latency_ms"] or 0),
        "model_count": len(workspace["models"]),
    })


@router.get("/api/admin/stats")
def admin_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan
    from sqlalchemy import func as _func

    recent_users_rows = (
        db.query(UserModel).order_by(UserModel.created_at.desc()).limit(5).all()
    )
    recent_users = [
        {
            "username": u.username or u.email,
            "email": u.email,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in recent_users_rows
    ]

    type_rows = (
        db.query(Note.card_type, _func.count(Note.id)).group_by(Note.card_type).all()
    )
    type_dist = {ct or "general": cnt for ct, cnt in type_rows}

    return _ok({
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
        "recent_users": recent_users,
        "type_dist": type_dist,
        "downloads": client_download_service.download_stats(db),
    })


@router.get("/api/admin/users")
def admin_list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按邮箱或用户名模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    query = db.query(UserModel)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (UserModel.email.ilike(like)) | (UserModel.username.ilike(like))
        )
    total = query.count()
    users = (
        query.order_by(UserModel.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return _ok({
        "items": [u.to_dict() for u in users],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.patch("/api/admin/users/{user_id}")
def admin_patch_user(
    user_id: str,
    body: AdminUserPatch,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")

    # Guard: cannot disable or demote yourself (would lock you out).
    if user_id == current_user.id:
        if body.is_active is False:
            return _err("不能禁用自己")
        if body.is_admin is False:
            return _err("不能取消自己的管理员权限")

    # Guard: must keep at least one enabled admin.
    demoting_admin = user.is_admin and (body.is_admin is False or body.is_active is False)
    if demoting_admin:
        active_admins = (
            db.query(UserModel)
            .filter(UserModel.is_admin.is_(True), UserModel.is_active.is_(True))
            .count()
        )
        if active_admins <= 1:
            return _err("至少保留一个启用的管理员")

    if body.is_active is not None:
        user.is_active = body.is_active
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.username is not None:
        new_username = body.username.strip()
        if len(new_username) < 2:
            return _err("用户名至少 2 个字符")
        dup = (
            db.query(UserModel)
            .filter(UserModel.username == new_username, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该用户名已被使用")
        user.username = new_username
    if body.email is not None:
        new_email = body.email.strip().lower()
        if "@" not in new_email:
            return _err("邮箱格式无效")
        dup = (
            db.query(UserModel)
            .filter(UserModel.email == new_email, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该邮箱已被使用")
        if new_email != user.email:
            user.email = new_email
            user.email_verified = False
            user.email_verification_nonce = None
            user.email_verification_sent_at = None
    db.commit()
    db.refresh(user)
    # Audit: record the specific action taken.
    if body.is_admin is not None:
        action = "user_promote" if body.is_admin else "user_demote"
    elif body.is_active is not None:
        action = "user_enable" if body.is_active else "user_disable"
    elif body.username is not None or body.email is not None:
        action = "user_edit"
    else:
        action = None
    if action:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action=action,
            target_type="user",
            target_id=user_id,
            detail={"username": user.username or user.email},
            ip=_client_ip(request),
        )
    return _ok(user.to_dict())


@router.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if user_id == current_user.id:
        return _err("不能删除自己")
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    username = user.username or user.email
    db.delete(user)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_delete",
        target_type="user",
        target_id=user_id,
        detail={"username": username},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


class AdminResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=128)


@router.get("/api/admin/users/{user_id}")
def admin_get_user_detail(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """用户详情聚合：基本信息 + 笔记/计划计数 + 最近 5 条笔记 + 最近 3 条计划。"""
    from app.models.plan import Plan

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    notes_count = db.query(Note).filter(Note.user_id == user_id).count()
    plans_count = db.query(Plan).filter(Plan.user_id == user_id).count()
    recent_notes = (
        db.query(Note)
        .filter(Note.user_id == user_id)
        .order_by(Note.created_at.desc())
        .limit(5)
        .all()
    )
    recent_plans = (
        db.query(Plan)
        .filter(Plan.user_id == user_id)
        .order_by(Plan.created_at.desc())
        .limit(3)
        .all()
    )
    return _ok({
        **user.to_dict(),
        "notes_count": notes_count,
        "plans_count": plans_count,
        "recent_notes": [
            {
                "id": n.id,
                "video_title": n.video_title,
                "card_type": n.card_type,
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in recent_notes
        ],
        "recent_plans": [
            {
                "id": p.id,
                "title": p.title,
                "status": p.status,
                "total_days": p.total_days,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in recent_plans
        ],
    })


@router.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_user_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """管理员重置任意用户密码。新密码经 werkzeug 哈希后存储。"""
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    user.hashed_password = auth_service.hash_password(body.new_password)
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_reset_password",
        target_type="user",
        target_id=user_id,
        detail={"username": user.username or user.email},
        ip=_client_ip(request),
    )
    return _ok({"reset": True})


# ---------------------------------------------------------------------------
# Admin endpoints — runtime LLM/ASR configuration (no restart needed)
# ---------------------------------------------------------------------------
class LlmConfigRequest(BaseModel):
    provider: Literal["deepseek", "custom", "omniroute"] | None = None
    model: str | None = None
    api_base: str | None = None
    api_key: str | None = None  # None/empty = leave unchanged


class OmniRouteConfigRequest(BaseModel):
    api_base: str | None = None
    api_key: str | None = None  # None/empty = leave unchanged
    model: str | None = None
    dashboard_url: str | None = None


class AsrConfigRequest(BaseModel):
    api_key: str | None = None
    api_base_url: str | None = None
    model: str | None = None


class ExtractionConfigRequest(BaseModel):
    asr_concurrency: int = Field(
        ...,
        ge=1,
        le=settings_service.MAX_EXTRACTION_ASR_CONCURRENCY,
    )
    llm_concurrency: int = Field(
        ...,
        ge=1,
        le=settings_service.MAX_EXTRACTION_LLM_CONCURRENCY,
    )


class CreatorSyncConfigRequest(BaseModel):
    enabled: bool = False
    xhs_cookie: str | None = Field(default=None, max_length=16384)
    douyin_concurrency: int = Field(default=1, ge=1, le=4)
    bilibili_concurrency: int = Field(default=2, ge=1, le=4)
    xiaohongshu_concurrency: int = Field(default=1, ge=1, le=4)


class AgentV2ConfigRequest(BaseModel):
    enabled: bool = False
    rollout_percent: int = Field(default=0, ge=0, le=100)
    allowlist: list[str] = Field(default_factory=list, max_length=500)


class CreatorConnectorTestRequest(BaseModel):
    platform: Literal["douyin", "bilibili", "xiaohongshu"]
    profile_ref: str | None = Field(default=None, max_length=1024)


@router.get("/api/admin/llm-config")
def admin_get_llm_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_llm_config_masked(db))


@router.get("/api/admin/creator-sync-config")
def admin_get_creator_sync_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_creator_sync_config(db))


@router.get("/api/admin/agent-v2-config")
def admin_get_agent_v2_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_agent_v2_config(db))


@router.put("/api/admin/agent-v2-config")
def admin_put_agent_v2_config(
    body: AgentV2ConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    value = settings_service.set_agent_v2_config(
        db,
        enabled=body.enabled,
        rollout_percent=body.rollout_percent,
        allowlist=body.allowlist,
    )
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="agent_v2_config_update",
        target_type="config",
        target_id="agent-v2",
        detail={
            "enabled": value["enabled"],
            "rollout_percent": value["rollout_percent"],
            "allowlist_count": len(value["allowlist"]),
        },
        ip=_client_ip(request),
    )
    return _ok(value)


@router.put("/api/admin/creator-sync-config")
def admin_put_creator_sync_config(
    body: CreatorSyncConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    value = settings_service.set_creator_sync_config(
        db,
        enabled=body.enabled,
        xhs_cookie=body.xhs_cookie,
        douyin_concurrency=body.douyin_concurrency,
        bilibili_concurrency=body.bilibili_concurrency,
        xiaohongshu_concurrency=body.xiaohongshu_concurrency,
    )
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="creator_sync_config_update",
        target_type="config",
        target_id="creator-sync",
        detail={
            "enabled": value["enabled"],
            "concurrency": value["concurrency"],
            "xhs_cookie": "***updated***" if body.xhs_cookie else "unchanged",
        },
        ip=_client_ip(request),
    )
    return _ok(value)


@router.post("/api/admin/creator-sync-config/test")
def admin_test_creator_sync_connector(
    body: CreatorConnectorTestRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    config = settings_service.get_creator_sync_config(db, include_secret=True)
    tested_at = datetime.now(timezone.utc).isoformat()

    def catalog_readiness(platform: str, session_scope: str = "") -> dict:
        if platform not in {"douyin", "bilibili"}:
            return {
                "platform": platform,
                "healthy": True,
                "supports_catalog_all": False,
            }
        try:
            return creator_connectors.catalog_health(
                platform,
                douyin_session_scope=session_scope,
            )
        except Exception:
            return {
                "platform": platform,
                "healthy": False,
                "supports_catalog_all": False,
                "error_code": "catalog_health_failed",
            }

    if body.platform == "xiaohongshu" and not config.get("xhs_cookie"):
        settings_service.record_creator_connector_test(
            db, platform=body.platform, healthy=False, tested_at=tested_at
        )
        return _err("请先配置小红书专用服务账号 Cookie")
    if body.profile_ref:
        binding = (
            douyin_binding_service.get_or_create(db, current_user.id)
            if body.platform == "douyin"
            else None
        )
        try:
            preview = creator_connectors.resolve_creator(
                body.platform,
                body.profile_ref,
                douyin_session_scope=binding.session_scope if binding else "",
                xhs_cookie=str(config.get("xhs_cookie") or ""),
            )
        except creator_connectors.CreatorConnectorError as exc:
            settings_service.record_creator_connector_test(
                db, platform=body.platform, healthy=False, tested_at=tested_at
            )
            return _err(str(exc))
        catalog_state = catalog_readiness(
            body.platform,
            binding.session_scope if binding else "",
        )
        catalog_healthy = bool(catalog_state.get("supports_catalog_all"))
        settings_service.record_creator_connector_test(
            db,
            platform=body.platform,
            healthy=True,
            tested_at=tested_at,
            catalog_healthy=catalog_healthy if body.platform in {"douyin", "bilibili"} else None,
        )
        return _ok({
            "healthy": True,
            "catalog_healthy": catalog_healthy,
            "message": (
                "近期与全部作品连接器均可用"
                if catalog_healthy or body.platform == "xiaohongshu"
                else "近期作品可用；全部作品连接器尚未通过健康检查"
            ),
            "preview": preview,
            "catalog_health": catalog_state,
        })
    if body.platform == "douyin":
        binding = douyin_binding_service.get_or_create(db, current_user.id)
        state = douyin_library.connection_status(binding.session_scope)
        catalog_state = catalog_readiness("douyin", binding.session_scope)
        healthy = bool(state.get("connected"))
        catalog_healthy = bool(catalog_state.get("supports_catalog_all"))
        settings_service.record_creator_connector_test(
            db,
            platform=body.platform,
            healthy=healthy,
            tested_at=tested_at,
            catalog_healthy=catalog_healthy,
        )
        return _ok({
            "healthy": healthy,
            "platform": body.platform,
            "catalog_healthy": catalog_healthy,
            "message": (
                "近期与全部作品连接器均可用"
                if healthy and catalog_healthy
                else "近期作品可用；全部作品连接器尚未通过健康检查"
                if healthy
                else "抖音连接器不可用"
            ),
            "catalog_health": catalog_state,
        })
    if body.platform == "bilibili":
        recent_healthy = importlib.util.find_spec("yt_dlp") is not None
        catalog_state = catalog_readiness("bilibili")
        healthy = False
        catalog_healthy = False
        settings_service.record_creator_connector_test(
            db,
            platform=body.platform,
            healthy=healthy,
            tested_at=tested_at,
            catalog_healthy=catalog_healthy,
        )
        return _ok({
            "healthy": healthy,
            "platform": body.platform,
            "catalog_healthy": catalog_healthy,
            "message": (
                "请填写一个公开的 B站博主主页进行真实连接测试"
                if recent_healthy
                else "B站近期作品连接器不可用"
            ),
            "catalog_health": catalog_state,
        })
    settings_service.record_creator_connector_test(
        db, platform=body.platform, healthy=False, tested_at=tested_at
    )
    return _err("小红书需要填写一个公开视频博主主页进行真实测试")


@router.put("/api/admin/llm-config")
def admin_put_llm_config(
    body: LlmConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    current = settings_service.get_llm_config(db)
    provider = body.provider or current["provider"]
    model = body.model if body.model is not None else current["model"]
    api_base = body.api_base if body.api_base is not None else current["api_base"]
    try:
        normalized = settings_service.validate_llm_preset(
            provider,
            model,
            api_base,
        )
    except ValueError as exc:
        return _err(str(exc))
    if normalized["api_base"]:
        _validate_http_url(normalized["api_base"], "API Base")

    changed: dict = {}
    if normalized["provider"] != current["provider"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_PROVIDER_KEY,
            normalized["provider"],
        )
        changed["provider"] = normalized["provider"]
    if normalized["model"] != current["model"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_MODEL_KEY,
            normalized["model"],
        )
        changed["model"] = normalized["model"]
    if normalized["api_base"] != current["api_base"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_API_BASE_KEY,
            normalized["api_base"],
        )
        changed["api_base"] = normalized["api_base"]
    if body.api_key:  # empty string = leave unchanged
        settings_service.set_secret(db, settings_service.LLM_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="llm_config_update",
            target_type="config",
            target_id="llm",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_llm_config_masked(db))


@router.get("/api/admin/asr-config")
def admin_get_asr_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_asr_config_masked(db))


@router.put("/api/admin/asr-config")
def admin_put_asr_config(
    body: AsrConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if body.api_base_url:
        _validate_http_url(body.api_base_url, "API Base URL")
    changed: dict = {}
    if body.api_key:  # empty = leave unchanged
        settings_service.set_secret(db, settings_service.ASR_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if body.api_base_url is not None:
        settings_service.set_setting(db, settings_service.ASR_API_BASE_URL_KEY, body.api_base_url)
        changed["api_base_url"] = body.api_base_url
    if body.model is not None:
        settings_service.set_setting(db, settings_service.ASR_MODEL_KEY, body.model)
        changed["model"] = body.model
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="asr_config_update",
            target_type="config",
            target_id="asr",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_asr_config_masked(db))


@router.get("/api/admin/extraction-config")
def admin_get_extraction_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    values = settings_service.get_extraction_concurrency(db)
    return _ok({
        "asr_concurrency": values["asr"],
        "llm_concurrency": values["llm"],
        "max_asr_concurrency": settings_service.MAX_EXTRACTION_ASR_CONCURRENCY,
        "max_llm_concurrency": settings_service.MAX_EXTRACTION_LLM_CONCURRENCY,
        "max_batch_items": 100,
        "max_ai_batch_items": 50,
        "database_stores_media": False,
    })


@router.put("/api/admin/extraction-config")
def admin_put_extraction_config(
    body: ExtractionConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    values = settings_service.set_extraction_concurrency(
        db,
        asr=body.asr_concurrency,
        llm=body.llm_concurrency,
    )
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="extraction_config_update",
        target_type="config",
        target_id="library-extraction",
        detail=values,
        ip=_client_ip(request),
    )
    return _ok({
        "asr_concurrency": values["asr"],
        "llm_concurrency": values["llm"],
        "max_asr_concurrency": settings_service.MAX_EXTRACTION_ASR_CONCURRENCY,
        "max_llm_concurrency": settings_service.MAX_EXTRACTION_LLM_CONCURRENCY,
        "max_batch_items": 100,
        "max_ai_batch_items": 50,
        "database_stores_media": False,
    })


# ---------------------------------------------------------------------------
# Admin endpoints — note management
# ---------------------------------------------------------------------------
@router.get("/api/admin/notes")
def admin_list_notes(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    card_type: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = note_service.list_notes_admin(
        db, page=page, per_page=per_page, search=search, card_type=card_type
    )
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/notes/{note_id}")
def admin_delete_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    title = note.video_title if note else None
    if not note_service.delete_note(db, note_id):
        return _err("笔记不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_delete",
        target_type="note",
        target_id=note_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


@router.post("/api/admin/notes/{note_id}/re-extract")
def admin_re_extract_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return _err("笔记不存在")
    transcript = note.transcript_raw or ""
    if not transcript.strip():
        return _err("该笔记没有转录文本，无法重新抽取")
    # Re-run AI on the existing transcript with current LLM config.
    content_type = ai_juicer.detect_content_type(transcript)
    ai_result = ai_juicer.generate_card(transcript, content_type, note.video_title)
    note = note_service.update_note_ai(db, note, ai_result)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_reextract",
        target_type="note",
        target_id=note_id,
        detail={"title": note.video_title, "content_type": content_type},
        ip=_client_ip(request),
    )
    return _ok(note.to_dict())


class AdminBatchDeleteNotesRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=200)


@router.post("/api/admin/notes/batch-delete")
def admin_batch_delete_notes(
    body: AdminBatchDeleteNotesRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    deleted = 0
    titles: list[str] = []
    for nid in body.ids:
        note = db.query(Note).filter(Note.id == nid).first()
        if note:
            titles.append(note.video_title)
            db.delete(note)
            deleted += 1
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_batch_delete",
        target_type="note",
        target_id=",".join(body.ids[:8]),
        detail={"count": deleted, "titles": titles[:5]},
        ip=_client_ip(request),
    )
    return _ok({"deleted": deleted})


# ---------------------------------------------------------------------------
# Admin endpoints — user feedback
# ---------------------------------------------------------------------------
@router.get("/api/admin/feedback")
def admin_list_feedback(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status: Literal["pending", "processing", "resolved", "closed"] | None = Query(None),
    category: Literal["bug", "suggestion", "content", "account", "other"] | None = Query(None),
    q: str | None = Query(None, max_length=160),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total, counts = feedback_service.list_admin_feedback(
        db,
        page=page,
        per_page=per_page,
        status=status,
        category=category,
        q=q,
    )
    return _ok({
        "items": [
            feedback_service.to_dict(
                feedback,
                user=user,
                include_client_context=True,
            )
            for feedback, user in items
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
        "counts": counts,
    })


@router.patch("/api/admin/feedback/{feedback_id}")
def admin_update_feedback(
    feedback_id: str,
    body: AdminFeedbackUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if not body.model_fields_set:
        raise HTTPException(status_code=400, detail="请至少更新处理状态或回复内容")
    feedback = feedback_service.get_feedback(db, feedback_id)
    if not feedback:
        raise HTTPException(status_code=404, detail="反馈不存在")

    updated = feedback_service.update_feedback(
        db,
        feedback,
        status=body.status,
        admin_reply=body.admin_reply if "admin_reply" in body.model_fields_set else None,
        handled_by=current_user.id,
    )
    owner = db.query(UserModel).filter(UserModel.id == updated.user_id).first()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="feedback_update",
        target_type="feedback",
        target_id=feedback_id,
        detail={
            "status": updated.status,
            "has_reply": bool(updated.admin_reply),
            "subject": updated.subject[:80],
        },
        ip=_client_ip(request),
    )
    return _ok(
        feedback_service.to_dict(
            updated,
            user=owner,
            include_client_context=True,
        )
    )


# ---------------------------------------------------------------------------
# Admin endpoints — audit log viewer
# ---------------------------------------------------------------------------
@router.get("/api/admin/audit-logs")
def admin_list_audit_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = audit_service.list_audit_logs(
        db, page=page, per_page=per_page, action=action
    )
    # Join admin username for display.
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    return _ok({
        "items": [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.get("/api/admin/llm-usage")
def admin_get_llm_usage(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    model: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(llm_usage_service.get_usage_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        model=model,
    ))


@router.get("/api/admin/user-activity")
def admin_get_user_activity(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    user_id: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(activity_service.get_activity_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        action=action,
        user_id=user_id,
    ))


@router.get("/api/admin/error-logs")
def admin_get_error_logs(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    source: str | None = Query(None),
    severity: str | None = Query(None),
    status_code: int | None = Query(None, ge=400, le=599),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(error_log_service.get_error_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        source=source,
        severity=severity,
        status_code=status_code,
    ))


# ---------------------------------------------------------------------------
# Admin endpoints — plan management
# ---------------------------------------------------------------------------
@router.get("/api/admin/plans")
def admin_list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按标题模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan

    query = db.query(Plan)
    if q:
        query = query.filter(Plan.title.ilike(f"%{q.strip()}%"))
    total = query.count()
    plans = (
        query.order_by(Plan.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    user_ids = {p.user_id for p in plans if p.user_id}
    user_map: dict[str, str] = {}
    if user_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
        user_map = {r.id: (r.username or r.email) for r in rows}
    items = [{
        "id": p.id,
        "title": p.title,
        "user_id": p.user_id,
        "author": user_map.get(p.user_id, ""),
        "status": p.status,
        "total_days": p.total_days,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    } for p in plans]
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/plans/{plan_id}")
def admin_delete_plan(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    plan = plan_service.get_plan(db, plan_id)
    title = plan.title if plan else None
    if not plan_service.delete_plan(db, plan_id):
        return _err("计划不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="plan_delete",
        target_type="plan",
        target_id=plan_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


# ---------------------------------------------------------------------------
# Admin endpoints — config connection test
# ---------------------------------------------------------------------------
@router.post("/api/admin/llm-config/test")
def admin_test_llm_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current LLM config with a minimal completion request."""
    cfg = settings_service.get_llm_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    try:
        from litellm import completion
        kwargs: dict = {
            "model": cfg["runtime_model"],
            "messages": [{"role": "user", "content": "请只回复两个字：成功"}],
            "max_tokens": 16,
            "timeout": 20,
            # Connection tests must fail fast. LiteLLM/provider retries can
            # otherwise keep an admin request open for several minutes after
            # the configured timeout (for example on an exhausted account).
            "num_retries": 0,
        }
        if cfg["api_base"]:
            kwargs["api_base"] = cfg["api_base"]
        kwargs["api_key"] = cfg["api_key"]
        resp = completion(**kwargs)
        llm_usage_service.record_response_usage(
            resp,
            provider=cfg["provider"],
            model=cfg["model"],
            operation="admin_llm_test",
        )
        reply = (resp.choices[0].message.content or "").strip()
        audit_service.log_action(
            db, admin_user_id=current_user.id, action="llm_config_test",
            target_type="config", target_id="llm", ip=_client_ip(request),
        )
        return _ok({"ok": True, "reply": reply[:80], "model": cfg["model"]})
    except Exception as e:
        error_log_service.record_exception_safely(
            e,
            source="llm",
            status_code=502,
            method="POST",
            path="/api/admin/llm-config/test",
            user_id=current_user.id,
            ip=_client_ip(request),
            metadata={
                "provider": cfg["provider"],
                "model": cfg["model"],
                "operation": "admin_llm_test",
            },
        )
        return _ok({"ok": False, "error": str(e)[:200]})


def _asr_probe_wav() -> bytes:
    """Build a tiny valid WAV so providers test auth and decoding, not EOF."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\x00\x00" * 4_000)
    return buffer.getvalue()


@router.post("/api/admin/asr-config/test")
def admin_test_asr_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current ASR config by probing the endpoint with the configured key.

    A 400/422 means the key was accepted (auth ok) and only the probe payload
    was rejected — that counts as a pass. 401/403 means the key is invalid.
    """
    cfg = settings_service.get_asr_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    if not cfg["api_base_url"]:
        return _ok({"ok": False, "error": "未配置 API Base URL"})
    try:
        headers = {"Authorization": f"Bearer {cfg['api_key']}"}
        files = {
            "file": ("test.wav", _asr_probe_wav(), "audio/wav"),
            "model": (None, cfg["model"]),
        }
        r = http_requests.post(cfg["api_base_url"], headers=headers, files=files, timeout=20)
        if r.status_code in (401, 403):
            return _ok({"ok": False, "error": f"API Key 无效 (HTTP {r.status_code})", "status": r.status_code})
        if r.status_code in (400, 422):
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "Key 有效（空音频被拒绝属正常）", "status": r.status_code})
        if r.status_code == 200:
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "连接成功", "status": 200})
        return _ok({"ok": False, "error": f"HTTP {r.status_code}: {r.text[:120]}", "status": r.status_code})
    except Exception as e:
        error_log_service.record_exception_safely(
            e,
            source="asr",
            status_code=502,
            method="POST",
            path="/api/admin/asr-config/test",
            user_id=current_user.id,
            ip=_client_ip(request),
            metadata={
                "model": cfg["model"],
                "operation": "admin_asr_test",
            },
        )
        return _ok({"ok": False, "error": str(e)[:200]})


# ---------------------------------------------------------------------------
# Admin endpoints — system info (read-only, no secrets exposed)
# ---------------------------------------------------------------------------
@router.get("/api/admin/system-info")
def admin_system_info(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Read-only system info for the settings page. Secret keys are reported
    only as booleans (set / not set), never plaintext."""
    from app.models.plan import Plan

    db_type = "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite"
    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    return _ok({
        "db_type": db_type,
        "llm_model": llm_cfg["model"],
        "llm_api_base": llm_cfg["api_base"] or "(官方默认)",
        "llm_key_set": bool(llm_cfg["api_key_masked"]),
        "asr_model": asr_cfg["model"],
        "asr_api_base_url": asr_cfg["api_base_url"],
        "asr_key_set": bool(asr_cfg["api_key_masked"]),
        "encryption_key_set": bool(settings.ENCRYPTION_KEY),
        "jwt_secret_set": bool(settings.JWT_SECRET),
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
    })


# ---------------------------------------------------------------------------
# Admin endpoints — operations dashboard (health + table counts + recent audit)
# ---------------------------------------------------------------------------
@router.get("/api/admin/ops")
def admin_ops(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """运维概览：各表行数、最近 5 条审计、密钥配置状态。只读，不暴露明文。"""
    from app.models.plan import Plan
    from app.models.admin_audit_log import AdminAuditLog
    from app.models.llm_usage_log import LlmUsageLog
    from app.models.user_activity_log import UserActivityLog
    from app.models.application_error_log import ApplicationErrorLog

    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    items, _ = audit_service.list_audit_logs(db, page=1, per_page=5)
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    recent = [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items]

    return _ok({
        "table_counts": {
            "users": count_users(db),
            "notes": db.query(Note).count(),
            "plans": db.query(Plan).count(),
            "audit_logs": db.query(AdminAuditLog).count(),
            "llm_usage_logs": db.query(LlmUsageLog).count(),
            "user_activity_logs": db.query(UserActivityLog).count(),
            "application_error_logs": db.query(ApplicationErrorLog).count(),
        },
        "recent_audit": recent,
        "keys": {
            "llm_key_set": bool(llm_cfg["api_key_masked"]),
            "asr_key_set": bool(asr_cfg["api_key_masked"]),
            "encryption_key_set": bool(settings.ENCRYPTION_KEY),
            "jwt_secret_set": bool(settings.JWT_SECRET),
        },
        "db_type": "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite",
    })
