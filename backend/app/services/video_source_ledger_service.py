"""Concurrency-safe persistence for the user video-source ledger."""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger

_SOURCE_MODES = {"like", "collect", "post", "unknown"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_source_mode(value: object) -> str:
    mode = str(value or "").strip().lower()
    if mode == "collection":
        mode = "collect"
    return mode if mode in _SOURCE_MODES else "unknown"


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _ensure_aware(value)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return _ensure_aware(datetime.fromisoformat(raw.replace("Z", "+00:00")))
    except ValueError:
        return None


def legacy_source_meta(note: Note | None) -> dict[str, Any]:
    """Read old source metadata without mutating the Note JSON."""
    if note is None or not note.ai_summary:
        return {}
    try:
        payload = json.loads(note.ai_summary)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    meta = payload.get("source_meta")
    return dict(meta) if isinstance(meta, dict) else {}


def _validate_note_owner(
    db: Session,
    *,
    user_id: str,
    note_id: str | None,
) -> str | None:
    if not note_id:
        return None
    owned_note_id = db.execute(
        select(Note.id).where(Note.id == note_id, Note.user_id == user_id)
    ).scalar_one_or_none()
    if owned_note_id is None:
        raise ValueError("来源台账不能关联其他用户的知识记录")
    return owned_note_id


def _upsert_statement(
    db: Session,
    values: dict[str, Any],
):
    """Build a dialect-native UPSERT with monotonic observation times."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        insert_stmt = postgresql_insert(VideoSourceLedger).values(**values)
        older_first_seen = func.least(
            VideoSourceLedger.first_seen_at,
            insert_stmt.excluded.first_seen_at,
        )
        newer_last_seen = func.greatest(
            VideoSourceLedger.last_seen_at,
            insert_stmt.excluded.last_seen_at,
        )
        newer_synced = func.greatest(
            VideoSourceLedger.source_synced_at,
            insert_stmt.excluded.source_synced_at,
        )
    elif dialect == "sqlite":
        insert_stmt = sqlite_insert(VideoSourceLedger).values(**values)
        older_first_seen = func.min(
            VideoSourceLedger.first_seen_at,
            insert_stmt.excluded.first_seen_at,
        )
        newer_last_seen = func.max(
            VideoSourceLedger.last_seen_at,
            insert_stmt.excluded.last_seen_at,
        )
        newer_synced = func.max(
            VideoSourceLedger.source_synced_at,
            insert_stmt.excluded.source_synced_at,
        )
    else:
        raise RuntimeError(
            f"来源台账暂不支持数据库方言：{dialect}"
        )

    return insert_stmt.on_conflict_do_update(
        index_elements=["user_id", "video_id", "source_mode"],
        set_={
            "note_id": func.coalesce(
                insert_stmt.excluded.note_id,
                VideoSourceLedger.note_id,
            ),
            "source_rank": case(
                (
                    insert_stmt.excluded.last_seen_at
                    >= VideoSourceLedger.last_seen_at,
                    insert_stmt.excluded.source_rank,
                ),
                else_=VideoSourceLedger.source_rank,
            ),
            "first_seen_at": older_first_seen,
            "last_seen_at": newer_last_seen,
            "source_synced_at": newer_synced,
        },
    )


def upsert_source(
    db: Session,
    *,
    user_id: str,
    video_id: str,
    source_mode: str,
    source_rank: int | None = None,
    note_id: str | None = None,
    observed_at: datetime | None = None,
    first_seen_at: datetime | None = None,
    source_synced_at: datetime | None = None,
    commit: bool = True,
) -> VideoSourceLedger:
    """Atomically insert or refresh one source membership."""
    clean_user_id = str(user_id or "").strip()
    clean_video_id = str(video_id or "").strip()
    if not clean_user_id or not clean_video_id:
        raise ValueError("来源台账缺少用户或视频标识")

    clean_note_id = _validate_note_owner(
        db,
        user_id=clean_user_id,
        note_id=str(note_id or "").strip() or None,
    )
    seen_at = _ensure_aware(observed_at or _utcnow())
    first_seen = _ensure_aware(first_seen_at or seen_at)
    if first_seen > seen_at:
        first_seen = seen_at
    synced_at = _ensure_aware(source_synced_at or seen_at)
    mode = normalize_source_mode(source_mode)
    rank = source_rank if isinstance(source_rank, int) and source_rank >= 0 else None

    db.execute(_upsert_statement(db, {
        "user_id": clean_user_id,
        "note_id": clean_note_id,
        "video_id": clean_video_id,
        "source_mode": mode,
        "source_rank": rank,
        "first_seen_at": first_seen,
        "last_seen_at": seen_at,
        "source_synced_at": synced_at,
    }))
    if commit:
        db.commit()
    else:
        db.flush()

    ledger = db.execute(
        select(VideoSourceLedger).where(
            VideoSourceLedger.user_id == clean_user_id,
            VideoSourceLedger.video_id == clean_video_id,
            VideoSourceLedger.source_mode == mode,
        )
    ).scalar_one()
    return ledger


def upsert_item(
    db: Session,
    *,
    user_id: str,
    item: dict[str, Any],
    note_id: str | None = None,
    observed_at: datetime | None = None,
    first_seen_at: datetime | None = None,
    source_synced_at: datetime | None = None,
    commit: bool = True,
) -> VideoSourceLedger:
    video_id = str(item.get("aweme_id") or item.get("video_id") or "").strip()
    item_synced_at = (
        source_synced_at
        or _parse_timestamp(item.get("source_synced_at"))
        or observed_at
    )
    return upsert_source(
        db,
        user_id=user_id,
        video_id=video_id,
        source_mode=normalize_source_mode(item.get("source_mode")),
        source_rank=item.get("source_rank"),
        note_id=note_id,
        observed_at=observed_at,
        first_seen_at=first_seen_at,
        source_synced_at=item_synced_at,
        commit=commit,
    )


def upsert_items(
    db: Session,
    *,
    user_id: str,
    items: Iterable[dict[str, Any]],
    notes_by_video_id: dict[str, Note] | None = None,
    observed_at: datetime | None = None,
    source_synced_at: datetime | None = None,
) -> int:
    """Upsert a bounded sync result in one transaction."""
    clean_items: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    for item in items:
        video_id = str(item.get("aweme_id") or item.get("video_id") or "").strip()
        mode = normalize_source_mode(item.get("source_mode"))
        key = (video_id, mode)
        if not video_id or key in seen_keys:
            continue
        seen_keys.add(key)
        clean_items.append(item)

    observed = _ensure_aware(observed_at or _utcnow())
    try:
        for item in clean_items:
            video_id = str(
                item.get("aweme_id") or item.get("video_id") or ""
            ).strip()
            note = (notes_by_video_id or {}).get(video_id)
            legacy_meta = legacy_source_meta(note)
            item_mode = normalize_source_mode(item.get("source_mode"))
            legacy_mode = normalize_source_mode(
                legacy_meta.get("source_mode")
            )
            legacy_first_seen = (
                _parse_timestamp(legacy_meta.get("first_seen_at"))
                if item_mode in {"collect", "like", "post"}
                and legacy_mode == item_mode
                else None
            )
            upsert_item(
                db,
                user_id=user_id,
                item=item,
                note_id=note.id if note is not None else None,
                observed_at=observed,
                first_seen_at=legacy_first_seen or observed,
                source_synced_at=source_synced_at,
                commit=False,
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return len(clean_items)


def link_note(
    db: Session,
    *,
    user_id: str,
    video_id: str,
    note_id: str,
    commit: bool = True,
) -> int:
    """Attach every source membership for a video to one owned Note."""
    clean_note_id = _validate_note_owner(
        db,
        user_id=user_id,
        note_id=note_id,
    )
    result = db.execute(
        update(VideoSourceLedger)
        .where(
            VideoSourceLedger.user_id == user_id,
            VideoSourceLedger.video_id == video_id,
        )
        .values(note_id=clean_note_id)
    )
    if commit:
        db.commit()
    else:
        db.flush()
    return int(result.rowcount or 0)


def list_by_video_ids(
    db: Session,
    *,
    user_id: str,
    video_ids: Iterable[str],
) -> dict[str, list[VideoSourceLedger]]:
    """Read source memberships without mutating Notes or the ledger."""
    clean_ids = list(dict.fromkeys(
        str(video_id or "").strip()
        for video_id in video_ids
        if str(video_id or "").strip()
    ))
    if not clean_ids:
        return {}
    rows = db.execute(
        select(VideoSourceLedger)
        .where(
            VideoSourceLedger.user_id == user_id,
            VideoSourceLedger.video_id.in_(clean_ids),
        )
        .order_by(
            VideoSourceLedger.video_id,
            VideoSourceLedger.last_seen_at.desc(),
        )
    ).scalars().all()
    result: dict[str, list[VideoSourceLedger]] = {}
    for row in rows:
        result.setdefault(row.video_id, []).append(row)
    return result


def preferred_for_item(
    ledgers: Iterable[VideoSourceLedger],
    source_mode: object,
) -> VideoSourceLedger | None:
    """Pick the matching membership, otherwise the most recently observed."""
    rows = list(ledgers)
    wanted = normalize_source_mode(source_mode)
    for row in rows:
        if row.source_mode == wanted:
            return row
    return rows[0] if rows else None


def source_meta_for_note(
    db: Session,
    note: Note,
) -> dict[str, Any]:
    """Return ledger-first source fields with legacy JSON as a fallback."""
    meta = legacy_source_meta(note)
    rows = list_by_video_ids(
        db,
        user_id=note.user_id,
        video_ids=[note.video_id],
    ).get(note.video_id, [])
    if not rows:
        return meta
    ledger = rows[0]
    ledger_data = ledger.to_dict()
    return {
        **meta,
        "source_mode": ledger.source_mode,
        "source_rank": ledger.source_rank,
        "first_seen_at": ledger_data["first_seen_at"],
        "last_seen_at": ledger_data["last_seen_at"],
        "source_synced_at": ledger_data["source_synced_at"],
    }
