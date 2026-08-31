"""
Video extraction service.

Wraps the existing DouyinProcessor from the douyin-mcp-server project so the
backend can parse Douyin share links, download videos, and extract transcripts.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import json
import random
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit


def _patch_ffmpeg_path():
    """Monkey-patch ffmpeg-python to use the correct ffmpeg binary on Windows.

    ffmpeg-python caches the ffmpeg command at import time. If ffmpeg is not in
    the system PATH (common on Windows), we need to replace it with the full
    path to the binary bundled by imageio-ffmpeg.
    """
    if shutil.which("ffmpeg"):
        return  # ffmpeg already in PATH, no patch needed

    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        if not os.path.exists(ffmpeg_exe):
            return

        # Create a copy named ffmpeg.exe if the bundled binary has a different name
        ffmpeg_dir = os.path.dirname(ffmpeg_exe)
        ffmpeg_win = os.path.join(ffmpeg_dir, "ffmpeg.exe")
        if not os.path.exists(ffmpeg_win):
            shutil.copy2(ffmpeg_exe, ffmpeg_win)

        # Patch ffmpeg-python's _run module to use the full path
        import ffmpeg._run as _ffmpeg_run
        _ffmpeg_run.FFMPEG_BINARY = ffmpeg_win

        # Also patch the probe command
        try:
            import ffmpeg._probe as _ffmpeg_probe
            _ffmpeg_probe.FFPROBE_BINARY = ffmpeg_win.replace("ffmpeg", "ffprobe")
        except (ImportError, AttributeError):
            pass

    except Exception:
        pass


# Apply the patch before importing anything that uses ffmpeg
_patch_ffmpeg_path()

# ---------------------------------------------------------------------------
# Make the existing douyin-mcp-server scripts importable.  Production uses
# immutable release worktrees, while this reviewed external dependency is
# provisioned once in the persistent checkout because it is intentionally
# gitignored.  Keep local development working, but allow releases to resolve
# the same audited installation without copying it into every worktree.
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_DOUYIN_MCP_CANDIDATES = []
if configured_root := os.getenv("DOUYIN_MCP_SERVER_ROOT", "").strip():
    _DOUYIN_MCP_CANDIDATES.append(Path(configured_root))
_DOUYIN_MCP_CANDIDATES.extend(
    (
        (_BACKEND_ROOT / ".." / "douyin-mcp-server").resolve(),
        Path("/opt/zhicui/douyin-mcp-server"),
    )
)
_SCRIPTS_DIR = next(
    (
        root / "douyin-video" / "scripts"
        for root in _DOUYIN_MCP_CANDIDATES
        if (root / "douyin-video" / "scripts" / "douyin_downloader.py").is_file()
    ),
    None,
)
if _SCRIPTS_DIR is None:
    raise RuntimeError(
        "douyin-mcp-server 运行依赖缺失；请设置 DOUYIN_MCP_SERVER_ROOT "
        "或在项目根目录安装固定依赖"
    )
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from douyin_downloader import DouyinProcessor  # noqa: E402


# ---------------------------------------------------------------------------
# Platform detection and Bilibili helpers
# ---------------------------------------------------------------------------

_SHARE_URL_PATTERN = re.compile(r"https?://[^\s<>{}\[\]\"']+", re.IGNORECASE)
_TRAILING_SHARE_PUNCTUATION = ".,!?;:，。！？；：、）)]}>」』】\"'"
_DOUYIN_INFO_UNAVAILABLE = (
    "抖音暂时未返回该作品的公开信息，可能是分享链接失效、作品不可访问，"
    "或平台临时限制了读取。请确认原视频可以正常打开；如果仍可访问，"
    "请先在“同步视频”中连接或重新验证抖音账号，再回来重试。"
)
_DOUYIN_ROUTER_MAX_BYTES = 2 * 1024 * 1024
_DOUYIN_ROUTER_CONNECT_TIMEOUT = 5
_DOUYIN_ROUTER_READ_TIMEOUT = 10
_DOUYIN_ROUTER_MAX_REDIRECTS = 4


class VideoExtractionError(RuntimeError):
    """An expected extraction failure whose message is safe for end users."""


class VideoMetadataUnavailableError(VideoExtractionError):
    """The platform did not expose enough public metadata for extraction."""

    def __init__(self, message: str, *, item_id: str = "") -> None:
        super().__init__(message)
        clean_id = str(item_id or "").strip()
        self.item_id = clean_id if re.fullmatch(r"\d{8,32}", clean_id) else ""


def _host_matches(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith(f".{domain}")


def _platform_from_url(url: str) -> str:
    try:
        hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        hostname = ""
    if _host_matches(hostname, "bilibili.com") or _host_matches(hostname, "b23.tv"):
        return 'bilibili'
    if _host_matches(hostname, "douyin.com") or _host_matches(hostname, "iesdouyin.com"):
        return 'douyin'
    if hostname == 'mp.weixin.qq.com':
        return 'wechat'
    if any(
        _host_matches(hostname, domain)
        for domain in ("xiaohongshu.com", "rednote.com", "xhslink.com")
    ):
        return 'xiaohongshu'
    return 'unknown'


def _trusted_douyin_page_url(url: str) -> bool:
    """Accept only ordinary HTTPS pages on official Douyin hosts."""
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower().rstrip(".")
    return bool(
        parsed.scheme.lower() == "https"
        and not parsed.username
        and not parsed.password
        and port in (None, 443)
        and (
            _host_matches(hostname, "douyin.com")
            or _host_matches(hostname, "iesdouyin.com")
        )
    )


def normalize_share_url(value: str) -> str:
    """Extract one supported HTTP(S) URL from a copied platform share message.

    Mobile share actions commonly copy a caption, hashtags and an URL as one
    string. Downstream connectors must receive only the URL. Prefer a supported
    platform URL when several links are present.
    """
    raw = unescape(str(value or "")).strip()
    if not raw:
        return ""

    candidates: list[str] = []
    for match in _SHARE_URL_PATTERN.finditer(raw):
        candidate = match.group(0).rstrip(_TRAILING_SHARE_PUNCTUATION)
        if candidate:
            candidates.append(candidate)
    if not candidates:
        return raw

    for candidate in candidates:
        if _platform_from_url(candidate) != "unknown":
            return candidate
    return candidates[0]


def _detect_platform(value: str) -> str:
    """Return a platform identifier after normalizing copied share text."""
    return _platform_from_url(normalize_share_url(value))


def _first_http_url(value: object) -> str:
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return value
    if isinstance(value, (list, tuple)):
        for item in value:
            found = _first_http_url(item)
            if found:
                return found
    if isinstance(value, Mapping):
        for key in ("url_list", "url", "uri"):
            found = _first_http_url(value.get(key))
            if found:
                return found
    return ""


def _probe_douyin_item(payload: object, *, depth: int = 0) -> Mapping[str, Any] | None:
    """Find a Douyin item in normalized or loader-data shaped output."""
    if depth > 5:
        return None
    if isinstance(payload, Mapping):
        has_id = any(payload.get(key) for key in ("video_id", "aweme_id", "id"))
        if has_id and (
            payload.get("url")
            or payload.get("download_url")
            or isinstance(payload.get("video"), Mapping)
        ):
            return payload
        item_list = payload.get("item_list") or payload.get("aweme_list")
        if isinstance(item_list, list):
            for item in item_list[:5]:
                found = _probe_douyin_item(item, depth=depth + 1)
                if found is not None:
                    return found
        for key in ("videoInfoRes", "aweme_detail", "data", "loaderData"):
            found = _probe_douyin_item(payload.get(key), depth=depth + 1)
            if found is not None:
                return found
        if depth <= 2:
            for item in list(payload.values())[:30]:
                found = _probe_douyin_item(item, depth=depth + 1)
                if found is not None:
                    return found
    elif isinstance(payload, list):
        for item in payload[:10]:
            found = _probe_douyin_item(item, depth=depth + 1)
            if found is not None:
                return found
    return None


def _normalize_douyin_info(payload: object) -> dict[str, Any]:
    item = _probe_douyin_item(payload)
    if item is None:
        raise VideoMetadataUnavailableError(_DOUYIN_INFO_UNAVAILABLE)

    video = item.get("video") if isinstance(item.get("video"), Mapping) else {}
    play = (
        video.get("play_addr")
        or video.get("play_addr_h264")
        or video.get("play_addr_265")
        or {}
    )
    video_id = str(
        item.get("video_id") or item.get("aweme_id") or item.get("id") or ""
    ).strip()
    media_url = _first_http_url(
        item.get("url") or item.get("download_url") or item.get("play_url") or play
    )
    if not video_id or not media_url:
        raise VideoMetadataUnavailableError(_DOUYIN_INFO_UNAVAILABLE)
    media_url = media_url.replace("playwm", "play")

    author = item.get("author") if isinstance(item.get("author"), Mapping) else {}
    cover = video.get("cover") or video.get("origin_cover") or item.get("cover_url")
    normalized = dict(item)
    normalized.update({
        "video_id": video_id,
        "title": str(item.get("title") or item.get("desc") or "抖音作品").strip(),
        "url": media_url,
        "cover_url": _first_http_url(cover),
        "author_name": str(
            item.get("author_name") or author.get("nickname") or ""
        ).strip(),
    })
    return normalized


def _read_douyin_router_payload(response: Any) -> Mapping[str, Any] | None:
    try:
        declared_size = int(response.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        declared_size = 0
    if declared_size > _DOUYIN_ROUTER_MAX_BYTES:
        return None

    body = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        body.extend(chunk)
        if len(body) > _DOUYIN_ROUTER_MAX_BYTES:
            return None
    html = bytes(body).decode("utf-8", errors="replace")
    match = re.search(
        r"window\._ROUTER_DATA\s*=\s*(.*?)</script>",
        html,
        flags=re.DOTALL,
    )
    if not match:
        return None
    raw_json = match.group(1).strip().removesuffix(";").strip()
    try:
        payload = json.loads(raw_json)
    except (TypeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, Mapping) else None


def _douyin_aweme_id_from_url(value: str) -> str:
    if not _trusted_douyin_page_url(value):
        return ""
    match = re.search(
        r"/(?:share/)?(?:video|note)/(\d{8,32})(?:[/?#]|$)",
        value,
    )
    return match.group(1) if match else ""


def _fetch_douyin_router_page(
    value: str,
) -> tuple[str, Mapping[str, Any] | None]:
    """Fetch bounded official HTML and recover its router payload.

    Redirects are followed manually so every hop is checked against the same
    strict Douyin hostname allowlist. No cookies or user credentials are sent.
    """
    import requests

    initial_url = normalize_share_url(value)
    if not _trusted_douyin_page_url(initial_url):
        return "", None
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
            "Mobile/15E148 Safari/604.1"
        ),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
    }
    candidates = [initial_url]
    visited: set[str] = set()
    resolved_id = _douyin_aweme_id_from_url(initial_url)
    session = requests.Session()
    session.trust_env = False
    try:
        while candidates:
            current = candidates.pop(0)
            for _redirect in range(_DOUYIN_ROUTER_MAX_REDIRECTS + 1):
                if current in visited or not _trusted_douyin_page_url(current):
                    break
                visited.add(current)
                response = None
                try:
                    response = session.get(
                        current,
                        headers=headers,
                        timeout=(
                            _DOUYIN_ROUTER_CONNECT_TIMEOUT,
                            _DOUYIN_ROUTER_READ_TIMEOUT,
                        ),
                        allow_redirects=False,
                        stream=True,
                    )
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = str(response.headers.get("Location") or "").strip()
                        redirected = urljoin(current, location)
                        if not location or not _trusted_douyin_page_url(redirected):
                            break
                        resolved_id = (
                            _douyin_aweme_id_from_url(redirected) or resolved_id
                        )
                        current = redirected
                        continue
                    response.raise_for_status()
                    final_url = str(getattr(response, "url", "") or current)
                    if not _trusted_douyin_page_url(final_url):
                        break
                    resolved_id = _douyin_aweme_id_from_url(final_url) or resolved_id
                    payload = _read_douyin_router_payload(response)
                    if payload is not None and _probe_douyin_item(payload) is not None:
                        item = _probe_douyin_item(payload)
                        payload_id = str(
                            (item or {}).get("video_id")
                            or (item or {}).get("aweme_id")
                            or (item or {}).get("id")
                            or ""
                        ).strip()
                        if re.fullmatch(r"\d{8,32}", payload_id):
                            resolved_id = payload_id
                        return resolved_id, payload
                    if resolved_id:
                        canonical = (
                            "https://www.iesdouyin.com/share/video/"
                            f"{resolved_id}"
                        )
                        if canonical not in visited and canonical not in candidates:
                            candidates.append(canonical)
                    break
                except requests.RequestException:
                    break
                finally:
                    if response is not None:
                        response.close()
        return resolved_id, None
    finally:
        session.close()


def _fetch_douyin_router_payload(value: str) -> Mapping[str, Any] | None:
    """Compatibility wrapper returning only usable router metadata."""
    return _fetch_douyin_router_page(value)[1]


def resolve_douyin_aweme_id(value: str) -> str:
    """Resolve a public Douyin URL to a validated numeric work identifier."""
    clean_url = normalize_share_url(value)
    direct = _douyin_aweme_id_from_url(clean_url)
    if direct:
        return direct
    resolved_id, _payload = _fetch_douyin_router_page(clean_url)
    return resolved_id


def _parse_douyin_share_info(processor: DouyinProcessor, value: str) -> dict[str, Any]:
    clean_url = normalize_share_url(value)
    try:
        payload = processor.parse_share_url(clean_url)
    except KeyError:
        # The upstream connector historically indexed ``videoInfoRes``
        # directly. Probe the bounded official page before giving up.
        resolved_id, payload = _fetch_douyin_router_page(clean_url)
        if payload is None:
            raise VideoMetadataUnavailableError(
                _DOUYIN_INFO_UNAVAILABLE,
                item_id=resolved_id,
            ) from None
    except (IndexError, TypeError):
        raise VideoMetadataUnavailableError(_DOUYIN_INFO_UNAVAILABLE) from None
    return _normalize_douyin_info(payload)


_BILI_HEADERS = [
    '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--add-header', 'Referer:https://www.bilibili.com/',
    '--add-header', 'Origin:https://www.bilibili.com',
    '--add-header', 'Accept-Language:zh-CN,zh;q=0.9,en;q=0.8',
]

_BILI_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
_BILI_API_BASE = "https://api.bilibili.com"
_BILI_AUDIO_MAX_BYTES = 800 * 1024 * 1024
_ASR_DIRECT_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
_ASR_RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
_ASR_MAX_ATTEMPTS = 3
_ASR_RETRY_DELAYS_SECONDS = (0.75, 1.5)
_ASR_MAX_RETRY_AFTER_SECONDS = 8.0


class CloudAsrError(RuntimeError):
    """云端 ASR 的安全、可操作错误。

    不保留供应商响应正文，避免网关回显请求标识或内部信息；调用方可以直接
    展示 ``public_message``，并根据 ``retryable`` 决定是否返回 HTTP 503。
    """

    def __init__(
        self,
        public_message: str,
        *,
        retryable: bool,
        status_code: int | None = None,
        attempts: int = 1,
    ) -> None:
        super().__init__(public_message)
        self.public_message = public_message
        self.retryable = retryable
        self.status_code = status_code
        self.attempts = max(1, int(attempts))


def _cloud_asr_http_message(status_code: int, *, attempts: int) -> str:
    if status_code in {401, 403}:
        return "云端语音识别配置无效，请联系管理员检查 ASR 凭据"
    if status_code == 413:
        return "音频片段超过云端语音识别服务的大小限制"
    if status_code == 429:
        return f"云端语音识别请求过多，已自动尝试 {attempts} 次，请稍后重新提取"
    if status_code == 503:
        return f"云端语音识别服务暂时不可用（HTTP 503），已自动尝试 {attempts} 次，请稍后重新提取"
    if status_code in _ASR_RETRYABLE_HTTP_STATUSES:
        return f"云端语音识别服务暂时繁忙（HTTP {status_code}），已自动尝试 {attempts} 次，请稍后重新提取"
    return f"云端语音识别请求失败（HTTP {status_code}），请稍后重新提取"


def _cloud_asr_retry_delay(response: Any | None, attempt: int) -> float:
    """返回有上限的短暂退避时间，并尊重数值型 Retry-After。"""
    retry_after = ""
    if response is not None:
        retry_after = str(response.headers.get("Retry-After") or "").strip()
    try:
        provider_delay = float(retry_after)
    except (TypeError, ValueError):
        provider_delay = 0.0
    base_delay = _ASR_RETRY_DELAYS_SECONDS[
        min(max(attempt - 1, 0), len(_ASR_RETRY_DELAYS_SECONDS) - 1)
    ]
    bounded_delay = min(
        _ASR_MAX_RETRY_AFTER_SECONDS,
        max(base_delay, provider_delay),
    )
    # 少量抖动可避免批量请求在供应商恢复后同时重试，再次形成流量尖峰。
    return min(
        _ASR_MAX_RETRY_AFTER_SECONDS,
        bounded_delay + random.uniform(0.0, min(0.25, bounded_delay * 0.2)),
    )


def _clean_bilibili_url(url: str) -> str:
    """Extract a clean B站 BV/av URL from any user input."""
    import re as _re
    from urllib.parse import parse_qs as _parse_qs, urlsplit as _urlsplit

    # Multi-P creator catalog items use the stable ``?p=N`` selector. Keep
    # only that bounded integer and discard every tracking/signature query.
    try:
        raw_page = (_parse_qs(_urlsplit(url).query).get('p') or [''])[0]
        page = int(raw_page) if str(raw_page).isdigit() else 0
    except (TypeError, ValueError):
        page = 0
    page_query = f'?p={page}' if 1 <= page <= 10_000 else ''
    # b23.tv short link → pass through raw
    if 'b23.tv' in url:
        return url.split('?')[0].split(' ')[0].rstrip('/')
    # Extract BV/av number
    m = _re.search(r'(?:/video/|/bangumi/play/)(BV[\w]+|av\d+|ep\d+|ss\d+)', url)
    if m:
        return f'https://www.bilibili.com/video/{m.group(1)}/{page_query}'
    # Fallback: strip query + spaces
    return url.split('?')[0].split(' ')[0].rstrip('/')


def _bilibili_api_data(path: str, params: dict[str, Any]) -> dict[str, Any]:
    """Read one public Bilibili API response without depending on the video page.

    Bilibili may return HTTP 412 for cloud-server requests to ``/video/*`` while
    its public metadata and play APIs remain available.  Keeping this path
    independent from yt-dlp prevents one page-level risk-control response from
    disabling metadata, covers, subtitles and audio extraction together.
    """
    import requests as _requests

    with _requests.Session() as session:
        session.trust_env = False
        response = session.get(
            f"{_BILI_API_BASE}{path}",
            params=params,
            headers=_BILI_HTTP_HEADERS,
            timeout=(8, 30),
        )
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or int(payload.get("code") or 0) != 0:
        message = str((payload or {}).get("message") or "B站公开接口暂时不可用")
        raise RuntimeError(message[:160])
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def _bilibili_public_info(url: str) -> dict[str, Any]:
    """Resolve stable Bilibili metadata through the public view API."""
    clean_url = _clean_bilibili_url(url)
    bv_match = re.search(r"(BV[0-9A-Za-z]+)", clean_url)
    if not bv_match:
        raise RuntimeError("B站公开视频接口需要有效的 BV 号")
    bvid = bv_match.group(1)
    view = _bilibili_api_data("/x/web-interface/view", {"bvid": bvid})
    pages = view.get("pages") if isinstance(view.get("pages"), list) else []
    try:
        page_number = int((parse_qs(urlsplit(clean_url).query).get("p") or ["1"])[0])
    except (TypeError, ValueError):
        page_number = 1
    page_number = min(max(page_number, 1), max(len(pages), 1))
    page = pages[page_number - 1] if pages else {}
    owner = view.get("owner") if isinstance(view.get("owner"), dict) else {}
    published_at = ""
    try:
        published_at = datetime.fromtimestamp(
            int(view.get("pubdate") or 0),
            tz=timezone.utc,
        ).isoformat()
    except (OSError, OverflowError, TypeError, ValueError):
        pass
    source_url = f"https://www.bilibili.com/video/{bvid}/"
    if page_number > 1:
        source_url += f"?p={page_number}"
    cover_url = str(view.get("pic") or "").strip()
    if cover_url.startswith("http://"):
        cover_url = "https://" + cover_url.removeprefix("http://")
    return {
        "video_id": bvid,
        "bvid": bvid,
        "cid": str(page.get("cid") or view.get("cid") or ""),
        "page": page_number,
        "pages": pages,
        "title": str(view.get("title") or page.get("part") or "B站视频"),
        "description": str(view.get("desc") or ""),
        "author_name": str(owner.get("name") or ""),
        "author_id": str(owner.get("mid") or ""),
        "cover_url": cover_url,
        "tags": [],
        "duration": page.get("duration") or view.get("duration"),
        "published_at": published_at,
        "source_url": source_url,
        "webpage_url": source_url,
        # Signed CDN URLs are resolved only when needed and never persisted.
        "media_url": "",
        "download_url": "",
        "url": "",
        "platform": "bilibili",
        "media_type": "video",
        "subtitles": {},
        "automatic_captions": {},
    }

def _bilibili_get_title(bvid: str) -> str:
    """Return the title for a B站 BV id, or empty string on any error."""
    try:
        r = subprocess.run(
            [sys.executable, '-c',
             f'from bilibili_api import video; import asyncio; '
             f'v=video.Video(bvid=\"{bvid}\"); '
             f'info=asyncio.run(v.get_info()); '
             f'print(info.get(\"title\",\"\"))'],
            capture_output=True, text=True, timeout=15,
        )
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''

def _parse_bilibili(url: str) -> dict[str, Any]:
    """Extract normalized Bilibili metadata, preferring the public view API."""
    import json as _json
    import re as _re

    clean_url = _clean_bilibili_url(url)
    bv_match = _re.search(r'(BV[\w]+|av\d+)', clean_url)
    bvid = bv_match.group(1) if bv_match else ''

    # The public API remains usable when Bilibili rejects a cloud server's
    # webpage request with HTTP 412.  It is also substantially faster than
    # spawning yt-dlp for each item in an account batch.
    try:
        return _bilibili_public_info(clean_url)
    except Exception:
        pass

    full_cmd = [
        sys.executable, '-m', 'yt_dlp',
        '--dump-single-json', '--no-playlist', '--skip-download',
        *_BILI_HEADERS,
        clean_url,
    ]
    try:
        full_result = subprocess.run(
            full_cmd, capture_output=True, text=True, timeout=45,
        )
        if full_result.returncode == 0 and full_result.stdout.strip():
            info = _json.loads(full_result.stdout)
            source_url = (
                info.get('webpage_url')
                or (f'https://www.bilibili.com/video/{bvid}/' if bvid else clean_url)
            )
            media_url = info.get('url', '')
            return {
                'video_id': info.get('id', '') or bvid,
                'title': info.get('title', 'B站视频'),
                'description': info.get('description') or '',
                'author_name': info.get('uploader') or info.get('channel') or '',
                'author_id': str(info.get('uploader_id') or info.get('channel_id') or ''),
                'cover_url': info.get('thumbnail') or '',
                'tags': [str(tag) for tag in (info.get('tags') or []) if str(tag).strip()],
                'duration': info.get('duration'),
                'published_at': info.get('upload_date') or '',
                'source_url': source_url,
                'webpage_url': source_url,
                'media_url': media_url,
                'download_url': media_url,
                'url': media_url,
                'platform': 'bilibili',
                'media_type': 'video',
                'subtitles': info.get('subtitles') or {},
                'automatic_captions': info.get('automatic_captions') or {},
            }
    except (OSError, subprocess.TimeoutExpired, _json.JSONDecodeError):
        pass

    # ── bilibili-api (never chokes under uvicorn's asyncio loop) ──
    if bvid:
        try:
            # Use a subprocess to avoid event-loop clobbering inside uvicorn
            info_raw = subprocess.run(
                [sys.executable, '-c',
                 f'from bilibili_api import video; import asyncio; '
                 f'v=video.Video(bvid=\"{bvid}\"); '
                 f'info=asyncio.run(v.get_info()); '
                 f'print(info.get(\"title\",\"\"))'],
                capture_output=True, text=True, timeout=15,
            )
            title = info_raw.stdout.strip()
            if title and info_raw.returncode == 0:
                return {
                    'video_id': bvid,
                    'title': title,
                    'download_url': '',
                    'url': '',
                    'source_url': f'https://www.bilibili.com/video/{bvid}/',
                    'description': '',
                    'author_name': '',
                    'cover_url': '',
                    'tags': [],
                    'platform': 'bilibili',
                    'media_type': 'video',
                    'subtitles': {},
                    'automatic_captions': {},
                }
        except Exception:
            pass  # Fall through to yt-dlp on error

    # ── Fallback: yt-dlp (only reached if bilibili-api completely fails) ──
    cmd = [
        sys.executable, '-m', 'yt_dlp',
        '--dump-json', '--no-playlist', '--no-download',
        *_BILI_HEADERS,
        clean_url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise NotImplementedError(
            "B站视频解析需要 yt-dlp，请先安装: pip install yt-dlp"
        )
    if r.returncode != 0:
        raise RuntimeError(
            f"yt-dlp 解析 B站视频失败 (code={r.returncode}): {r.stderr[:300]}"
        )
    info = _json.loads(r.stdout)
    bv_link = f'https://www.bilibili.com/video/{bvid}/' if bvid else ''
    return {
        'video_id': info.get('id', ''),
        'title': info.get('title', 'B站视频'),
        'description': info.get('description') or '',
        'author_name': info.get('uploader') or '',
        'cover_url': info.get('thumbnail') or '',
        'tags': info.get('tags') or [],
        'source_url': info.get('webpage_url') or bv_link,
        'media_url': info.get('url', ''),
        'download_url': info.get('url', ''),
        'url': info.get('url', ''),
        'platform': 'bilibili',
        'media_type': 'video',
        'subtitles': info.get('subtitles', {}),
        'automatic_captions': info.get('automatic_captions') or {},
    }


def _bilibili_subtitles_with_source(
    url: str,
    info: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """Download available Bilibili subtitles and report their source.

    Raises RuntimeError if no subtitles are available.
    """
    resolved = info or _parse_bilibili(url)
    bvid = str(resolved.get("bvid") or resolved.get("video_id") or "").strip()
    cid = str(resolved.get("cid") or "").strip()
    public_player_read = False
    if bvid.startswith("BV") and cid:
        try:
            player = _bilibili_api_data(
                "/x/player/v2",
                {"bvid": bvid, "cid": cid},
            )
            public_player_read = True
            subtitle_data = player.get("subtitle")
            subtitle_items = (
                subtitle_data.get("subtitles")
                if isinstance(subtitle_data, dict)
                and isinstance(subtitle_data.get("subtitles"), list)
                else []
            )
            preferred = sorted(
                (item for item in subtitle_items if isinstance(item, dict)),
                key=lambda item: (
                    0 if str(item.get("lan") or "").lower() in {"zh-hans", "zh-cn", "zh"} else 1,
                    str(item.get("lan") or ""),
                ),
            )
            import requests as _requests

            for item in preferred:
                subtitle_url = str(item.get("subtitle_url") or "").strip()
                if subtitle_url.startswith("//"):
                    subtitle_url = "https:" + subtitle_url
                if not subtitle_url.startswith("https://"):
                    continue
                with _requests.Session() as session:
                    session.trust_env = False
                    response = session.get(
                        subtitle_url,
                        headers=_BILI_HTTP_HEADERS,
                        timeout=(8, 30),
                    )
                    response.raise_for_status()
                    body = response.json().get("body") or []
                lines: list[str] = []
                for row in body:
                    if not isinstance(row, dict):
                        continue
                    line = str(row.get("content") or "").strip()
                    if line and (not lines or lines[-1] != line):
                        lines.append(line)
                clean = "\n".join(lines).strip()
                if clean:
                    language = str(item.get("lan") or "").lower()
                    source = (
                        "automatic-subtitle"
                        if language.startswith("ai-") or bool(item.get("ai_type"))
                        else "manual-subtitle"
                    )
                    return clean, source
        except Exception:
            # Old/region-limited videos may not expose subtitles through the
            # public player API.  Keep yt-dlp as a compatibility fallback.
            pass
    if public_player_read:
        raise RuntimeError("B站视频没有可用的字幕")

    clean_url = _clean_bilibili_url(url)
    manual_available = bool(resolved.get('subtitles'))
    with tempfile.TemporaryDirectory() as tmpdir:
        outtmpl = os.path.join(tmpdir, '%(id)s.%(ext)s')
        cmd = [
            sys.executable, '-m', 'yt_dlp',
            '--write-subs', '--write-auto-subs',
            '--sub-langs', 'zh-Hans,zh-CN,zh,ai-zh,en',
            '--convert-subs', 'srt',
            '--skip-download',
            '--output', outtmpl,
            *_BILI_HEADERS,
            clean_url,
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            raise NotImplementedError(
                "B站字幕下载需要 yt-dlp，请先安装: pip install yt-dlp"
            )

        for f in sorted(os.listdir(tmpdir)):
            if f.endswith(('.srt', '.vtt')):
                sub_path = os.path.join(tmpdir, f)
                with open(sub_path, encoding='utf-8') as sf:
                    content = sf.read()
                lines: list[str] = []
                for raw_line in content.splitlines():
                    line = raw_line.strip()
                    if not line or line == 'WEBVTT' or line.isdigit() or '-->' in line:
                        continue
                    line = re.sub(r'<[^>]+>', '', line).strip()
                    if line and (not lines or lines[-1] != line):
                        lines.append(line)
                clean = '\n'.join(lines).strip()
                if clean:
                    source = 'manual-subtitle' if manual_available else 'automatic-subtitle'
                    return clean, source

        raise RuntimeError("B站视频没有可用的字幕")


def _bilibili_subtitles(url: str) -> str:
    """Backward-compatible text-only wrapper for existing callers."""
    return _bilibili_subtitles_with_source(url)[0]


def _bilibili_download_audio(url: str, output_dir: str) -> str:
    """Download B站 audio track to *output_dir*, return the file path."""
    resolved = _parse_bilibili(url)
    bvid = str(resolved.get("bvid") or resolved.get("video_id") or "").strip()
    cid = str(resolved.get("cid") or "").strip()
    if bvid.startswith("BV") and cid:
        try:
            play = _bilibili_api_data(
                "/x/player/playurl",
                {
                    "bvid": bvid,
                    "cid": cid,
                    "qn": 64,
                    "fnval": 16,
                    "fourk": 1,
                },
            )
            dash = play.get("dash") if isinstance(play.get("dash"), dict) else {}
            audio_tracks = dash.get("audio") if isinstance(dash.get("audio"), list) else []
            candidates = sorted(
                (track for track in audio_tracks if isinstance(track, dict)),
                key=lambda track: int(track.get("bandwidth") or 0),
            )
            import requests as _requests

            for track in candidates:
                urls = [
                    track.get("baseUrl") or track.get("base_url"),
                    *(track.get("backupUrl") or track.get("backup_url") or []),
                ]
                for candidate_url in urls:
                    media_url = str(candidate_url or "").strip()
                    if not media_url.startswith("https://"):
                        continue
                    raw_path = Path(output_dir) / "bilibili-audio.m4s"
                    mp3_path = Path(output_dir) / "bilibili-audio.mp3"
                    try:
                        with _requests.Session() as session:
                            session.trust_env = False
                            with session.get(
                                media_url,
                                headers={
                                    **_BILI_HTTP_HEADERS,
                                    "Referer": f"https://www.bilibili.com/video/{bvid}/",
                                },
                                stream=True,
                                timeout=(10, 300),
                            ) as response:
                                response.raise_for_status()
                                content_length = int(response.headers.get("Content-Length") or 0)
                                if content_length > _BILI_AUDIO_MAX_BYTES:
                                    raise RuntimeError("B站音轨过大，暂不支持提取")
                                written = 0
                                with raw_path.open("wb") as output:
                                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                                        if not chunk:
                                            continue
                                        written += len(chunk)
                                        if written > _BILI_AUDIO_MAX_BYTES:
                                            raise RuntimeError("B站音轨过大，暂不支持提取")
                                        output.write(chunk)
                        if not raw_path.exists() or raw_path.stat().st_size == 0:
                            raise RuntimeError("B站音轨为空")
                        converted = subprocess.run(
                            [
                                _get_ffmpeg_path(),
                                "-y",
                                "-loglevel",
                                "error",
                                "-i",
                                str(raw_path),
                                "-vn",
                                "-ac",
                                "1",
                                "-ar",
                                "16000",
                                "-codec:a",
                                "libmp3lame",
                                "-b:a",
                                "48k",
                                str(mp3_path),
                            ],
                            capture_output=True,
                            text=True,
                            timeout=900,
                        )
                        if converted.returncode != 0 or not mp3_path.exists():
                            raise RuntimeError(f"B站音轨转换失败：{converted.stderr[-200:]}")
                        raw_path.unlink(missing_ok=True)
                        return str(mp3_path)
                    except Exception:
                        raw_path.unlink(missing_ok=True)
                        mp3_path.unlink(missing_ok=True)
                        continue
        except Exception:
            pass

    clean_url = _clean_bilibili_url(url)
    outtmpl = os.path.join(output_dir, '%(id)s.%(ext)s')
    cmd = [
        sys.executable, '-m', 'yt_dlp',
        '-f', 'worstaudio',
        '--output', outtmpl,
        *_BILI_HEADERS,
        clean_url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        raise NotImplementedError(
            "B站音频下载需要 yt-dlp，请先安装: pip install yt-dlp"
        )
    for f in os.listdir(output_dir):
        if f.endswith(('.m4a', '.mp3', '.webm', '.opus')):
            return os.path.join(output_dir, f)
    raise RuntimeError(f"B站音频下载失败: {r.stderr[:300]}")


def _asr_single_audio_file(
    audio_path: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
) -> str:
    """发送单个受限大小的音频，仅对临时故障自动重试。"""
    import requests as _req
    api_base_url = api_base_url or "https://api.siliconflow.cn/v1/audio/transcriptions"
    model = model or "FunAudioLLM/SenseVoiceSmall"

    for attempt in range(1, _ASR_MAX_ATTEMPTS + 1):
        response = None
        try:
            # 每次重试都重新打开文件；requests 会消费文件流，复用句柄会上传空内容。
            with open(audio_path, "rb") as source:
                response = _req.post(
                    api_base_url,
                    headers={"Authorization": f"Bearer {api_key}"},
                    data={"model": model},
                    files={"file": source},
                    timeout=300,
                )
        except (_req.Timeout, _req.ConnectionError) as exc:
            if attempt < _ASR_MAX_ATTEMPTS:
                time.sleep(_cloud_asr_retry_delay(None, attempt))
                continue
            raise CloudAsrError(
                f"云端语音识别网络连接暂时失败，已自动尝试 {attempt} 次，请稍后重新提取",
                retryable=True,
                attempts=attempt,
            ) from exc

        status_code = int(response.status_code)
        retryable = status_code in _ASR_RETRYABLE_HTTP_STATUSES
        if retryable and attempt < _ASR_MAX_ATTEMPTS:
            time.sleep(_cloud_asr_retry_delay(response, attempt))
            continue
        if status_code >= 400:
            raise CloudAsrError(
                _cloud_asr_http_message(status_code, attempts=attempt),
                retryable=retryable,
                status_code=status_code,
                attempts=attempt,
            )

        try:
            payload = response.json()
        except (TypeError, ValueError) as exc:
            raise CloudAsrError(
                "云端语音识别返回了无法解析的结果，请稍后重新提取",
                retryable=False,
                status_code=status_code,
                attempts=attempt,
            ) from exc
        if not isinstance(payload, dict):
            raise CloudAsrError(
                "云端语音识别返回了无法解析的结果，请稍后重新提取",
                retryable=False,
                status_code=status_code,
                attempts=attempt,
            )
        return str(payload.get("text") or "")

    raise AssertionError("ASR retry loop exited unexpectedly")


def _asr_audio_file(
    audio_path: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
) -> str:
    """Transcribe short audio directly and split long Bilibili audio safely."""
    source = Path(audio_path)
    if source.stat().st_size <= _ASR_DIRECT_UPLOAD_MAX_BYTES:
        return _asr_single_audio_file(
            str(source), api_key, api_base_url, model,
        )

    with tempfile.TemporaryDirectory(prefix="zhicui-bili-asr-") as chunk_dir:
        chunk_pattern = str(Path(chunk_dir) / "chunk-%03d.mp3")
        segmented = subprocess.run(
            [
                _get_ffmpeg_path(),
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(source),
                "-f",
                "segment",
                "-segment_time",
                "900",
                "-reset_timestamps",
                "1",
                "-c",
                "copy",
                chunk_pattern,
            ],
            capture_output=True,
            text=True,
            timeout=900,
        )
        chunks = sorted(Path(chunk_dir).glob("chunk-*.mp3"))
        if segmented.returncode != 0 or not chunks:
            raise RuntimeError(f"长音频切分失败：{segmented.stderr[-200:]}")
        texts = [
            _asr_single_audio_file(str(chunk), api_key, api_base_url, model).strip()
            for chunk in chunks
        ]
    return "\n".join(text for text in texts if text).strip()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_video_info(url: str) -> dict[str, Any]:
    """Return video_id, title, and download_url for a video share link.

    Supports Douyin (抖音) and Bilibili (B站).
    Does NOT require an API key -- only fetches metadata.
    """
    url = normalize_share_url(url)
    platform = _detect_platform(url)

    if platform == 'bilibili':
        return _parse_bilibili(url)

    if platform == 'wechat':
        from app.services.wechat_extractor import extract_wechat_article
        article = extract_wechat_article(url)
        return {
            "video_id": article["video_id"],
            "title": article["title"],
            "download_url": article["download_url"],
            "platform": "wechat",
        }

    if platform == 'xiaohongshu':
        from app.services.xhs_extractor import parse_xhs_note
        import os as _os
        cookie = _os.environ.get('XHS_COOKIE', '')
        note = parse_xhs_note(url, cookie=cookie)
        return {
            "video_id": note.get("note_id", ""),
            "title": note.get("title", "小红书笔记"),
            "download_url": "",
            "platform": "xiaohongshu",
        }

    if platform == 'unknown':
        raise NotImplementedError(
            "暂不支持该平台的视频链接。当前支持：抖音、B站、微信公众号、小红书。"
        )

    # Douyin path
    processor = DouyinProcessor(api_key="")
    info = _parse_douyin_share_info(processor, url)
    return {
        "video_id": info["video_id"],
        "title": info["title"],
        "download_url": info["url"],
        "cover_url": info.get("cover_url", ""),
        "author_name": info.get("author_name", ""),
        "platform": "douyin",
        "source_url": url,
    }


def extract_transcript(
    url: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
    *,
    video_info: Mapping[str, Any] | None = None,
) -> str:
    """Full pipeline: parse -> download -> extract audio -> transcribe.

    Supports Douyin (抖音) and Bilibili (B站).

    Parameters
    ----------
    url:
        A video share link (Douyin or Bilibili).
    api_key:
        SiliconFlow API key used for the ASR endpoint.
    api_base_url:
        Optional ASR endpoint URL. Defaults to ``DouyinProcessor`` settings.
    model:
        Optional ASR model name. Defaults to ``DouyinProcessor`` settings.

    Returns
    -------
    str
        The transcribed text.
    """
    url = normalize_share_url(url)
    platform = _detect_platform(url)

    if platform == 'wechat':
        raise NotImplementedError(
            "微信公众号文章无需语音识别，直接使用文章文本作为文案"
        )

    if platform == 'xiaohongshu':
        from app.services.xhs_extractor import extract_xhs_content
        import os as _os
        cookie = _os.environ.get('XHS_COOKIE', '')
        return extract_xhs_content(url, cookie=cookie)

    if platform == 'bilibili':
        # B站: fast subtitle check (15s timeout), skip if none
        try:
            subs = _bilibili_subtitles(url)
            if subs.strip() and len(subs) > 50:
                return subs
        except Exception:
            pass  # No subs — fall through to audio download + ASR

        info = _parse_bilibili(url)

        # No subtitles → download audio → cloud ASR
        if api_key:
            import tempfile as _tmp
            import traceback as _tb
            try:
                with _tmp.TemporaryDirectory() as tmpdir:
                    audio_path = _bilibili_download_audio(url, tmpdir)
                    text = _asr_audio_file(audio_path, api_key, api_base_url, model)
                    if text and text.strip():
                        return text
            except Exception:
                _tb.print_exc()

        # Cloud ASR failed → title fallback
        return f"[B站视频] {info.get('title', '')}"

    # Douyin path
    processor = DouyinProcessor(
        api_key=api_key,
        api_base_url=api_base_url,
        model=model,
    )
    resolved_video_info = (
        _normalize_douyin_info(video_info)
        if video_info is not None
        else _parse_douyin_share_info(processor, url)
    )

    # Download video to temp dir
    video_path = processor.download_video(resolved_video_info, show_progress=False)

    # Extract audio
    audio_path = processor.extract_audio(video_path, show_progress=False)

    # Transcribe (supports automatic splitting for long audio)
    text = processor.extract_text_from_audio(audio_path, show_progress=False)

    # Cleanup
    processor.cleanup_files(video_path, audio_path)

    return text


def extract_media_url_transcript(
    media_url: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
    *,
    max_bytes: int = 800 * 1024 * 1024,
    request_headers: dict[str, str] | None = None,
) -> str:
    """Transcribe a trusted direct media URL from the companion library.

    Video bytes are piped directly into FFmpeg without creating a video file.
    Only a compact temporary mono MP3 exists during ASR; the temporary
    directory is removed in ``finally`` on both success and failure.
    """
    import requests as _requests

    clean_url = media_url.strip()
    if not clean_url.startswith(("http://", "https://")):
        raise ValueError("媒体地址无效")
    has_sidecar_scope = any(
        str(name).lower() == "x-zhicui-scope"
        for name in (request_headers or {})
    )
    if has_sidecar_scope:
        parsed_media_url = urlsplit(clean_url)
        if (
            parsed_media_url.scheme != "http"
            or (parsed_media_url.hostname or "").lower() not in {"127.0.0.1", "::1"}
            or parsed_media_url.username
            or parsed_media_url.password
        ):
            raise ValueError("抖音连接器媒体地址不在本机回环范围内")

    temp_dir = Path(tempfile.mkdtemp(prefix="zhicui-library-"))
    audio_path = temp_dir / "audio.mp3"
    failures: list[str] = []
    cloud_failure: CloudAsrError | None = None

    try:
        ffmpeg_exe = _get_ffmpeg_path()
        command = [
            ffmpeg_exe,
            "-y",
            "-loglevel",
            "error",
            "-nostats",
            "-i",
            "pipe:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "64k",
            str(audio_path),
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            with _requests.Session() as session:
                session.trust_env = False
                with session.get(
                    clean_url,
                    headers=request_headers or None,
                    stream=True,
                    timeout=(10, 300),
                    allow_redirects=not has_sidecar_scope,
                ) as response:
                    if has_sidecar_scope and (
                        response.is_redirect or response.is_permanent_redirect
                    ):
                        raise RuntimeError("抖音连接器返回了不安全的媒体重定向")
                    response.raise_for_status()
                    content_length = int(response.headers.get("Content-Length") or 0)
                    if content_length > max_bytes:
                        raise RuntimeError("视频文件过大，暂不支持提取")

                    written = 0
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        written += len(chunk)
                        if written > max_bytes:
                            raise RuntimeError("视频文件过大，暂不支持提取")
                        if process.stdin is None:
                            raise RuntimeError("FFmpeg 输入管道不可用")
                        process.stdin.write(chunk)
            if written == 0:
                raise RuntimeError("下载器返回了空视频流")
            if process.stdin is not None:
                process.stdin.close()
            try:
                return_code = process.wait(timeout=600)
            except subprocess.TimeoutExpired as exc:
                process.kill()
                process.wait()
                raise RuntimeError("FFmpeg 提取音频超时") from exc
            stderr = (
                process.stderr.read().decode("utf-8", errors="replace")
                if process.stderr is not None
                else ""
            )
            if return_code != 0 or not audio_path.exists():
                raise RuntimeError(f"FFmpeg 提取音频失败：{stderr[-300:]}")
        except Exception:
            if process.poll() is None:
                process.kill()
                process.wait()
            raise

        if api_key:
            try:
                transcript = _asr_audio_file(
                    str(audio_path),
                    api_key,
                    api_base_url,
                    model,
                )
                if transcript and transcript.strip():
                    return transcript.strip()
                failures.append("云端 ASR 返回空文案")
            except CloudAsrError as exc:
                cloud_failure = exc
                failures.append(exc.public_message)
            except Exception:
                # 意外的第三方异常也不暴露供应商地址、临时路径或响应正文。
                failures.append("云端语音识别调用失败")

        try:
            from app.services.local_asr import transcribe_file, transcribe_with_whisper

            try:
                transcript = transcribe_file(audio_path)
            except Exception as exc:
                failures.append(f"本地 FunASR：{exc}")
                transcript = transcribe_with_whisper(str(audio_path), model_size="base")
            if transcript and transcript.strip():
                return transcript.strip()
            failures.append("本地 ASR 返回空文案")
        except Exception as exc:
            failures.append(f"本地 ASR：{exc}")

        if cloud_failure is not None:
            raise cloud_failure
        detail = "；".join(failures[-3:])
        raise RuntimeError(f"视频文案提取失败{f'：{detail}' if detail else ''}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def fallback_local_asr(
    url: str,
    *,
    video_info: Mapping[str, Any] | None = None,
) -> str:
    """Offline ASR fallback using FunASR (Alibaba DAMO Academy).

    Supports Douyin (抖音), Bilibili (B站), 微信公众号 (WeChat), and 小红书 (Xiaohongshu).
    Downloads the video, extracts audio, then
    transcribes locally with FunASR's Paraformer-large model.
    Falls back to faster-whisper if FunASR fails.
    """
    import tempfile as _tempfile
    import shutil as _shutil
    import subprocess as _subprocess
    from pathlib import Path as _Path

    from app.services.local_asr import transcribe_file, transcribe_with_whisper

    url = normalize_share_url(url)
    platform = _detect_platform(url)

    if platform == 'wechat':
        raise NotImplementedError(
            "微信公众号文章无需本地语音识别，直接使用文章文本作为文案"
        )

    if platform == 'xiaohongshu':
        from app.services.xhs_extractor import extract_xhs_content
        import os as _os
        cookie = _os.environ.get('XHS_COOKIE', '')
        return extract_xhs_content(url, cookie=cookie)

    if platform == 'bilibili':
        # B站: fast subtitle check, skip heavy audio download if subs exist
        try:
            subs = _bilibili_subtitles(url)
            if subs.strip() and len(subs) > 50:
                return subs
        except Exception:
            pass

        info = _parse_bilibili(url)

        # No subtitles → download audio → local FunASR / whisper
        import tempfile as _tmp2
        import shutil as _sh2
        import traceback as _tb2
        from pathlib import Path as _Path2
        tmp_dir = _Path2(_tmp2.mkdtemp())
        try:
            audio_path = _bilibili_download_audio(url, str(tmp_dir))
            try:
                text = transcribe_file(audio_path)
                if text and text.strip():
                    return text
            except Exception:
                _tb2.print_exc()
            text = transcribe_with_whisper(audio_path)
            if text and text.strip():
                return text
        except Exception:
            _tb2.print_exc()
        finally:
            _sh2.rmtree(tmp_dir, ignore_errors=True)

        # All local ASR failed → title fallback
        return f"[B站视频] {info.get('title', '')}"

    # Step 1: Extract video info to get the download URL
    processor = DouyinProcessor(api_key="")
    resolved_video_info = (
        _normalize_douyin_info(video_info)
        if video_info is not None
        else _parse_douyin_share_info(processor, url)
    )
    video_url = resolved_video_info["url"]

    # Step 2: Download video and extract audio
    temp_dir = _Path(_tempfile.mkdtemp())
    audio_path = temp_dir / "audio.mp3"

    try:
        # Download video
        video_path = temp_dir / "video.mp4"
        import requests as req
        headers = {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) '
                          'AppleWebKit/605.1.15 (KHTML, like Gecko) '
                          'EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1'
        }
        resp = req.get(video_url, headers=headers, stream=True)
        resp.raise_for_status()
        with open(video_path, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        # Extract audio using ffmpeg directly via subprocess
        ffmpeg_exe = _get_ffmpeg_path()
        cmd = [
            ffmpeg_exe, "-y",
            "-i", str(video_path),
            "-vn", "-acodec", "libmp3lame", "-q:a", "0",
            str(audio_path),
        ]
        result = _subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg 提取音频失败: {result.stderr[:200]}")

        # Step 3: Transcribe with FunASR (primary local ASR)
        try:
            text = transcribe_file(audio_path)
            if text.strip():
                return text
        except Exception as e:
            # FunASR failed, try faster-whisper as last resort
            text = transcribe_with_whisper(audio_path, model_size="base")
            if text.strip():
                return text

        raise RuntimeError("本地 ASR 未能识别到任何文本")

    finally:
        _shutil.rmtree(temp_dir, ignore_errors=True)


def _get_ffmpeg_path() -> str:
    """Get the full path to ffmpeg binary.

    Checks system PATH first, then falls back to imageio-ffmpeg bundled binary.
    """
    import shutil

    # Check system PATH
    found = shutil.which("ffmpeg")
    if found:
        return found

    # Use imageio-ffmpeg bundled binary
    import imageio_ffmpeg
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    # Create a copy named ffmpeg.exe if needed (imageio names it differently)
    ffmpeg_dir = os.path.dirname(ffmpeg_exe)
    ffmpeg_win = os.path.join(ffmpeg_dir, "ffmpeg.exe")
    if not os.path.exists(ffmpeg_win):
        import shutil as sh
        sh.copy2(ffmpeg_exe, ffmpeg_win)

    return ffmpeg_win
