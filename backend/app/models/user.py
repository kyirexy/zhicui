"""
User model for authentication.

Stores email + hashed password.  No username, no phone — pure email auth.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, String
from sqlalchemy.orm import Session

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: f"u-{uuid.uuid4().hex[:12]}")
    email = Column(String, unique=True, nullable=False, index=True)
    username = Column(String, unique=True, nullable=True, index=True)
    hashed_password = Column(String, nullable=False)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    email_verified = Column(Boolean, default=False, nullable=False)
    email_verification_nonce = Column(String(96), nullable=True)
    email_verification_sent_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "username": self.username,
            "is_active": self.is_active,
            "is_admin": self.is_admin,
            "email_verified": bool(self.email_verified),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.query(User).filter(User.email == email).first()


def get_user_by_username(db: Session, username: str) -> User | None:
    return db.query(User).filter(User.username == username).first()


def get_user_by_id(db: Session, user_id: str) -> User | None:
    return db.query(User).filter(User.id == user_id).first()


def create_user(db: Session, email: str, hashed_password: str, username: str | None = None) -> User:
    user = User(email=email, username=username, hashed_password=hashed_password)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def list_users(db: Session, page: int = 1, per_page: int = 20) -> tuple[list[User], int]:
    q = db.query(User).order_by(User.created_at.desc())
    total = q.count()
    users = q.offset((page - 1) * per_page).limit(per_page).all()
    return users, total


def count_users(db: Session) -> int:
    return db.query(User).count()
