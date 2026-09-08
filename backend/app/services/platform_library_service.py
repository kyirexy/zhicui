"""User-scoped Bilibili and Xiaohongshu imports for the video library."""

from __future__ import annotations

import json
import re
import hashlib
import hmac
import ipaddress
import socket
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote, urlsplit

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.media_reference import (
    platform_from_source_url,
    sanitized_source_meta,
    stable_note_source,
)
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import ai_juicer, note_service, plan_service, settings_service, video_extractor
from app.services.xhs_downloader_client import (
    XhsDownloaderUnavailable,
    fetch_xhs_detail,
)

SOURCE_KIND = "platform-import"
SUPPORTED_PLATFORMS = {"bilibili", "xiaohongshu"}
MAX_IMPORT_URLS = 10
_COVER_URL_TTL_SECONDS = 6 * 60 * 60
_MEDIA_URL_TTL_SECONDS = 5 * 60

_URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_XHS_MEDIA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 "
        "Mobile/15E148 Safari/604.1"
    ),
    "Referer": "https://www.xiaohongshu.com/",
}
_BILIBILI_PLACEHOLDER_TITLES = {"", "B站视频", "未命名视频"}
_ACCOUNT_SOURCE_MODES = ("collect", "like", "post")
_DOUYIN_MEDIA_DOMAINS = (
    "douyinvod.com",
    "douyin.com",
    "iesdouyin.com",
    "bytecdn.cn",
    "bytecdn.com",
    "ibytedtos.com",
    "pstatp.com",
    "snssdk.com",
    "zjcdn.com",
    "volccdn.com",
)
_DOUYIN_IMAGE_DOMAINS = (
    "douyinpic.com",
    "byteimg.com",
    "ibytedtos.com",
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_shared_url(value: str) -> str:
    match = _URL_PATTERN.search(value or "")
    if not match:
        raise ValueError("没有找到可导入的视频链接")
    return match.group(0).rstrip("。；，、,.;!！?？)]}")


def _load_payload(note: Note) -> dict[str, Any]:
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (json.JSONDecodeError, TypeError):
        payload = {}
    return payload if isinstance(payload, dict) else {}


def _source_meta(note: Note) -> dict[str, Any]:
    source_meta = _load_payload(note).get("source_meta")
    return source_meta if isinstance(source_meta, dict) else {}


def _source_modes(*values: object) -> list[str]:
    """Keep every explicit account membership without guessing unknown sources."""
    result: list[str] = []
    for value in values:
        candidates = value if isinstance(value, (list, tuple, set)) else [value]
        for candidate in candidates:
            mode = str(candidate or "").strip().lower()
            if mode in _ACCOUNT_SOURCE_MODES and mode not in result:
                result.append(mode)
    return result


_ORDER_MAP_FIELDS = (
    "source_ranks", "source_synced_ats", "source_order_reliabilities", "source_coverages",
)
_ORDER_SCALAR_FIELDS = (
    "source_rank", "source_synced_at", "source_order_reliable", "source_coverage",
)


def _snapshot_time(value: object) -> float:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0.0


def _normalize_snapshot(value: str | None) -> str:
    if not value:
        return _utcnow()
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("来源同步时间格式无效") from exc
    if parsed > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError("来源同步时间不能超过当前时间五分钟")
    return parsed.isoformat()


def _order_maps(meta: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """每个频道各自保留排名，兼容只保存单个排名的旧资料。"""
    maps = {
        key: dict(meta[key]) if isinstance(meta.get(key), dict) else {}
        for key in _ORDER_MAP_FIELDS
    }
    mode = str(meta.get("source_mode") or "import")
    for map_key, scalar_key in zip(_ORDER_MAP_FIELDS, _ORDER_SCALAR_FIELDS):
        if scalar_key in meta and meta[scalar_key] is not None:
            maps[map_key].setdefault(mode, meta[scalar_key])
    return maps


def _with_source_order(
    meta: dict[str, Any], *, source_mode: str | None, rank: int,
    synced_at: str, reliable: bool, coverage: str,
) -> dict[str, Any]:
    mode = source_mode if source_mode in _ACCOUNT_SOURCE_MODES else "import"
    result = {key: value for key, value in meta.items()
              if key not in {*_ORDER_MAP_FIELDS, *_ORDER_SCALAR_FIELDS}}
    result.update({
        "source_mode": mode,
        "source_modes": [mode] if mode in _ACCOUNT_SOURCE_MODES else [],
        "source_rank": rank if reliable else None,
        "source_synced_at": synced_at,
        "source_order_reliable": bool(reliable),
        "source_coverage": coverage,
        "source_ranks": {mode: rank} if reliable else {},
        "source_synced_ats": {mode: synced_at},
        "source_order_reliabilities": {mode: bool(reliable)},
        "source_coverages": {mode: coverage},
    })
    return result


def _merge_source_metadata(
    previous: dict[str, Any], incoming: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    previous_maps = _order_maps(previous)
    incoming_maps = _order_maps(incoming)
    incoming_mode = str(incoming.get("source_mode") or "import")
    removed_ats = dict(previous.get("source_removed_ats") or {})
    incoming_time = _snapshot_time(incoming_maps["source_synced_ats"].get(incoming_mode))
    previous_time = _snapshot_time(previous_maps["source_synced_ats"].get(incoming_mode))
    removed_time = _snapshot_time(removed_ats.get(incoming_mode))
    accepted = incoming_time >= previous_time and (
        incoming_mode not in removed_ats or incoming_time > removed_time
    )
    merged = {**previous, **incoming} if accepted else dict(previous)
    incoming_modes = [mode for mode in _source_modes(incoming.get("source_modes"), incoming_mode)
                      if mode not in removed_ats or _snapshot_time(
                          incoming_maps["source_synced_ats"].get(mode),
                      ) > _snapshot_time(removed_ats[mode])]
    modes = _source_modes(previous.get("source_modes"), previous.get("source_mode"),
                          incoming_modes)
    for mode, stamp in incoming_maps["source_synced_ats"].items():
        old_time = _snapshot_time(previous_maps["source_synced_ats"].get(mode))
        new_time = _snapshot_time(stamp)
        if new_time < old_time or (mode in removed_ats and new_time <= _snapshot_time(removed_ats[mode])):
            continue
        old_rank = previous_maps["source_ranks"].get(mode)
        new_rank = incoming_maps["source_ranks"].get(mode)
        for field in _ORDER_MAP_FIELDS:
            if mode in incoming_maps[field]:
                previous_maps[field][mode] = incoming_maps[field][mode]
        # 同一快照中的重复链接保留首次位置；新快照则完整替换该频道的排名。
        if new_time == old_time and isinstance(old_rank, int) and isinstance(new_rank, int):
            previous_maps["source_ranks"][mode] = min(old_rank, new_rank)
        if not incoming_maps["source_order_reliabilities"].get(mode, True):
            previous_maps["source_ranks"].pop(mode, None)
    merged.update(previous_maps)
    if removed_ats:
        # 清理成员关系时保留水位：同一/更早快照不能把已移除成员重新插回。
        merged["source_removed_ats"] = removed_ats
    if modes:
        merged["source_modes"] = modes
    primary = str(merged.get("source_mode") or "import")
    if previous_maps["source_synced_ats"]:
        newest = max(previous_maps["source_synced_ats"], key=lambda mode: (
            _snapshot_time(previous_maps["source_synced_ats"][mode]), mode == primary,
        ))
        primary = newest
    merged["source_mode"] = primary
    for map_key, scalar_key in zip(_ORDER_MAP_FIELDS, _ORDER_SCALAR_FIELDS):
        if primary in previous_maps[map_key]:
            merged[scalar_key] = previous_maps[map_key][primary]
        else:
            merged.pop(scalar_key, None)
    return merged, accepted


def _canonical_bilibili_id(url: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if host != "bilibili.com" and not host.endswith(".bilibili.com"):
        return ""
    match = re.fullmatch(r"/video/(BV[0-9A-Za-z]+)/?", parsed.path, re.IGNORECASE)
    return "BV" + match.group(1)[2:] if match else ""


def _bilibili_source_watermark(db: Session, *, user_id: str, mode: str) -> float:
    """只读取小型来源 JSON 的频道水位，覆盖尚无旧 Note 的迟到采集。"""
    latest = 0.0
    for (raw_payload,) in db.query(Note.ai_summary).filter(Note.user_id == user_id).yield_per(200):
        try:
            payload = json.loads(raw_payload or "{}")
        except (ValueError, TypeError):
            continue
        meta = payload.get("source_meta") if isinstance(payload, dict) else None
        if not isinstance(meta, dict) or meta.get("source_kind") != SOURCE_KIND or meta.get("platform") != "bilibili":
            continue
        maps = _order_maps(meta)
        removed = meta.get("source_removed_ats")
        latest = max(
            latest, _snapshot_time(maps["source_synced_ats"].get(mode)),
            _snapshot_time(removed.get(mode)) if isinstance(removed, dict) else 0.0,
        )
    return latest


def _cover_signature(note_id: str, expires: int) -> str:
    payload = f"platform-cover:{note_id}:{expires}".encode("utf-8")
    return hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def public_cover_url(note_id: str) -> str:
    """Create a short-lived same-origin capability for one imported cover."""
    # Bucket the expiry so repeated list requests return the same signed URL
    # for fifteen minutes and the browser can reuse its cached cover bytes.
    now = int(time.time())
    expires = (now // 900) * 900 + _COVER_URL_TTL_SECONDS
    signature = _cover_signature(note_id, expires)
    return (
        f"/api/library/imports/{quote(note_id, safe='')}/cover"
        f"?expires={expires}&signature={signature}"
    )


def verify_cover_signature(
    note_id: str,
    expires: int,
    signature: str,
) -> bool:
    now = int(time.time())
    if expires < now or expires > now + _COVER_URL_TTL_SECONDS + 60:
        return False
    return hmac.compare_digest(_cover_signature(note_id, expires), signature)


def _media_signature(note_id: str, expires: int) -> str:
    payload = f"platform-media:{note_id}:{expires}".encode("utf-8")
    return hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def public_media_url(note_id: str) -> str:
    """Mint a short-lived same-origin play capability for one owned Note."""
    expires = int(time.time()) + _MEDIA_URL_TTL_SECONDS
    signature = _media_signature(note_id, expires)
    return (
        f"/api/library/imports/{quote(note_id, safe='')}/media"
        f"?expires={expires}&signature={signature}"
    )


def verify_media_signature(note_id: str, expires: int, signature: str) -> bool:
    now = int(time.time())
    if expires < now or expires > now + _MEDIA_URL_TTL_SECONDS + 60:
        return False
    return hmac.compare_digest(_media_signature(note_id, expires), signature)


def media_platform(note: Note) -> str:
    meta = _source_meta(note)
    source_url = stable_note_source(
        video_id=note.video_id,
        video_url=note.video_url,
        source_meta=meta,
    )
    return str(meta.get("platform") or platform_from_source_url(source_url) or "").strip()


def validated_media_target(value: object, platform: str) -> str:
    target = str(value or "").strip()
    try:
        parsed = urlsplit(target)
    except ValueError:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not hostname or hostname in {"localhost", "localhost.localdomain"}:
        return ""
    if platform == "douyin" and not any(
        hostname == domain or hostname.endswith(f".{domain}")
        for domain in _DOUYIN_MEDIA_DOMAINS
    ):
        return ""
    if platform == "xiaohongshu" and not (
        hostname == "xhscdn.com" or hostname.endswith(".xhscdn.com")
    ):
        return ""
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                hostname,
                443,
                type=socket.SOCK_STREAM,
            )
        }
    except OSError:
        return ""
    if not addresses:
        return ""
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                return ""
        except ValueError:
            return ""
    return target


def validated_douyin_image_target(value: object) -> str:
    """Accept only public HTTPS Douyin image CDN targets."""
    target = str(value or "").strip()
    try:
        parsed = urlsplit(target)
        port = parsed.port
    except ValueError:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or not any(
            hostname == domain or hostname.endswith(f".{domain}")
            for domain in _DOUYIN_IMAGE_DOMAINS
        )
    ):
        return ""
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                hostname,
                443,
                type=socket.SOCK_STREAM,
            )
        }
    except OSError:
        return ""
    if not addresses:
        return ""
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                return ""
        except ValueError:
            return ""
    return target


