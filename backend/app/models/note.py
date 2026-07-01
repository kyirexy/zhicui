"""
Note ORM model -- the core entity that stores a video-to-card result.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=_uuid
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    video_id: Mapped[str] = mapped_column(String(128), nullable=False)
    video_title: Mapped[str] = mapped_column(String(512), nullable=False)
    video_url: Mapped[str] = mapped_column(String(1024), nullable=False)

    transcript_raw: Mapped[str | None] = mapped_column(Text, nullable=True)

    # JSON-encoded structured card content produced by the AI.
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    card_type: Mapped[str] = mapped_column(
        String(32), default="general", nullable=False
    )

    seo_title: Mapped[str] = mapped_column(String(256), nullable=False)
    seo_slug: Mapped[str] = mapped_column(
        String(128), unique=True, index=True, nullable=False
    )
    seo_meta: Mapped[str] = mapped_column(String(512), nullable=False)

    pitfall_rating: Mapped[int] = mapped_column(Integer, default=3, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        """Serialize the note to a plain dict for JSON responses."""
        import json

        # Parse the AI summary JSON to extract structured card data.
        ai = {}
        if self.ai_summary:
            try:
                ai = json.loads(self.ai_summary)
            except (json.JSONDecodeError, TypeError):
                ai = {}

        return {
            "id": self.id,
            "video_id": self.video_id,
            "title": self.video_title,
            "video_title": self.video_title,
            "video_url": self.video_url,
            "source_url": self.video_url,
            "transcript_raw": self.transcript_raw,
            "card_type": self.card_type,
            "sections": ai.get("sections", []),
            "conclusion": ai.get("conclusion", ""),
            "pitfall_rating": self.pitfall_rating,
            # Adaptive-card profile (added 2026-06; defaults keep older notes
            # backward-compatible).
            "tone": ai.get("tone", "hybrid"),
            "density": ai.get("density", "medium"),
            "hero_quote": ai.get("hero_quote", ""),
            "key_insight": ai.get("key_insight", ""),
            "stats": ai.get("stats", []),
            "seo_title": self.seo_title,
            "seo_slug": self.seo_slug,
            "seo_meta": self.seo_meta,
            "excerpt": (ai.get("conclusion", "") or "")[:160],
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
