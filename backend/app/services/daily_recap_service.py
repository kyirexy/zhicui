"""昨日回顾：只读取知萃首次发现的来源记录，不推断平台点赞或收藏日期。"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.media_reference import canonical_source_url
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.library_sync import LibrarySyncRun
from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger
from app.services import local_douyin_library_service, platform_library_service

MAX_RECAP_ITEMS = 100
_MODES = ("collect", "like")


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=value.tzinfo or timezone.utc).astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _aware(value).isoformat().replace("+00:00", "Z")


def day_window(
    *, target_date: date | None = None, timezone_name: str = "Asia/Shanghai",
    reference_at: datetime | None = None,
) -> tuple[date, datetime, datetime]:
    """以当地两个午夜构建半开区间，兼容夏令时的 23/25 小时日期。"""
    try:
        local_tz = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise ValueError("请选择有效的时区") from exc
    anchor = _aware(reference_at or datetime.now(timezone.utc)).astimezone(local_tz)
    chosen = target_date or anchor.date() - timedelta(days=1)
    if not isinstance(chosen, date) or isinstance(chosen, datetime):
        raise ValueError("请选择有效的回顾日期")
    if chosen > anchor.date():
        raise ValueError("不能回顾未来日期")
    try:
        start = datetime.combine(chosen, time.min, local_tz)
        end = datetime.combine(chosen + timedelta(days=1), time.min, local_tz)
    except OverflowError as exc:
        raise ValueError("回顾日期超出允许范围") from exc
    return chosen, start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _platform(video_id: str) -> str:
    if re.fullmatch(r"[0-9]{5,32}", video_id):
        return "douyin"
    if re.fullmatch(r"BV[0-9A-Za-z]{3,30}", video_id):
        return "bilibili"
    return ""


def _source_meta(note: Note | None) -> dict[str, Any]:
    try:
        value = json.loads(note.ai_summary or "{}") if note else {}
    except (TypeError, json.JSONDecodeError):
        return {}
    meta = value.get("source_meta") if isinstance(value, dict) else None
    return meta if isinstance(meta, dict) else {}


def _initial_imports(
    db: Session, *, user_id: str, end: datetime,
) -> tuple[set[tuple[str, str, str]], set[tuple[str, str]]]:
    """首个成功快照的各分页属于历史导入；失败批次和重试时间不作为首次日期。"""
    initial_snapshots: dict[tuple[str, str], str] = {}
    initial_ids: set[tuple[str, str, str]] = set()
    runs = db.scalars(select(LibrarySyncRun).where(
        LibrarySyncRun.user_id == user_id,
        LibrarySyncRun.platform.in_(("douyin", "bilibili")),
        LibrarySyncRun.source_mode.in_(_MODES),
        LibrarySyncRun.status.in_(("succeeded", "partial")),
        LibrarySyncRun.accepted > 0,
        LibrarySyncRun.source_synced_at < end,
    ).order_by(LibrarySyncRun.source_synced_at.asc(), LibrarySyncRun.source_rank_offset.asc(), LibrarySyncRun.id.asc()))
    for run in runs.yield_per(100):
        key = (run.platform, run.source_mode)
        snapshot = _iso(run.source_synced_at)
        initial_snapshots.setdefault(key, snapshot)
        if initial_snapshots[key] != snapshot:
            continue
        try:
            values = json.loads(run.video_ids_json or "[]")
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(values, list):
            initial_ids.update(
                (run.platform, run.source_mode, value)
                for value in values
                if isinstance(value, str) and _platform(value) == run.platform
            )
    return initial_ids, set(initial_snapshots)


def get_daily_recap(
    db: Session, *, user_id: str, target_date: date | None = None,
    timezone_name: str = "Asia/Shanghai", limit: int = MAX_RECAP_ITEMS,
    reference_at: datetime | None = None,
) -> dict[str, Any]:
    if not str(user_id or "").strip():
        raise ValueError("缺少回顾用户")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_RECAP_ITEMS:
        raise ValueError(f"回顾条数必须为 1–{MAX_RECAP_ITEMS}")
    chosen, start, end = day_window(
        target_date=target_date, timezone_name=timezone_name, reference_at=reference_at,
    )
    hidden = select(LibraryHiddenItem.aweme_id).where(LibraryHiddenItem.user_id == user_id)
    ledgers = db.scalars(select(VideoSourceLedger).where(
        VideoSourceLedger.user_id == user_id,
        VideoSourceLedger.source_mode.in_(_MODES),
        VideoSourceLedger.first_seen_at >= start,
        VideoSourceLedger.first_seen_at < end,
        VideoSourceLedger.video_id.not_in(hidden),
    )).all()
    grouped: dict[str, list[VideoSourceLedger]] = {}
    for row in ledgers:
        if _platform(row.video_id):
            grouped.setdefault(row.video_id, []).append(row)
    video_ids = list(grouped)
    snapshots: dict[str, DouyinLocalLibraryItem] = {}
    notes: dict[str, Note] = {}
    # 分块避免大量同步时超过 SQLite 参数限制；不读取正文到接口响应。
    for offset in range(0, len(video_ids), 400):
        chunk = video_ids[offset:offset + 400]
        snapshots.update({row.video_id: row for row in db.scalars(
            select(DouyinLocalLibraryItem).where(
                DouyinLocalLibraryItem.user_id == user_id,
                DouyinLocalLibraryItem.video_id.in_(chunk),
            )
        )})
        for note in db.scalars(select(Note).where(
            Note.user_id == user_id, Note.video_id.in_(chunk),
        ).order_by(Note.created_at.desc(), Note.id.asc())):
            previous = notes.get(note.video_id)
            if previous is None or (not (previous.transcript_raw or "").strip() and (note.transcript_raw or "").strip()):
                notes[note.video_id] = note
    initial_ids, known_initial_modes = _initial_imports(db, user_id=user_id, end=end)
    items: list[dict[str, Any]] = []
    unknown_initial_count = 0
    for video_id, memberships in grouped.items():
        platform = _platform(video_id)
        note = notes.get(video_id)
        snapshot = snapshots.get(video_id)
        meta = _source_meta(note)
        ready = bool(note and (note.transcript_raw or "").strip())
        if ready and platform == "bilibili":
            ready = platform_library_service._is_complete_bilibili_note(note)
        # 未通过同步资料质量门槛的占位条目不能在首页重新出现。
        if snapshot is not None and (
            not snapshot.available or not local_douyin_library_service.is_displayable_snapshot(snapshot)
        ):
            continue
        if snapshot is None and note is None:
            continue
        if platform == "bilibili" and (note is None or platform_library_service.media_platform(note) != platform):
            continue
        modes = [mode for mode in _MODES if any(row.source_mode == mode for row in memberships)]
        first_seen = min(_aware(row.first_seen_at) for row in memberships)
        initial = any((platform, mode, video_id) in initial_ids for mode in modes)
        initial_known = all((platform, mode) in known_initial_modes for mode in modes)
        if not initial_known:
            unknown_initial_count += 1
        raw_cover = snapshot.cover_url if snapshot else str(meta.get("cover_url") or "")
        cover = (
            platform_library_service.public_cover_url(note.id)
            if note and raw_cover and platform == "bilibili" else raw_cover
        )
        items.append({
            "id": f"{platform}:{video_id}", "video_id": video_id, "platform": platform,
            "note_id": note.id if note else None,
            "title": (snapshot.title if snapshot else note.video_title) or "视频资料",
            "author_name": snapshot.author_name if snapshot else str(meta.get("author_name") or ""),
            "cover_url": cover,
            "source_url": canonical_source_url(video_id=video_id, platform=platform),
            "source_modes": modes, "first_seen_at": _iso(first_seen),
            "discovered_at": _iso(first_seen),
            "transcript_ready": ready, "needs_extraction": not ready,
            "ai_initialized": bool(note and note.ai_initialized),
            "can_extract": snapshot is not None or note is not None,
            "initial_import": initial, "initial_import_known": initial_known,
            "_rank": min((row.source_rank for row in memberships if row.source_rank is not None), default=2_147_483_647),
        })
    items.sort(key=lambda item: (-datetime.fromisoformat(item["first_seen_at"].replace("Z", "+00:00")).timestamp(), item["_rank"], item["id"]))
    for item in items:
        item.pop("_rank", None)
    selected = items[:limit]
    initial_count = sum(item["initial_import"] for item in items)
    message = "按知萃首次同步记录回顾点赞与收藏，平台未提供实际操作日期。"
    if initial_count:
        message += f"其中 {initial_count} 条来自首次历史导入。"
    if unknown_initial_count:
        message += "部分旧记录无法区分是否为首次历史导入。"
    return {
        "date": chosen.isoformat(), "timezone": timezone_name,
        "time_basis": "first_discovered", "time_basis_label": "按知萃首次同步记录",
        "message": message, "total": len(items),
        "like_count": sum("like" in item["source_modes"] for item in items),
        "collect_count": sum("collect" in item["source_modes"] for item in items),
        "ready_count": sum(item["transcript_ready"] for item in items),
        "pending_count": sum(not item["transcript_ready"] for item in items),
        "initial_import_count": initial_count,
        "initial_import_unknown_count": unknown_initial_count,
        "items": selected, "preview": selected[:3], "has_more": len(items) > limit,
        "ready_note_ids": [item["note_id"] for item in selected if item["transcript_ready"]],
    }
