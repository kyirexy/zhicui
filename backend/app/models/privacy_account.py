"""Privacy, legal-consent and destructive-account-action records."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserLegalConsent(Base):
    """One auditable acceptance row for each versioned legal document."""

    __tablename__ = "user_legal_consents"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "document_type",
            "document_version",
            name="uq_user_legal_consent_version",
        ),
        Index("ix_user_legal_consents_user_accepted", "user_id", "accepted_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_type: Mapped[str] = mapped_column(String(24), nullable=False)
    document_version: Mapped[str] = mapped_column(String(24), nullable=False)
    client_type: Mapped[str] = mapped_column(String(24), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    def to_dict(self) -> dict[str, str | None]:
        return {
            "document_type": self.document_type,
            "document_version": self.document_version,
            "client_type": self.client_type,
            "accepted_at": self.accepted_at.isoformat() if self.accepted_at else None,
        }


class AccountActionGrant(Base):
    """Short-lived, one-time password-reverified grant stored only as a hash."""

    __tablename__ = "account_action_grants"
    __table_args__ = (
        Index("ix_account_action_grants_user_action", "user_id", "action"),
        Index("ix_account_action_grants_expires", "expires_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    action: Mapped[str] = mapped_column(String(24), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    client_type: Mapped[str] = mapped_column(String(24), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class AccountPrivacyAuditEvent(Base):
    """Content-free audit evidence that survives account deletion."""

    __tablename__ = "account_privacy_audit_events"
    __table_args__ = (
        Index("ix_account_privacy_audit_action_created", "action", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    subject_reference: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(48), nullable=False)
    client_type: Mapped[str] = mapped_column(String(24), nullable=False)
    detail_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
