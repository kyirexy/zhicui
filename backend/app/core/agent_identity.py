"""Opaque, domain-separated identifiers for local Agent account binding."""

from __future__ import annotations

import hashlib
import hmac

from app.core.config import settings


def agent_profile_key(user_id: str) -> str:
    """Return an opaque per-user profile key safe to pass to the desktop host."""
    secret = str(settings.AGENT_TOKEN_PEPPER or settings.JWT_SECRET or "").encode("utf-8")
    if not secret:
        raise RuntimeError("AGENT_TOKEN_PEPPER 或 JWT_SECRET 未配置")
    message = f"desktop-profile:{str(user_id).strip()}".encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def agent_user_hash(user_id: str) -> str:
    """Return the descriptor marker corresponding to ``agent_profile_key``."""
    return hashlib.sha256(agent_profile_key(user_id).encode("ascii")).hexdigest()
