"""User-scoped visibility records for Douyin library items."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LibraryHiddenItem(Base):
    __tablename__ = "library_hidden_items"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "aweme_id",
            name="uq_library_hidden_items_user_aweme",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    aweme_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    hide_mode: Mapped[str] = mapped_column(
        String(16),
        default="permanent",
        server_default="permanent",
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utcnow,
        nullable=False,
    )
