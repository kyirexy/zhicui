"""Production dependency readiness without leaking credentials."""

from __future__ import annotations

import json
import smtplib
import ssl
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
from app.services import (
    automation_runner,
    creator_connectors,
    email_delivery,
    settings_service,
    video_analysis_catalog_service,
)


_cache_lock = threading.Lock()
_cache_until = 0.0
_cached: dict[str, Any] | None = None
_smtp_cache_lock = threading.Lock()
_smtp_cache_until = 0.0
_smtp_cached: dict[str, Any] | None = None


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


def _check_agent_interface() -> dict[str, Any]:
    """Validate the production-critical Agent credential boundary.

    Local development may keep the interface disabled and continue using the
    historical JWT fallback.  Once the public interface is enabled, PAT and
    device-token hashes must use an independent high-entropy pepper so a
    database disclosure cannot be attacked with the JWT signing secret.
    """
    if not settings.AGENT_INTERFACE_ENABLED:
        return {"status": "disabled", "enabled": False}
    pepper = str(settings.AGENT_TOKEN_PEPPER or "").encode("utf-8")
    jwt_secret = str(settings.JWT_SECRET or "").encode("utf-8")
    strong = len(pepper) >= 32 and len(set(pepper)) >= 16
    independent = bool(pepper) and pepper != jwt_secret
    automation_enabled = bool(settings.AGENT_AUTOMATION_ENABLED)
    try:
        automation_poll_seconds = int(settings.AGENT_AUTOMATION_POLL_SECONDS)
    except (TypeError, ValueError):
        automation_poll_seconds = 0
    automation_poll_valid = 5 <= automation_poll_seconds <= 300
    if not strong:
        error_code = "agent_token_pepper_weak"
    elif not independent:
        error_code = "agent_token_pepper_not_independent"
    elif not automation_enabled:
        error_code = "agent_automation_disabled"
    elif not automation_poll_valid:
        error_code = "agent_automation_poll_invalid"
    else:
        error_code = None
    ready = strong and independent and automation_enabled and automation_poll_valid
    return {
        "status": "ready" if ready else "not_ready",
        "enabled": True,
        "independent_credential_pepper": strong and independent,
        "automation_enabled": automation_enabled,
        "automation_poll_seconds": automation_poll_seconds,
        "error_code": error_code,
    }


def _smtp_failure(error_code: str) -> dict[str, Any]:
    """Return a deliberately non-sensitive SMTP readiness result."""

    return {
        "status": "not_ready",
        "configured": email_delivery.is_configured(),
        "tls_verified": False,
        "authenticated": False,
        "protocol_ready": False,
        "error_code": error_code,
    }


