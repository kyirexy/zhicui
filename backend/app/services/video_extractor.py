"""
Video extraction service.

Wraps the existing DouyinProcessor from the douyin-mcp-server project so the
backend can parse Douyin share links, download videos, and extract transcripts.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


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
# Make the existing douyin-mcp-server scripts importable
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / ".." / "douyin-mcp-server" / "douyin-video" / "scripts"
_SCRIPTS_DIR = _SCRIPTS_DIR.resolve()
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from douyin_downloader import DouyinProcessor  # noqa: E402

import re


# ---------------------------------------------------------------------------
# Platform detection and Bilibili helpers
# ---------------------------------------------------------------------------

def _detect_platform(url: str) -> str:
    """Return platform identifier based on URL host."""
    if 'bilibili.com' in url or 'b23.tv' in url:
        return 'bilibili'
    if 'douyin.com' in url or 'iesdouyin.com' in url:
        return 'douyin'
    if 'mp.weixin.qq.com' in url:
        return 'wechat'
    if 'xiaohongshu.com' in url or 'rednote.com' in url or 'xhslink.com' in url:
        return 'xiaohongshu'
    return 'unknown'


_BILI_HEADERS = [
    '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--add-header', 'Referer:https://www.bilibili.com/',
    '--add-header', 'Origin:https://www.bilibili.com',
    '--add-header', 'Accept-Language:zh-CN,zh;q=0.9,en;q=0.8',
]


def _clean_bilibili_url(url: str) -> str:
    """Extract a clean B站 BV/av URL from any user input."""
    import re as _re
    # b23.tv short link → pass through raw
    if 'b23.tv' in url:
        return url.split('?')[0].split(' ')[0].rstrip('/')
    # Extract BV/av number
    m = _re.search(r'(?:/video/|/bangumi/play/)(BV[\w]+|av\d+|ep\d+|ss\d+)', url)
    if m:
        return f'https://www.bilibili.com/video/{m.group(1)}/'
    # Fallback: strip query + spaces
    return url.split('?')[0].split(' ')[0].rstrip('/')

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
    """Extract B站 video metadata.  Tries bilibili-api first, falls back to yt-dlp."""
    import json as _json
    import re as _re

    clean_url = _clean_bilibili_url(url)
    bv_match = _re.search(r'(BV[\w]+|av\d+)', clean_url)
    bvid = bv_match.group(1) if bv_match else ''

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
                    'download_url': f'https://www.bilibili.com/video/{bvid}/',
                    'url': f'https://www.bilibili.com/video/{bvid}/',
                    'platform': 'bilibili',
                    'subtitles': {},
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
        'download_url': info.get('url', '') or bv_link,
        'url': info.get('url', '') or bv_link,
        'platform': 'bilibili',
        'subtitles': info.get('subtitles', {}),
    }


def _bilibili_subtitles(url: str) -> str:
    """Download B站 auto-generated subtitles and return as plain text.

    Raises RuntimeError if no subtitles are available.
    """
    clean_url = _clean_bilibili_url(url)
    with tempfile.TemporaryDirectory() as tmpdir:
        outtmpl = os.path.join(tmpdir, '%(id)s.%(ext)s')
        cmd = [
            sys.executable, '-m', 'yt_dlp',
            '--write-auto-subs', '--sub-lang', 'zh-Hans,zh,ai-zh,en',
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

        for f in os.listdir(tmpdir):
            if f.endswith(('.srt', '.vtt')):
                sub_path = os.path.join(tmpdir, f)
                with open(sub_path, encoding='utf-8') as sf:
                    content = sf.read()
                # Strip SRT/VTT markup to plain text
                clean = re.sub(
                    r'\d+\n\d{2}:\d{2}:\d{2}[.,]\d{3} --> \d{2}:\d{2}:\d{2}[.,]\d{3}\n',
                    '', content,
                )
                clean = re.sub(r'<[^>]+>', '', clean)
                clean = re.sub(r'\n\n+', '\n', clean)
                return clean.strip()

        raise RuntimeError("B站视频没有可用的自动字幕")


def _bilibili_download_audio(url: str, output_dir: str) -> str:
    """Download B站 audio track to *output_dir*, return the file path."""
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


def _asr_audio_file(
    audio_path: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
) -> str:
    """Send an audio file to the SiliconFlow ASR API, return transcribed text.

    This is the B站 equivalent of ``DouyinProcessor.extract_text_from_audio``
    — it uploads the downloaded audio and gets back the transcript.
    """
    import requests as _req
    api_base_url = api_base_url or "https://api.siliconflow.cn/v1/audio/transcriptions"
    model = model or "FunAudioLLM/SenseVoiceSmall"

    with open(audio_path, 'rb') as f:
        resp = _req.post(
            api_base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            data={"model": model},
            files={"file": f},
            timeout=300,
        )
    resp.raise_for_status()
    return resp.json().get("text", "")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_video_info(url: str) -> dict[str, Any]:
    """Return video_id, title, and download_url for a video share link.

    Supports Douyin (抖音) and Bilibili (B站).
    Does NOT require an API key -- only fetches metadata.
    """
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
            f"暂不支持该平台的视频链接。当前支持: 抖音、B站、微信公众号、小红书。链接: {url[:80]}..."
        )

    # Douyin path
    processor = DouyinProcessor(api_key="")
    info: dict = processor.parse_share_url(url)
    return {
        "video_id": info["video_id"],
        "title": info["title"],
        "download_url": info["url"],
    }


def extract_transcript(
    url: str,
    api_key: str,
    api_base_url: str | None = None,
    model: str | None = None,
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
    video_info = processor.parse_share_url(url)

    # Download video to temp dir
    video_path = processor.download_video(video_info, show_progress=False)

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
) -> str:
    """Transcribe a trusted direct media URL from the companion library.

    The media is streamed into a temporary directory, converted to a compact
    mono MP3, sent to the configured cloud ASR, and then retried through the
    existing local ASR stack when available.
    """
    import requests as _requests

    clean_url = media_url.strip()
    if not clean_url.startswith(("http://", "https://")):
        raise ValueError("媒体地址无效")

    temp_dir = Path(tempfile.mkdtemp(prefix="zhicui-library-"))
    video_path = temp_dir / "source.mp4"
    audio_path = temp_dir / "audio.mp3"
    failures: list[str] = []

    try:
        with _requests.Session() as session:
            session.trust_env = False
            with session.get(clean_url, stream=True, timeout=(10, 300)) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("Content-Length") or 0)
                if content_length > max_bytes:
                    raise RuntimeError("视频文件过大，暂不支持提取")

                written = 0
                with open(video_path, "wb") as output:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        written += len(chunk)
                        if written > max_bytes:
                            raise RuntimeError("视频文件过大，暂不支持提取")
                        output.write(chunk)
        if not video_path.exists() or video_path.stat().st_size == 0:
            raise RuntimeError("下载器返回了空视频文件")

        ffmpeg_exe = _get_ffmpeg_path()
        command = [
            ffmpeg_exe,
            "-y",
            "-i",
            str(video_path),
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
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0 or not audio_path.exists():
            raise RuntimeError(f"FFmpeg 提取音频失败：{result.stderr[-300:]}")

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
            except Exception as exc:
                failures.append(f"云端 ASR：{exc}")

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

        detail = "；".join(failures[-3:])
        raise RuntimeError(f"视频文案提取失败{f'：{detail}' if detail else ''}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def fallback_local_asr(url: str) -> str:
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
    video_info = processor.parse_share_url(url)
    video_url = video_info["url"]

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
