"""Production dependency readiness without leaking credentials."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.agent_runtime import AgentTurn
from app.models.creator_sync import ACTIVE_CREATOR_RUN_STATUSES, CreatorSyncRun
from app.services import creator_connectors, settings_service


_cache_lock = threading.Lock()
_cache_until = 0.0
_cached: dict[str, Any] | None = None


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _check_database(db: Session) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        db.execute(text("SELECT 1"))
        return {
            "status": "ready",
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }
    except Exception:
        db.rollback()
        return {"status": "not_ready", "error_code": "database_unavailable"}


def _check_ai_config(db: Session) -> dict[str, Any]:
    llm = settings_service.get_llm_config_masked(db)
    asr = settings_service.get_asr_config_masked(db)
    llm_ready = bool(llm.get("model") and llm.get("api_key_masked"))
    asr_ready = bool(asr.get("model") and asr.get("api_key_masked"))
    return {
        "status": "ready" if llm_ready and asr_ready else "not_ready",
        "llm_configured": llm_ready,
        "asr_configured": asr_ready,
    }


def _check_queues(db: Session) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=5)
    stale_agent = db.query(AgentTurn).filter(
        AgentTurn.status.in_(["queued", "running"]),
        AgentTurn.updated_at < stale_cutoff,
    ).count()
    expired_creator = db.query(CreatorSyncRun).filter(
        CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
        CreatorSyncRun.lease_until.is_not(None),
        CreatorSyncRun.lease_until < now,
    ).count()
    degraded = stale_agent > 10 or expired_creator > 3
    return {
        "status": "degraded" if degraded else "ready",
        "stale_agent_turns": stale_agent,
        "expired_creator_leases": expired_creator,
    }


def _check_connectors(db: Session) -> dict[str, Any]:
    config = settings_service.get_creator_sync_config(db)
    if not config.get("enabled"):
        return {"status": "disabled", "enabled": False, "catalog": {}}
    catalog: dict[str, Any] = {}
    required_failure = False
    for platform in ("douyin", "bilibili"):
        enabled = bool(config.get("catalog_platforms", {}).get(platform))
        if not enabled:
            catalog[platform] = {"enabled": False, "status": "disabled"}
            continue
        probe = creator_connectors.catalog_health(platform)
        healthy = bool(probe.get("healthy"))
        required_failure = required_failure or not healthy
        catalog[platform] = {
            "enabled": True,
            "status": "ready" if healthy else "not_ready",
            "version": str(probe.get("version") or "")[:32] or None,
            "error_code": str(probe.get("error_code") or "")[:96] or None,
        }
    return {
        "status": "not_ready" if required_failure else "ready",
        "enabled": True,
        "catalog": catalog,
    }


def _check_backup() -> dict[str, Any]:
    if not settings.DATABASE_URL.startswith("postgresql"):
        return {"status": "not_applicable"}
    path = Path(settings.BACKUP_STATUS_FILE)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        completed_at = datetime.fromisoformat(str(payload["completed_at"]).replace("Z", "+00:00"))
        if completed_at.tzinfo is None:
            completed_at = completed_at.replace(tzinfo=timezone.utc)
        age_hours = (datetime.now(timezone.utc) - completed_at).total_seconds() / 3600
        checksum_ok = bool(payload.get("checksum_verified"))
        restore_ok = bool(payload.get("restore_verified"))
        offsite_required = bool(settings.BACKUP_OFFSITE_REQUIRED)
        backup_mode = "offsite" if offsite_required else "local_only"
        local_risk_accepted = bool(settings.EARLY_STAGE_LOCAL_BACKUP_ACCEPTED)
        payload_offsite_required = payload.get("offsite_required") is True
        mode_matches = payload_offsite_required == offsite_required
        offsite_ok = bool(payload.get("offsite_verified"))
        recovery_material_ok = bool(payload.get("recovery_material_verified"))
        offsite_verified_at: datetime | None = None
        if payload.get("offsite_verified_at"):
            offsite_verified_at = datetime.fromisoformat(
                str(payload["offsite_verified_at"]).replace("Z", "+00:00")
            )
            if offsite_verified_at.tzinfo is None:
                offsite_verified_at = offsite_verified_at.replace(tzinfo=timezone.utc)
        offsite_age_seconds = (
            (datetime.now(timezone.utc) - offsite_verified_at).total_seconds()
            if offsite_verified_at else -1
        )
        offsite_fresh = bool(
            offsite_verified_at
            and offsite_verified_at >= completed_at
            and 0 <= offsite_age_seconds
            <= max(1, settings.BACKUP_MAX_AGE_HOURS) * 3600
        )
        offsite_ready = offsite_ok and recovery_material_ok and offsite_fresh
        local_evidence_truthful = (
            payload.get("backup_mode") == "local_only"
            and not offsite_ok
            and not recovery_material_ok
            and not payload.get("offsite_verified_at")
        )
        protection_ready = (
            offsite_ready if offsite_required
            else local_risk_accepted and local_evidence_truthful
        )
        ready = (
            payload.get("status") == "ok"
            and checksum_ok
            and restore_ok
            and age_hours <= max(1, settings.BACKUP_MAX_AGE_HOURS)
            and mode_matches
            and protection_ready
        )
        if ready:
            error_code = None
        elif not offsite_required and not local_risk_accepted:
            error_code = "backup_local_mode_not_accepted"
        elif not mode_matches:
            error_code = "backup_mode_mismatch"
        elif offsite_required and not offsite_ready:
            error_code = "backup_offsite_unverified"
        elif not offsite_required and not local_evidence_truthful:
            error_code = "backup_local_evidence_invalid"
        else:
            error_code = "backup_stale_or_unverified"
        return {
            "status": "ready" if ready else "not_ready",
            "completed_at": _iso(completed_at),
            "age_hours": round(max(0.0, age_hours), 1),
            "checksum_verified": checksum_ok,
            "restore_verified": restore_ok,
            "backup_mode": backup_mode,
            "local_risk_accepted": local_risk_accepted,
            "mode_matches": mode_matches,
            "offsite_required": offsite_required,
            "offsite_verified": offsite_ok,
            "offsite_verified_at": _iso(offsite_verified_at),
            "offsite_provider": str(payload.get("offsite_provider") or "")[:24] or None,
            "recovery_material_verified": recovery_material_ok,
            "error_code": error_code,
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"status": "not_ready", "error_code": "backup_status_unavailable"}


def _build(db: Session) -> dict[str, Any]:
    checks = {
        "database": _check_database(db),
        "ai_configuration": _check_ai_config(db),
        "queues": _check_queues(db),
        "creator_connectors": _check_connectors(db),
        "backup": _check_backup(),
    }
    statuses = {str(value.get("status")) for value in checks.values()}
    if "not_ready" in statuses:
        status = "not_ready"
    elif "degraded" in statuses:
        status = "degraded"
    else:
        status = "ready"
    return {
        "status": status,
        "checked_at": _iso(datetime.now(timezone.utc)),
        "checks": checks,
    }


def get_readiness(db: Session, *, force: bool = False) -> dict[str, Any]:
    global _cache_until, _cached
    now = time.monotonic()
    with _cache_lock:
        if not force and _cached is not None and now < _cache_until:
            return dict(_cached)
    result = _build(db)
    with _cache_lock:
        _cached = result
        _cache_until = now + max(1, settings.READINESS_CACHE_SECONDS)
    return dict(result)


def public_summary(result: dict[str, Any]) -> dict[str, Any]:
    checks = result.get("checks") or {}
    return {
        "status": result.get("status", "not_ready"),
        "checked_at": result.get("checked_at"),
        "checks": {
            name: {"status": value.get("status", "not_ready")}
            for name, value in checks.items()
            if isinstance(value, dict)
        },
    }


def clear_cache() -> None:
    global _cache_until, _cached
    with _cache_lock:
        _cache_until = 0.0
        _cached = None
