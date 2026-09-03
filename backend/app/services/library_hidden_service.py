"""Persist and query user-scoped Douyin library visibility records."""

from datetime import datetime, timezone
from typing import Literal

from sqlalchemy.orm import Session

from app.models.library_hidden_item import LibraryHiddenItem
from app.models.creator_sync import CreatorSourceItem

MAX_BATCH_REMOVE = 50
HideMode = Literal["temporary", "permanent"]
VALID_HIDE_MODES = {"temporary", "permanent"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_mode(value: object) -> HideMode:
    """Treat legacy or unknown values conservatively as permanent."""
    return "temporary" if value == "temporary" else "permanent"


def _normalize_aweme_ids(aweme_ids: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for raw_id in aweme_ids:
        aweme_id = str(raw_id or "").strip()
        if not aweme_id or aweme_id in seen:
            continue
        seen.add(aweme_id)
        unique.append(aweme_id)
    return unique


def list_hidden_aweme_ids(
    db: Session,
    user_id: str,
    aweme_ids: list[str] | None = None,
) -> set[str]:
    query = db.query(LibraryHiddenItem.aweme_id).filter(
        LibraryHiddenItem.user_id == user_id
    )
    candidates = _normalize_aweme_ids(aweme_ids or [])
    if aweme_ids is not None:
        if not candidates:
            return set()
        query = query.filter(LibraryHiddenItem.aweme_id.in_(candidates))
    return {row[0] for row in query.all()}


def list_hidden_modes(
    db: Session,
    user_id: str,
    aweme_ids: list[str] | None = None,
) -> dict[str, HideMode]:
    query = db.query(
        LibraryHiddenItem.aweme_id,
        LibraryHiddenItem.hide_mode,
    ).filter(LibraryHiddenItem.user_id == user_id)
    candidates = _normalize_aweme_ids(aweme_ids or [])
    if aweme_ids is not None:
        if not candidates:
            return {}
        query = query.filter(LibraryHiddenItem.aweme_id.in_(candidates))
    return {
        row.aweme_id: _coerce_mode(row.hide_mode)
        for row in query.all()
    }


def list_hidden_records(
    db: Session,
    user_id: str,
    mode: HideMode = "permanent",
    limit: int = 100,
) -> list[LibraryHiddenItem]:
    safe_limit = max(1, min(int(limit), 1000))
    return (
        db.query(LibraryHiddenItem)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.hide_mode == _coerce_mode(mode),
        )
        .order_by(LibraryHiddenItem.created_at.desc(), LibraryHiddenItem.id.desc())
        .limit(safe_limit)
        .all()
    )


def count_hidden(
    db: Session,
    user_id: str,
    mode: HideMode = "permanent",
) -> int:
    return (
        db.query(LibraryHiddenItem.id)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.hide_mode == _coerce_mode(mode),
        )
        .count()
    )


def is_hidden(db: Session, user_id: str, aweme_id: str) -> bool:
    return (
        db.query(LibraryHiddenItem.id)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.aweme_id == aweme_id,
        )
        .first()
        is not None
    )


def hide_aweme_ids(
    db: Session,
    user_id: str,
    aweme_ids: list[str],
    mode: HideMode = "temporary",
    *,
    commit: bool = True,
) -> dict[str, object]:
    normalized = _normalize_aweme_ids(aweme_ids)
    if not normalized or len(normalized) > MAX_BATCH_REMOVE:
        raise ValueError(f"移除数量必须在 1 到 {MAX_BATCH_REMOVE} 条之间")
    if mode not in VALID_HIDE_MODES:
        raise ValueError("隐藏方式无效")

    records = (
        db.query(LibraryHiddenItem)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.aweme_id.in_(normalized),
        )
        .all()
    )
    existing = {record.aweme_id: record for record in records}
    new_ids: list[str] = []
    promoted_ids: list[str] = []
    for aweme_id in normalized:
        record = existing.get(aweme_id)
        if record is None:
            db.add(LibraryHiddenItem(
                user_id=user_id,
                aweme_id=aweme_id,
                hide_mode=mode,
            ))
            new_ids.append(aweme_id)
            continue
        if mode == "permanent" and _coerce_mode(record.hide_mode) != "permanent":
            record.hide_mode = "permanent"
            record.created_at = _utcnow()
            promoted_ids.append(aweme_id)

    if mode == "permanent":
        now = _utcnow()
        (
            db.query(CreatorSourceItem)
            .filter(
                CreatorSourceItem.user_id == user_id,
                CreatorSourceItem.platform == "douyin",
                CreatorSourceItem.external_id.in_(normalized),
            )
            .update(
                {
                    CreatorSourceItem.state: "removed",
                    CreatorSourceItem.removed_at: now,
                    CreatorSourceItem.note_id: None,
                },
                synchronize_session=False,
            )
        )

    if commit and (new_ids or promoted_ids or mode == "permanent"):
        db.commit()
    return {
        "removed": len(normalized),
        "newly_removed": len(new_ids),
        "promoted": len(promoted_ids),
        "mode": mode,
        "aweme_ids": normalized,
    }


def clear_temporary_hidden(
    db: Session,
    user_id: str,
    completed_at: datetime,
) -> int:
    """Restore temporary removals created no later than this successful sync."""
    if completed_at.tzinfo is None:
        completed_at = completed_at.replace(tzinfo=timezone.utc)
    deleted = (
        db.query(LibraryHiddenItem)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.hide_mode == "temporary",
            LibraryHiddenItem.created_at <= completed_at,
        )
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return int(deleted or 0)


def restore_permanent_aweme_ids(
    db: Session,
    user_id: str,
    aweme_ids: list[str],
) -> dict[str, object]:
    normalized = _normalize_aweme_ids(aweme_ids)
    if not normalized or len(normalized) > MAX_BATCH_REMOVE:
        raise ValueError(f"恢复数量必须在 1 到 {MAX_BATCH_REMOVE} 条之间")
    restored = (
        db.query(LibraryHiddenItem)
        .filter(
            LibraryHiddenItem.user_id == user_id,
            LibraryHiddenItem.aweme_id.in_(normalized),
            LibraryHiddenItem.hide_mode == "permanent",
        )
        .delete(synchronize_session=False)
    )
    creator_items_restored = (
        db.query(CreatorSourceItem)
        .filter(
            CreatorSourceItem.user_id == user_id,
            CreatorSourceItem.platform == "douyin",
            CreatorSourceItem.external_id.in_(normalized),
            CreatorSourceItem.state == "removed",
        )
        .update(
            {
                CreatorSourceItem.state: "discovered",
                CreatorSourceItem.removed_at: None,
            },
            synchronize_session=False,
        )
    )
    if restored or creator_items_restored:
        db.commit()
    return {
        "restored": int(restored or 0),
        "aweme_ids": normalized,
    }