def _check_smtp_transport(*, force: bool = False) -> dict[str, Any]:
    """Probe SMTP transport, TLS and authentication without sending email.

    A successful TCP connection alone is not sufficient for Stable. The
    probe verifies the remote certificate through ``create_default_context``,
    authenticates with the configured production account and issues only an
    SMTP ``NOOP``. Hostnames, usernames, passwords and exception text are
    intentionally absent from the returned result and logs.
    """

    global _smtp_cache_until, _smtp_cached
    now = time.monotonic()
    with _smtp_cache_lock:
        if not force and _smtp_cached is not None and now < _smtp_cache_until:
            return dict(_smtp_cached)

    if not email_delivery.is_configured():
        result = _smtp_failure("smtp_not_configured")
    elif not str(settings.SMTP_USER or "").strip() or not str(
        settings.SMTP_PASSWORD or ""
    ):
        result = _smtp_failure("smtp_auth_not_configured")
    elif bool(settings.SMTP_USE_SSL) == bool(settings.SMTP_USE_TLS):
        # Stable requires one explicit encrypted transport mode. Both false is
        # plaintext; both true is ambiguous and may hide a deployment mistake.
        result = _smtp_failure("smtp_tls_mode_invalid")
    else:
        timeout = max(5, min(int(settings.SMTP_TIMEOUT_SECONDS), 60))
        context = ssl.create_default_context()
        smtp: smtplib.SMTP | None = None
        tls_verified = False
        authenticated = False
        error_code: str | None = None
        try:
            if settings.SMTP_USE_SSL:
                smtp = smtplib.SMTP_SSL(
                    settings.SMTP_HOST,
                    settings.SMTP_PORT,
                    timeout=timeout,
                    context=context,
                )
                tls_verified = True
            else:
                smtp = smtplib.SMTP(
                    settings.SMTP_HOST,
                    settings.SMTP_PORT,
                    timeout=timeout,
                )
            ehlo_code, _ = smtp.ehlo()
            if not 200 <= int(ehlo_code) < 300:
                raise smtplib.SMTPHeloError(ehlo_code, b"")
            if settings.SMTP_USE_TLS:
                if not smtp.has_extn("starttls"):
                    error_code = "smtp_starttls_unavailable"
                    raise RuntimeError("STARTTLS unavailable")
                smtp.starttls(context=context)
                tls_verified = True
                ehlo_code, _ = smtp.ehlo()
                if not 200 <= int(ehlo_code) < 300:
                    raise smtplib.SMTPHeloError(ehlo_code, b"")
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            authenticated = True
            noop_code, _ = smtp.noop()
            if not 200 <= int(noop_code) < 300:
                error_code = "smtp_noop_rejected"
                raise RuntimeError("NOOP rejected")
        except smtplib.SMTPAuthenticationError:
            error_code = "smtp_auth_failed"
        except (ssl.SSLError, ssl.CertificateError):
            error_code = "smtp_tls_verification_failed"
        except (OSError, smtplib.SMTPException, RuntimeError):
            error_code = error_code or "smtp_transport_unavailable"
        finally:
            if smtp is not None:
                try:
                    smtp.quit()
                except Exception:
                    pass
        ready = bool(tls_verified and authenticated and error_code is None)
        result = {
            "status": "ready" if ready else "not_ready",
            "configured": True,
            "tls_verified": tls_verified,
            "authenticated": authenticated,
            "protocol_ready": ready,
            "error_code": error_code,
        }

    success_ttl = max(30, min(int(settings.SMTP_READINESS_CACHE_SECONDS), 3600))
    ttl = success_ttl if result["status"] == "ready" else min(success_ttl, 30)
    with _smtp_cache_lock:
        _smtp_cached = dict(result)
        _smtp_cache_until = now + ttl
    return dict(result)


