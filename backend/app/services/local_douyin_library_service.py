"""Persist and read public Douyin metadata discovered on the user's device."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.video_source_ledger import VideoSourceLedger
from app.services import note_service, video_source_ledger_service

MAX_LOCAL_SYNC_ITEMS = 100
_VIDEO_ID_PATTERN = re.compile(r"^[0-9]{5,32}$")
_CANONICAL_PATH_PATTERN = re.compile(r"^/video/([0-9]{5,32})/?$")
_SOURCE_MODES = {"like", "collect", "post"}
_FORBIDDEN_KEYS = {
    "cookie",
    "cookies",
    "headers",
    "local_storage",
    "localstorage",
    "media_url",
    "download_url",
    "play_url",
    "profile_path",
    "signature",
    "signed_url",
}
_COVER_HOST_SUFFIXES = (
    ".douyinpic.com",
    ".byteimg.com",
    ".ibytedtos.com",
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _bounded_text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _safe_https_url(value: object, *, hosts: set[str] | None = None) -> str:
    raw = _bounded_text(value, 2048)
    if not raw:
        return ""
    parsed = urlsplit(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise ValueError("本地同步包含不安全的 URL")
    if hosts is not None and host not in hosts:
        raise ValueError("本地同步包含非抖音作品链接")
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))


def _safe_cover_url(value: object) -> str:
    url = _safe_https_url(value)
    host = (urlsplit(url).hostname or "").lower()
    if not any(host.endswith(suffix) for suffix in _COVER_HOST_SUFFIXES):
        raise ValueError("本地同步包含非抖音封面地址")
    return url


def normalize_video_id(value: object, source_url: object) -> tuple[str, str]:
    clean_id = _bounded_text(value, 32)
    raw_url = _safe_https_url(
        source_url,
        hosts={"www.douyin.com", "douyin.com"},
    )
    parsed = urlsplit(raw_url)
    match = _CANONICAL_PATH_PATTERN.fullmatch(parsed.path)
    url_id = match.group(1) if match else ""
    if not _VIDEO_ID_PATTERN.fullmatch(clean_id) or clean_id != url_id:
        raise ValueError("抖音作品标识或 canonical URL 无效")
    return clean_id, f"https://www.douyin.com/video/{clean_id}"


def _normalize_published_at(value: object) -> str:
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return ""
    raw = _bounded_text(value, 64)
    if not raw:
        return ""
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_item(raw: dict[str, Any], *, fallback_rank: int) -> dict[str, Any]:
    unexpected_sensitive = _FORBIDDEN_KEYS.intersection(
        str(key or "").strip().lower() for key in raw
    )
    if unexpected_sensitive:
        raise ValueError("本地同步不得包含 Cookie、签名媒体地址或本机路径")
    video_id, source_url = normalize_video_id(raw.get("video_id"), raw.get("source_url"))
    duration = int(raw.get("duration_seconds") or 0)
    if duration < 0 or duration > 24 * 60 * 60:
        raise ValueError("抖音作品时长无效")
    rank_value = raw.get("source_rank", fallback_rank)
    rank = int(rank_value) if rank_value is not None else fallback_rank
    if rank < 0 or rank >= MAX_LOCAL_SYNC_ITEMS:
        raise ValueError("抖音来源顺序无效")
    cover_url = _safe_cover_url(raw.get("cover_url")) if raw.get("cover_url") else ""
    caption = _bounded_text(raw.get("caption"), 20_000)
    title = _bounded_text(raw.get("title"), 500) or caption[:120] or "抖音作品"
    return {
        "video_id": video_id,
        "title": title,
        "source_url": source_url,
        "cover_url": cover_url,
        "caption": caption,
        "author_name": _bounded_text(raw.get("author_name"), 200),
        "published_at": _normalize_published_at(raw.get("published_at")),
        "duration_seconds": duration,
        "source_rank": rank,
        "metadata_degraded": False,
    }


def _discard_repeated_page_metadata(items: list[dict[str, Any]]) -> None:
    """Drop page-wide text accidentally attached to several visible cards."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        signature = str(item.get("caption") or item.get("title") or "").strip()
        if len(signature) >= 32:
            grouped[signature].append(item)
    for repeated in grouped.values():
        if len(repeated) < 3:
            continue
        if not all(
            not item.get("author_name")
            and not item.get("published_at")
            and int(item.get("duration_seconds") or 0) == 0
            for item in repeated
        ):
            continue
        for item in repeated:
            item["discarded_title"] = item.get("title") or ""
            item["discarded_caption"] = item.get("caption") or ""
            item["title"] = "抖音作品"
            item["caption"] = ""
            item["metadata_degraded"] = True


