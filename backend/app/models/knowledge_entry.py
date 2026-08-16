"""User-authored entries in the permanent personal knowledge library."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class KnowledgeEntry(Base):
    __tablename__ = "knowledge_entries"
    __table_args__ = (
        Index("ix_knowledge_entries_user_updated", "user_id", "updated_at"),
        Index(
            "ix_knowledge_entries_user_status_updated",
            "user_id",
            "status",
            "updated_at",
        ),
        Index(
            "ux_knowledge_entries_user_source_note",
            "user_id",
            "source_note_id",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    summary: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default="canonical", server_default="canonical", nullable=False
    )
    origin: Mapped[str] = mapped_column(
        String(32), default="manual", server_default="manual", nullable=False
    )
    source_note_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey(
            "notes.id",
            name="fk_knowledge_entries_source_note_id_notes",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    source_label: Mapped[str] = mapped_column(String(256), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": "page",
            "title": self.title,
            "summary": self.summary,
            "content": self.content,
            "excerpt": (self.summary or self.content)[:180],
            "status": self.status,
            "origin": self.origin,
            "source_note_id": self.source_note_id,
            "source_count": 1 if self.source_note_id else 0,
            "source_label": self.source_label,
            "content_chars": len(self.content),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
