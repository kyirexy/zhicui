"""Atomic, user-scoped removal of video-library notes.

Both the browser route and Product Action call this service so permanent
Douyin hiding, creator-catalog tombstones and Note deletion cannot drift.
Nothing is committed until every selected owned Note has been processed.
"""

from __future__ import annotations

from typing import Iterable
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.note import Note
from app.services import creator_sync_service, library_hidden_service


MAX_BATCH_REMOVE = 50


def normalize_note_ids(note_ids: Iterable[object]) -> list[str]:
    """Return unique canonical UUIDs while preserving caller order."""
    raw_values = list(note_ids)
    if not 1 <= len(raw_values) <= MAX_BATCH_REMOVE:
        raise ValueError(f"删除数量必须在 1 到 {MAX_BATCH_REMOVE} 条之间")
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        if not isinstance(raw, str):
            raise ValueError("视频资料标识格式无效")
        try:
            note_id = str(UUID(raw.strip()))
        except (TypeError, ValueError, AttributeError) as exc:
            raise ValueError("视频资料标识格式无效") from exc
        if note_id not in seen:
            normalized.append(note_id)
            seen.add(note_id)
    return normalized


def remove_many(
    db: Session,
    *,
    user_id: str,
    note_ids: Iterable[object],
) -> dict[str, object]:
    """Permanently remove owned notes in one database transaction.

    IDs belonging to another user are deliberately indistinguishable from
    nonexistent IDs: both are reported only as caller-supplied ``missing_ids``.
    """
    clean_ids = normalize_note_ids(note_ids)
    notes = db.query(Note).filter(
        Note.user_id == user_id,
        Note.id.in_(clean_ids),
    ).all()
    by_id = {str(note.id): note for note in notes}
    ordered_notes = [by_id[note_id] for note_id in clean_ids if note_id in by_id]
    douyin_ids = [
        str(note.video_id or "").strip()
        for note in ordered_notes
        if str(note.to_dict().get("platform") or "").strip().lower() == "douyin"
        and str(note.video_id or "").strip()
    ]

    try:
        if douyin_ids:
            library_hidden_service.hide_aweme_ids(
                db,
                user_id,
                douyin_ids,
                "permanent",
                commit=False,
            )
        for note in ordered_notes:
            creator_sync_service.mark_note_permanently_removed(
                db,
                user_id=user_id,
                note_id=note.id,
            )
            db.delete(note)
        db.commit()
    except Exception:
        db.rollback()
        raise

    deleted_ids = [str(note.id) for note in ordered_notes]
    deleted_set = set(deleted_ids)
    return {
        "deleted": len(deleted_ids),
        "deleted_ids": deleted_ids,
        "missing_ids": [note_id for note_id in clean_ids if note_id not in deleted_set],
        "permanent": True,
    }
