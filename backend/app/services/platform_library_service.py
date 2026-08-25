"""User-scoped Bilibili and Xiaohongshu imports for the video library."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.note import Note
from app.models.plan import Plan
from app.services import ai_juicer, note_service, plan_service, settings_service, video_extractor
from app.services.xhs_downloader_client import (
    XhsDownloaderUnavailable,
    fetch_xhs_detail,
)

SOURCE_KIND = "platform-import"
SUPPORTED_PLATFORMS = {"bilibili", "xiaohongshu"}
MAX_IMPORT_URLS = 10

_URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_XHS_MEDIA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 "
        "Mobile/15E148 Safari/604.1"
    ),
    "Referer": "https://www.xiaohongshu.com/",
}


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


def _find_existing(
    db: Session,
    *,
    user_id: str,
    platform: str,
    video_id: str,
) -> Note | None:
    candidates = (
        db.query(Note)
        .filter(Note.user_id == user_id, Note.video_id == video_id)
        .order_by(Note.created_at.desc())
        .all()
    )
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
        "media_url": info.get("media_url") or "",
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
        "media_url": info.get("media_url") or "",
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
    existing = _find_existing(
        db, user_id=user_id, platform=platform, video_id=video_id,
    )
    media_url = str(source_meta.get("media_url") or source_meta.get("source_url") or "")
    if existing is None:
        note = note_service.create_transcript_note(
            db,
            video_info={
                "video_id": video_id,
                "title": info.get("title") or "未命名视频",
                "download_url": media_url,
                "platform": platform,
            },
            transcript=transcript,
            source_meta=source_meta,
            user_id=user_id,
        )
        return note, False

    payload = _load_payload(existing)
    previous_meta = payload.get("source_meta") if isinstance(payload.get("source_meta"), dict) else {}
    payload["source_meta"] = {
        **previous_meta,
        **source_meta,
        "first_seen_at": previous_meta.get("first_seen_at") or existing.created_at.isoformat(),
    }
    existing.video_title = str(info.get("title") or existing.video_title)
    existing.video_url = media_url or existing.video_url
    if transcript and len(transcript) >= len(existing.transcript_raw or ""):
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
) -> dict[str, Any]:
    url = normalize_shared_url(value)
    platform = video_extractor._detect_platform(url)
    if platform not in SUPPORTED_PLATFORMS:
        raise ValueError("当前导入只支持 B站和小红书链接")
    if platform == "bilibili":
        info, transcript, source_meta = _extract_bilibili(url, db)
    else:
        info, transcript, source_meta = _extract_xiaohongshu(url, db)
    if source_mode in {"collect", "like", "post"}:
        source_meta["source_mode"] = source_mode
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
) -> dict[str, Any]:
    if not 1 <= len(values) <= MAX_IMPORT_URLS:
        raise ValueError(f"每次需要提交 1–{MAX_IMPORT_URLS} 条链接")
    results: list[dict[str, Any]] = []
    for raw_value in values:
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
    return {
        "items": results,
        "total": len(results),
        "success": succeeded,
        "failed": len(results) - succeeded,
    }


def list_notes(db: Session, *, user_id: str, platform: str = "all") -> list[Note]:
    if platform not in {"all", *SUPPORTED_PLATFORMS}:
        raise ValueError("无效的平台筛选")
    candidates = (
        db.query(Note)
        .filter(Note.user_id == user_id)
        .order_by(Note.updated_at.desc(), Note.created_at.desc())
        .limit(500)
        .all()
    )
    result = []
    for note in candidates:
        meta = _source_meta(note)
        if meta.get("source_kind") != SOURCE_KIND:
            continue
        if platform != "all" and meta.get("platform") != platform:
            continue
        result.append(note)
    return result


def serialize_item(note: Note) -> dict[str, Any]:
    data = note.to_dict()
    meta = _source_meta(note)
    return {
        "id": note.id,
        "video_id": note.video_id,
        "title": note.video_title,
        "platform": meta.get("platform") or "",
        "caption": meta.get("caption") or "",
        "author_name": meta.get("author_name") or "",
        "cover_url": meta.get("cover_url") or "",
        "source_url": meta.get("source_url") or note.video_url,
        "media_url": meta.get("media_url") or note.video_url or "",
        "media_type": meta.get("media_type") or "video",
        "tags": meta.get("tags") or [],
        "published_at": meta.get("published_at") or "",
        "imported_at": meta.get("first_seen_at") or data.get("created_at") or "",
        "transcript_chars": len(note.transcript_raw or ""),
        "transcript_source": meta.get("transcript_source") or "caption-only",
        "speech_ready": bool(meta.get("speech_ready")),
        "degraded": bool(meta.get("degraded")),
        "ai_initialized": bool(note.ai_initialized),
        "card_type": note.card_type,
        "source_mode": str(meta.get("source_mode") or "import").strip() or "import",
        "note": data,
    }


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
    if refresh_media and note.video_id:
        current_meta = _source_meta(note)
        platform = str(current_meta.get("platform") or "douyin").strip()
        if platform == "douyin":
            source_url = str(
                current_meta.get("source_url")
                or f"https://www.douyin.com/video/{note.video_id}"
            ).strip()
            info = video_extractor.parse_video_info(source_url)
            refreshed_media = str(info.get("download_url") or info.get("url") or "").strip()
            if refreshed_media:
                note.video_url = refreshed_media
                summary = json.loads(note.ai_summary or "{}")
                source_meta = summary.get("source_meta")
                if not isinstance(source_meta, dict):
                    source_meta = {}
                source_meta.update({
                    "source_kind": source_meta.get("source_kind") or "single-link",
                    "platform": "douyin",
                    "source_url": source_url,
                    "media_url": refreshed_media,
                    "cover_url": str(info.get("cover_url") or info.get("thumbnail") or source_meta.get("cover_url") or ""),
                    "author_name": str(info.get("author_name") or info.get("author") or source_meta.get("author_name") or ""),
                    "media_type": "video",
                    "source_mode": source_meta.get("source_mode") or "import",
                })
                summary["source_meta"] = source_meta
                note.ai_summary = json.dumps(summary, ensure_ascii=False)
                db.commit()
                db.refresh(note)
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
    source_meta = _source_meta(note)
    ai_result["source_meta"] = source_meta
    plan_data = ai_juicer.generate_plan(transcript) if intent.get("is_plan") else None
    if plan_data:
        ai_result["plan"] = plan_data
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
