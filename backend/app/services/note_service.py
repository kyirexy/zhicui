"""
Note persistence service.

Handles CRUD operations and SEO metadata generation for notes.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.note import Note
from app.models.plan import Plan


# ---------------------------------------------------------------------------
# SEO helpers
# ---------------------------------------------------------------------------

def generate_seo_title(video_title: str) -> str:
    """Produce an SEO-friendly Chinese title for a note card."""
    clean = video_title.strip()
    return f"《【视频干货】{clean}的文字笔记与步骤总结》"


def generate_slug(video_id: str) -> str:
    """Create a short, URL-friendly slug.

    Combines a truncated hash of a UUID with a short portion of the video_id
    to stay unique and readable.
    """
    random_part = hashlib.md5(uuid.uuid4().bytes).hexdigest()[:8]
    # Keep only alphanumeric chars from video_id, truncated to 8 chars.
    safe_id = re.sub(r"[^a-zA-Z0-9]", "", video_id)[:8]
    return f"v-{safe_id}-{random_part}"


def _generate_seo_meta(video_title: str, content_type: str) -> str:
    """Generate a default meta description."""
    return (
        f"{video_title} - 视频内容笔记，涵盖核心要点与实用建议。"
        f"类型：{content_type}"
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def create_note(
    db: Session,
    video_info: dict[str, Any],
    transcript: str,
    ai_result: dict[str, Any],
    user_id: str = "",
    *,
    ai_initialized: bool = True,
) -> Note:
    """Persist a new note from extraction results.

    Parameters
    ----------
    db:
        Active database session.
    video_info:
        Dict with keys ``video_id``, ``title``, and one of
        ``download_url`` (preferred) or ``url`` for the no-watermark mp4.
    transcript:
        Raw transcript text.
    ai_result:
        Structured card output from ``ai_juicer.generate_card``.
    """
    video_title: str = video_info.get("title", "未知标题")
    card_type: str = ai_result.get("card_type", "general")

    # video_extractor.parse_video_info returns the no-watermark mp4 link as
    # `download_url`; older callers pass it as `url`. Accept both.
    video_url: str = (
        video_info.get("download_url")
        or video_info.get("url")
        or ""
    )

    note = Note(
        id=str(uuid.uuid4()),
        user_id=user_id,
        video_id=video_info.get("video_id", ""),
        video_title=video_title,
        video_url=video_url,
        transcript_raw=transcript,
        ai_summary=json.dumps(ai_result, ensure_ascii=False),
        ai_initialized=ai_initialized,
        card_type=card_type,
        seo_title=generate_seo_title(video_title),
        seo_slug=generate_slug(video_info.get("video_id", "")),
        seo_meta=_generate_seo_meta(video_title, card_type),
        pitfall_rating=int(ai_result.get("pitfall_rating", 3)),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def create_transcript_note(
    db: Session,
    *,
    video_info: dict[str, Any],
    transcript: str,
    source_meta: dict[str, Any],
    user_id: str,
) -> Note:
    """Persist a transcript-ready library Note without inventing AI output."""
    return create_note(
        db,
        video_info,
        transcript,
        {
            "ai_initialized": False,
            "source_meta": source_meta,
        },
        user_id,
        ai_initialized=False,
    )


def get_note(db: Session, note_id: str, user_id: str = "") -> Note | None:
    """Fetch a single note by primary key, optionally scoped to user."""
    q = db.query(Note).filter(Note.id == note_id)
    if user_id:
        q = q.filter(Note.user_id == user_id)
    return q.first()


def get_note_by_slug(db: Session, slug: str, user_id: str = "") -> Note | None:
    """Fetch a single note by its SEO slug, optionally scoped to user."""
    q = db.query(Note).filter(Note.seo_slug == slug)
    if user_id:
        q = q.filter(Note.user_id == user_id)
    return q.first()


def get_note_by_video_id(
    db: Session,
    video_id: str,
    user_id: str = "",
) -> Note | None:
    """Fetch the newest note for one external video id."""
    clean_id = video_id.strip()
    if not clean_id:
        return None
    query = db.query(Note).filter(Note.video_id == clean_id)
    if user_id:
        query = query.filter(Note.user_id == user_id)
    return query.order_by(Note.created_at.desc()).first()


def get_notes_by_video_ids(
    db: Session,
    video_ids: list[str],
    user_id: str = "",
) -> dict[str, Note]:
    """Return the newest user-owned Note keyed by external video id."""
    clean_ids = list(dict.fromkeys(
        video_id.strip()
        for video_id in video_ids
        if video_id and video_id.strip()
    ))
    if not clean_ids:
        return {}

    query = db.query(Note).filter(Note.video_id.in_(clean_ids))
    if user_id:
        query = query.filter(Note.user_id == user_id)

    result: dict[str, Note] = {}
    for note in query.order_by(Note.created_at.desc()).all():
        result.setdefault(note.video_id, note)
    return result


def merge_library_source_meta(
    note: Note,
    item: dict[str, Any],
) -> bool:
    """Refresh reliable downloader metadata without changing the transcript.

    This lets older transcript Notes participate in Agent source filters as
    soon as the user opens the video library again. It never stores media.
    """
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (json.JSONDecodeError, TypeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    previous = payload.get("source_meta")
    if not isinstance(previous, dict):
        previous = {}
    synced_at = (
        str(item.get("source_synced_at") or "").strip()
        or str(item.get("recorded_at") or "").strip()
        or (
            note.created_at.isoformat()
            if note.created_at
            else datetime.now(timezone.utc).isoformat()
        )
    )
    updated = {
        **previous,
        "source_kind": "douyin-library",
        "platform": "douyin",
        "source_url": str(item.get("source_url") or note.video_url or ""),
        "cover_url": str(item.get("cover_url") or ""),
        "author_name": str(item.get("author_name") or ""),
        "recorded_at": str(item.get("recorded_at") or ""),
        "caption": str(item.get("caption") or ""),
        "source_mode": str(item.get("source_mode") or "unknown"),
        "source_rank": item.get("source_rank"),
        "source_synced_at": synced_at,
        "first_seen_at": previous.get("first_seen_at") or synced_at,
    }
    if updated == previous:
        return False
    payload["source_meta"] = updated
    note.ai_summary = json.dumps(payload, ensure_ascii=False)
    return True


def list_notes(
    db: Session,
    page: int = 1,
    per_page: int = 20,
    user_id: str = "",
    search: str | None = None,
    card_type: str | None = None,
) -> tuple[list[Note], int]:
    """Return a paginated list of notes and the total count.

    Parameters
    ----------
    page:
        1-indexed page number.
    per_page:
        Items per page (capped at 100).

    Returns
    -------
    tuple[list[Note], int]
        (notes on this page, total number of notes)
    """
    per_page = min(per_page, 100)
    offset = (max(page, 1) - 1) * per_page

    query = db.query(Note)
    if user_id:
        query = query.filter(Note.user_id == user_id)
    # Transcript-ready library records live in the library workspace until the
    # user explicitly initializes a card; do not render them as empty cards.
    query = query.filter(Note.ai_initialized.is_(True))
    clean_search = (search or "").strip()
    if clean_search:
        escaped_search = (
            clean_search
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        pattern = f"%{escaped_search}%"
        query = query.filter(or_(
            Note.video_title.ilike(pattern, escape="\\"),
            Note.ai_summary.ilike(pattern, escape="\\"),
        ))
    if card_type:
        query = query.filter(Note.card_type == card_type)

    total: int = query.count() or 0
    notes = (
        query.order_by(Note.created_at.desc())
        .offset(offset)
        .limit(per_page)
        .all()
    )
    return notes, total


def delete_note(db: Session, note_id: str) -> bool:
    """Delete a note by id (admin — no user scoping). Returns True if deleted."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return False
    db.delete(note)
    db.commit()
    return True


