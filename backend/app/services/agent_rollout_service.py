"""Fail-closed rollout gates for the Agent interface.

The global switch prevents an accidental deployment from exposing anything.
These two optional allowlists then make it possible to enable a small set of
ordinary users and Product Actions without changing Registry definitions or
granting administrator capabilities.
"""

from __future__ import annotations

from app.core.config import settings


def _values(raw: str) -> frozenset[str]:
    return frozenset(
        item.strip()
        for item in str(raw or "").split(",")
        if item.strip()
    )


def _allows(raw: str, value: str) -> bool:
    configured = _values(raw)
    return not configured or "*" in configured or value in configured


def user_is_enabled(user_id: str) -> bool:
    """Return whether this immutable user ID is inside the current rollout."""

    return _allows(settings.AGENT_INTERFACE_USER_ALLOWLIST, str(user_id))


def action_is_enabled(action_id: str) -> bool:
    """Return whether this reviewed Registry Action is inside the rollout."""

    return _allows(settings.AGENT_INTERFACE_ACTION_ALLOWLIST, str(action_id))
