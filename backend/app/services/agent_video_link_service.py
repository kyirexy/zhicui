"""Agent 显式公开视频链接：用户隔离、限量下载和文稿提取。"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import subprocess
import tempfile
import time
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator
from urllib.parse import parse_qs, urljoin, urlsplit

import urllib3
import requests
from sqlalchemy.orm import Session

from app.core.media_reference import stable_note_source
from app.models.note import Note
from app.services import douyin_library, library_sync_service, note_service, platform_library_service, settings_service, video_extractor


MAX_MEDIA_BYTES = 512 * 1024 * 1024
MAX_DOWNLOAD_SECONDS = 240
SOURCE_KIND = "agent-link-import"
_MEDIA_DOMAINS = {
    "douyin": platform_library_service._DOUYIN_MEDIA_DOMAINS,
    "bilibili": ("bilivideo.com", "bilivideo.cn", "bilivideo.net", "akamaized.net"),
}
_PAGE_DOMAINS = {
    "douyin": ("douyin.com", "iesdouyin.com"),
    "bilibili": ("bilibili.com", "b23.tv"),
}
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Accept-Encoding": "identity",
}
_WEB_DOWNLOAD_LIMIT = threading.BoundedSemaphore(4)
_WEB_DOWNLOAD_USERS: set[str] = set()
_WEB_DOWNLOAD_LOCK = threading.Lock()


class VideoLinkError(ValueError):
    def __init__(self, code: str, message: str, *, status: int = 422, retryable: bool = False):
        super().__init__(message)
        self.code, self.http_status, self.retryable = code, status, retryable


@contextmanager
def user_download_slot(user_id: str) -> Iterator[None]:
    """单工作进程最多 4 个下载、每用户 1 个；覆盖准备和文件发送全生命周期。"""
    with _WEB_DOWNLOAD_LOCK:
        if user_id in _WEB_DOWNLOAD_USERS or not _WEB_DOWNLOAD_LIMIT.acquire(blocking=False):
            raise VideoLinkError("DOWNLOAD_BUSY", "已有视频正在下载，请稍后再试", status=429, retryable=True)
        _WEB_DOWNLOAD_USERS.add(user_id)
    try:
        yield
    finally:
        with _WEB_DOWNLOAD_LOCK:
            _WEB_DOWNLOAD_USERS.discard(user_id)
            _WEB_DOWNLOAD_LIMIT.release()


def _target(value: str, domains: tuple[str, ...], *, resolve: bool = True) -> tuple[Any, str]:
    """仅接受官方域名公网 HTTPS；DNS 结果随后固定到连接，避免二次解析。"""
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        valid = (parsed.scheme == "https" and not parsed.username and not parsed.password
                 and parsed.port in (None, 443) and not parsed.fragment
                 and not any(ord(c) < 33 or ord(c) == 127 for c in value)
                 and any(host == domain or host.endswith("." + domain) for domain in domains))
    except ValueError:
        valid = False
    if not valid:
        raise VideoLinkError("UNSAFE_MEDIA_TARGET", "平台返回了不受支持的媒体地址")
    if not resolve:
        return parsed, ""
    try:
        addresses = list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
        if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
            raise ValueError("non-public address")
    except (OSError, ValueError):
        raise VideoLinkError("UNSAFE_MEDIA_TARGET", "平台媒体地址未通过公网校验") from None
    return parsed, addresses[0]


@contextmanager
def _get(url: str, *, domains: tuple[str, ...], referer: str, deadline: float):
    """固定 DNS、TLS SNI/证书主机检查；每次重定向重新校验，绝不转发 PAT。"""
    current = url
    for _ in range(5):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise VideoLinkError("MEDIA_TIMEOUT", "视频下载超时，请稍后重试", status=504, retryable=True)
        parsed, address = _target(current, domains)
        host = (parsed.hostname or "").rstrip(".")
        pool = urllib3.HTTPSConnectionPool(
            address, port=443, server_hostname=host, assert_hostname=host,
            cert_reqs="CERT_REQUIRED", maxsize=1,
            timeout=urllib3.Timeout(connect=min(8, remaining), read=min(20, remaining)),
        )
        response = None
        try:
            response = pool.urlopen(
                "GET", parsed.path + ("?" + parsed.query if parsed.query else "") or "/",
                headers={**_HEADERS, "Host": host, "Referer": referer},
                redirect=False, retries=False, preload_content=False,
            )
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get("Location", "")
                if not location:
                    raise VideoLinkError("PLATFORM_UNAVAILABLE", "平台没有返回视频内容", status=502)
                current = urljoin(current, location)
                continue
            if response.status in (401, 403, 412, 429):
                raise VideoLinkError("PLATFORM_AUTH_REQUIRED", "平台要求登录或验证，请在知萃客户端完成后重试；不会自动重试", status=409)
            if response.status != 200:
                raise VideoLinkError("PLATFORM_UNAVAILABLE", "平台暂时没有返回可下载的视频", status=502, retryable=True)
            yield response
            return
        except urllib3.exceptions.HTTPError:
            raise VideoLinkError("PLATFORM_UNAVAILABLE", "平台连接暂时不可用，请稍后重试", status=502, retryable=True) from None
        finally:
            if response is not None:
                response.close()
            pool.close()
    raise VideoLinkError("UNSAFE_MEDIA_TARGET", "平台重定向次数过多")


def _source(value: str) -> tuple[str, str]:
    url = video_extractor.normalize_share_url(value)
    platform = video_extractor._detect_platform(url)
    if platform not in _PAGE_DOMAINS:
        raise VideoLinkError("UNSUPPORTED_PLATFORM", "此入口只支持抖音和 B站的公开视频链接")
    _check_video_part(url, platform)
    # 源地址不允许 userinfo、非标准端口或私有地址；短链每一跳同样校验。
    _target(url, _PAGE_DOMAINS[platform], resolve=False)
    if urlsplit(url).hostname == "v.douyin.com":
        # 官方分享入口携带公开的跳转上下文；不要先跳一次、丢掉上下文后再读 PC 页。
        # 现有抖音解析器会在同一 Session 中限制每一跳的官方域名与超时。
        if not _public_share_url(url):
            raise VideoLinkError("INVALID_INPUT", "抖音短链只能包含公开分享路径")
        return url, platform
    if urlsplit(url).hostname == "b23.tv":
        with _get(url, domains=_PAGE_DOMAINS[platform], referer=f"https://www.{'douyin.com' if platform == 'douyin' else 'bilibili.com'}/", deadline=time.monotonic() + 40) as response:
            # urllib3 的 request URL 为最后一跳路径；ID 只用于构造规范公开地址。
            final_path = str(response.geturl() or "")
            _check_video_part(final_path, platform)
            if platform == "douyin":
                match = re.search(r"/(?:share/)?(?:video|note)/(\d{8,32})(?:[/?#]|$)", final_path)
                if match:
                    return f"https://www.douyin.com/video/{match.group(1)}", platform
            else:
                match = re.search(r"/video/(BV[0-9A-Za-z]+|av\d+)", final_path)
                if match:
                    return f"https://www.bilibili.com/video/{match.group(1)}/", platform
            raise VideoLinkError("PLATFORM_AUTH_REQUIRED", "分享链接需要在平台登录或验证后才能读取", status=409)
    if platform == "douyin" and not video_extractor._douyin_aweme_id_from_url(url):
        raise VideoLinkError("INVALID_INPUT", "请提供一条抖音视频分享链接")
    if platform == "bilibili" and not re.fullmatch(r"/video/(?:BV[0-9A-Za-z]+|av\d+)/?", urlsplit(url).path):
        raise VideoLinkError("INVALID_INPUT", "请提供一条 B站视频或 b23.tv 分享链接")
    return url, platform


def _public_share_url(value: Any) -> str:
    url = str(value or "").strip()
    return url if re.fullmatch(r"https://v\.douyin\.com/[A-Za-z0-9_-]{1,128}/?", url) else ""


def _remember_share(db: Session, note: Note, url: str) -> None:
    share = _public_share_url(url)
    if not share:
        return
    payload = platform_library_service._load_payload(note)
    meta = platform_library_service._source_meta(note)
    if meta.get("public_share_url") != share:
        payload["source_meta"] = {**meta, "public_share_url": share}
        note.ai_summary = json.dumps(payload, ensure_ascii=False)
        db.commit()


def _check_video_part(url: str, platform: str) -> None:
    # 资料的持久身份目前以 BV 号为单位；不得把另一个分 P 静默当作第一集。
    pages = parse_qs(urlsplit(url).query).get("p", ["1"])
    if platform == "bilibili" and pages != ["1"]:
        raise VideoLinkError("UNSUPPORTED_VIDEO_PART", "当前链接交接仅支持 B站视频的第一分 P，请提供该分 P 的独立视频链接")


def _public_info(url: str, platform: str) -> dict[str, Any]:
    if platform == "douyin":
        video_id = video_extractor._douyin_aweme_id_from_url(url)
        if video_id:
            # PC 详情页可能只返回验证壳；已知 ID 直接读官方移动分享页，不做风控重试。
            url = f"https://www.iesdouyin.com/share/video/{video_id}"
    _target(url, _PAGE_DOMAINS[platform])
    try:
        info = video_extractor.parse_video_info(url)
    except video_extractor.VideoMetadataUnavailableError:
        raise VideoLinkError("PLATFORM_AUTH_REQUIRED", "抖音暂未开放这条视频的公开读取，请在客户端完成平台验证后重试；不会自动重试", status=409) from None
    except Exception:
        raise VideoLinkError("PLATFORM_UNAVAILABLE", "平台元数据暂时无法读取，请稍后重试", status=502, retryable=True) from None
    video_id = str(info.get("video_id") or "")
    pattern = r"\d{8,32}" if platform == "douyin" else r"(?:BV[0-9A-Za-z]+|av\d+)(?:_p\d+)?"
    if not re.fullmatch(pattern, video_id) or not str(info.get("title") or "").strip():
        raise VideoLinkError("PLATFORM_UNAVAILABLE", "平台没有返回完整的视频信息", status=502)
    return info


def _item(note: Note) -> dict[str, Any]:
    data = note.to_dict(include_transcript=False)
    data.update(note_id=note.id, title=note.video_title, transcript_ready=bool((note.transcript_raw or "").strip()))
    return data


def import_link(db: Session, *, user_id: str, value: str) -> dict[str, Any]:
    url, platform = _source(value)
    direct_id = video_extractor._douyin_aweme_id_from_url(url) if platform == "douyin" else platform_library_service._canonical_bilibili_id(url)
    if direct_id:
        existing = note_service.get_note_by_video_id(db, direct_id, user_id)
        if existing is not None and platform_library_service.media_platform(existing) == platform:
            return {"status": "reused", "item": _item(existing)}
    db.commit()
    info = _public_info(url, platform)
    video_id = str(info["video_id"])
    with library_sync_service.import_lease(db, user_id=user_id, platform=platform, video_id=video_id):
        existing = note_service.get_note_by_video_id(db, video_id, user_id)
        if existing is not None and platform_library_service.media_platform(existing) == platform:
            _remember_share(db, existing, url)
            return {"status": "reused", "item": _item(existing)}
        source_url = stable_note_source(video_id=video_id, video_url=url, source_meta={"platform": platform, "source_url": url}, platform=platform)
        meta = {
            "source_kind": SOURCE_KIND, "platform": platform, "source_url": source_url,
            "source_mode": "import", "media_type": "video", "transcript_source": "pending",
            "speech_ready": False, "cover_url": info.get("cover_url") or "",
            "author_name": info.get("author_name") or "", "caption": info.get("description") or "",
        }
        if share := _public_share_url(url):
            meta["public_share_url"] = share
        note = note_service.create_transcript_note(
            db, video_info={"video_id": video_id, "title": info["title"], "source_url": source_url, "platform": platform},
            transcript="", source_meta=meta, user_id=user_id,
        )
        return {"status": "imported", "item": _item(note)}


def owned_note(db: Session, *, user_id: str, note_id: str) -> Note:
    note = note_service.get_note(db, note_id, user_id)
    if note is None:
        raise VideoLinkError("RESOURCE_NOT_FOUND", "视频资料不存在", status=404)
    if platform_library_service.media_platform(note) not in _MEDIA_DOMAINS:
        raise VideoLinkError("UNSUPPORTED_PLATFORM", "只支持抖音和 B站的视频文件")
    return note


def media_snapshot(note: Note) -> Any:
    """外部下载只拿不可变的来源快照，避免分钟级等待占着数据库读事务。"""
    return SimpleNamespace(video_id=note.video_id, video_url=note.video_url, ai_summary=note.ai_summary)


def _download(url: str, path: Path, *, platform: str, budget: list[int], deadline: float) -> None:
    with _get(url, domains=_MEDIA_DOMAINS[platform], referer=f"https://www.{'douyin.com' if platform == 'douyin' else 'bilibili.com'}/", deadline=deadline) as response:
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if content_type not in {"video/mp4", "video/x-flv", "video/flv", "audio/mp4", "application/octet-stream", "binary/octet-stream", "video/quicktime"}:
            raise VideoLinkError("INVALID_MEDIA", "平台未返回有效的视频文件", status=502)
        try:
            length = int(response.headers.get("Content-Length") or 0)
        except ValueError:
            raise VideoLinkError("INVALID_MEDIA", "平台视频长度无效", status=502) from None
        if length < 0 or length > budget[0]:
            raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
        written = 0
        with path.open("wb") as output:
            for chunk in response.stream(256 * 1024, decode_content=False):
                if time.monotonic() > deadline:
                    raise VideoLinkError("MEDIA_TIMEOUT", "视频下载超时", status=504, retryable=True)
                budget[0] -= len(chunk)
                if budget[0] < 0:
                    raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
                output.write(chunk)
                written += len(chunk)
        if not written or (length and written != length):
            raise VideoLinkError("INVALID_MEDIA", "视频下载不完整，请稍后重试", status=502, retryable=True)


def _remux(paths: list[Path], target: Path) -> None:
    command = [video_extractor._get_ffmpeg_path(), "-nostdin", "-y", "-loglevel", "error"]
    for path in paths:
        with path.open("rb") as source:
            signature = source.read(12)
        container = "mov" if signature[4:8] in {b"ftyp", b"styp", b"moov", b"moof"} else "flv" if signature.startswith(b"FLV") else ""
        if not container:
            raise VideoLinkError("INVALID_MEDIA", "平台没有返回 MP4 或 FLV 视频文件", status=502)
        # 固定容器，禁止把伪装成视频的播放列表交给 FFmpeg 再访问其他路径。
        command += ["-protocol_whitelist", "file,pipe", "-f", container, "-i", str(path)]
    command += ["-map", "0:v:0"]
    if len(paths) == 2:
        command += ["-map", "1:a:0"]
    else:
        command += ["-map", "0:a?"]
    command += ["-c", "copy", "-movflags", "+faststart", str(target)]
    try:
        result = subprocess.run(command, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise VideoLinkError("MEDIA_PROCESSING_FAILED", "视频封装处理未完成", status=502) from None
    if result.returncode or not target.exists() or target.stat().st_size == 0:
        raise VideoLinkError("INVALID_MEDIA", "平台文件没有可用的视频画面", status=502)


@contextmanager
def prepared_media(note: Note) -> Iterator[Path]:
    """只在请求生命周期保存临时视频；完整校验成功后才返回 HTTP 200。"""
    platform = platform_library_service.media_platform(note)
    if platform not in _MEDIA_DOMAINS:
        raise VideoLinkError("UNSUPPORTED_PLATFORM", "只支持抖音和 B站的视频文件")
    meta = platform_library_service._source_meta(note)
    source = (_public_share_url(meta.get("public_share_url")) if platform == "douyin" else "") or stable_note_source(video_id=note.video_id, video_url=note.video_url, source_meta=meta, platform=platform)
    source, checked_platform = _source(source)
    if checked_platform != platform:
        raise VideoLinkError("UNSAFE_MEDIA_TARGET", "视频来源平台不一致")
    info = _public_info(source, platform)
    if str(info.get("video_id")) != str(note.video_id):
        raise VideoLinkError("INVALID_MEDIA", "平台返回的视频与资料不一致", status=502)
    urls: list[str] = []
    if platform == "douyin":
        urls = [str(info.get("download_url") or info.get("url") or "")]
    else:
        try:
            play = video_extractor._bilibili_api_data("/x/player/playurl", {"bvid": info.get("bvid") or info["video_id"], "cid": info["cid"], "qn": 64, "fnval": 16, "fourk": 0})
            dash = play.get("dash") or {}
            videos = sorted(dash.get("video") or [], key=lambda row: (int(row.get("codecid") or 0) != 7, -int(row.get("bandwidth") or 0)))
            audios = sorted(dash.get("audio") or [], key=lambda row: -int(row.get("bandwidth") or 0))
            if videos:
                tracks = [videos[0]] + ([audios[0]] if audios else [])
                urls = [str(track.get("baseUrl") or track.get("base_url") or "") for track in tracks]
            elif len(play.get("durl") or []) == 1:
                urls = [str(play["durl"][0].get("url") or "")]
        except Exception:
            raise VideoLinkError("PLATFORM_UNAVAILABLE", "B站暂未返回可下载的视频轨道", status=502) from None
    if not urls or any(not url for url in urls):
        raise VideoLinkError("MEDIA_UNAVAILABLE", "这个作品暂时没有可下载的视频", status=404)
    with tempfile.TemporaryDirectory(prefix="zhicui-agent-media-") as directory:
        root = Path(directory)
        paths, budget, deadline = [], [MAX_MEDIA_BYTES], time.monotonic() + MAX_DOWNLOAD_SECONDS
        for index, url in enumerate(urls):
            path = root / f"track-{index}.bin"
            _download(url, path, platform=platform, budget=budget, deadline=deadline)
            paths.append(path)
        target = root / "video.mp4"
        _remux(paths, target)
        if target.stat().st_size > MAX_MEDIA_BYTES:
            raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
        yield target


@contextmanager
def prepared_user_media(note: Note, *, session_scope: str = "") -> Iterator[Path]:
    """Web 用户的绑定流；本机没有作品时再尝试同一资料的公开来源一次。"""
    if not session_scope or platform_library_service.media_platform(note) != "douyin":
        with prepared_media(note) as path:
            yield path
        return
    video_id = str(note.video_id)
    if not re.fullmatch(r"\d{8,32}", video_id):
        raise VideoLinkError("INVALID_MEDIA", "视频资料标识无效")
    # URL 与 scope 均由服务器配置/当前用户绑定构造，不能接受客户端任意媒体地址。
    url = douyin_library.companion_media_url(video_id)
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.username or parsed.password:
        raise VideoLinkError("UNSAFE_MEDIA_TARGET", "本机视频连接器配置无效", status=503)
    fallback = False
    with tempfile.TemporaryDirectory(prefix="zhicui-web-media-") as directory:
        root = Path(directory)
        track = root / "source.bin"
        deadline = time.monotonic() + MAX_DOWNLOAD_SECONDS
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.get(url, headers=douyin_library.companion_headers(session_scope), stream=True, allow_redirects=False, timeout=(8, 20)) as response:
                    if response.status_code in {404, 410}:
                        fallback = True
                    elif response.status_code in {401, 403, 412, 429}:
                        raise VideoLinkError("PLATFORM_AUTH_REQUIRED", "请在客户端重新连接抖音并完成平台验证后重试", status=409)
                    elif response.status_code != 200:
                        raise VideoLinkError("PLATFORM_UNAVAILABLE", "已绑定的视频暂时无法读取，请稍后重试", status=502, retryable=True)
                    else:
                        try:
                            length = int(response.headers.get("Content-Length") or 0)
                        except ValueError:
                            raise VideoLinkError("INVALID_MEDIA", "平台视频长度无效", status=502) from None
                        if length < 0 or length > MAX_MEDIA_BYTES:
                            raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
                        written = 0
                        with track.open("wb") as output:
                            for chunk in response.iter_content(256 * 1024):
                                if time.monotonic() > deadline:
                                    raise VideoLinkError("MEDIA_TIMEOUT", "视频下载超时", status=504, retryable=True)
                                written += len(chunk)
                                if written > MAX_MEDIA_BYTES:
                                    raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
                                output.write(chunk)
                        if not written or (length and written != length):
                            raise VideoLinkError("INVALID_MEDIA", "视频下载不完整，请稍后重试", status=502)
            if not fallback:
                target = root / "video.mp4"
                _remux([track], target)
                if target.stat().st_size > MAX_MEDIA_BYTES:
                    raise VideoLinkError("MEDIA_TOO_LARGE", "视频超过 512 MB 下载限制", status=413)
                yield target
                return
        except requests.RequestException:
            raise VideoLinkError("PLATFORM_UNAVAILABLE", "视频连接器暂时不可用，请稍后重试", status=502, retryable=True) from None
    with prepared_media(note) as path:
        yield path


def transcribe_note(db: Session, *, user_id: str, note_id: str, check_active: Callable[[], None] | None = None) -> dict[str, Any]:
    if check_active:
        check_active()
    note = note_service.get_note(db, note_id, user_id)
    if note is None:
        raise VideoLinkError("RESOURCE_NOT_FOUND", "视频资料不存在", status=404)
    if (note.transcript_raw or "").strip():
        return {**note.to_dict(), "already_existed": True}
    note = owned_note(db, user_id=user_id, note_id=note_id)
    with library_sync_service.import_lease(db, user_id=user_id, platform=platform_library_service.media_platform(note), video_id=note.video_id):
        db.refresh(note)
        if (note.transcript_raw or "").strip():
            return {**note.to_dict(), "already_existed": True}
        meta = platform_library_service._source_meta(note)
        if meta.get("transcript_status") == "no_audio":
            return {**note.to_dict(), "state": "no_audio", "transcript_status": "no_audio", "transcript_notice": "无音频", "already_existed": True}
        config = settings_service.get_asr_config(db)
        if not config.get("api_key"):
            raise VideoLinkError("ASR_NOT_CONFIGURED", "知萃语音识别服务尚未配置", status=503)
        snapshot = media_snapshot(note)
        db.commit()
        try:
            with prepared_media(snapshot) as media:
                if check_active:
                    check_active()
                audio = media.with_suffix(".mp3")
                command = [video_extractor._get_ffmpeg_path(), "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", str(media), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", str(audio)]
                try:
                    result = subprocess.run(command, capture_output=True, timeout=120)
                except (OSError, subprocess.TimeoutExpired):
                    raise VideoLinkError("MEDIA_PROCESSING_FAILED", "音频提取未完成", status=502) from None
                if result.returncode:
                    if video_extractor._ffmpeg_has_no_audio(result.stderr.decode("utf-8", errors="replace")):
                        raise video_extractor.NoAudioError()
                    raise VideoLinkError("MEDIA_PROCESSING_FAILED", "视频音轨暂时无法提取", status=502)
                if video_extractor._audio_is_digital_silence(audio):
                    raise video_extractor.NoAudioError("silent_audio")
                if check_active:
                    check_active()
                try:
                    transcript = video_extractor._asr_audio_file(str(audio), config["api_key"], config.get("api_base_url"), config.get("model"))
                except Exception:
                    raise VideoLinkError("TRANSCRIPT_GENERATION_FAILED", "语音识别暂时失败，请稍后重试", status=502, retryable=True) from None
                if not (transcript or "").strip():
                    raise video_extractor.NoAudioError("no_speech")
        except video_extractor.NoAudioError:
            if check_active:
                check_active()
            payload = platform_library_service._load_payload(note)
            payload["source_meta"] = {**platform_library_service._source_meta(note), "transcript_status": "no_audio", "speech_ready": False}
            note.ai_summary = json.dumps(payload, ensure_ascii=False)
            db.commit()
            return {**note.to_dict(), "state": "no_audio", "transcript_status": "no_audio", "transcript_notice": "无音频", "already_existed": False}
        if check_active:
            check_active()
        payload = platform_library_service._load_payload(note)
        payload["source_meta"] = {**platform_library_service._source_meta(note), "transcript_status": "ready", "transcript_source": "cloud-asr", "speech_ready": True}
        note.transcript_raw = transcript.strip()
        note.ai_summary = json.dumps(payload, ensure_ascii=False)
        db.commit()
        db.refresh(note)
        return {**note.to_dict(), "already_existed": False}