def _check_agent_product_features(
    db: Session,
    *,
    connector_check: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fail Stable readiness when a published cloud Action is a dead end."""

    if not settings.AGENT_INTERFACE_ENABLED:
        return {"status": "disabled", "enabled": False}
    try:
        creator = settings_service.get_creator_sync_config(db)
        creator_platforms = {
            platform: bool((creator.get("platforms") or {}).get(platform))
            for platform in ("douyin", "bilibili", "xiaohongshu")
        }
        creator_catalogs = {
            platform: bool((creator.get("catalog_platforms") or {}).get(platform))
            for platform in ("douyin", "bilibili")
        }
        connector_state = connector_check or _check_connectors(db)
        creator_ready = bool(creator.get("enabled")) and all(
            creator_platforms.values()
        ) and all(creator_catalogs.values()) and connector_state.get("status") == "ready"
        analysis = video_analysis_catalog_service.published_catalog(
            db,
            trigger="agent",
        )
        raw_analysis_items = analysis.get("items")
        analysis_items = raw_analysis_items if isinstance(raw_analysis_items, list) else []
        analysis_ready = bool(analysis.get("enabled")) and bool(analysis_items)
        email_transport = _check_smtp_transport()
        email_ready = email_transport.get("status") == "ready"
    except Exception:
        return {
            "status": "not_ready",
            "enabled": True,
            "error_code": "agent_product_dependency_probe_failed",
        }
    ready = creator_ready and analysis_ready and email_ready
    return {
        "status": "ready" if ready else "not_ready",
        "enabled": True,
        "creator_sync_ready": creator_ready,
        "creator_platforms": creator_platforms,
        "creator_catalogs": creator_catalogs,
        "video_analysis_ready": analysis_ready,
        "published_analysis_offerings": len(analysis_items),
        "email_delivery_ready": email_ready,
        "email_transport": email_transport,
        "error_code": None if ready else "agent_product_dependencies_unavailable",
    }


def _check_agent_automation_runtime() -> dict[str, Any]:
    """Require the persistent automation worker to be alive in Stable mode."""

    if not settings.AGENT_INTERFACE_ENABLED:
        return {"status": "disabled", "enabled": False}
    try:
        runner = automation_runner.runner.status()
        enabled = bool(runner.get("enabled"))
        running = bool(runner.get("running"))
        poll_seconds = int(runner.get("poll_seconds") or 0)
        poll_valid = 5 <= poll_seconds <= 300
        has_recorded_error = bool(str(runner.get("last_error") or "").strip())
    except Exception:
        return {
            "status": "not_ready",
            "enabled": True,
            "error_code": "agent_automation_runtime_probe_failed",
        }
    ready = enabled and running and poll_valid and not has_recorded_error
    if not enabled:
        error_code = "agent_automation_disabled"
    elif not running:
        error_code = "agent_automation_not_running"
    elif not poll_valid:
        error_code = "agent_automation_poll_invalid"
    elif has_recorded_error:
        error_code = "agent_automation_last_error"
    else:
        error_code = None
    return {
        "status": "ready" if ready else "not_ready",
        "enabled": enabled,
        "running": running,
        "poll_seconds": poll_seconds,
        "has_recorded_error": has_recorded_error,
        "error_code": error_code,
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


def _fresh_connector_probe(value: Any) -> dict[str, Any]:
    max_age_hours = max(
        1,
        min(int(settings.CREATOR_CONNECTOR_READINESS_MAX_AGE_HOURS), 168),
    )
    try:
        checked_at = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        if checked_at.tzinfo is None:
            checked_at = checked_at.replace(tzinfo=timezone.utc)
        age_hours = (
            datetime.now(timezone.utc) - checked_at.astimezone(timezone.utc)
        ).total_seconds() / 3600
        fresh = 0 <= age_hours <= max_age_hours
    except (TypeError, ValueError):
        checked_at = None
        age_hours = None
        fresh = False
    return {
        "status": "ready" if fresh else "not_ready",
        "tested_at": _iso(checked_at),
        "age_hours": round(age_hours, 1) if age_hours is not None else None,
        "max_age_hours": max_age_hours,
        "error_code": None if fresh else "creator_connector_probe_stale_or_missing",
    }


def _check_connectors(db: Session) -> dict[str, Any]:
    config = settings_service.get_creator_sync_config(db)
    if not config.get("enabled"):
        return {
            "status": "disabled",
            "enabled": False,
            "platforms": {},
            "catalog": {},
        }
    advertised_platforms = config.get("platforms") or {}
    tested_at = config.get("last_tested_at") or {}
    strict_stable = bool(settings.AGENT_INTERFACE_ENABLED)
    platforms: dict[str, Any] = {}
    catalog: dict[str, Any] = {}
    required_failure = False
    for platform in ("douyin", "bilibili", "xiaohongshu"):
        enabled = bool(advertised_platforms.get(platform))
        probe = _fresh_connector_probe(tested_at.get(platform))
        ready = enabled and (
            probe.get("status") == "ready" or not strict_stable
        )
        required_failure = required_failure or (strict_stable and not ready)
        platforms[platform] = {
            "enabled": enabled,
            **probe,
            "status": "ready" if ready else "not_ready",
            "error_code": (
                None
                if ready
                else "creator_platform_disabled"
                if not enabled
                else probe.get("error_code")
            ),
        }
    for platform in ("douyin", "bilibili"):
        enabled = bool(config.get("catalog_platforms", {}).get(platform))
        if not enabled:
            required_failure = required_failure or strict_stable
            catalog[platform] = {
                "enabled": False,
                "status": "not_ready" if strict_stable else "disabled",
                "error_code": (
                    "creator_catalog_disabled" if strict_stable else None
                ),
            }
            continue
        probe = creator_connectors.catalog_health(platform)
        healthy = bool(probe.get("healthy"))
        required_failure = required_failure or not healthy
        catalog[platform] = {
            "enabled": True,
            "status": "ready" if healthy else "not_ready",
            "version": str(probe.get("version") or "")[:32] or None,
            "error_code": (
                None
                if healthy
                else str(probe.get("error_code") or "")[:96]
                or "creator_catalog_live_probe_failed"
            ),
        }
    return {
        "status": "not_ready" if required_failure else "ready",
        "enabled": True,
        "platforms": platforms,
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
    connector_check = _check_connectors(db)
    checks = {
        "database": _check_database(db),
        "ai_configuration": _check_ai_config(db),
        "agent_interface": _check_agent_interface(),
        "agent_product_features": _check_agent_product_features(
            db,
            connector_check=connector_check,
        ),
        "agent_automation_runtime": _check_agent_automation_runtime(),
        "queues": _check_queues(db),
        "creator_connectors": connector_check,
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
    global _cache_until, _cached, _smtp_cache_until, _smtp_cached
    with _cache_lock:
        _cache_until = 0.0
        _cached = None
    with _smtp_cache_lock:
        _smtp_cache_until = 0.0
        _smtp_cached = None
