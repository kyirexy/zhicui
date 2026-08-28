"""按需视频详细解析的纯执行引擎。

本模块刻意不创建任务、不报价也不直接修改账本。持久任务服务负责授权与
结算，本模块只在任务级临时目录中完成媒体下载、镜头检测、关键帧采样和
可选视觉模型调用，并返回不含媒体地址、文件路径或图片数据的结构化结果。
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import inspect
import json
import math
import os
import re
import shutil
import socket
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol, Sequence
from urllib.parse import urljoin, urlparse

from app.core.config import settings


SCENE_ADAPTIVE_THRESHOLD = 3.5
SCENE_MIN_SECONDS = 0.6
SCENE_WINDOW_WIDTH = 3
SCENE_MIN_CONTENT_VAL = 15.0

LOCAL_SCENE_FRAME_BUDGET = 8
VLM_MIN_FRAME_BUDGET = 8
VLM_MAX_FRAME_BUDGET = 24
MAX_FRAMES_PER_VLM_CALL = 8
LONG_SCENE_SUPPLEMENT_SECONDS = 10.0

SUPPORTED_VIDEO_PLATFORMS = {"douyin", "bilibili", "xiaohongshu"}
SUPPORTED_ANALYSIS_METHODS = {"local_scene", "scene_frames_vlm", "native_video"}

_SAFE_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
_MAX_PERSISTED_SCENES = 500
_MAX_OBSERVATIONS = 96
_DOWNLOAD_HOOK_LOCK = threading.Lock()
_ACTIVE_WORKSPACES_LOCK = threading.Lock()
_ACTIVE_WORKSPACES: set[Path] = set()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class VideoAnalysisError(RuntimeError):
    """带稳定安全错误码的解析错误，不在消息中包含上游原始详情。"""

    code = "video_analysis_error"

    def __init__(self, message: str = "视频详细解析失败") -> None:
        super().__init__(message[:240])


class MediaNotEligibleError(VideoAnalysisError):
    code = "media_not_eligible"


class MediaDownloadError(VideoAnalysisError):
    code = "media_download_failed"


class MediaProbeError(VideoAnalysisError):
    code = "media_probe_failed"


class MediaDurationLimitError(VideoAnalysisError):
    code = "media_duration_unsupported"


class VisionDriverUnavailableError(VideoAnalysisError):
    code = "vision_driver_unavailable"


class VisionProviderCallError(VideoAnalysisError):
    code = "vision_provider_failed"


class ByokConfigurationError(VideoAnalysisError):
    code = "byok_configuration_invalid"


class AnalysisCancelled(VideoAnalysisError):
    code = "analysis_cancelled"

    def __init__(
        self,
        message: str = "视频详细解析已取消",
        *,
        result_usage: Mapping[str, int] | None = None,
        partial_result: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.result_usage = dict(result_usage or {})
        self.partial_result = dict(partial_result or {}) if partial_result else None


class AnalysisReauthorizationRequired(VideoAnalysisError):
    code = "reauthorization_required"

    def __init__(self, verified_duration_ms: int) -> None:
        super().__init__("视频实际时长超过报价授权范围，需要重新确认")
        self.verified_duration_ms = max(0, int(verified_duration_ms or 0))


@dataclass(frozen=True)
class MediaEligibility:
    eligible: bool
    platform: str
    media_type: str
    reason_code: str = ""


@dataclass(frozen=True, repr=False)
class MediaDownloadRequest:
    """仅在一次 worker 执行期间存在的媒体下载能力。"""

    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    duration_ms: int = 0
    source_fingerprint: str = ""
    suffix: str = ".mp4"
    allow_private_network: bool = False


@dataclass(frozen=True, repr=False)
class DownloadedMedia:
    path: Path
    duration_ms: int
    source_fingerprint: str
    byte_count: int


@dataclass(frozen=True)
class SceneBoundary:
    index: int
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class SceneDetection:
    scenes: tuple[SceneBoundary, ...]
    duration_ms: int
    method: str
    degraded_reason: str = ""


@dataclass(frozen=True, repr=False)
class FrameSample:
    index: int
    scene_index: int
    timestamp_ms: int
    jpeg_bytes: bytes


@dataclass
class DriverUsage:
    calls: int = 0
    image_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    provider_units: int = 0
    platform_cost_micros: int = 0
    failure_cost_micros: int = 0

    def add(self, other: "DriverUsage") -> None:
        for name in (
            "calls",
            "image_count",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "provider_units",
            "platform_cost_micros",
            "failure_cost_micros",
        ):
            setattr(self, name, max(0, int(getattr(self, name))) + max(0, int(getattr(other, name))))

    def to_dict(self) -> dict[str, int]:
        return {
            "calls": max(0, int(self.calls)),
            "image_count": max(0, int(self.image_count)),
            "prompt_tokens": max(0, int(self.prompt_tokens)),
            "completion_tokens": max(0, int(self.completion_tokens)),
            "total_tokens": max(0, int(self.total_tokens)),
            "provider_units": max(0, int(self.provider_units)),
            "platform_cost_micros": max(0, int(self.platform_cost_micros)),
            "failure_cost_micros": max(0, int(self.failure_cost_micros)),
        }


@dataclass(frozen=True)
class ImageDriverResult:
    observations: tuple[Mapping[str, Any], ...]
    usage: DriverUsage


@dataclass(frozen=True)
class NativeDriverResult:
    payload: Mapping[str, Any]
    usage: DriverUsage


@dataclass(frozen=True)
class AnalysisOutcome:
    status: str
    result_payload: dict[str, Any]
    scene_count: int
    frame_count: int
    duration_ms: int
    degraded_reason: str
    result_usage: dict[str, int]


CancelCheck = Callable[[], bool]
StageCallback = Callable[[str], None]
MediaDownloadHook = Callable[..., DownloadedMedia | MediaDownloadRequest | Mapping[str, Any] | str | Path]


class ImageVLMDriver(Protocol):
    def analyze_frames(
        self,
        frames: Sequence[FrameSample],
        *,
        provider_config: Mapping[str, Any],
        video_title: str,
        transcript: str,
        batch_index: int,
        batch_count: int,
    ) -> ImageDriverResult: ...


class NativeVideoDriver(Protocol):
    def analyze_video(
        self,
        media: DownloadedMedia,
        *,
        provider_config: Mapping[str, Any],
        video_title: str,
        transcript: str,
    ) -> NativeDriverResult: ...


_REGISTERED_DOWNLOAD_HOOK: MediaDownloadHook | None = None
_IMAGE_DRIVERS: dict[str, ImageVLMDriver] = {}
_NATIVE_VIDEO_DRIVERS: dict[str, NativeVideoDriver] = {}


def register_media_download_hook(hook: MediaDownloadHook | None) -> None:
    """注册运行时媒体解析 hook；hook 返回值不得被写入数据库或日志。"""
    global _REGISTERED_DOWNLOAD_HOOK
    with _DOWNLOAD_HOOK_LOCK:
        _REGISTERED_DOWNLOAD_HOOK = hook


def register_image_driver(name: str, driver: ImageVLMDriver) -> None:
    clean_name = str(name or "").strip().lower()
    if not clean_name:
        raise ValueError("图片视觉驱动名称不能为空")
    _IMAGE_DRIVERS[clean_name] = driver


def register_native_video_driver(name: str, driver: NativeVideoDriver) -> None:
    clean_name = str(name or "").strip().lower()
    if not clean_name:
        raise ValueError("原生视频驱动名称不能为空")
    _NATIVE_VIDEO_DRIVERS[clean_name] = driver


def native_video_driver_installed(name: str | None = None) -> bool:
    """供 Offering 发布校验使用；首版默认没有原生视频驱动。"""
    if name:
        return str(name).strip().lower() in _NATIVE_VIDEO_DRIVERS
    return bool(_NATIVE_VIDEO_DRIVERS)


def validate_analysis_method(
    method: str,
    *,
    driver_name: str = "",
) -> None:
    clean_method = str(method or "").strip().lower()
    if clean_method not in SUPPORTED_ANALYSIS_METHODS:
        raise ValueError("不支持的视频解析方法")
    if clean_method == "native_video" and not native_video_driver_installed(driver_name or None):
        raise VisionDriverUnavailableError("原生视频解析驱动尚未安装或未通过校验")


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _value(source: Any, key: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(key, default)
    return getattr(source, key, default)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return {}
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _context_note(context: Mapping[str, Any]) -> Any:
    return context.get("note") or context.get("source_note")


def _source_meta(source: Any) -> dict[str, Any]:
    explicit = _value(source, "source_meta")
    if isinstance(explicit, Mapping):
        return dict(explicit)
    payload = _json_object(_value(source, "ai_summary"))
    nested = payload.get("source_meta")
    return dict(nested) if isinstance(nested, Mapping) else {}


def _duration_value_ms(value: Any, *, multiplier: int) -> int:
    """仅接受有明确单位的平台元数据，不从文案或文件大小猜测时长。"""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(numeric) or numeric <= 0:
        return 0
    milliseconds = int(round(numeric * multiplier))
    # 防止恶意/损坏元数据制造无界整数；此上限不是 Offering 限制。
    return milliseconds if milliseconds <= 30 * 24 * 60 * 60 * 1000 else 0


def _explicit_metadata_duration_ms(value: Mapping[str, Any]) -> int:
    for key in (
        "duration_ms",
        "video_duration_ms",
        "source_duration_ms",
        "duration_milliseconds",
    ):
        duration = _duration_value_ms(value.get(key), multiplier=1)
        if duration:
            return duration
    for key in ("duration_seconds", "video_duration_seconds"):
        duration = _duration_value_ms(value.get(key), multiplier=1000)
        if duration:
            return duration
    return 0


def _source_metadata_duration_ms(value: Mapping[str, Any]) -> int:
    duration = _explicit_metadata_duration_ms(value)
    if duration:
        return duration
    # Note.source_meta 的旧字段 duration 契约是秒，与服务层保持一致。
    return _duration_value_ms(value.get("duration"), multiplier=1000)


def _douyin_router_duration_ms(payload: Mapping[str, Any]) -> int:
    loader_data = payload.get("loaderData")
    if not isinstance(loader_data, Mapping):
        return 0
    for page in loader_data.values():
        if not isinstance(page, Mapping):
            continue
        info = page.get("videoInfoRes")
        if not isinstance(info, Mapping):
            continue
        items = info.get("item_list")
        if not isinstance(items, list) or not items or not isinstance(items[0], Mapping):
            continue
        item = items[0]
        video = item.get("video")
        if isinstance(video, Mapping):
            duration = _duration_value_ms(video.get("duration"), multiplier=1)
            if duration:
                return duration
        duration = _duration_value_ms(item.get("duration"), multiplier=1)
        if duration:
            return duration
    return 0


def _trusted_douyin_host(url: str) -> bool:
    hostname = (urlparse(str(url or "")).hostname or "").lower()
    return any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffix in ("douyin.com", "iesdouyin.com")
    )


def _probe_douyin_page_duration_ms(source_url: str) -> int:
    """只请求抖音作品页 JSON，不请求 play_addr 媒体流。"""
    if not source_url or not _trusted_douyin_host(source_url):
        return 0
    import requests

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 Chrome/124 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml",
    }
    connect_timeout = max(
        1, min(15, int(getattr(settings, "VIDEO_ANALYSIS_DOWNLOAD_CONNECT_TIMEOUT_SECONDS", 10)))
    )
    candidates = [source_url]
    session = requests.Session()
    session.trust_env = False
    try:
        for index, candidate in enumerate(candidates):
            response = session.get(
                candidate,
                headers=headers,
                timeout=(connect_timeout, 20),
                allow_redirects=True,
            )
            response.raise_for_status()
            if not _trusted_douyin_host(response.url):
                return 0
            match = re.search(r"window\._ROUTER_DATA\s*=\s*(.*?)</script>", response.text, re.DOTALL)
            if match:
                try:
                    parsed = json.loads(match.group(1).strip())
                except (TypeError, json.JSONDecodeError):
                    parsed = None
                if isinstance(parsed, Mapping):
                    duration = _douyin_router_duration_ms(parsed)
                    if duration:
                        return duration
            # 短链页可能只负责跳转；用解出的数字 ID 请求一次官方元数据页。
            if index == 0:
                id_match = re.search(r"/(?:video|note)/(\d+)", response.url)
                if id_match:
                    canonical = f"https://www.iesdouyin.com/share/video/{id_match.group(1)}"
                    if canonical not in candidates:
                        candidates.append(canonical)
        return 0
    except Exception:
        return 0
    finally:
        session.close()


def probe_note_duration_ms(note: Any) -> int:
    """用可信平台元数据为报价探测时长，不下载或 ffprobe 远程媒体。

    返回 0 表示时长不可信/不可用；调用方必须将它处理为
    ``duration_unknown``，不得用 Offering 最大时长代替真实时长报价。
    """
    meta = _source_meta(note)
    known = _source_metadata_duration_ms(meta)
    if known:
        return known

    platform = str(meta.get("platform") or "").strip().lower()
    source_url = str(meta.get("source_url") or _value(note, "video_url", "") or "").strip()
    if not platform:
        try:
            from app.services.video_extractor import _detect_platform

            platform = str(_detect_platform(source_url) or "").strip().lower()
        except Exception:
            return 0
    if platform not in SUPPORTED_VIDEO_PLATFORMS:
        return 0

    if platform == "douyin":
        # 本地平台库若已保存时长则优先使用；仅读 manifest。
        if meta.get("source_kind") == "douyin-library":
            try:
                from app.core.database import SessionLocal
                from app.models.douyin_account_binding import DouyinAccountBinding
                from app.services import douyin_library

                user_id = str(_value(note, "user_id", "") or "")
                with SessionLocal() as db:
                    binding = (
                        db.query(DouyinAccountBinding)
                        .filter(DouyinAccountBinding.user_id == user_id)
                        .first()
                    )
                    item = (
                        douyin_library.get_item(
                            binding.session_scope,
                            binding.id,
                            str(_value(note, "video_id", "") or ""),
                        )
                        if binding is not None
                        else None
                    )
                if isinstance(item, Mapping):
                    duration = _explicit_metadata_duration_ms(item)
                    if duration:
                        return duration
            except Exception:
                pass
        return _probe_douyin_page_duration_ms(source_url)

    if platform == "bilibili":
        try:
            from app.services import video_extractor

            info = video_extractor._parse_bilibili(source_url)
            return _duration_value_ms(info.get("duration"), multiplier=1000)
        except Exception:
            return 0

    # XHS-Downloader 此请求显式 download=false；只有明确单位的
    # 元数据字段才可进入报价，否则返回 duration_unknown。
    try:
        from app.services.xhs_downloader_client import fetch_xhs_detail

        detail = fetch_xhs_detail(
            source_url,
            cookie=str(getattr(settings, "XHS_COOKIE", "") or ""),
        )
        return _explicit_metadata_duration_ms(detail)
    except Exception:
        return 0


def assess_media_eligibility(source: Any) -> MediaEligibility:
    """判定 Note/执行上下文是否代表可手动详细解析的视频。"""
    source_map = _mapping(source)
    note = source_map.get("note") or source_map.get("source_note") or source
    meta = {}
    for candidate in (
        _mapping(source_map.get("source")),
        _mapping(source_map.get("media")),
        _mapping(source_map.get("source_meta")),
        _source_meta(note),
    ):
        meta.update(candidate)

    platform = str(
        source_map.get("platform")
        or meta.get("platform")
        or _value(note, "platform", "")
        or ""
    ).strip().lower()
    media_type = str(
        source_map.get("media_type")
        or meta.get("media_type")
        or _value(note, "media_type", "")
        or ""
    ).strip().lower()

    if platform not in SUPPORTED_VIDEO_PLATFORMS:
        return MediaEligibility(False, platform, media_type, "unsupported_platform")
    if media_type in {"image", "images", "article", "note", "gallery", "text"}:
        return MediaEligibility(False, platform, media_type, "not_video_media")
    # 小红书同时承载图文和视频，空类型不得被猜成视频。
    if platform == "xiaohongshu" and media_type != "video":
        return MediaEligibility(False, platform, media_type, "not_video_media")
    return MediaEligibility(True, platform, media_type or "video")


def ensure_media_eligible(source: Any) -> MediaEligibility:
    eligibility = assess_media_eligibility(source)
    if not eligibility.eligible:
        raise MediaNotEligibleError("当前资料不是可详细解析的视频")
    return eligibility


def build_source_fingerprint(source: Any, *, duration_ms: int = 0) -> str:
    """只用稳定作品元数据生成缓存指纹，不把签名 URL 纳入键。"""
    source_map = _mapping(source)
    note = source_map.get("note") or source_map.get("source_note") or source
    meta = _source_meta(note)
    transcript = str(
        source_map.get("transcript")
        or _value(note, "transcript_raw", "")
        or ""
    )
    stable = {
        "platform": source_map.get("platform") or meta.get("platform") or "",
        "video_id": source_map.get("video_id") or _value(note, "video_id", ""),
        "media_version": source_map.get("media_version") or meta.get("media_version") or "",
        "duration_ms": max(0, int(duration_ms or source_map.get("source_duration_ms") or 0)),
        # Updating ai_summary after a successful analysis also updates the Note
        # row timestamp.  A wall-clock field would therefore invalidate the
        # cache immediately and could charge the same video twice.  Transcript
        # content is stable across summary refreshes while still invalidating a
        # result after a real ASR/re-extraction change.
        "transcript_sha256": hashlib.sha256(
            transcript.encode("utf-8")
        ).hexdigest(),
    }
    raw = json.dumps(stable, ensure_ascii=True, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@contextmanager
def temporary_media_workspace() -> Iterator[Path]:
    """创建权限收紧的任务目录，并在所有退出路径递归清理。"""
    workspace = Path(tempfile.mkdtemp(prefix="zhicui-video-analysis-")).resolve()
    active_marker = workspace / ".active"
    heartbeat_stop = threading.Event()

    def refresh_marker() -> None:
        while not heartbeat_stop.wait(30):
            try:
                active_marker.touch(exist_ok=True)
            except OSError:
                return

    try:
        try:
            os.chmod(workspace, 0o700)
        except OSError:
            pass
        active_marker.touch(exist_ok=True)
        with _ACTIVE_WORKSPACES_LOCK:
            _ACTIVE_WORKSPACES.add(workspace)
        heartbeat = threading.Thread(
            target=refresh_marker,
            name=f"video-analysis-temp-{workspace.name[-8:]}",
            daemon=True,
        )
        heartbeat.start()
        yield workspace
    finally:
        heartbeat_stop.set()
        heartbeat = locals().get("heartbeat")
        if isinstance(heartbeat, threading.Thread):
            heartbeat.join(timeout=2)
        with _ACTIVE_WORKSPACES_LOCK:
            _ACTIVE_WORKSPACES.discard(workspace)
        shutil.rmtree(workspace, ignore_errors=True)


def cleanup_stale_media_workspaces(*, max_age_minutes: int = 60) -> int:
    """Remove only abandoned task directories created by this engine.

    A process crash can bypass the context manager's ``finally`` block.  The
    recovery loop calls this bounded cleaner; it never follows a directory
    outside the operating-system temp root and never touches a non-prefixed
    path.
    """
    root = Path(tempfile.gettempdir()).resolve()
    cutoff = time.time() - max(5, min(int(max_age_minutes or 60), 1440)) * 60
    removed = 0
    try:
        candidates = list(root.iterdir())
    except OSError:
        return 0
    for candidate in candidates:
        if not candidate.name.startswith("zhicui-video-analysis-"):
            continue
        try:
            resolved = candidate.resolve()
            if resolved.parent != root or not resolved.is_dir():
                continue
            with _ACTIVE_WORKSPACES_LOCK:
                if resolved in _ACTIVE_WORKSPACES:
                    continue
            active_marker = resolved / ".active"
            if active_marker.is_file() and active_marker.stat().st_mtime >= cutoff:
                continue
            if resolved.stat().st_mtime >= cutoff:
                continue
            shutil.rmtree(resolved)
            removed += 1
        except OSError:
            continue
    return removed


def _inside_workspace(path: Path, workspace: Path) -> bool:
    try:
        path.resolve().relative_to(workspace.resolve())
        return True
    except (OSError, ValueError):
        return False


def _safe_suffix(value: str) -> str:
    suffix = Path(str(value or "")).suffix.lower()
    return suffix if suffix in _SAFE_SUFFIXES else ".mp4"


def _safe_positive_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return max(0, int(default))


def _check_cancel(cancel_check: CancelCheck | None) -> None:
    if cancel_check and cancel_check():
        raise AnalysisCancelled()


def _call_download_hook(
    hook: MediaDownloadHook,
    context: Mapping[str, Any],
    workspace: Path,
    cancel_check: CancelCheck | None,
) -> Any:
    """兼容窄 hook 逐步演进，同时不把运行时媒体能力序列化。"""
    try:
        signature = inspect.signature(hook)
    except (TypeError, ValueError):
        return hook(context, workspace, cancel_check)
    parameters = signature.parameters
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in parameters.values()):
        return hook(context=context, workspace=workspace, cancel_check=cancel_check)
    kwargs = {
        key: value
        for key, value in {
            "context": context,
            "workspace": workspace,
            "cancel_check": cancel_check,
        }.items()
        if key in parameters
    }
    if kwargs:
        return hook(**kwargs)
    positional_count = len(
        [
            param
            for param in parameters.values()
            if param.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
        ]
    )
    return hook(*[context, workspace, cancel_check][:positional_count])


def _request_from_mapping(value: Mapping[str, Any]) -> MediaDownloadRequest | None:
    url = str(value.get("media_url") or value.get("url") or value.get("download_url") or "").strip()
    if not url:
        return None
    headers = value.get("headers") or value.get("request_headers") or {}
    return MediaDownloadRequest(
        url=url,
        headers={str(key): str(item) for key, item in _mapping(headers).items()},
        duration_ms=_safe_positive_int(value.get("duration_ms") or value.get("source_duration_ms")),
        source_fingerprint=str(value.get("source_fingerprint") or ""),
        suffix=_safe_suffix(str(value.get("suffix") or urlparse(url).path)),
        allow_private_network=bool(value.get("allow_private_network")),
    )


def _default_media_request(context: Mapping[str, Any]) -> MediaDownloadRequest:
    for candidate in (
        _mapping(context.get("media_request")),
        _mapping(context.get("resolved_media")),
        _mapping(context.get("media")),
        context,
    ):
        request = _request_from_mapping(candidate)
        if request:
            return request

    note_id = str(context.get("note_id") or _value(_context_note(context), "id", "")).strip()
    user_id = str(context.get("user_id") or _value(_context_note(context), "user_id", "")).strip()
    if not note_id or not user_id:
        raise MediaDownloadError("任务没有可用的媒体解析能力")
    return _resolve_note_media_request(note_id=note_id, user_id=user_id)


def _resolve_note_media_request(*, note_id: str, user_id: str) -> MediaDownloadRequest:
    """按平台在执行时刷新媒体地址；地址和 Cookie 只停留在当前调用栈。"""
    from app.core.database import SessionLocal
    from app.models.note import Note

    with SessionLocal() as db:
        note = db.query(Note).filter(Note.id == note_id, Note.user_id == user_id).first()
        if note is None:
            raise MediaNotEligibleError("视频资料不存在或无权访问")
        eligibility = ensure_media_eligible(note)
        meta = _source_meta(note)
        source_fingerprint = build_source_fingerprint(note)
        source_url = str(meta.get("source_url") or note.video_url or "").strip()
        duration_ms = _safe_positive_int(meta.get("duration_ms"))

        if eligibility.platform == "douyin" and meta.get("source_kind") == "douyin-library":
            from app.models.douyin_account_binding import DouyinAccountBinding
            from app.services import douyin_library

            binding = (
                db.query(DouyinAccountBinding)
                .filter(DouyinAccountBinding.user_id == user_id)
                .first()
            )
            if binding is None:
                raise MediaDownloadError("抖音登录会话不可用，请重新连接账号")
            return MediaDownloadRequest(
                url=douyin_library.companion_media_url(note.video_id),
                headers=douyin_library.companion_headers(binding.session_scope),
                duration_ms=duration_ms,
                source_fingerprint=source_fingerprint,
                suffix=".mp4",
                allow_private_network=True,
            )

    if eligibility.platform == "bilibili":
        from app.services import video_extractor

        info = video_extractor._parse_bilibili(source_url)
        media_url = str(info.get("media_url") or info.get("download_url") or "").strip()
        if not media_url:
            raise MediaDownloadError("B站暂时没有返回可用视频流")
        return MediaDownloadRequest(
            url=media_url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.bilibili.com/",
            },
            duration_ms=_safe_positive_int(float(info.get("duration") or 0) * 1000) or duration_ms,
            source_fingerprint=source_fingerprint,
            suffix=_safe_suffix(urlparse(media_url).path),
        )

    if eligibility.platform == "xiaohongshu":
        media_url = str(meta.get("media_url") or "").strip()
        if not media_url:
            try:
                from app.core.config import settings as runtime_settings
                from app.services.xhs_downloader_client import fetch_xhs_detail

                detail = fetch_xhs_detail(source_url, cookie=runtime_settings.XHS_COOKIE)
                media_url = str(detail.get("media_url") or "").strip()
            except Exception as exc:
                raise MediaDownloadError("小红书视频地址已失效，请重新同步该作品") from exc
        if not media_url:
            raise MediaDownloadError("小红书作品没有可用视频流")
        return MediaDownloadRequest(
            url=media_url,
            headers={
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)",
                "Referer": "https://www.xiaohongshu.com/",
            },
            duration_ms=duration_ms,
            source_fingerprint=source_fingerprint,
            suffix=_safe_suffix(urlparse(media_url).path),
        )

    if not source_url:
        raise MediaDownloadError("视频来源地址不可用")
    from app.services import video_extractor

    info = video_extractor.parse_video_info(source_url)
    media_url = str(info.get("download_url") or info.get("url") or "").strip()
    if not media_url:
        raise MediaDownloadError("平台暂时没有返回可用视频流")
    return MediaDownloadRequest(
        url=media_url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": source_url},
        duration_ms=duration_ms,
        source_fingerprint=source_fingerprint,
        suffix=_safe_suffix(urlparse(media_url).path),
    )


def _validate_download_url(url: str, *, allow_private_network: bool) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise MediaDownloadError("媒体下载地址无效")
    hostname = parsed.hostname.lower()
    if allow_private_network:
        return
    if hostname == "localhost":
        raise MediaDownloadError("媒体下载地址不在允许范围内")
    try:
        resolved = {
            item[4][0]
            for item in socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        }
    except OSError as exc:
        raise MediaDownloadError("无法解析媒体下载地址") from exc
    for raw_address in resolved:
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError:
            raise MediaDownloadError("媒体下载地址无效")
        if not address.is_global:
            raise MediaDownloadError("媒体下载地址不在允许范围内")


def _download_request_to_workspace(
    request: MediaDownloadRequest,
    workspace: Path,
    cancel_check: CancelCheck | None,
    *,
    configured_max_bytes: int = 0,
) -> DownloadedMedia:
    import requests

    _validate_download_url(request.url, allow_private_network=request.allow_private_network)
    global_max_bytes = max(
        1,
        int(
            getattr(
                settings,
                "VIDEO_ANALYSIS_MAX_DOWNLOAD_BYTES",
                800 * 1024 * 1024,
            )
        ),
    )
    max_bytes = (
        min(global_max_bytes, max(1, int(configured_max_bytes)))
        if int(configured_max_bytes or 0) > 0
        else global_max_bytes
    )
    connect_timeout = max(1, int(getattr(settings, "VIDEO_ANALYSIS_DOWNLOAD_CONNECT_TIMEOUT_SECONDS", 10)))
    read_timeout = max(5, int(getattr(settings, "VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_SECONDS", 300)))
    part_path = workspace / f"source{_safe_suffix(request.suffix)}.part"
    final_path = workspace / f"source{_safe_suffix(request.suffix)}"
    digest = hashlib.sha256()
    byte_count = 0
    current_url = request.url
    current_headers = dict(request.headers)
    has_sidecar_scope = any(
        str(key).lower() == "x-zhicui-scope"
        for key in current_headers
    )
    if has_sidecar_scope:
        scoped_target = urlparse(current_url)
        if (
            scoped_target.scheme != "http"
            or (scoped_target.hostname or "").lower() not in {"127.0.0.1", "::1"}
            or scoped_target.username
            or scoped_target.password
        ):
            raise MediaDownloadError("抖音连接器媒体地址不在本机回环范围内")

    try:
        with requests.Session() as session:
            session.trust_env = False
            for redirect_count in range(6):
                _check_cancel(cancel_check)
                response = session.get(
                    current_url,
                    headers=current_headers or None,
                    stream=True,
                    timeout=(connect_timeout, read_timeout),
                    allow_redirects=False,
                )
                if response.is_redirect or response.is_permanent_redirect:
                    location = response.headers.get("Location")
                    response.close()
                    if has_sidecar_scope:
                        raise MediaDownloadError("抖音连接器返回了不安全的媒体重定向")
                    if not location or redirect_count >= 5:
                        raise MediaDownloadError("媒体下载重定向无效")
                    next_url = urljoin(current_url, location)
                    _validate_download_url(next_url, allow_private_network=request.allow_private_network)
                    if urlparse(next_url).hostname != urlparse(current_url).hostname:
                        current_headers = {
                            key: value
                            for key, value in current_headers.items()
                            if key.lower() not in {
                                "authorization", "cookie", "x-session-scope", "x-zhicui-scope",
                            }
                        }
                    current_url = next_url
                    continue

                try:
                    response.raise_for_status()
                    content_length = _safe_positive_int(response.headers.get("Content-Length"))
                    if content_length > max_bytes:
                        raise MediaDownloadError("视频文件超过详细解析大小限制")
                    with part_path.open("wb") as output:
                        for chunk in response.iter_content(chunk_size=1024 * 1024):
                            _check_cancel(cancel_check)
                            if not chunk:
                                continue
                            byte_count += len(chunk)
                            if byte_count > max_bytes:
                                raise MediaDownloadError("视频文件超过详细解析大小限制")
                            output.write(chunk)
                            digest.update(chunk)
                    break
                finally:
                    response.close()
            else:
                raise MediaDownloadError("媒体下载重定向次数过多")
    except AnalysisCancelled:
        raise
    except MediaDownloadError:
        raise
    except Exception as exc:
        raise MediaDownloadError("视频临时下载失败") from exc

    if byte_count <= 0 or not part_path.is_file():
        raise MediaDownloadError("平台返回了空视频流")
    part_path.replace(final_path)
    return DownloadedMedia(
        path=final_path,
        duration_ms=max(0, int(request.duration_ms)),
        source_fingerprint=request.source_fingerprint or digest.hexdigest(),
        byte_count=byte_count,
    )


def _copy_local_media(
    source_path: Path,
    workspace: Path,
    *,
    duration_ms: int,
    source_fingerprint: str,
    cancel_check: CancelCheck | None,
    configured_max_bytes: int = 0,
) -> DownloadedMedia:
    if not source_path.is_file():
        raise MediaDownloadError("临时媒体文件不可用")
    global_max_bytes = max(
        1,
        int(
            getattr(
                settings,
                "VIDEO_ANALYSIS_MAX_DOWNLOAD_BYTES",
                800 * 1024 * 1024,
            )
        ),
    )
    max_bytes = (
        min(global_max_bytes, max(1, int(configured_max_bytes)))
        if int(configured_max_bytes or 0) > 0
        else global_max_bytes
    )
    target = workspace / f"source{_safe_suffix(source_path.name)}"
    digest = hashlib.sha256()
    byte_count = 0
    try:
        with source_path.open("rb") as source, target.open("wb") as output:
            while True:
                _check_cancel(cancel_check)
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                byte_count += len(chunk)
                if byte_count > max_bytes:
                    raise MediaDownloadError("视频文件超过详细解析大小限制")
                output.write(chunk)
                digest.update(chunk)
    except AnalysisCancelled:
        raise
    except MediaDownloadError:
        raise
    except Exception as exc:
        raise MediaDownloadError("复制临时媒体失败") from exc
    return DownloadedMedia(
        path=target,
        duration_ms=max(0, int(duration_ms)),
        source_fingerprint=source_fingerprint or digest.hexdigest(),
        byte_count=byte_count,
    )


def prepare_media(
    context: Mapping[str, Any],
    workspace: Path,
    *,
    cancel_check: CancelCheck | None = None,
    download_hook: MediaDownloadHook | None = None,
) -> DownloadedMedia:
    """解析一次性媒体能力并保证最终文件位于当前任务目录。"""
    ensure_media_eligible(context)
    _check_cancel(cancel_check)
    hook = download_hook
    if hook is None:
        with _DOWNLOAD_HOOK_LOCK:
            hook = _REGISTERED_DOWNLOAD_HOOK

    limits = (
        _mapping(context.get("limits"))
        or _mapping(context.get("offering_limits"))
        or _mapping(_mapping(context.get("runtime_provider_config")).get("limits"))
    )
    configured_max_bytes = _safe_positive_int(limits.get("max_file_bytes"))

    value: Any
    if hook is not None:
        try:
            value = _call_download_hook(hook, context, workspace, cancel_check)
        except AnalysisCancelled:
            raise
        except VideoAnalysisError:
            raise
        except Exception as exc:
            raise MediaDownloadError("平台媒体解析失败") from exc
    else:
        local_path = context.get("local_media_path")
        if local_path:
            value = Path(str(local_path))
        else:
            value = _default_media_request(context)

    if isinstance(value, DownloadedMedia):
        media = value
    elif isinstance(value, MediaDownloadRequest):
        media = _download_request_to_workspace(
            value,
            workspace,
            cancel_check,
            configured_max_bytes=configured_max_bytes,
        )
    elif isinstance(value, (str, Path)):
        media = _copy_local_media(
            Path(value),
            workspace,
            duration_ms=_safe_positive_int(context.get("source_duration_ms")),
            source_fingerprint=str(context.get("source_fingerprint") or ""),
            cancel_check=cancel_check,
            configured_max_bytes=configured_max_bytes,
        )
    elif isinstance(value, Mapping):
        value_path = value.get("path") or value.get("local_path")
        if value_path:
            media = _copy_local_media(
                Path(str(value_path)),
                workspace,
                duration_ms=_safe_positive_int(value.get("duration_ms")),
                source_fingerprint=str(value.get("source_fingerprint") or ""),
                cancel_check=cancel_check,
                configured_max_bytes=configured_max_bytes,
            )
        else:
            request = _request_from_mapping(value)
            if request is None:
                raise MediaDownloadError("媒体下载 hook 返回格式无效")
            media = _download_request_to_workspace(
                request,
                workspace,
                cancel_check,
                configured_max_bytes=configured_max_bytes,
            )
    else:
        raise MediaDownloadError("媒体下载 hook 返回格式无效")

    if not _inside_workspace(media.path, workspace) or not media.path.is_file():
        raise MediaDownloadError("临时媒体没有保存在任务隔离目录中")
    return media


def _probe_media(path: Path) -> tuple[int, float]:
    try:
        import cv2

        capture = cv2.VideoCapture(str(path))
        try:
            if not capture.isOpened():
                raise MediaProbeError("无法读取临时视频")
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            frame_count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
            duration_ms = int(round(frame_count / fps * 1000)) if fps > 0 and frame_count > 0 else 0
            if duration_ms <= 0:
                duration_ms = int(round(float(capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0)))
            return max(0, duration_ms), max(0.0, fps)
        finally:
            capture.release()
    except ImportError as exc:
        raise MediaProbeError("OpenCV 视频探测组件未安装") from exc


def _uniform_detection(duration_ms: int, reason: str) -> SceneDetection:
    if duration_ms <= 0:
        raise MediaProbeError("无法确定视频时长")
    return SceneDetection(
        scenes=(SceneBoundary(index=0, start_ms=0, end_ms=duration_ms),),
        duration_ms=duration_ms,
        method="uniform_fallback",
        degraded_reason=reason,
    )


def _timecode_seconds(value: Any) -> float:
    seconds = getattr(value, "seconds", None)
    if seconds is not None:
        return float(seconds)
    return float(value.get_seconds())


def detect_scenes(
    media: DownloadedMedia,
    *,
    cancel_check: CancelCheck | None = None,
    max_duration_ms: int | None = None,
) -> SceneDetection:
    """使用固定 AdaptiveDetector 参数检测镜头，失败时退到均匀采样。"""
    _check_cancel(cancel_check)
    probed_duration_ms = 0
    probed_fps = 0.0
    try:
        probed_duration_ms, probed_fps = _probe_media(media.path)
    except VideoAnalysisError:
        if media.duration_ms <= 0:
            raise
    duration_ms = probed_duration_ms or media.duration_ms
    if duration_ms <= 0:
        raise MediaProbeError("无法确定视频时长")
    if max_duration_ms is not None and duration_ms > max(1, int(max_duration_ms)):
        raise MediaDurationLimitError("视频时长超过当前解析方案限制")

    try:
        from scenedetect import SceneManager, open_video
        from scenedetect.detectors import AdaptiveDetector

        video = open_video(str(media.path))
        try:
            fps = float(getattr(video, "frame_rate", 0.0) or probed_fps or 25.0)
            min_scene_frames = max(1, int(round(SCENE_MIN_SECONDS * fps)))
            manager = SceneManager()
            manager.add_detector(
                AdaptiveDetector(
                    adaptive_threshold=SCENE_ADAPTIVE_THRESHOLD,
                    min_scene_len=min_scene_frames,
                    window_width=SCENE_WINDOW_WIDTH,
                    min_content_val=SCENE_MIN_CONTENT_VAL,
                )
            )
            manager.detect_scenes(video=video, show_progress=False, frame_skip=0)
            raw_scenes = manager.get_scene_list(start_in_scene=True)
        finally:
            close = getattr(video, "close", None)
            if callable(close):
                close()
        _check_cancel(cancel_check)
        scenes: list[SceneBoundary] = []
        for index, (start, end) in enumerate(raw_scenes):
            start_ms = max(0, int(round(_timecode_seconds(start) * 1000)))
            end_ms = min(duration_ms, max(start_ms + 1, int(round(_timecode_seconds(end) * 1000))))
            if end_ms > start_ms:
                scenes.append(SceneBoundary(index=index, start_ms=start_ms, end_ms=end_ms))
        if not scenes:
            return _uniform_detection(duration_ms, "scene_detection_empty")
        if scenes[-1].end_ms < duration_ms:
            last = scenes[-1]
            scenes[-1] = SceneBoundary(last.index, last.start_ms, duration_ms)
        return SceneDetection(tuple(scenes), duration_ms, "pyscenedetect")
    except AnalysisCancelled:
        raise
    except Exception:
        return _uniform_detection(duration_ms, "scene_detection_failed")


def calculate_frame_budget(
    method: str,
    duration_ms: int,
    *,
    configured_max_frames: int | None = None,
    configured_max_calls: int | None = None,
) -> int:
    clean_method = str(method or "").strip().lower()
    if clean_method == "local_scene":
        budget = LOCAL_SCENE_FRAME_BUDGET
    elif clean_method == "scene_frames_vlm":
        adaptive = int(math.ceil(max(0, duration_ms) / 20_000))
        budget = min(VLM_MAX_FRAME_BUDGET, max(VLM_MIN_FRAME_BUDGET, adaptive))
    else:
        return 0
    if configured_max_frames is not None:
        budget = min(budget, max(0, int(configured_max_frames)))
    if configured_max_calls is not None and clean_method == "scene_frames_vlm":
        budget = min(
            budget,
            max(0, int(configured_max_calls)) * MAX_FRAMES_PER_VLM_CALL,
        )
    return max(0, budget)


def _evenly_select(values: Sequence[int], limit: int) -> list[int]:
    unique = sorted({max(0, int(value)) for value in values})
    if len(unique) <= limit:
        return unique
    if limit <= 1:
        return [unique[len(unique) // 2]]
    indices = [round(index * (len(unique) - 1) / (limit - 1)) for index in range(limit)]
    return [unique[index] for index in indices]


def select_frame_timestamps(detection: SceneDetection, budget: int) -> list[int]:
    """每镜头取中点，长镜头每 10 秒补帧，再按总预算均匀裁剪。"""
    candidates: list[int] = []
    for scene in detection.scenes:
        candidates.append((scene.start_ms + scene.end_ms) // 2)
        cursor = scene.start_ms + int(LONG_SCENE_SUPPLEMENT_SECONDS * 1000)
        while cursor < scene.end_ms - 500:
            candidates.append(cursor)
            cursor += int(LONG_SCENE_SUPPLEMENT_SECONDS * 1000)

    if len(set(candidates)) < budget:
        interval = detection.duration_ms / max(1, budget)
        candidates.extend(
            min(detection.duration_ms - 1, max(0, int(round((index + 0.5) * interval))))
            for index in range(budget)
        )
    return _evenly_select(candidates, budget)


def _scene_index_for_timestamp(scenes: Sequence[SceneBoundary], timestamp_ms: int) -> int:
    for scene in scenes:
        if scene.start_ms <= timestamp_ms < scene.end_ms:
            return scene.index
    return scenes[-1].index if scenes else 0


def _extract_frame_with_cv2(path: Path, timestamp_ms: int) -> bytes:
    import cv2

    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            return b""
        capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp_ms))
        ok, frame = capture.read()
        if not ok or frame is None:
            return b""
        max_width = max(320, int(getattr(settings, "VIDEO_ANALYSIS_FRAME_MAX_WIDTH", 1024)))
        height, width = frame.shape[:2]
        if width > max_width:
            target_height = max(2, int(round(height * max_width / width)))
            frame = cv2.resize(frame, (max_width, target_height), interpolation=cv2.INTER_AREA)
        quality = min(95, max(45, int(getattr(settings, "VIDEO_ANALYSIS_JPEG_QUALITY", 85))))
        encoded, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return bytes(buffer) if encoded else b""
    finally:
        capture.release()


def extract_frame_samples(
    media: DownloadedMedia,
    detection: SceneDetection,
    timestamps_ms: Sequence[int],
    *,
    cancel_check: CancelCheck | None = None,
) -> list[FrameSample]:
    samples: list[FrameSample] = []
    for timestamp_ms in timestamps_ms:
        _check_cancel(cancel_check)
        try:
            jpeg = _extract_frame_with_cv2(media.path, int(timestamp_ms))
        except Exception:
            jpeg = b""
        if not jpeg:
            continue
        samples.append(
            FrameSample(
                index=len(samples),
                scene_index=_scene_index_for_timestamp(detection.scenes, int(timestamp_ms)),
                timestamp_ms=int(timestamp_ms),
                jpeg_bytes=jpeg,
            )
        )
    return samples


def _usage_value(usage: Any, key: str) -> int:
    value = usage.get(key) if isinstance(usage, Mapping) else getattr(usage, key, 0)
    return _safe_positive_int(value)


def _strip_json_fence(raw: str) -> str:
    text = str(raw or "").strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        text = text[first_newline + 1 :] if first_newline >= 0 else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


class LiteLLMImageDriver:
    """OpenAI-compatible 图片输入驱动；凭证来源由引擎在调用前校验。"""

    def analyze_frames(
        self,
        frames: Sequence[FrameSample],
        *,
        provider_config: Mapping[str, Any],
        video_title: str,
        transcript: str,
        batch_index: int,
        batch_count: int,
    ) -> ImageDriverResult:
        if not frames or len(frames) > MAX_FRAMES_PER_VLM_CALL:
            raise VisionProviderCallError("图片视觉请求帧数不合法")
        model = str(provider_config.get("runtime_model") or provider_config.get("model") or "").strip()
        api_key = str(provider_config.get("api_key") or "").strip()
        api_base = str(provider_config.get("api_base") or "").strip()
        if not model or not api_key:
            raise VisionDriverUnavailableError("图片视觉 Provider 配置不完整")

        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "你正在分析同一视频的一组按时间排序截图。只输出严格 JSON，不要 Markdown。"
                    "不得猜测截图外的事实；看不清时留空。返回："
                    '{"frames":[{"frame_index":0,"summary":"",'
                    '"ocr_text":[],"people":[],"objects":[],"actions":[],"events":[],'
                    '"confidence":0.0}]}。frame_index 必须对应本批输入序号。\n'
                    f"视频标题：{video_title[:300]}\n"
                    f"批次：{batch_index + 1}/{batch_count}\n"
                    f"已有文稿（仅辅助理解，不得伪装成画面证据）：{transcript[:6000]}"
                ),
            }
        ]
        for frame in frames:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/jpeg;base64," + base64.b64encode(frame.jpeg_bytes).decode("ascii")
                    },
                }
            )

        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max(512, min(4096, _safe_positive_int(provider_config.get("max_tokens"), 2048))),
            "temperature": 0,
            "timeout": max(
                10,
                min(
                    300,
                    _safe_positive_int(
                        provider_config.get("timeout_seconds")
                        or _mapping(provider_config.get("limits")).get("timeout_seconds"),
                        90,
                    ),
                ),
            ),
            "drop_params": True,
            "api_key": api_key,
        }
        if api_base:
            kwargs["api_base"] = api_base
        try:
            from litellm import completion

            response = completion(**kwargs)
            raw = str(response.choices[0].message.content or "")
            parsed = json.loads(_strip_json_fence(raw))
            rows = parsed.get("frames") if isinstance(parsed, Mapping) else None
            if not isinstance(rows, list):
                raise ValueError("missing frames")
            usage_obj = getattr(response, "usage", None)
            usage = DriverUsage(
                calls=1,
                image_count=len(frames),
                provider_units=1,
                prompt_tokens=_usage_value(usage_obj, "prompt_tokens"),
                completion_tokens=_usage_value(usage_obj, "completion_tokens"),
                total_tokens=_usage_value(usage_obj, "total_tokens"),
            )
            if usage.total_tokens <= 0:
                usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
            usage.platform_cost_micros = _configured_platform_cost_micros(
                provider_config,
                usage,
            )
            try:
                from app.services import llm_usage_service

                llm_usage_service.record_response_usage(
                    response,
                    provider=str(provider_config.get("provider") or "vision")[:32],
                    model=str(provider_config.get("model") or model)[:128],
                    operation="video_analysis_images",
                )
            except Exception:
                pass
            return ImageDriverResult(tuple(row for row in rows if isinstance(row, Mapping)), usage)
        except VisionProviderCallError:
            raise
        except Exception as exc:
            raise VisionProviderCallError("图片视觉 Provider 调用失败") from exc


register_image_driver("litellm_image", LiteLLMImageDriver())
register_image_driver("image_vlm", _IMAGE_DRIVERS["litellm_image"])
register_image_driver("openai_compatible", _IMAGE_DRIVERS["litellm_image"])
register_image_driver("openai_compatible_image", _IMAGE_DRIVERS["litellm_image"])
register_image_driver("omniroute_image", _IMAGE_DRIVERS["litellm_image"])


def _provider_config(context: Mapping[str, Any], *, use_byok: bool) -> Mapping[str, Any]:
    if use_byok:
        config = (
            _mapping(context.get("byok_provider_config"))
            or _mapping(context.get("byok_runtime_provider"))
            or _mapping(context.get("runtime_provider_config"))
        )
        source = str(config.get("credential_source") or config.get("scope") or "").strip().lower()
        if not config or source not in {"byok", "user", "user_byok"}:
            raise ByokConfigurationError("用户视觉 BYOK 配置不可用")
    else:
        config = (
            _mapping(context.get("platform_provider_config"))
            or _mapping(context.get("runtime_provider_config"))
        )
        source = str(config.get("credential_source") or config.get("scope") or "platform").strip().lower()
        if not config or source in {"byok", "user", "user_byok"}:
            raise VisionDriverUnavailableError("平台图片视觉 Provider 配置不可用")
    if not bool(config.get("enabled", True)):
        raise VisionDriverUnavailableError("图片视觉 Provider 当前不可用")
    return config


def _string_list(value: Any, *, max_items: int = 20, max_length: int = 240) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        values = list(value)
    else:
        values = []
    result: list[str] = []
    for item in values:
        text = re.sub(r"\s+", " ", str(item or "")).strip()[:max_length]
        if text and text not in result:
            result.append(text)
        if len(result) >= max_items:
            break
    return result


def _confidence(value: Any) -> float:
    try:
        return round(min(1.0, max(0.0, float(value))), 3)
    except (TypeError, ValueError):
        return 0.0


def _server_timed_observations(
    rows: Sequence[Mapping[str, Any]],
    frames: Sequence[FrameSample],
) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    used: set[int] = set()
    for row in rows:
        try:
            frame_index = int(row.get("frame_index"))
        except (TypeError, ValueError):
            continue
        if frame_index < 0 or frame_index >= len(frames) or frame_index in used:
            continue
        used.add(frame_index)
        frame = frames[frame_index]
        summary = re.sub(r"\s+", " ", str(row.get("summary") or "")).strip()[:1000]
        observation = {
            "timestamp_ms": frame.timestamp_ms,
            "scene_index": frame.scene_index,
            "summary": summary,
            "ocr_text": _string_list(row.get("ocr_text"), max_items=24, max_length=300),
            "people": _string_list(row.get("people")),
            "objects": _string_list(row.get("objects")),
            "actions": _string_list(row.get("actions")),
            "events": _string_list(row.get("events")),
            "confidence": _confidence(row.get("confidence")),
            "source": "visual",
            "label": "AI 画面观察",
        }
        if summary or any(observation[key] for key in ("ocr_text", "people", "objects", "actions", "events")):
            observations.append(observation)
        if len(observations) >= _MAX_OBSERVATIONS:
            break
    return observations


def _analysis_limits(context: Mapping[str, Any]) -> tuple[int | None, int | None]:
    limits = (
        _mapping(context.get("limits"))
        or _mapping(context.get("offering_limits"))
        or _mapping(_mapping(context.get("runtime_provider_config")).get("limits"))
        or _mapping(context.get("billing_snapshot"))
    )
    raw_frames = (
        limits["max_frames"]
        if "max_frames" in limits
        else context.get("max_frames")
    )
    if "max_provider_calls" in limits:
        raw_calls = limits["max_provider_calls"]
    elif "max_model_calls" in limits:
        raw_calls = limits["max_model_calls"]
    elif "max_calls" in limits:
        raw_calls = limits["max_calls"]
    elif "max_provider_calls" in context:
        raw_calls = context.get("max_provider_calls")
    else:
        raw_calls = context.get("max_calls")
    max_frames = _safe_positive_int(raw_frames) if raw_frames is not None else None
    max_calls = _safe_positive_int(raw_calls) if raw_calls is not None else None
    return max_frames, max_calls


def _maximum_duration_ms(context: Mapping[str, Any]) -> int:
    limits = (
        _mapping(context.get("limits"))
        or _mapping(context.get("offering_limits"))
        or _mapping(_mapping(context.get("runtime_provider_config")).get("limits"))
        or _mapping(context.get("billing_snapshot"))
    )
    seconds = _safe_positive_int(
        limits.get("max_duration_seconds")
        or context.get("max_duration_seconds"),
        7200,
    )
    return max(30_000, seconds * 1000)


def _analysis_method(context: Mapping[str, Any]) -> str:
    offering = context.get("offering_version") or context.get("offering")
    method = (
        context.get("analysis_method")
        or context.get("method")
        or _value(offering, "analysis_method", "")
        or _value(offering, "method", "")
        or "local_scene"
    )
    return str(method).strip().lower()


def _driver_name(config: Mapping[str, Any], default: str) -> str:
    return str(config.get("driver") or config.get("driver_name") or default).strip().lower()


def _configured_platform_cost_micros(
    provider_config: Mapping[str, Any],
    usage: DriverUsage,
) -> int:
    """按管理员保存的整数微元单价计算观测成本，不内置供应商价格。"""
    if str(provider_config.get("credential_source") or "").lower() in {"byok", "user", "user_byok"}:
        return 0
    if usage.platform_cost_micros > 0:
        return usage.platform_cost_micros
    cost = _mapping(provider_config.get("cost"))
    if not cost:
        return 0

    # The admin UI exposes a provider-neutral metering contract.  Keep the
    # more detailed fields below for advanced adapters, but always honor the
    # common ``metering.unit + cost.micros_per_unit`` pair so budgets and
    # margin reports do not silently stay at zero.
    metering = _mapping(provider_config.get("metering"))
    metering_unit = str(metering.get("unit") or "").strip().lower()
    micros_per_unit = _safe_positive_int(cost.get("micros_per_unit"))
    generic_total = 0
    if micros_per_unit:
        if metering_unit in {"image", "images", "frame", "frames"}:
            quantity = usage.image_count
        elif metering_unit in {"call", "calls", "request", "requests"}:
            quantity = usage.calls
        elif metering_unit in {"token", "tokens"}:
            quantity = usage.total_tokens
        elif metering_unit in {"1k_token", "1k_tokens", "thousand_tokens"}:
            quantity = int(math.ceil(usage.total_tokens / 1000))
        else:
            quantity = usage.provider_units or usage.calls
        generic_total = max(0, int(quantity)) * micros_per_unit

    per_call = _safe_positive_int(cost.get("per_call_micros") or cost.get("per_request_micros"))
    per_image = _safe_positive_int(cost.get("per_image_micros"))
    per_unit = _safe_positive_int(cost.get("per_provider_unit_micros") or cost.get("per_media_unit_micros"))
    input_per_1k = _safe_positive_int(cost.get("per_1k_input_tokens_micros"))
    output_per_1k = _safe_positive_int(cost.get("per_1k_output_tokens_micros"))
    total_per_1k = _safe_positive_int(cost.get("per_1k_tokens_micros"))
    total = generic_total + (
        usage.calls * per_call
        + usage.image_count * per_image
        + usage.provider_units * per_unit
        + int(math.ceil(usage.prompt_tokens / 1000)) * input_per_1k
        + int(math.ceil(usage.completion_tokens / 1000)) * output_per_1k
    )
    if not input_per_1k and not output_per_1k:
        total += int(math.ceil(usage.total_tokens / 1000)) * total_per_1k
    return max(0, int(total))


def _title_and_transcript(context: Mapping[str, Any]) -> tuple[str, str]:
    note = _context_note(context)
    title = str(context.get("video_title") or context.get("title") or _value(note, "video_title", "") or "未命名视频")
    transcript = str(context.get("transcript") or _value(note, "transcript_raw", "") or "")
    return title[:512], transcript[:20_000]


def _chapters(scenes: Sequence[SceneBoundary], duration_ms: int) -> list[dict[str, Any]]:
    if not scenes:
        return []
    count = min(8, max(1, int(math.ceil(duration_ms / 120_000))))
    segment_ms = max(1, int(math.ceil(duration_ms / count)))
    result: list[dict[str, Any]] = []
    for index in range(count):
        start_ms = index * segment_ms
        end_ms = min(duration_ms, (index + 1) * segment_ms)
        members = [scene.index for scene in scenes if scene.start_ms < end_ms and scene.end_ms > start_ms]
        if not members:
            continue
        result.append(
            {
                "index": len(result),
                "title": f"片段 {len(result) + 1}",
                "start_ms": start_ms,
                "end_ms": end_ms,
                "scene_indices": members[:200],
            }
        )
    return result


def _structured_payload(
    *,
    method: str,
    detection: SceneDetection,
    timestamps_ms: Sequence[int],
    observations: Sequence[Mapping[str, Any]],
    frame_budget: int,
    sampled_frame_count: int,
    visual_batches: int,
    failed_batches: int,
    degraded_reason: str,
) -> dict[str, Any]:
    by_scene: dict[int, list[int]] = {}
    for timestamp_ms in timestamps_ms:
        scene_index = _scene_index_for_timestamp(detection.scenes, int(timestamp_ms))
        by_scene.setdefault(scene_index, []).append(int(timestamp_ms))
    persisted_scenes = list(detection.scenes[:_MAX_PERSISTED_SCENES])
    scenes = [
        {
            "index": scene.index,
            "start_ms": scene.start_ms,
            "end_ms": scene.end_ms,
            "representative_timestamps_ms": by_scene.get(scene.index, [])[:16],
        }
        for scene in persisted_scenes
    ]
    safe_observations = [dict(item) for item in observations[:_MAX_OBSERVATIONS]]
    evidence = [
        {
            "source": "visual",
            "label": "AI 画面观察",
            "timestamp_ms": _safe_positive_int(item.get("timestamp_ms")),
            "quote": str(item.get("summary") or "")[:500],
            "confidence": _confidence(item.get("confidence")),
        }
        for item in safe_observations
        if str(item.get("summary") or "").strip()
    ]
    return {
        "schema_version": 1,
        "method": method,
        "generated_at": _utcnow_iso(),
        "duration_ms": detection.duration_ms,
        "scene_count": len(detection.scenes),
        "frame_count": sampled_frame_count,
        "chapters": _chapters(detection.scenes, detection.duration_ms),
        "scenes": scenes,
        "visual_observations": safe_observations,
        "evidence": evidence,
        "quality": {
            "scene_detection": detection.method,
            "sampling_strategy": "scene_midpoints_with_10s_supplements",
            "frame_budget": frame_budget,
            "sampled_frame_count": sampled_frame_count,
            "visual_batches": visual_batches,
            "failed_visual_batches": failed_batches,
            "scenes_truncated": len(detection.scenes) > len(persisted_scenes),
        },
        "degraded_reason": str(degraded_reason or "")[:120],
    }


def _run_image_analysis(
    frames: Sequence[FrameSample],
    *,
    context: Mapping[str, Any],
    use_byok: bool,
    video_title: str,
    transcript: str,
    cancel_check: CancelCheck | None,
) -> tuple[list[dict[str, Any]], DriverUsage, int, int, list[str]]:
    provider_config = _provider_config(context, use_byok=use_byok)
    driver_name = _driver_name(provider_config, "litellm_image")
    driver = _IMAGE_DRIVERS.get(driver_name)
    if driver is None:
        if use_byok:
            raise ByokConfigurationError("用户配置的图片视觉驱动未安装")
        raise VisionDriverUnavailableError("图片视觉驱动尚未安装")

    batches = [frames[index : index + MAX_FRAMES_PER_VLM_CALL] for index in range(0, len(frames), MAX_FRAMES_PER_VLM_CALL)]
    usage = DriverUsage()
    observations: list[dict[str, Any]] = []
    failures: list[str] = []
    successful_batches = 0
    for batch_index, batch in enumerate(batches):
        if cancel_check and cancel_check():
            raise AnalysisCancelled(result_usage=usage.to_dict())
        try:
            result = driver.analyze_frames(
                batch,
                provider_config=provider_config,
                video_title=video_title,
                transcript=transcript,
                batch_index=batch_index,
                batch_count=len(batches),
            )
            usage.add(result.usage)
            observations.extend(_server_timed_observations(result.observations, batch))
            successful_batches += 1
        except AnalysisCancelled:
            raise
        except VideoAnalysisError as exc:
            failures.append(exc.code)
            failed_usage = DriverUsage(
                calls=1,
                image_count=len(batch),
                provider_units=1,
            )
            failed_usage.platform_cost_micros = _configured_platform_cost_micros(
                provider_config,
                failed_usage,
            )
            failed_usage.failure_cost_micros = failed_usage.platform_cost_micros
            usage.add(failed_usage)
        except Exception:
            failures.append("vision_provider_failed")
            failed_usage = DriverUsage(
                calls=1,
                image_count=len(batch),
                provider_units=1,
            )
            failed_usage.platform_cost_micros = _configured_platform_cost_micros(
                provider_config,
                failed_usage,
            )
            failed_usage.failure_cost_micros = failed_usage.platform_cost_micros
            usage.add(failed_usage)
        if cancel_check and cancel_check():
            raise AnalysisCancelled(result_usage=usage.to_dict())
    return observations, usage, successful_batches, len(failures), failures


def analyze_video_details(
    context: Mapping[str, Any],
    *,
    cancel_check: CancelCheck | None = None,
    stage_callback: StageCallback | None = None,
    download_hook: MediaDownloadHook | None = None,
) -> AnalysisOutcome:
    """执行单个持久 Item；调用者负责数据库状态和资金事务。"""
    method = _analysis_method(context)
    provider_hint = _mapping(context.get("runtime_provider_config"))
    validate_analysis_method(method, driver_name=_driver_name(provider_hint, "") if provider_hint else "")
    ensure_media_eligible(context)
    use_byok = bool(context.get("use_byok"))
    title, transcript = _title_and_transcript(context)

    def stage(name: str) -> None:
        if stage_callback:
            stage_callback(name)
        _check_cancel(cancel_check)

    with temporary_media_workspace() as workspace:
        stage("downloading")
        media = prepare_media(context, workspace, cancel_check=cancel_check, download_hook=download_hook)
        stage("detecting_scenes")
        detection = detect_scenes(
            media,
            cancel_check=cancel_check,
            max_duration_ms=_maximum_duration_ms(context),
        )
        billing_snapshot = _mapping(context.get("billing_snapshot"))
        quota_snapshot = _mapping(context.get("quota_snapshot"))
        authorized_duration_ms = _safe_positive_int(
            billing_snapshot.get("duration_ms")
        )
        increment_ms = max(
            1000,
            _safe_positive_int(
                billing_snapshot.get("billing_increment_seconds"), 60
            )
            * 1000,
        )
        price_crossed = bool(
            _safe_positive_int(billing_snapshot.get("per_minute_points")) > 0
            and authorized_duration_ms > 0
            and math.ceil(detection.duration_ms / increment_ms)
            > math.ceil(authorized_duration_ms / increment_ms)
        )
        quota_crossed = bool(
            str(quota_snapshot.get("unit") or "") == "minute"
            and _safe_positive_int(quota_snapshot.get("required_units")) > 0
            and math.ceil(detection.duration_ms / 60_000)
            > _safe_positive_int(quota_snapshot.get("required_units"))
        )
        if price_crossed or quota_crossed:
            # 在任何视觉 Provider 调用前暂停，避免超授权成本和重复上游调用。
            raise AnalysisReauthorizationRequired(detection.duration_ms)
        max_frames, max_calls = _analysis_limits(context)
        if method in {"scene_frames_vlm", "native_video"} and max_calls is not None and max_calls < 1:
            raise VisionDriverUnavailableError("解析方案未授权视觉 Provider 调用")
        frame_budget = calculate_frame_budget(
            method,
            detection.duration_ms,
            configured_max_frames=max_frames,
            configured_max_calls=max_calls,
        )
        timestamps = select_frame_timestamps(detection, frame_budget) if frame_budget else []
        stage("sampling_frames")

        if method == "local_scene":
            degraded_reason = detection.degraded_reason
            payload = _structured_payload(
                method=method,
                detection=detection,
                timestamps_ms=timestamps,
                observations=[],
                frame_budget=frame_budget,
                sampled_frame_count=len(timestamps),
                visual_batches=0,
                failed_batches=0,
                degraded_reason=degraded_reason,
            )
            return AnalysisOutcome(
                status="succeeded",
                result_payload=payload,
                scene_count=len(detection.scenes),
                frame_count=len(timestamps),
                duration_ms=detection.duration_ms,
                degraded_reason=degraded_reason,
                result_usage=DriverUsage().to_dict(),
            )

        runtime_provider = (
            _mapping(context.get("platform_provider_config"))
            or _mapping(context.get("runtime_provider_config"))
        )
        if (
            method == "scene_frames_vlm"
            and not use_byok
            and _driver_name(runtime_provider, "") == "local_scene"
        ):
            degraded_reason = str(
                runtime_provider.get("degraded_reason")
                or detection.degraded_reason
                or "visual_provider_degraded_to_local_scene"
            )[:120]
            payload = _structured_payload(
                method="local_scene",
                detection=detection,
                timestamps_ms=timestamps,
                observations=[],
                frame_budget=frame_budget,
                sampled_frame_count=len(timestamps),
                visual_batches=0,
                failed_batches=0,
                degraded_reason=degraded_reason,
            )
            return AnalysisOutcome(
                status="partial",
                result_payload=payload,
                scene_count=len(detection.scenes),
                frame_count=len(timestamps),
                duration_ms=detection.duration_ms,
                degraded_reason=degraded_reason,
                result_usage=DriverUsage().to_dict(),
            )

        if method == "native_video":
            config = _provider_config(context, use_byok=use_byok)
            driver_name = _driver_name(config, "")
            driver = _NATIVE_VIDEO_DRIVERS.get(driver_name)
            if driver is None:
                raise VisionDriverUnavailableError("原生视频解析驱动尚未安装")
            stage("analyzing_visuals")
            try:
                native_result = driver.analyze_video(
                    media,
                    provider_config=config,
                    video_title=title,
                    transcript=transcript,
                )
            except VideoAnalysisError:
                raise
            except Exception as exc:
                raise VisionProviderCallError("原生视频 Provider 调用失败") from exc
            payload = cached_result_payload(dict(native_result.payload))
            payload.setdefault("schema_version", 1)
            payload.setdefault("method", "native_video")
            payload.setdefault("generated_at", _utcnow_iso())
            payload.setdefault("duration_ms", detection.duration_ms)
            return AnalysisOutcome(
                status="succeeded",
                result_payload=payload,
                scene_count=_safe_positive_int(payload.get("scene_count")),
                frame_count=_safe_positive_int(payload.get("frame_count")),
                duration_ms=detection.duration_ms,
                degraded_reason=str(payload.get("degraded_reason") or "")[:120],
                result_usage=native_result.usage.to_dict(),
            )

        frames = extract_frame_samples(media, detection, timestamps, cancel_check=cancel_check)
        if not frames:
            degraded_reason = "frame_extraction_failed"
            if detection.degraded_reason:
                degraded_reason = f"{detection.degraded_reason},{degraded_reason}"
            payload = _structured_payload(
                method=method,
                detection=detection,
                timestamps_ms=timestamps,
                observations=[],
                frame_budget=frame_budget,
                sampled_frame_count=0,
                visual_batches=0,
                failed_batches=0,
                degraded_reason=degraded_reason,
            )
            return AnalysisOutcome(
                status="partial",
                result_payload=payload,
                scene_count=len(detection.scenes),
                frame_count=0,
                duration_ms=detection.duration_ms,
                degraded_reason=degraded_reason,
                result_usage=DriverUsage().to_dict(),
            )

        stage("analyzing_visuals")
        try:
            observations, usage, successful_batches, failed_batches, failures = _run_image_analysis(
                frames,
                context=context,
                use_byok=use_byok,
                video_title=title,
                transcript=transcript,
                cancel_check=cancel_check,
            )
        except AnalysisCancelled as exc:
            local_payload = _structured_payload(
                method=method,
                detection=detection,
                timestamps_ms=timestamps,
                observations=[],
                frame_budget=frame_budget,
                sampled_frame_count=len(frames),
                visual_batches=0,
                failed_batches=0,
                degraded_reason="analysis_cancelled",
            )
            raise AnalysisCancelled(result_usage=exc.result_usage, partial_result=local_payload) from exc
        except VideoAnalysisError as exc:
            # 图片 Provider/BYOK 失败时保留已完成的本地场景结构，且不切换凭证。
            observations = []
            usage = DriverUsage()
            successful_batches = 0
            failed_batches = max(
                1,
                int(math.ceil(len(frames) / MAX_FRAMES_PER_VLM_CALL)),
            )
            failures = [exc.code]

        degraded_parts = [part for part in (detection.degraded_reason,) if part]
        if failed_batches:
            degraded_parts.append(failures[0] if failures else "vision_provider_failed")
        if successful_batches == 0:
            degraded_parts.append("visual_analysis_unavailable")
        degraded_reason = ",".join(dict.fromkeys(degraded_parts))
        status = "partial" if failed_batches or successful_batches == 0 or len(frames) < len(timestamps) else "succeeded"
        payload = _structured_payload(
            method=method,
            detection=detection,
            timestamps_ms=timestamps,
            observations=observations,
            frame_budget=frame_budget,
            sampled_frame_count=len(frames),
            visual_batches=successful_batches,
            failed_batches=failed_batches,
            degraded_reason=degraded_reason,
        )
        if use_byok:
            # BYOK 上游成本属于用户自己的供应商账户，不进入平台成本。
            usage.platform_cost_micros = 0
        return AnalysisOutcome(
            status=status,
            result_payload=payload,
            scene_count=len(detection.scenes),
            frame_count=len(frames),
            duration_ms=detection.duration_ms,
            degraded_reason=degraded_reason,
            result_usage=usage.to_dict(),
        )


def cached_result_payload(cached: Any) -> dict[str, Any]:
    """读取缓存结果但不泄露 ORM 的其他字段。"""
    raw = _value(cached, "result_json", cached)
    payload = _json_object(raw)
    allowed = {
        "schema_version",
        "method",
        "generated_at",
        "duration_ms",
        "scene_count",
        "frame_count",
        "chapters",
        "scenes",
        "visual_observations",
        "evidence",
        "quality",
        "degraded_reason",
    }
    safe: dict[str, Any] = {}
    for key in allowed:
        if key not in payload:
            continue
        cleaned = _sanitize_result_value(payload[key], key=key)
        if cleaned is not _DROP_RESULT_VALUE:
            safe[key] = cleaned
    return safe


_DROP_RESULT_VALUE = object()
_SENSITIVE_RESULT_KEYS = {
    "url",
    "media_url",
    "download_url",
    "source_url",
    "path",
    "local_path",
    "temp_path",
    "base64",
    "cookie",
    "cookies",
    "api_key",
    "authorization",
    "headers",
    "request_headers",
    "jpeg_bytes",
    "image_bytes",
    "frame_bytes",
}


def _sanitize_result_value(value: Any, *, key: str = "") -> Any:
    normalized_key = str(key or "").strip().lower()
    if (
        normalized_key in _SENSITIVE_RESULT_KEYS
        or normalized_key.endswith("_url")
        or normalized_key.endswith("_path")
        or normalized_key.endswith("_base64")
    ):
        return _DROP_RESULT_VALUE
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:256]:
            child_key = str(raw_key or "")[:80]
            if not child_key:
                continue
            cleaned = _sanitize_result_value(raw_value, key=child_key)
            if cleaned is not _DROP_RESULT_VALUE:
                result[child_key] = cleaned
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        result_list: list[Any] = []
        for item in list(value)[:600]:
            cleaned = _sanitize_result_value(item)
            if cleaned is not _DROP_RESULT_VALUE:
                result_list.append(cleaned)
        return result_list
    if isinstance(value, str):
        text = value.strip()
        if text.lower().startswith(("data:image/", "file://")):
            return _DROP_RESULT_VALUE
        return text[:4000]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:1000]


def merge_detailed_analysis_summary(
    existing_summary: str | Mapping[str, Any] | None,
    result_payload: Mapping[str, Any],
    *,
    analysis_id: str | None = None,
    offering_version_id: str | None = None,
    source_fingerprint: str | None = None,
    status: str | None = None,
) -> str:
    """保留普通摘要，并把可读的画面补充合并进现有内容区。

    ``detailed_video_analysis`` 是 Agent/证据链使用的完整结构化结果；普通
    卡片布局只渲染 ``sections``，因此同时维护一个带稳定来源标记的摘要段落。
    重跑时替换该段落，避免不断追加重复内容。
    """
    existing = _json_object(existing_summary)
    safe_result = cached_result_payload(result_payload)
    generated_at = str(safe_result.get("generated_at") or _utcnow_iso())[:64]
    existing["detailed_video_analysis"] = {
        "analysis_id": str(analysis_id or "")[:64],
        "offering_version_id": str(offering_version_id or "")[:64],
        "source_fingerprint": str(source_fingerprint or "")[:128],
        "status": str(status or ("partial" if safe_result.get("degraded_reason") else "succeeded"))[:32],
        "updated_at": generated_at,
        **safe_result,
    }

    def format_timestamp(value: Any) -> str:
        milliseconds = _safe_positive_int(value)
        total_seconds = milliseconds // 1000
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    observations = safe_result.get("visual_observations")
    observation_rows = observations if isinstance(observations, list) else []
    lines: list[str] = []
    for row in observation_rows[:8]:
        if not isinstance(row, Mapping):
            continue
        details: list[str] = []
        summary = str(row.get("summary") or "").strip()
        if summary:
            details.append(summary[:320])
        ocr = row.get("ocr_text")
        if isinstance(ocr, list):
            visible_text = "、".join(str(value).strip() for value in ocr[:3] if str(value).strip())
            if visible_text:
                details.append(f"可见文字：{visible_text[:180]}")
        if not details:
            for key, label in (
                ("people", "人物"),
                ("objects", "物体"),
                ("actions", "动作"),
                ("events", "事件"),
            ):
                values = row.get(key)
                if isinstance(values, list):
                    joined = "、".join(
                        str(value).strip() for value in values[:4] if str(value).strip()
                    )
                    if joined:
                        details.append(f"{label}：{joined[:180]}")
        if details:
            lines.append(
                f"{format_timestamp(row.get('timestamp_ms'))} · {'；'.join(details)}"
            )

    if not lines:
        scene_count = _safe_positive_int(safe_result.get("scene_count"))
        chapters = safe_result.get("chapters")
        chapter_count = len(chapters) if isinstance(chapters, list) else 0
        if scene_count:
            structure = f"已识别 {scene_count} 个镜头"
            if chapter_count:
                structure += f"，整理为 {chapter_count} 个时间段"
            lines.append(structure + "。")

    if lines:
        sections = existing.get("sections")
        current_sections = sections if isinstance(sections, list) else []
        preserved_sections = [
            section
            for section in current_sections
            if not (
                isinstance(section, Mapping)
                and str(section.get("source") or "") == "detailed_video_analysis"
            )
        ]
        preserved_sections.append(
            {
                "title": "画面补充",
                "content": "\n".join(lines)[:4000],
                "icon": "Eye",
                "source": "detailed_video_analysis",
            }
        )
        existing["sections"] = preserved_sections
    return json.dumps(existing, ensure_ascii=False, separators=(",", ":"))


__all__ = [
    "AnalysisCancelled",
    "AnalysisReauthorizationRequired",
    "AnalysisOutcome",
    "ByokConfigurationError",
    "DownloadedMedia",
    "DriverUsage",
    "ImageDriverResult",
    "ImageVLMDriver",
    "MAX_FRAMES_PER_VLM_CALL",
    "MediaDownloadError",
    "MediaDownloadRequest",
    "MediaDurationLimitError",
    "MediaEligibility",
    "MediaNotEligibleError",
    "NativeVideoDriver",
    "SceneBoundary",
    "SceneDetection",
    "VideoAnalysisError",
    "VisionDriverUnavailableError",
    "analyze_video_details",
    "assess_media_eligibility",
    "build_source_fingerprint",
    "cached_result_payload",
    "calculate_frame_budget",
    "cleanup_stale_media_workspaces",
    "detect_scenes",
    "ensure_media_eligible",
    "merge_detailed_analysis_summary",
    "native_video_driver_installed",
    "prepare_media",
    "probe_note_duration_ms",
    "register_image_driver",
    "register_media_download_hook",
    "register_native_video_driver",
    "select_frame_timestamps",
    "temporary_media_workspace",
    "validate_analysis_method",
]