def _source_kind(note: Note) -> str:
    """Read a Note's source kind without trusting malformed legacy JSON."""
    if not note.ai_summary:
        return ""
    try:
        payload = json.loads(note.ai_summary)
    except (json.JSONDecodeError, TypeError):
        return ""
    source_meta = payload.get("source_meta")
    if not isinstance(source_meta, dict):
        return ""
    return str(source_meta.get("source_kind") or "").strip()


def delete_user_library_note(
    db: Session,
    note_id: str,
    user_id: str,
) -> tuple[bool, int]:
    """Delete one user-owned video-library Note and its generated plans."""
    note = (
        db.query(Note)
        .filter(Note.id == note_id, Note.user_id == user_id)
        .first()
    )
    if note is None or _source_kind(note) != "douyin-library":
        return False, 0

    plans_deleted = (
        db.query(Plan)
        .filter(Plan.user_id == user_id, Plan.note_id == note.id)
        .delete(synchronize_session=False)
    )
    db.delete(note)
    db.commit()
    return True, int(plans_deleted or 0)


def update_note_ai(db: Session, note: Note, ai_result: dict[str, Any]) -> Note:
    """Re-apply an AI result to an existing note (re-extraction).

    Updates ai_summary, card_type, pitfall_rating, updated_at.
    """
    # Preserve the first reliable time this source entered Zhicui when a user
    # later initializes or refreshes the AI card. The downloader's current
    # sync timestamp is not the original Douyin favourite timestamp.
    previous_source_meta: dict[str, Any] = {}
    if note.ai_summary:
        try:
            previous_payload = json.loads(note.ai_summary)
            candidate = previous_payload.get("source_meta")
            if isinstance(candidate, dict):
                previous_source_meta = candidate
        except (json.JSONDecodeError, TypeError):
            previous_source_meta = {}
    initialized_result = {**ai_result, "ai_initialized": True}
    new_source_meta = initialized_result.get("source_meta")
    if isinstance(new_source_meta, dict):
        merged_source_meta = {**previous_source_meta, **new_source_meta}
        if previous_source_meta.get("first_seen_at"):
            merged_source_meta["first_seen_at"] = previous_source_meta["first_seen_at"]
        initialized_result["source_meta"] = merged_source_meta
    note.ai_summary = json.dumps(initialized_result, ensure_ascii=False)
    note.ai_initialized = True
    note.card_type = ai_result.get("card_type", note.card_type)
    note.pitfall_rating = int(ai_result.get("pitfall_rating", note.pitfall_rating))
    note.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(note)
    return note


def list_notes_admin(
    db: Session,
    page: int = 1,
    per_page: int = 20,
    search: str | None = None,
    card_type: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Paginated notes for the admin panel, with author username joined.

    Returns (items, total) where items are lightweight dicts (no transcript)
    suitable for a management table. Optional filters: search (title ILIKE)
    and card_type (exact match).
    """
    from app.models.user import User

    per_page = min(per_page, 100)
    offset = (max(page, 1) - 1) * per_page

    q = db.query(Note, User.username).outerjoin(User, Note.user_id == User.id)
    if search:
        q = q.filter(Note.video_title.ilike(f"%{search}%"))
    if card_type:
        q = q.filter(Note.card_type == card_type)

    total: int = q.count() or 0

    rows = (
        q.order_by(Note.created_at.desc())
        .offset(offset)
        .limit(per_page)
        .all()
    )
    items = [
        {
            "id": note.id,
            "video_title": note.video_title,
            "card_type": note.card_type,
            "ai_initialized": bool(note.ai_initialized),
            "author": username or "-",
            "has_transcript": bool(note.transcript_raw),
            "created_at": note.created_at.isoformat() if note.created_at else None,
        }
        for note, username in rows
    ]
    return items, total
