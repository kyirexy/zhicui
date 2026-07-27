"""Persist and query user-scoped hidden Douyin library items."""

from sqlalchemy.orm import Session

from app.models.library_hidden_item import LibraryHiddenItem

MAX_BATCH_REMOVE = 50


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
) -> dict[str, object]:
    normalized = _normalize_aweme_ids(aweme_ids)
    if not normalized or len(normalized) > MAX_BATCH_REMOVE:
        raise ValueError(f"移除数量必须在 1 到 {MAX_BATCH_REMOVE} 条之间")
    existing = list_hidden_aweme_ids(db, user_id, normalized)
    new_ids = [aweme_id for aweme_id in normalized if aweme_id not in existing]
    if new_ids:
        db.add_all([
            LibraryHiddenItem(user_id=user_id, aweme_id=aweme_id)
            for aweme_id in new_ids
        ])
        db.commit()
    return {
        "removed": len(normalized),
        "newly_removed": len(new_ids),
        "aweme_ids": normalized,
    }
