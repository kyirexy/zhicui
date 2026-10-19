"""将已验证的 B站文稿关联到当前用户已有的博主目录。"""

from __future__ import annotations

import json
import re

from sqlalchemy import inspect, or_
from sqlalchemy.orm import Session, object_session

from app.models.creator_sync import CreatorSource, CreatorSourceItem
from app.models.note import Note


def link_ready_bilibili_note(db: Session, *, user_id: str, note: Note) -> int:
    """暂存同账号、同作品的目录关联，由调用方与文稿一起提交或回滚。

    未完成转写的导入不能提前设置 note_id，因为目录以此判断 imported。
    不创建博主、目录或同步记录，也不改变同步计数、删除标记和质量结论。
    """
    if (
        not user_id
        or object_session(note) is not db
        or not inspect(note).persistent
        or note.user_id != user_id
        or not re.fullmatch(r"BV[0-9A-Za-z]{10}", note.video_id or "")
        or not (note.transcript_raw or "").strip()
    ):
        return 0
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (TypeError, ValueError):
        return 0
    meta = payload.get("source_meta") if isinstance(payload, dict) else None
    if (
        not isinstance(meta, dict)
        or meta.get("platform") != "bilibili"
        or meta.get("speech_ready") is not True
        or str(meta.get("transcript_source") or "").strip() in {"", "pending", "caption-only"}
        or meta.get("transcript_status") not in (None, "", "ready")
    ):
        return 0

    rows = (
        db.query(CreatorSourceItem)
        .join(CreatorSource, CreatorSource.id == CreatorSourceItem.source_id)
        .filter(
            CreatorSourceItem.user_id == user_id,
            CreatorSourceItem.platform == "bilibili",
            CreatorSourceItem.external_id == note.video_id,
            CreatorSource.user_id == user_id,
            CreatorSource.platform == "bilibili",
            CreatorSource.status == "active",
            CreatorSourceItem.removed_at.is_(None),
            CreatorSourceItem.state != "removed",
            CreatorSourceItem.is_available.is_(True),
            CreatorSourceItem.transcription_blocked.is_(False),
            CreatorSourceItem.metadata_quality != "quarantined",
            or_(CreatorSourceItem.note_id.is_(None), CreatorSourceItem.note_id == note.id),
        )
        .order_by(CreatorSourceItem.id)
        .with_for_update(of=CreatorSourceItem)
        .all()
    )
    changed = 0
    for item in rows:
        if item.note_id == note.id and item.state == "ready" and not item.error_code:
            continue
        item.note_id = note.id
        item.state = "ready"
        item.error_code = ""
        changed += 1
    return changed