def resolve_media_target(note: Note) -> tuple[str, dict[str, str]]:
    """Resolve a fresh upstream URL in memory; never write it to the Note."""
    meta = _source_meta(note)
    platform = media_platform(note)
    source_url = stable_note_source(
        video_id=note.video_id,
        video_url=note.video_url,
        source_meta=meta,
        platform=platform,
    )
    if not source_url or str(meta.get("media_type") or "video") != "video":
        return "", {}
    if platform == "xiaohongshu":
        info = fetch_xhs_detail(source_url, cookie=settings.XHS_COOKIE)
        target = validated_media_target(info.get("media_url"), platform)
        return target, dict(_XHS_MEDIA_HEADERS) if target else {}
    if platform == "douyin":
        info = video_extractor.parse_video_info(source_url)
        target = validated_media_target(
            info.get("download_url") or info.get("url"),
            platform,
        )
        return target, {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Referer": "https://www.douyin.com/",
        } if target else {}
    return "", {}


def cover_target(db: Session, note_id: str) -> str:
    """Return an allowlisted video cover target for a signed capability."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if note is None:
        return ""
    meta = _source_meta(note)
    platform = str(meta.get("platform") or "").strip()
    if platform not in {"bilibili", "douyin"}:
        return ""
    if platform == "bilibili" and meta.get("source_kind") != SOURCE_KIND:
        return ""
    return str(meta.get("cover_url") or "").strip()


def _find_existing(
    db: Session,
    *,
    user_id: str,
    platform: str,
    video_id: str,
    for_update: bool = False,
) -> Note | None:
    query = (
        db.query(Note)
        .filter(Note.user_id == user_id, Note.video_id == video_id)
        .order_by(Note.created_at.desc())
    )
    if for_update:
        # 提取完成后再锁定/刷新 JSON，防止并发收藏与喜欢互相覆盖来源映射。
        query = query.populate_existing().with_for_update()
    candidates = query.all()
    for note in candidates:
        meta = _source_meta(note)
        if meta.get("source_kind") == SOURCE_KIND and meta.get("platform") == platform:
            return note
    return None


def _caption_text(title: str, description: str, tags: list[str]) -> str:
    parts = [part.strip() for part in (title, description) if part and part.strip()]
    if tags:
        parts.append("标签：" + "、".join(tags))
    return "\n\n".join(parts)


def _combine_spoken_text(caption: str, spoken: str, spoken_label: str) -> str:
    sections: list[str] = []
    if caption.strip():
        sections.append("【发布文案】\n" + caption.strip())
    if spoken.strip():
        sections.append(f"【{spoken_label}】\n" + spoken.strip())
    return "\n\n".join(sections)


def bilibili_result_issues(
    info: dict[str, Any],
    transcript: str,
    source_meta: dict[str, Any],
) -> list[str]:
    """Describe why a Bilibili result is not ready for the video library.

    A title-only/caption-only result is useful diagnostic evidence, but it is
    not the complete video document promised by account sync.  Persisting it
    as a ready Note made legacy rows look successful even though their cover,
    creator identity, or spoken transcript had never been obtained.
    """
    issues: list[str] = []
    title = str(info.get("title") or "").strip()
    if title in _BILIBILI_PLACEHOLDER_TITLES:
        issues.append("标题")
    if not str(source_meta.get("cover_url") or "").strip():
        issues.append("封面")
    if not str(source_meta.get("author_name") or "").strip():
        issues.append("作者")
    transcript_source = str(source_meta.get("transcript_source") or "").strip()
    if (
        not bool(source_meta.get("speech_ready"))
        or transcript_source in {"", "caption-only"}
        or not str(transcript or "").strip()
    ):
        issues.append("视频文稿")
    return issues


def ensure_bilibili_result_ready(
    info: dict[str, Any],
    transcript: str,
    source_meta: dict[str, Any],
) -> None:
    """Reject incomplete Bilibili snapshots instead of publishing fake success."""
    issues = bilibili_result_issues(info, transcript, source_meta)
    if issues:
        raise RuntimeError(
            "B站视频尚未完整读取（缺少"
            + "、".join(issues)
            + "），本次不会作为已完成资料入库，请稍后重试"
        )


def _is_complete_bilibili_note(note: Note) -> bool:
    meta = _source_meta(note)
    return not bilibili_result_issues(
        {"title": note.video_title},
        note.transcript_raw or "",
        meta,
    )


def _extract_bilibili(url: str, db: Session) -> tuple[dict[str, Any], str, dict[str, Any]]:
    info = video_extractor._parse_bilibili(url)
    tags = [str(tag).strip() for tag in (info.get("tags") or []) if str(tag).strip()]
    caption = _caption_text(info.get("title", ""), info.get("description", ""), tags)
    spoken = ""
    transcript_source = "caption-only"

    try:
        spoken, transcript_source = video_extractor._bilibili_subtitles_with_source(url, info)
    except Exception:
        asr_cfg = settings_service.get_asr_config(db)
        if asr_cfg["api_key"]:
            try:
                candidate = video_extractor.extract_transcript(
                    url,
                    asr_cfg["api_key"],
                    asr_cfg["api_base_url"],
                    asr_cfg["model"],
                )
                if candidate and not candidate.lstrip().startswith("[B站视频]"):
                    spoken = candidate.strip()
                    transcript_source = "cloud-asr"
            except Exception:
                spoken = ""
        if not spoken:
            try:
                candidate = video_extractor.fallback_local_asr(url)
                if candidate and not candidate.lstrip().startswith("[B站视频]"):
                    spoken = candidate.strip()
                    transcript_source = "local-asr"
            except Exception:
                spoken = ""

    transcript = _combine_spoken_text(caption, spoken, "视频字幕" if "subtitle" in transcript_source else "视频语音")
    if not transcript:
        raise RuntimeError("B站视频没有可用的发布文案、字幕或语音内容")
    source_meta = {
        "source_kind": SOURCE_KIND,
        "platform": "bilibili",
        "source_url": info.get("source_url") or url,
        "cover_url": info.get("cover_url") or "",
        "author_name": info.get("author_name") or "",
        "author_id": info.get("author_id") or "",
        "caption": info.get("description") or "",
        "tags": tags,
        "media_type": "video",
        "published_at": info.get("published_at") or "",
        "recorded_at": _utcnow(),
        "source_synced_at": _utcnow(),
        "transcript_source": transcript_source,
        "speech_ready": bool(spoken),
        "provider": "yt-dlp",
    }
    return info, transcript, source_meta


def _legacy_xhs_detail(url: str) -> dict[str, Any]:
    from app.services.xhs_extractor import parse_xhs_note

    raw = parse_xhs_note(url, cookie=settings.XHS_COOKIE)
    images = [str(item) for item in (raw.get("images") or []) if str(item).startswith("http")]
    return {
        "note_id": str(raw.get("note_id") or ""),
        "title": str(raw.get("title") or "小红书作品"),
        "desc": str(raw.get("desc") or ""),
        "type": "video" if str(raw.get("type") or "").lower() == "video" else "image",
        "source_type": str(raw.get("type") or "未知"),
        "author_name": str(raw.get("author") or ""),
        "author_id": str(raw.get("author_id") or ""),
        "source_url": url,
        "cover_url": images[0] if images else "",
        "media_url": "",
        "tags": [str(tag) for tag in (raw.get("tags") or []) if str(tag).strip()],
        "published_at": "",
        "provider": "builtin-fallback",
    }


def _extract_xiaohongshu(url: str, db: Session) -> tuple[dict[str, Any], str, dict[str, Any]]:
    degraded = False
    try:
        info = fetch_xhs_detail(url, cookie=settings.XHS_COOKIE)
    except XhsDownloaderUnavailable:
        info = _legacy_xhs_detail(url)
        degraded = True

    tags = [str(tag).strip() for tag in (info.get("tags") or []) if str(tag).strip()]
    caption = _caption_text(info.get("title", ""), info.get("desc", ""), tags)
    spoken = ""
    transcript_source = "caption-only"
    if info.get("type") == "video" and info.get("media_url"):
        asr_cfg = settings_service.get_asr_config(db)
        try:
            spoken = video_extractor.extract_media_url_transcript(
                info["media_url"],
                asr_cfg["api_key"],
                asr_cfg["api_base_url"],
                asr_cfg["model"],
                request_headers=_XHS_MEDIA_HEADERS,
            ).strip()
            if spoken:
                transcript_source = "cloud-asr" if asr_cfg["api_key"] else "local-asr"
        except Exception:
            # Publishing copy remains useful library material. The metadata
            # explicitly reports that speech extraction is still unavailable.
            spoken = ""

    if info.get("type") == "video":
        transcript = _combine_spoken_text(caption, spoken, "视频语音")
    else:
        transcript = caption
    if not transcript.strip():
        raise RuntimeError("小红书作品没有可用的发布文案或视频语音")

    source_meta = {
        "source_kind": SOURCE_KIND,
        "platform": "xiaohongshu",
        "source_url": info.get("source_url") or url,
        "cover_url": info.get("cover_url") or "",
        "author_name": info.get("author_name") or "",
        "author_id": info.get("author_id") or "",
        "caption": info.get("desc") or "",
        "tags": tags,
        "media_type": info.get("type") or "image",
        "published_at": info.get("published_at") or "",
        "recorded_at": _utcnow(),
        "source_synced_at": _utcnow(),
        "transcript_source": transcript_source,
        "speech_ready": bool(spoken),
        "provider": info.get("provider") or "builtin-fallback",
        "degraded": degraded,
    }
    return info, transcript, source_meta


def _save_or_refresh(
    db: Session,
    *,
    user_id: str,
    platform: str,
    info: dict[str, Any],
    transcript: str,
    source_meta: dict[str, Any],
) -> tuple[Note, bool]:
    video_id = str(info.get("video_id") or info.get("note_id") or "").strip()
    if not video_id:
        raise RuntimeError("平台没有返回可用的作品标识")
    source_meta = sanitized_source_meta(source_meta)
    stable_source_url = stable_note_source(
        video_id=video_id,
        video_url="",
        source_meta=source_meta,
        platform=platform,
    )
    if stable_source_url:
        source_meta["source_url"] = stable_source_url
    # 外部字幕/ASR 已完成才持有短事务用户锁，与完整快照对账串行。
    db.query(User.id).filter(User.id == user_id).with_for_update().one()
    existing = _find_existing(
        db, user_id=user_id, platform=platform, video_id=video_id, for_update=True,
    )
    mode = str(source_meta.get("source_mode") or "import")
    if platform == "bilibili" and mode in _ACCOUNT_SOURCE_MODES:
        incoming_time = _snapshot_time(_order_maps(source_meta)["source_synced_ats"].get(mode))
        if incoming_time < _bilibili_source_watermark(db, user_id=user_id, mode=mode):
            previous = _source_meta(existing) if existing is not None else {}
            if mode in _source_modes(previous.get("source_modes"), previous.get("source_mode")):
                # 保留已经确认的现有来源信息，不让迟到 ASR 改写其位置。
                source_meta = previous
            else:
                # 仍保存已提取的文案，但仅归普通导入，不把旧捕获加入新来源。
                source_meta = _with_source_order(
                    source_meta, source_mode=None, rank=0,
                    synced_at=str(source_meta.get("source_synced_at") or _utcnow()),
                    reliable=False, coverage="unknown",
                )
    if existing is None:
        note = note_service.create_transcript_note(
            db,
            video_info={
                "video_id": video_id,
                "title": info.get("title") or "未命名视频",
                "source_url": stable_source_url,
                "platform": platform,
            },
            transcript=transcript,
            source_meta=source_meta,
            user_id=user_id,
        )
        return note, False

    payload = _load_payload(existing)
    previous_meta = sanitized_source_meta(payload.get("source_meta"))
    previous_complete = platform != "bilibili" or _is_complete_bilibili_note(existing)
    merged_source_meta, accepted = _merge_source_metadata(previous_meta, source_meta)
    merged_source_meta["first_seen_at"] = (
        previous_meta.get("first_seen_at") or existing.created_at.isoformat()
    )
    payload["source_meta"] = merged_source_meta
    if accepted:
        existing.video_title = str(info.get("title") or existing.video_title)
        existing.video_url = stable_source_url
        if transcript and (not previous_complete or len(transcript) >= len(existing.transcript_raw or "")):
            existing.transcript_raw = transcript
    existing.ai_summary = json.dumps(payload, ensure_ascii=False)
    existing.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(existing)
    return existing, True


def _safe_error(platform: str, exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return str(exc)[:160]
    if platform == "bilibili":
        message = str(exc or "").strip()
        if message.startswith("B站视频尚未完整读取"):
            return message[:200]
        return "B站资料导入失败，请检查链接、视频访问权限或 yt-dlp 配置"
    if platform == "xiaohongshu":
        return "小红书资料导入失败，请更新分享链接或检查 Cookie/增强解析服务"
    return "当前只支持 B站和小红书链接"


def import_one(
    db: Session,
    *,
    user_id: str,
    value: str,
    source_mode: str | None = None,
    source_rank_offset: int = 0,
    source_synced_at: str | None = None,
    source_order_reliable: bool = True,
    source_coverage: str = "partial",
) -> dict[str, Any]:
    if isinstance(source_rank_offset, bool) or not isinstance(source_rank_offset, int) or source_rank_offset < 0:
        raise ValueError("来源排名偏移必须是非负整数")
    if source_coverage not in {"complete", "limited", "partial", "unknown"}:
        raise ValueError("来源同步范围无效")
    snapshot = _normalize_snapshot(source_synced_at)
    url = normalize_shared_url(value)
    platform = video_extractor._detect_platform(url)
    if platform not in SUPPORTED_PLATFORMS:
        raise ValueError("当前导入只支持 B站和小红书链接")
    if platform == "bilibili":
        # 收藏/喜欢重复同步先查规范 BV 标识；已有完整文案只更新来源顺序，
        # 不重新请求字幕、下载音轨或调用收费 ASR。残缺旧资料仍走完整提取。
        canonical_id = _canonical_bilibili_id(url)
        existing = _find_existing(
            db, user_id=user_id, platform=platform, video_id=canonical_id,
        ) if canonical_id else None
        if existing is not None and _is_complete_bilibili_note(existing):
            info = {"video_id": existing.video_id, "title": existing.video_title}
            transcript, source_meta = existing.transcript_raw, _source_meta(existing)
        else:
            info, transcript, source_meta = _extract_bilibili(url, db)
        ensure_bilibili_result_ready(info, transcript, source_meta)
    else:
        info, transcript, source_meta = _extract_xiaohongshu(url, db)
    source_meta = _with_source_order(
        source_meta, source_mode=source_mode, rank=source_rank_offset,
        synced_at=snapshot, reliable=source_order_reliable, coverage=source_coverage,
    )
    note, reused = _save_or_refresh(
        db,
        user_id=user_id,
        platform=platform,
        info=info,
        transcript=transcript,
        source_meta=source_meta,
    )
    return {"status": "reused" if reused else "imported", "item": serialize_item(note)}


def import_many(
    db: Session,
    *,
    user_id: str,
    values: list[str],
    source_mode: str | None = None,
    source_rank_offset: int = 0,
    source_synced_at: str | None = None,
    source_order_reliable: bool = True,
    source_coverage: str = "partial",
    source_snapshot_size: int | None = None,
) -> dict[str, Any]:
    if not 1 <= len(values) <= MAX_IMPORT_URLS:
        raise ValueError(f"每次需要提交 1–{MAX_IMPORT_URLS} 条链接")
    if isinstance(source_rank_offset, bool) or not isinstance(source_rank_offset, int) or source_rank_offset < 0:
        raise ValueError("来源排名偏移必须是非负整数")
    if source_snapshot_size is not None and (
        isinstance(source_snapshot_size, bool)
        or not isinstance(source_snapshot_size, int)
        or source_snapshot_size <= 0
    ):
        raise ValueError("来源快照总数必须是正整数")
    snapshot = _normalize_snapshot(source_synced_at)
    results: list[dict[str, Any]] = []
    for index, raw_value in enumerate(values):
        platform = "unknown"
        try:
            try:
                platform = video_extractor._detect_platform(normalize_shared_url(raw_value))
            except ValueError:
                platform = "unknown"
            result = import_one(
                db,
                user_id=user_id,
                value=raw_value,
                source_mode=source_mode,
                source_rank_offset=source_rank_offset + index,
                source_synced_at=snapshot,
                source_order_reliable=source_order_reliable,
                source_coverage=source_coverage,
            )
            results.append({"input": raw_value, "success": True, **result})
        except Exception as exc:
            db.rollback()
            results.append({
                "input": raw_value,
                "success": False,
                "status": "failed",
                "platform": platform,
                "error": _safe_error(platform, exc),
            })
    succeeded = sum(1 for result in results if result["success"])
    removed = None
    if (
        source_mode in _ACCOUNT_SOURCE_MODES
        and source_coverage == "complete"
        and source_order_reliable
        and source_snapshot_size is not None
        and source_rank_offset + len(values) >= source_snapshot_size
        and succeeded == len(results)
        and all(result["item"]["platform"] == "bilibili" for result in results)
    ):
        removed = _reconcile_bilibili_snapshot(
            db, user_id=user_id, source_mode=source_mode,
            snapshot=snapshot, expected_size=source_snapshot_size,
        )
    return {
        "items": results,
        "total": len(results),
        "success": succeeded,
        "failed": len(results) - succeeded,
        "source_reconciled": removed is not None,
        "source_memberships_removed": removed or 0,
    }


def _reconcile_bilibili_snapshot(
    db: Session, *, user_id: str, source_mode: str, snapshot: str, expected_size: int,
) -> int | None:
    """完整且可靠的最后一批才对账成员关系；文稿与其他频道永不删除。"""
    db.query(User.id).filter(User.id == user_id).with_for_update().one()
    candidates = (
        db.query(Note).filter(Note.user_id == user_id)
        .order_by(Note.id.asc()).populate_existing().with_for_update().all()
    )
    timestamp = _snapshot_time(snapshot)
    current_ids: set[str] = set()
    current_ranks: set[int] = set()
    previous_members: list[tuple[Note, dict[str, Any]]] = []
    for note in candidates:
        meta = _source_meta(note)
        if meta.get("source_kind") != SOURCE_KIND or meta.get("platform") != "bilibili":
            continue
        modes = _source_modes(meta.get("source_modes"), meta.get("source_mode"))
        if source_mode not in modes:
            continue
        maps = _order_maps(meta)
        note_time = _snapshot_time(maps["source_synced_ats"].get(source_mode))
        if note_time > timestamp:
            # 更新一轮已经开始，旧批次迟到不能用旧视图回滚当前成员关系。
            db.commit()
            return None
        if note_time == timestamp:
            rank = maps["source_ranks"].get(source_mode)
            if (
                maps["source_order_reliabilities"].get(source_mode) is True
                and _is_complete_bilibili_note(note)
                and isinstance(rank, int) and not isinstance(rank, bool) and rank >= 0
            ):
                current_ids.add(note.video_id)
                current_ranks.add(rank)
        else:
            previous_members.append((note, meta))
    # 前批失败/缺页/重复链接导致总量或排名不全时，保留所有旧成员待重试。
    if len(current_ids) < expected_size or not all(rank in current_ranks for rank in range(expected_size)):
        db.commit()
        return None
    for note, meta in previous_members:
        modes = [mode for mode in _source_modes(meta.get("source_modes"), meta.get("source_mode"))
                 if mode != source_mode]
        maps = _order_maps(meta)
        for field in _ORDER_MAP_FIELDS:
            maps[field].pop(source_mode, None)
        remaining_modes = [mode for mode in maps["source_synced_ats"]
                           if mode in modes or mode == "import"]
        primary = str(meta.get("source_mode") or "import")
        if primary == source_mode:
            primary = max(remaining_modes, key=lambda mode: _snapshot_time(
                maps["source_synced_ats"].get(mode),
            )) if remaining_modes else (modes[0] if modes else "import")
        removed_ats = dict(meta.get("source_removed_ats") or {})
        removed_ats[source_mode] = snapshot
        updated = {**meta, **maps, "source_mode": primary, "source_modes": modes,
                   "source_removed_ats": removed_ats}
        for map_key, scalar_key in zip(_ORDER_MAP_FIELDS, _ORDER_SCALAR_FIELDS):
            if primary in maps[map_key]:
                updated[scalar_key] = maps[map_key][primary]
            else:
                updated.pop(scalar_key, None)
        payload = _load_payload(note)
        payload["source_meta"] = updated
        note.ai_summary = json.dumps(payload, ensure_ascii=False)
    db.commit()
    return len(previous_members)


def list_notes(
    db: Session, *, user_id: str, platform: str = "all", source_mode: str | None = None,
) -> list[Note]:
    if platform not in {"all", *SUPPORTED_PLATFORMS}:
        raise ValueError("无效的平台筛选")
    candidates = (
        db.query(Note)
        .filter(Note.user_id == user_id)
        .order_by(Note.created_at.desc(), Note.id.asc())
        .all()
    )
    result = []
    for note in candidates:
        meta = _source_meta(note)
        if meta.get("source_kind") != SOURCE_KIND:
            continue
        if platform != "all" and meta.get("platform") != platform:
            continue
        if source_mode and source_mode != str(meta.get("source_mode") or "import") and source_mode not in _source_modes(meta.get("source_modes")):
            continue
        if meta.get("platform") == "bilibili" and not _is_complete_bilibili_note(note):
            # Preserve old partial rows for a later retry, but do not present
            # them as complete video documents in the user's library.
            continue
        result.append(note)

    def source_order(note: Note) -> tuple:
        meta = _source_meta(note)
        mode = source_mode or str(meta.get("source_mode") or "import")
        maps = _order_maps(meta)
        rank = maps["source_ranks"].get(mode)
        valid_rank = isinstance(rank, int) and not isinstance(rank, bool) and rank >= 0
        if not maps["source_order_reliabilities"].get(mode, True):
            valid_rank = False
        return (
            -_snapshot_time(maps["source_synced_ats"].get(mode)),
            not valid_rank, rank if valid_rank else 0,
            -_snapshot_time(meta.get("first_seen_at") or note.created_at), note.id,
        )

    # 先按来源快照分组，再按平台原始位置；文案/摘要的完成时间不参与排序。
    return sorted(result, key=source_order)[:500]


def serialize_item(
    note: Note,
    *,
    include_note: bool = True,
) -> dict[str, Any]:
    data = note.to_dict() if include_note else None
    meta = _source_meta(note)
    order_maps = _order_maps(meta)
    platform = str(meta.get("platform") or media_platform(note) or "").strip()
    mode = str(meta.get("source_mode") or "import").strip() or "import"
    source_url = stable_note_source(
        video_id=note.video_id,
        video_url=note.video_url,
        source_meta=meta,
        platform=platform,
    )
    media_type = str(meta.get("media_type") or "video")
    raw_cover_url = str(meta.get("cover_url") or "").strip()
    display_cover_url = (
        public_cover_url(note.id)
        if raw_cover_url and meta.get("platform") == "bilibili"
        else raw_cover_url
    )
    item = {
        "id": note.id,
        "video_id": note.video_id,
        "title": note.video_title,
        "platform": platform,
        "caption": meta.get("caption") or "",
        "author_name": meta.get("author_name") or "",
        "cover_url": display_cover_url,
        "source_url": source_url,
        "media_url": (
            public_media_url(note.id)
            if platform in {"douyin", "xiaohongshu"} and media_type == "video"
            else ""
        ),
        "media_type": media_type,
        "tags": meta.get("tags") or [],
        "published_at": meta.get("published_at") or "",
        "imported_at": (
            meta.get("first_seen_at")
            or (note.created_at.isoformat() if note.created_at else "")
        ),
        "transcript_chars": len(note.transcript_raw or ""),
        "transcript_source": meta.get("transcript_source") or "caption-only",
        "speech_ready": bool(meta.get("speech_ready")),
        "metadata_complete": (
            platform != "bilibili"
            or _is_complete_bilibili_note(note)
        ),
        "degraded": bool(meta.get("degraded")),
        "ai_initialized": bool(note.ai_initialized),
        "card_type": note.card_type,
        "source_mode": mode,
        "source_modes": _source_modes(
            meta.get("source_modes"),
            meta.get("source_mode"),
        ),
        **order_maps,
        "source_rank": order_maps["source_ranks"].get(mode),
        "source_synced_at": order_maps["source_synced_ats"].get(mode, ""),
        "source_order_reliable": bool(order_maps["source_order_reliabilities"].get(mode, False)),
        "source_coverage": order_maps["source_coverages"].get(mode, "unknown"),
    }
    if include_note:
        assert data is not None
        item["note"] = data
    return item


def get_import(db: Session, *, user_id: str, note_id: str) -> Note | None:
    note = note_service.get_note(db, note_id, user_id=user_id)
    return note if note is not None and _source_meta(note).get("source_kind") == SOURCE_KIND else None


def get_workspace(
    db: Session,
    *,
    user_id: str,
    note_id: str,
    refresh_media: bool = False,
) -> dict[str, Any] | None:
    # The shared reader is also the canonical source view for knowledge pages.
    # Keep mutation endpoints import-only, but allow any owned Note to be read
    # here so older Douyin/library entries and direct extractions do not lead to
    # a false 404 when users follow “查看来源”.
    note = note_service.get_note(db, note_id, user_id=user_id)
    if note is None:
        return None
    # Old rows may still contain an expired CDN URL. Clean it on read; a new
    # response capability is minted below regardless of ``refresh_media``.
    note_service.scrub_note_ephemeral_media(db, note)
    item = serialize_item(note)
    source_meta = _source_meta(note)
    source_kind = str(source_meta.get("source_kind") or "note").strip() or "note"
    workspace_item = {
        "id": note.id,
        "aweme_id": note.video_id,
        "title": item["title"],
        "caption": item["caption"],
        "author_name": item["author_name"],
        "media_type": item["media_type"],
        "tags": item["tags"],
        "date": item["published_at"],
        "recorded_at": item["imported_at"],
        "source_mode": str(source_meta.get("source_mode") or "import").strip() or "import",
        "source_url": item["source_url"],
        "media_url": item["media_url"],
        "cover_url": item["cover_url"],
        "can_extract": False,
        "extracted": True,
        "extracted_note_id": note.id,
        "transcript_chars": item["transcript_chars"],
        "ai_initialized": item["ai_initialized"],
        "card_type": item["card_type"],
        "platform": item["platform"],
    }
    plan = plan_service.get_plan_by_note(db, note.id, user_id=user_id)
    return {
        "item": workspace_item,
        "note": note.to_dict(),
        "plan": plan.to_dict() if plan else None,
        "media_storage": {
            "provider": source_kind,
            "mode": "external",
            "database_stores_media": False,
        },
    }


def initialize_ai(db: Session, *, user_id: str, note_id: str) -> tuple[Note, bool]:
    # This action is also used from the shared Note reader opened by knowledge
    # source links, so it must follow the same owned-Note scope as get_workspace.
    note = note_service.get_note(db, note_id, user_id=user_id)
    if note is None:
        raise LookupError("视频资料不存在")
    if note.ai_initialized:
        return note, True
    transcript = (note.transcript_raw or "").strip()
    if not transcript:
        raise ValueError("完整文案尚未就绪")
    intent = ai_juicer.classify_intent(transcript)
    ai_result = ai_juicer.generate_card(
        transcript=transcript,
        content_type=intent["card_type"],
        video_title=note.video_title,
    )
    plan_data = ai_juicer.generate_plan(transcript) if intent.get("is_plan") else None
    if plan_data:
        ai_result["plan"] = plan_data
    # LLM 等待期间可能已经重排/取消收藏；写回前刷新来源 JSON，不回滚新快照。
    db.query(User.id).filter(User.id == user_id).with_for_update().one()
    db.refresh(note)
    if note.ai_initialized:
        return note, True
    ai_result["source_meta"] = sanitized_source_meta(_source_meta(note))
    note = note_service.update_note_ai(db, note, ai_result)
    if plan_data and plan_data.get("tasks") and not plan_service.get_plan_by_note(db, note.id, user_id=user_id):
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan_data)
        plan_service.create_plan(
            db=db,
            note_id=note.id,
            title=plan_data.get("goal") or note.video_title,
            user_id=user_id,
            fields=fields,
            tasks=tasks,
            total_days=total_days,
            days=plan_data.get("days") or [],
        )
    return note, False


def delete_import(db: Session, *, user_id: str, note_id: str) -> bool:
    note = get_import(db, user_id=user_id, note_id=note_id)
    if note is None:
        return False
    # A creator-source tombstone survives Note deletion so a future manual
    # sync does not silently re-import something the user removed permanently.
    from app.services import creator_sync_service

    creator_sync_service.mark_note_permanently_removed(
        db, user_id=user_id, note_id=note.id
    )
    db.query(Plan).filter(
        Plan.user_id == user_id,
        Plan.note_id == note.id,
    ).delete(synchronize_session=False)
    db.query(Note).filter(Note.id == note.id, Note.user_id == user_id).delete()
    db.commit()
    return True
