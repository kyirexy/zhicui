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

from sqlalchemy import func
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

    q_total = db.query(func.count(Note.id))
    if user_id:
        q_total = q_total.filter(Note.user_id == user_id)
    total: int = q_total.scalar() or 0

    q = db.query(Note).order_by(Note.created_at.desc())
    if user_id:
        q = q.filter(Note.user_id == user_id)
    notes = q.offset(offset).limit(per_page).all()
    return notes, total
