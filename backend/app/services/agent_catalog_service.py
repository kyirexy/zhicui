"""将已获授权并保存的 Agent 清单投影到客户端目录，不重新下载或伪造文稿。"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import load_only

from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger
from app.services.video_source_ledger_service import legacy_source_meta


def list_douyin_items(db, *, user_id: str, source_mode: str | None = None,
                      video_id: str | None = None) -> list[dict]:
    query = select(Note, VideoSourceLedger).join(VideoSourceLedger,
        (VideoSourceLedger.note_id == Note.id) & (VideoSourceLedger.user_id == Note.user_id)
        & (VideoSourceLedger.video_id == Note.video_id),
    ).where(Note.user_id == user_id, VideoSourceLedger.source_mode.in_(["like", "collect"]))
    if source_mode:
        query = query.where(VideoSourceLedger.source_mode == source_mode)
    if video_id:
        query = query.where(Note.video_id == video_id)
    query = query.options(load_only(Note.id, Note.video_id, Note.video_title, Note.ai_summary))
    query = query.order_by(VideoSourceLedger.last_seen_at.desc(), Note.id.asc())
    result, seen = [], set()
    for note, ledger in db.execute(query):
        meta = legacy_source_meta(note)
        if (note.video_id in seen or not re.fullmatch(r"[0-9]{5,32}", note.video_id or "")
                or meta.get("source_kind") != "agent-link-import" or meta.get("platform") != "douyin"):
            continue
        seen.add(note.video_id)
        cover = str(meta.get("cover_url") or "")
        try:
            url = urlsplit(cover)
            if (url.scheme != "https" or url.username or url.password or url.port
                    or not (url.hostname or "").endswith((".douyinpic.com", ".byteimg.com", ".ibytedtos.com"))):
                cover = ""
        except ValueError:
            cover = ""
        source = ledger.to_dict()
        result.append({
            "id": note.video_id, "aweme_id": note.video_id, "title": note.video_title,
            "caption": str(meta.get("caption") or ""), "author_name": str(meta.get("author_name") or ""),
            "source_url": f"https://www.douyin.com/video/{note.video_id}", "cover_url": cover,
            "source_mode": ledger.source_mode, "source_rank": ledger.source_rank,
            "source_synced_at": source["source_synced_at"], "first_seen_at": source["first_seen_at"],
            "last_seen_at": source["last_seen_at"], "recorded_at": source["last_seen_at"],
            "published_at": "", "date": "", "duration": 0, "publish_timestamp": None,
            "media_type": "video", "media_url": "", "tags": [], "can_extract": True,
            "provider": "agent-sync", "metadata_only": True,
        })
    return result
