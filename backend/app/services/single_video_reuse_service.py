"""复用当前用户已完成的单条视频资料，避免重复下载和识别。"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qs, urlsplit

from sqlalchemy.orm import Session

from app.core.media_reference import platform_from_source_url, sanitized_source_meta
from app.models.note import Note
from app.services import library_sync_service, note_service


def _source_identity(source_url: str) -> tuple[str, str] | None:
    """仅识别明确作品页；短链由调用方解析后再传入，此处没有网络请求。"""
    try:
        parsed = urlsplit(str(source_url or "").strip())
        if parsed.username or parsed.password:
            return None
        platform = platform_from_source_url(source_url)
        if platform == "douyin":
            match = re.fullmatch(r"/(?:share/)?(?:video|note)/(\d{8,32})/?", parsed.path)
        elif platform == "bilibili":
            # 分 P 链接尚无独立文稿标识，不把其它分 P 当作第一集复用。
            if parse_qs(parsed.query).get("p", ["1"]) != ["1"]:
                return None
            match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", parsed.path)
        else:
            return None
    except (TypeError, ValueError):
        return None
    return (platform, match.group(1)) if match else None


def _payload(note: Note) -> dict[str, Any]:
    try:
        value = json.loads(note.ai_summary or "{}")
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _same_source(note: Note, platform: str, video_id: str) -> bool:
    meta = sanitized_source_meta(_payload(note).get("source_meta"))
    declared_platform = str(meta.get("platform") or "").strip().lower()
    if declared_platform and declared_platform != platform:
        return False
    # 兼容旧笔记缺少 source_meta，同时拒绝元数据与持久链接互相矛盾的资料。
    evidence = bool(declared_platform == platform)
    for value in (note.video_url, meta.get("source_url")):
        if not value:
            continue
        source_platform = platform_from_source_url(str(value))
        if source_platform and source_platform != platform:
            return False
        if source_platform == "bilibili":
            try:
                if parse_qs(urlsplit(str(value)).query).get("p", ["1"]) != ["1"]:
                    return False
            except ValueError:
                return False
        source_id = _source_identity(str(value))
        if source_id is not None and source_id != (platform, video_id):
            return False
        evidence = evidence or source_platform == platform
    return evidence


def _has_completed_content(note: Note) -> bool:
    transcript = str(note.transcript_raw or "").strip()
    if not transcript or not note.ai_initialized:
        return False
    if re.match(r"^\[no audio\b", transcript, re.IGNORECASE):
        return False
    if transcript.startswith("[B站视频]"):
        return False
    payload = _payload(note)
    if payload.get("generation_status", "ready") != "ready":
        return False
    meta = sanitized_source_meta(payload.get("source_meta"))
    if meta.get("degraded") or meta.get("transcript_source") in {
        "image-fallback", "image_fallback", "metadata", "caption", "caption-fallback",
        "caption-only", "creator-caption",
    }:
        return False
    sections = payload.get("sections")
    return isinstance(sections, list) and any(
        isinstance(section, dict)
        and isinstance(section.get("content"), str)
        and bool(section["content"].strip())
        for section in sections
    )


def _missing_title(value: str, video_id: str) -> bool:
    title = str(value or "").strip()
    return not title or bool(re.fullmatch(
        r"(?:抖音作品\s*\d*|douyin[_ -]?\d*|未知标题)", title, flags=re.IGNORECASE,
    )) or title in {
        "未知标题", "未知视频", "抖音作品", "抖音视频", "B站视频", "哔哩哔哩视频",
        video_id, f"抖音作品 {video_id}", f"抖音视频 {video_id}", f"B站视频 {video_id}",
    }


def _missing_author(value: object) -> bool:
    return str(value or "").strip() in {"", "未知作者", "未知用户", "未知", "unknown"}


def needs_metadata(note: Note) -> bool:
    """抖音资料已有完整文稿时，只需补齐缺失的标题或作者。"""
    meta = sanitized_source_meta(_payload(note).get("source_meta"))
    platform = str(meta.get("platform") or platform_from_source_url(note.video_url))
    return platform == "douyin" and (
        _missing_title(note.video_title, note.video_id) or _missing_author(meta.get("author_name"))
    )


def _validated_metadata(
    video_info: dict[str, Any] | None, identity: tuple[str, str],
) -> dict[str, Any]:
    """新补取的信息必须明确属于同一平台、同一作品。"""
    if not isinstance(video_info, dict):
        return {}
    platform, video_id = identity
    if str(video_info.get("video_id") or "") != video_id:
        return {}
    source_url = str(video_info.get("source_url") or "")
    declared = str(video_info.get("platform") or platform_from_source_url(source_url))
    if declared != platform:
        return {}
    source_identity = _source_identity(source_url)
    if source_identity is not None and source_identity != identity:
        return {}
    source_platform = platform_from_source_url(source_url)
    if source_platform and source_platform != platform:
        return {}
    return video_info


def _cover(value: object) -> str:
    cover = str(value or "").strip()
    try:
        parsed = urlsplit(cover)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return ""
    except ValueError:
        return ""
    return cover[:2048]


def find_reusable_note(
    db: Session,
    *,
    user_id: str,
    source_url: str,
    share_text: str = "",
    video_info: dict[str, Any] | None = None,
) -> Note | None:
    """返回同用户、同平台、同作品的最新完整资料；只补齐缺失的展示信息。

    仅查询当前用户的笔记，不读取其它用户的文稿或绑定信息。成功复用时不
    创建笔记、不重做语音识别和内容生成；若补齐元数据则提交到当前会话。
    """
    owner = str(user_id or "").strip()
    identity = _source_identity(source_url)
    if not owner or identity is None:
        return None
    platform, video_id = identity
    owned = (
        db.query(Note)
        .filter(Note.user_id == owner, Note.video_id == video_id)
        .order_by(Note.created_at.desc(), Note.id.desc())
        .limit(100)
        .all()
    )
    matching = [note for note in owned if _same_source(note, platform, video_id)]
    reusable = next((note for note in matching if _has_completed_content(note)), None)
    if reusable is None:
        return None

    payload = _payload(reusable)
    meta = sanitized_source_meta(payload.get("source_meta"))
    info: dict[str, Any] = {
        "video_id": video_id,
        "platform": platform,
        "title": reusable.video_title,
        "author_name": meta.get("author_name") or "",
        "cover_url": meta.get("cover_url") or "",
    }
    fresh = _validated_metadata(video_info, identity)
    if _missing_title(info["title"], video_id) and not _missing_title(fresh.get("title"), video_id):
        info["title"] = fresh["title"]
    if _missing_author(info["author_name"]) and not _missing_author(fresh.get("author_name")):
        info["author_name"] = fresh["author_name"]
    if not _cover(info["cover_url"]):
        info["cover_url"] = _cover(fresh.get("cover_url") or fresh.get("thumbnail"))
    for note in matching:
        donor_meta = sanitized_source_meta(_payload(note).get("source_meta"))
        if _missing_title(info["title"], video_id) and not _missing_title(note.video_title, video_id):
            info["title"] = note.video_title
        if _missing_author(info["author_name"]) and not _missing_author(donor_meta.get("author_name")):
            info["author_name"] = str(donor_meta["author_name"]).strip()
    if platform == "douyin" and share_text:
        from app.services.video_extractor import merge_douyin_share_metadata, normalize_share_url

        shared_identity = _source_identity(normalize_share_url(share_text))
        if shared_identity is None or shared_identity == identity:
            info = merge_douyin_share_metadata(info, share_text)

    changed = False
    title = str(info.get("title") or "").strip()[:512]
    if _missing_title(reusable.video_title, video_id) and not _missing_title(title, video_id):
        reusable.video_title = title
        reusable.seo_title = note_service.generate_seo_title(title)
        changed = True
    author = str(info.get("author_name") or "").strip()[:256]
    meta_changed = False
    if _missing_author(meta.get("author_name")) and not _missing_author(author):
        meta["author_name"] = author
        meta_changed = True
    cover = _cover(info.get("cover_url"))
    if not _cover(meta.get("cover_url")) and cover:
        meta["cover_url"] = cover
        meta_changed = True
    if fresh:
        from app.services.agent_video_link_service import _public_share_url

        share = _public_share_url(fresh.get("public_share_url") or fresh.get("source_url"))
        if platform == "douyin" and share and meta.get("public_share_url") != share:
            meta["public_share_url"] = share
            meta_changed = True
    if meta_changed:
        payload["source_meta"] = meta
        reusable.ai_summary = json.dumps(payload, ensure_ascii=False)
        changed = True
    if changed:
        db.commit()
        db.refresh(reusable)
    return reusable


def prepare_download_note(
    db: Session, *, user_id: str, video_info: dict[str, Any], source_url: str,
) -> Note | None:
    """真实作品元数据读取成功就保存资料；语音识别失败也仍可下载原视频。"""
    from app.services.agent_video_link_service import _public_share_url

    platform = str(video_info.get("platform") or "")
    video_id = str(video_info.get("video_id") or "")
    canonical = str(video_info.get("source_url") or source_url)
    if platform == "douyin" and re.fullmatch(r"\d{8,32}", video_id):
        canonical = f"https://www.douyin.com/video/{video_id}"
    elif platform == "bilibili" and re.fullmatch(r"BV[0-9A-Za-z]{10}", video_id):
        canonical = f"https://www.bilibili.com/video/{video_id}"
    else:
        return None
    # 分 P 没有独立文件身份，不能把别的分 P 下载成第一集。
    if platform == "bilibili" and parse_qs(urlsplit(source_url).query).get("p", ["1"]) != ["1"]:
        return None
    info = {**video_info, "source_url": canonical}
    meta = {
        "source_kind": "single-link", "platform": platform, "source_url": canonical,
        "source_mode": "import", "media_type": "video", "transcript_source": "pending",
        "speech_ready": False, "cover_url": str(video_info.get("cover_url") or video_info.get("thumbnail") or ""),
        "author_name": str(video_info.get("author_name") or video_info.get("author") or ""),
    }
    if platform == "douyin" and (share := _public_share_url(source_url)):
        meta["public_share_url"] = share
    with library_sync_service.import_lease(db, user_id=user_id, platform=platform, video_id=video_id):
        note = note_service.get_note_by_video_id(db, video_id, user_id)
        if note is None or not _same_source(note, platform, video_id):
            return note_service.create_transcript_note(db, video_info=info, transcript="", source_meta=meta, user_id=user_id)
        payload = _payload(note)
        previous = sanitized_source_meta(payload.get("source_meta"))
        # 不回退已有文稿与分析状态，只补充读取上下文和元数据。
        for key in ("source_kind", "source_mode", "transcript_source", "speech_ready"):
            if key in previous:
                meta[key] = previous[key]
        payload["source_meta"] = {**previous, **{key: value for key, value in meta.items() if value not in (None, "")}}
        note.ai_summary = json.dumps(payload, ensure_ascii=False)
        if not _missing_title(info.get("title"), video_id):
            note.video_title = str(info["title"])[:512]
        db.commit()
        db.refresh(note)
        return note
