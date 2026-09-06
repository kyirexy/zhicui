"""电脑授权手机的短期会话；不保存明文二维码或领取凭据。"""
import uuid
from sqlalchemy import Column, String, DateTime, ForeignKey, CheckConstraint
from app.core.database import Base


class PhoneLoginSession(Base):
    __tablename__ = "phone_login_sessions"
    __table_args__ = (CheckConstraint(
        "status IN ('pending','scanned','approved','consumed','cancelled','expired')",
        name="ck_phone_login_status",
    ),)
    id = Column(String(40), primary_key=True, default=lambda: f"pls-{uuid.uuid4().hex}")
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    scan_hash = Column(String(64), unique=True, nullable=False)
    claim_hash = Column(String(64), nullable=True)
    status = Column(String(16), nullable=False, default="pending")
    client_type = Column(String(16), nullable=True)
    verification_code = Column(String(4), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    last_polled_at = Column(DateTime(timezone=True), nullable=True)
