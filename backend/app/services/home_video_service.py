"""首页永久隐藏与收藏视频；所有来源归属均在服务端核对，不触发平台抓取或 AI。"""

from __future__ import annotations

import json
import re

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.media_reference import platform_from_source_url
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.home_video_preference import HomeVideoPreference
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger
from app.services import knowledge_service
from app.services import library_hidden_service


def _key(platform: str, video_id: str) -> tuple[str, str]:
    if platform not in {"douyin", "bilibili"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", video_id):
        raise ValueError("视频标识无效")
    return platform, video_id


def _note_platform(note: Note) -> str:
    try:
        value = json.loads(note.ai_summary or "{}")
        meta = value.get("source_meta", {}) if isinstance(value, dict) else {}
        platform = meta.get("platform") if isinstance(meta, dict) else None
        if platform in {"douyin", "bilibili"}:
            return platform
    except (ValueError, TypeError):
        pass
    return platform_from_source_url(note.video_url)


def _owned_video(db: Session, user_id: str, platform: str, video_id: str) -> dict:
    _key(platform, video_id)
    notes = [item for item in db.query(Note).filter(Note.user_id == user_id, Note.video_id == video_id)
             .order_by(Note.created_at.desc(), Note.id).all() if _note_platform(item) == platform]
    # 同一视频可能有多份历史解析；只使用已有真实摘要，随后才退回已有文稿。
    normalized = {item.id: knowledge_service.normalize_candidate_to_page(item) for item in notes}
    note = next((item for item in notes if normalized[item.id]), None)
    note = note or next((item for item in notes if (item.transcript_raw or "").strip()), None)
    note = note or (notes[0] if notes else None)
    snapshot = None
    if platform == "douyin" and note is None:
        snapshot = db.query(DouyinLocalLibraryItem).filter_by(user_id=user_id, video_id=video_id).first()
    # 历史抖音侧车的已同步清单可能只有来源台账；不读取任何其他用户的快照。
    legacy_owned = note is None and snapshot is None and platform == "douyin" and video_id.isdigit() and db.query(VideoSourceLedger.id).filter_by(
        user_id=user_id, video_id=video_id,
    ).first() is not None
    if note is None and snapshot is None and not legacy_owned:
        raise LookupError("视频不在你的资料中")
    label = "抖音" if platform == "douyin" else "B站"
    url = f"https://www.douyin.com/video/{video_id}" if platform == "douyin" else f"https://www.bilibili.com/video/{video_id}"
    return {"note": note, "notes": notes, "normalized": normalized,
            "title": note.video_title if note else (snapshot.title if snapshot else f"{label}视频 {video_id}"),
            "source_label": snapshot.author_name if snapshot and snapshot.author_name else label, "url": url}


def serialize_preference(item: HomeVideoPreference) -> dict:
    return {"platform": item.platform, "video_id": item.video_id, "hidden": item.hidden,
            "knowledge_entry_id": item.knowledge_entry_id}


def list_preferences(db: Session, user_id: str) -> list[dict]:
    return [serialize_preference(item) for item in db.query(HomeVideoPreference).filter_by(user_id=user_id).order_by(HomeVideoPreference.id).all()]


def _preference(db: Session, user_id: str, platform: str, video_id: str) -> HomeVideoPreference:
    query = db.query(HomeVideoPreference).filter_by(user_id=user_id, platform=platform, video_id=video_id)
    item = query.first()
    if item is not None:
        return item
    item = HomeVideoPreference(user_id=user_id, platform=platform, video_id=video_id)
    db.add(item)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        item = query.first()
        if item is None:
            raise
    db.refresh(item)
    return item


def set_hidden(db: Session, user_id: str, platform: str, video_id: str, hidden: bool) -> dict:
    _key(platform, video_id)
    item = db.query(HomeVideoPreference).filter_by(user_id=user_id, platform=platform, video_id=video_id).first()
    # 原视频稍后被用户删除，仍允许撤销其本人留下的首页隐藏偏好。
    if item is None or hidden:
        _owned_video(db, user_id, platform, video_id)
    item = item or _preference(db, user_id, platform, video_id)
    item.hidden = hidden
    # 首页拖拽隐藏表达的是“以后不再看到这条视频”，因此同步维护抖音资料库
    # 的永久隐藏记录。这样首页、昨日回顾和视频资料不会出现互相矛盾的可见性。
    # B 站资料目前没有同一套永久隐藏台账，保留首页范围内的偏好即可。
    if platform == "douyin":
        if hidden:
            library_hidden_service.hide_aweme_ids(
                db, user_id, [video_id], mode="permanent", commit=False,
            )
        else:
            library_hidden_service.restore_permanent_aweme_ids(db, user_id, [video_id])
    db.commit()
    db.refresh(item)
    return serialize_preference(item)


def _save_owned_video(db: Session, user_id: str, platform: str, video_id: str,
                      candidate: Note | None = None) -> tuple[KnowledgeEntry, bool, HomeVideoPreference]:
    _owned_video(db, user_id, platform, video_id)
    item = _preference(db, user_id, platform, video_id)
    for attempt in range(2):
        # 首页和知识库候选入口共用此行锁；读到最新关联后才决定是否创建。
        item = db.query(HomeVideoPreference).filter_by(id=item.id, user_id=user_id).populate_existing().with_for_update().one()
        video = _owned_video(db, user_id, platform, video_id)
        note = next((row for row in video["notes"] if candidate is not None and row.id == candidate.id), video["note"])
        entry = db.query(KnowledgeEntry).filter_by(id=item.knowledge_entry_id, user_id=user_id).first() if item.knowledge_entry_id else None
        if entry is None and video["notes"]:
            entry = db.query(KnowledgeEntry).filter(KnowledgeEntry.user_id == user_id,
                KnowledgeEntry.source_note_id.in_([row.id for row in video["notes"]]))
            entry = entry.order_by(KnowledgeEntry.created_at, KnowledgeEntry.id).first()
        created = entry is None
        if created:
            normalized = video["normalized"].get(note.id) if note is not None else None
            # 没有摘要时先保存真实资料链接/已有文稿，不生成或冒充 AI 分析。
            transcript = (note.transcript_raw or "").strip() if note is not None else ""
            content = f"[打开原视频]({video['url']})"
            if transcript:
                content += "\n\n## 视频文稿\n\n" + transcript[:95_000]
            entry = KnowledgeEntry(user_id=user_id, title=(note.video_title if note else video["title"])[:256],
                summary=normalized["summary"] if normalized else "已收藏的视频资料",
                content=normalized["content"] if normalized else content,
                status="canonical", origin="video", source_note_id=note.id if note else None,
                source_label=normalized["source_label"] if normalized else video["source_label"])
            db.add(entry)
        elif entry.source_note_id is None and note is not None:
            # 先存书签、后来得到文稿：只补真实关联，绝不重写用户已整理的正文。
            # 若历史数据已有另一条知识页，保留两条用户内容，不悄悄合并或伪造关联。
            linked = db.query(KnowledgeEntry.id).filter_by(user_id=user_id, source_note_id=note.id).first()
            if linked is None:
                entry.source_note_id = note.id
        try:
            db.flush()
            item.knowledge_entry_id = entry.id
            db.commit()
            break
        except IntegrityError:
            # 与升级前仍在执行的旧入口竞争时，回滚后重新加锁、复用已落库条目。
            db.rollback()
            if attempt:
                raise
    db.refresh(entry)
    db.refresh(item)
    return entry, created, item


def save_video_candidate(db: Session, user_id: str, note: Note) -> KnowledgeEntry | None:
    """已通过知识库候选资格检查的视频，共用首页的每视频保存锁。"""
    platform = _note_platform(note)
    if platform not in {"douyin", "bilibili"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", note.video_id):
        return None
    return _save_owned_video(db, user_id, platform, note.video_id, candidate=note)[0]


def save_to_knowledge(db: Session, user_id: str, platform: str, video_id: str) -> dict:
    entry, created, item = _save_owned_video(db, user_id, platform, video_id)
    # 返回条目的实际关联，不能把同一视频的新解析冒充为已保存的来源。
    note = db.query(Note).filter_by(id=entry.source_note_id, user_id=user_id).first() if entry.source_note_id else None
    return {"entry": knowledge_service.serialize_entry(entry, note), "created": created, "preference": serialize_preference(item)}
