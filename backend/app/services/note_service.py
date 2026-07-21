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


def update_note_ai(db: Session, note: Note, ai_result: dict[str, Any]) -> Note:
    """Re-apply an AI result to an existing note (re-extraction).

    Updates ai_summary, card_type, pitfall_rating, updated_at.
    """
    note.ai_summary = json.dumps(ai_result, ensure_ascii=False)
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
            "author": username or "-",
            "has_transcript": bool(note.transcript_raw),
            "created_at": note.created_at.isoformat() if note.created_at else None,
        }
        for note, username in rows
    ]
    return items, total
