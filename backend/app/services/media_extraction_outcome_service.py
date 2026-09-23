"""保存确认无音频的结果；不创建空笔记，也不把网络故障当作内容状态。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.models.media_extraction_outcome import MediaExtractionOutcome


def no_audio_result(*, already_existed: bool = False) -> dict[str, Any]:
    return {
        "state": "no_audio", "transcript_status": "no_audio",
        "transcript_source": "no-audio", "transcript_notice": "无音频",
        "can_extract": False, "transcript_chars": 0, "ai_initialized": False,
        "already_existed": already_existed,
    }


def has_no_audio(db, *, user_id: str, video_id: str, platform: str = "douyin") -> bool:
    row = db.get(MediaExtractionOutcome, (user_id, platform, video_id))
    return row is not None and row.status == "no_audio"


def record_no_audio(db, *, user_id: str, video_id: str, reason: str,
                    platform: str = "douyin") -> None:
    row = db.get(MediaExtractionOutcome, (user_id, platform, video_id))
    if row is None:
        row = MediaExtractionOutcome(user_id=user_id, platform=platform, video_id=video_id)
        db.add(row)
    row.status = "no_audio"
    row.reason = reason
    row.updated_at = datetime.now(timezone.utc)
    db.commit()


def annotate_items(db, *, user_id: str, items: list[dict[str, Any]],
                   platform: str = "douyin") -> None:
    items = [item for item in items if item.get("platform", platform) == platform]
    ids = [str(item.get("aweme_id") or item.get("video_id") or item.get("id") or "") for item in items]
    if not ids:
        return
    no_audio_ids = {
        row.video_id for row in db.query(MediaExtractionOutcome.video_id).filter(
            MediaExtractionOutcome.user_id == user_id,
            MediaExtractionOutcome.platform == platform,
            MediaExtractionOutcome.video_id.in_(ids),
            MediaExtractionOutcome.status == "no_audio",
        ).all()
    }
    for item in items:
        # 后续通过其他入口获得了真实文稿时，文稿优先于旧的无音频记录。
        if int(item.get("transcript_chars") or 0) > 0 or item.get("transcript_ready"):
            continue
        if str(item.get("aweme_id") or item.get("video_id") or item.get("id") or "") in no_audio_ids:
            item.update(no_audio_result(already_existed=True))
            item["needs_extraction"] = False