def _is_displayable_snapshot(value: dict[str, Any] | DouyinLocalLibraryItem) -> bool:
    """Keep empty discovery placeholders out of the user's visible library."""
    if isinstance(value, dict):
        read = value.get
    else:
        read = lambda key, default=None: getattr(value, key, default)
    title = _bounded_text(read("title"), 500)
    caption = _bounded_text(read("caption"), 20_000)
    has_meaningful_title = bool(title and title != "抖音作品")
    has_public_metadata = bool(
        _bounded_text(read("cover_url"), 2048)
        or _bounded_text(read("author_name"), 200)
        or _bounded_text(read("published_at"), 64)
        or int(read("duration_seconds", 0) or 0) > 0
    )
    return bool(caption or has_meaningful_title or has_public_metadata)


def ingest_items(
    db: Session,
    *,
    user_id: str,
    source_mode: str,
    items: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    mode = video_source_ledger_service.normalize_source_mode(source_mode)
    if mode not in _SOURCE_MODES:
        raise ValueError("抖音本地同步来源无效")
    values = list(items)
    if not 1 <= len(values) <= MAX_LOCAL_SYNC_ITEMS:
        raise ValueError("抖音本地同步每次需要提交 1–100 条作品")

    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, value in enumerate(values):
        item = normalize_item(value, fallback_rank=index)
        if item["video_id"] in seen:
            continue
        seen.add(item["video_id"])
        normalized.append(item)
    if not normalized:
        raise ValueError("抖音本地同步没有可登记的作品")
    _discard_repeated_page_metadata(normalized)

    existing_rows = db.execute(
        select(DouyinLocalLibraryItem).where(
            DouyinLocalLibraryItem.user_id == user_id,
            DouyinLocalLibraryItem.video_id.in_([item["video_id"] for item in normalized]),
        )
    ).scalars().all()
    existing_by_id = {row.video_id: row for row in existing_rows}
    note_map = note_service.get_notes_by_video_ids(
        db,
        [item["video_id"] for item in normalized],
        user_id=user_id,
    )
    now = _utcnow()
    created = 0
    try:
        for item in normalized:
            row = existing_by_id.get(item["video_id"])
            if row is None:
                row = DouyinLocalLibraryItem(
                    user_id=user_id,
                    first_seen_at=now,
                    available=_is_displayable_snapshot(item),
                    **{
                        key: value
                        for key, value in item.items()
                        if key in {
                            "video_id", "title", "source_url", "cover_url",
                            "caption", "author_name", "published_at",
                            "duration_seconds",
                        }
                    },
                )
                db.add(row)
                created += 1
            else:
                if item["metadata_degraded"]:
                    if row.title == item.get("discarded_title"):
                        row.title = "抖音作品"
                    if row.caption == item.get("discarded_caption"):
                        row.caption = ""
                else:
                    row.title = item["title"]
                    row.caption = item["caption"] or row.caption
                row.source_url = item["source_url"]
                row.cover_url = item["cover_url"] or row.cover_url
                row.author_name = item["author_name"] or row.author_name
                row.published_at = item["published_at"] or row.published_at
                row.duration_seconds = item["duration_seconds"] or row.duration_seconds
                row.available = _is_displayable_snapshot(row)
            row.last_seen_at = now
            row.updated_at = now
            note = note_map.get(item["video_id"])
            video_source_ledger_service.upsert_source(
                db,
                user_id=user_id,
                video_id=item["video_id"],
                source_mode=mode,
                source_rank=item["source_rank"],
                note_id=note.id if note else None,
                observed_at=now,
                source_synced_at=now,
                commit=False,
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        "accepted": len(normalized),
        "created": created,
        "reused": len(normalized) - created,
        "source_mode": mode,
        "source_synced_at": now.isoformat().replace("+00:00", "Z"),
        "video_ids": [item["video_id"] for item in normalized],
    }


def list_items(
    db: Session,
    *,
    user_id: str,
    source_mode: str | None = None,
) -> list[dict[str, Any]]:
    mode = (
        video_source_ledger_service.normalize_source_mode(source_mode)
        if source_mode
        else None
    )
    rows = db.execute(
        select(VideoSourceLedger).where(
            VideoSourceLedger.user_id == user_id,
            *([VideoSourceLedger.source_mode == mode] if mode else []),
        )
    ).scalars().all()
    rows.sort(
        key=lambda row: (
            row.source_rank is None,
            row.source_rank if row.source_rank is not None else MAX_LOCAL_SYNC_ITEMS + 1,
            -row.last_seen_at.timestamp(),
        )
    )
    snapshots = db.execute(
        select(DouyinLocalLibraryItem).where(
            DouyinLocalLibraryItem.user_id == user_id,
            DouyinLocalLibraryItem.available.is_(True),
        )
    ).scalars().all()
    snapshot_by_id = {
        row.video_id: row
        for row in snapshots
        if _is_displayable_snapshot(row)
    }
    result: list[dict[str, Any]] = []
    emitted: set[str] = set()
    for ledger in rows:
        if ledger.video_id in emitted:
            continue
        snapshot = snapshot_by_id.get(ledger.video_id)
        if snapshot is None:
            continue
        emitted.add(ledger.video_id)
        result.append(snapshot.to_library_item(
            source_mode=ledger.source_mode,
            source_rank=ledger.source_rank,
            source_synced_at=ledger.source_synced_at,
        ))
    return result


def get_item(db: Session, *, user_id: str, video_id: str) -> dict[str, Any] | None:
    clean_id = str(video_id or "").strip()
    if not _VIDEO_ID_PATTERN.fullmatch(clean_id):
        return None
    snapshot = db.execute(
        select(DouyinLocalLibraryItem).where(
            DouyinLocalLibraryItem.user_id == user_id,
            DouyinLocalLibraryItem.video_id == clean_id,
            DouyinLocalLibraryItem.available.is_(True),
        )
    ).scalar_one_or_none()
    if snapshot is None or not _is_displayable_snapshot(snapshot):
        return None
    ledgers = db.execute(
        select(VideoSourceLedger)
        .where(
            VideoSourceLedger.user_id == user_id,
            VideoSourceLedger.video_id == clean_id,
        )
        .order_by(VideoSourceLedger.last_seen_at.desc())
    ).scalars().all()
    ledger = ledgers[0] if ledgers else None
    return snapshot.to_library_item(
        source_mode=ledger.source_mode if ledger else "unknown",
        source_rank=ledger.source_rank if ledger else None,
        source_synced_at=ledger.source_synced_at if ledger else snapshot.last_seen_at,
    )


def get_cover_url(db: Session, *, user_id: str, video_id: str) -> str:
    clean_id = str(video_id or "").strip()
    if not _VIDEO_ID_PATTERN.fullmatch(clean_id):
        return ""
    value = db.execute(
        select(DouyinLocalLibraryItem.cover_url).where(
            DouyinLocalLibraryItem.user_id == user_id,
            DouyinLocalLibraryItem.video_id == clean_id,
            DouyinLocalLibraryItem.available.is_(True),
        )
    ).scalar_one_or_none()
    try:
        return _safe_cover_url(value) if value else ""
    except ValueError:
        return ""
