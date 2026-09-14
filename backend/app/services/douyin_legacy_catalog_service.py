"""旧目录只补归档一次，首屏读取本地资料时不等待旧连接器。"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.douyin_account_binding import DouyinAccountBinding
from app.models.douyin_legacy_catalog import DouyinLegacyCatalog
from app.models.user import User
from app.services import douyin_library, local_douyin_library_service

logger = logging.getLogger(__name__)
_RETRY_DELAY = timedelta(minutes=5)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: object) -> str:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        parsed = parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)
        if parsed <= _now():
            return parsed.isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        pass
    # 无原始时间的历史条目不能冒充本轮新同步。
    return "1970-01-01T00:00:00Z"


def _public_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not local_douyin_library_service.is_displayable_snapshot(raw):
        return None
    video_id = str(raw.get("aweme_id") or "").strip()
    media_type = str(raw.get("media_type") or "video")
    if media_type not in {"video", "gallery"}:
        return None
    try:
        # 复用作品身份和封面域名检查，仅接收明确列出的公开字段。
        normalized = local_douyin_library_service.normalize_item({
            "video_id": video_id,
            "source_url": f"https://www.douyin.com/video/{video_id}",
            "title": raw.get("title"), "caption": raw.get("caption"),
            "author_name": raw.get("author_name"), "cover_url": raw.get("cover_url"),
            "published_at": raw.get("published_at") or raw.get("publish_timestamp") or raw.get("date"),
            "duration_seconds": raw.get("duration") or 0,
        }, fallback_rank=0)
    except (TypeError, ValueError, OverflowError):
        return None
    mode = str(raw.get("source_mode") or "unknown")
    if mode not in {"like", "collect", "post", "unknown"}:
        return None
    observed = _timestamp(raw.get("first_seen_at") or raw.get("recorded_at") or raw.get("source_synced_at"))
    published = normalized["published_at"]
    return {
        "id": video_id, "aweme_id": video_id,
        "title": normalized["title"], "caption": normalized["caption"],
        "author_name": normalized["author_name"], "cover_url": normalized["cover_url"],
        "source_url": f"https://www.douyin.com/{'note' if media_type == 'gallery' else 'video'}/{video_id}",
        "published_at": published, "duration": normalized["duration_seconds"],
        "date": published[:10],
        "publish_timestamp": int(datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp()) if published else None,
        "tags": [str(tag).strip()[:80] for tag in (raw.get("tags") or []) if isinstance(tag, str)][:12],
        "media_type": media_type, "gallery_count": min(30, len(raw.get("gallery_images") or [])),
        "source_mode": mode, "source_rank": None, "source_synced_at": observed,
        "first_seen_at": observed, "last_seen_at": observed, "recorded_at": observed,
        "can_extract": media_type == "video", "provider": "legacy-archive",
    }


def _row(db: Session, user_id: str, binding_id: str) -> DouyinLegacyCatalog | None:
    return db.execute(select(DouyinLegacyCatalog).where(
        DouyinLegacyCatalog.user_id == user_id, DouyinLegacyCatalog.binding_id == binding_id,
    )).scalar_one_or_none()


def list_items(db: Session, *, user_id: str, binding_id: str, mode: str | None = None) -> list[dict]:
    row = _row(db, user_id, binding_id)
    if row is None:
        return []
    return [item for item in json.loads(row.items_json) if mode is None or item["source_mode"] == mode]


def get_item(db: Session, *, user_id: str, binding_id: str, video_id: str) -> dict | None:
    return next((item for item in list_items(db, user_id=user_id, binding_id=binding_id)
                 if item["aweme_id"] == video_id), None)


def recovery_pending(db: Session, *, user_id: str, binding_id: str) -> bool:
    row = _row(db, user_id, binding_id)
    return row is not None and row.completed_at is None


def recovery_completed(db: Session, *, user_id: str, binding_id: str) -> bool:
    row = _row(db, user_id, binding_id)
    return row is not None and row.completed_at is not None


def invalidate_recovery(db: Session, *, user_id: str, binding_id: str) -> None:
    row = _row(db, user_id, binding_id)
    if row is not None:
        row.completed_at = None
        row.next_attempt_at = None
        db.commit()


def archive_items(
    db: Session, *, user_id: str, binding_id: str, items: list[dict], complete: bool = True,
    refresh_existing: bool = False,
) -> None:
    # 与本地同步相同的用户行锁；旧快照只补目录，不改台账、水位或新元数据。
    db.execute(select(User.id).where(User.id == user_id).with_for_update()).scalar_one()
    row = _row(db, user_id, binding_id)
    if row is None:
        row = DouyinLegacyCatalog(user_id=user_id, binding_id=binding_id, items_json="[]")
        db.add(row)
    archived = {(item["source_mode"], item["aweme_id"]): item for item in json.loads(row.items_json)}
    for raw in items:
        item = _public_item(raw)
        if item is not None:
            identity = (item["source_mode"], item["aweme_id"])
            previous = archived.get(identity)
            if previous is not None and refresh_existing:
                # 显式刷新可更新标题、封面等；历史观察时间和非可信排名不能变成新同步。
                for key in ("first_seen_at", "last_seen_at", "recorded_at", "source_synced_at"):
                    item[key] = previous[key]
                archived[identity] = item
            else:
                archived.setdefault(identity, item)
    row.items_json = json.dumps(list(archived.values()), ensure_ascii=False)
    if complete:
        row.completed_at = _now()
        row.next_attempt_at = None
    db.commit()


def claim_recovery(db: Session, *, user_id: str, binding_id: str) -> bool:
    db.execute(select(User.id).where(User.id == user_id).with_for_update()).scalar_one()
    row = _row(db, user_id, binding_id)
    now = _now()
    if row is not None and (row.completed_at is not None or (
        row.next_attempt_at is not None
        and row.next_attempt_at.replace(tzinfo=row.next_attempt_at.tzinfo or timezone.utc) > now
    )):
        db.commit()
        return False
    if row is None:
        row = DouyinLegacyCatalog(user_id=user_id, binding_id=binding_id, items_json="[]")
        db.add(row)
    # 进程中断也会在期限后重试；请求之间不重复发起相同后台补归档。
    row.next_attempt_at = now + _RETRY_DELAY
    db.commit()
    return True


def recover(user_id: str, binding_id: str) -> None:
    try:
        with SessionLocal() as db:
            binding = db.execute(select(DouyinAccountBinding).where(
                DouyinAccountBinding.id == binding_id, DouyinAccountBinding.user_id == user_id,
            )).scalar_one_or_none()
            if binding is None:
                return
            scope = binding.session_scope
        # 等待旧连接器时不持有数据库连接；不会刷新、请求抖音私有列表。
        items = douyin_library.list_items(scope, binding_id, limit=0, preserve_sources=True)
        with SessionLocal() as db:
            binding = db.execute(select(DouyinAccountBinding).where(
                DouyinAccountBinding.id == binding_id, DouyinAccountBinding.user_id == user_id,
                DouyinAccountBinding.session_scope == scope,
            )).scalar_one_or_none()
            if binding is not None:
                archive_items(db, user_id=user_id, binding_id=binding_id, items=items)
    except Exception as exc:
        # 已有目录仍可用，未完成标记会允许下一次页面访问稍后重试。
        logger.info("Legacy Douyin archive deferred error_type=%s", type(exc).__name__)
