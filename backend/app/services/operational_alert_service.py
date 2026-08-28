"""Aggregate actionable operations alerts and optionally notify a webhook."""

from __future__ import annotations

import hashlib
import json
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.application_error_log import ApplicationErrorLog
from app.models.creator_sync import CreatorCatalogQualityRun, CreatorSyncRun
from app.models.operational_alert import OperationalAlert
from app.services import readiness_service


_APPLICATION_ERROR_LOOKBACK = timedelta(minutes=10)
_CREATOR_RUN_LOOKBACK = timedelta(hours=24)
_BACKUP_STATUS_FILES = {
    "backup": "last-backup.json",
    "restore_verify": "last-restore-verify.json",
    "offsite": "last-offsite.json",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _safe_meta(value: dict[str, Any]) -> str:
    # Operational dimensions only. Never admit user/source IDs, titles,
    # external IDs, free-form error messages, transcripts, or artifacts.
    allowed = {
        "count", "source", "error_type", "path", "check", "error_code",
        "platform", "operation", "status", "job", "mode",
    }
    return json.dumps(
        {key: str(raw)[:160] for key, raw in value.items() if key in allowed},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _normalized_readiness_status(check: dict[str, Any]) -> str:
    """Accept both current and staged readiness response field names."""
    raw = check.get("status")
    if raw is None:
        raw = check.get("readiness")
    if raw is None:
        raw = check.get("state")
    value = str(raw or "").strip().lower()
    if value in {"not_ready", "failed", "error", "unhealthy", "pending_restore"}:
        return "not_ready"
    if value in {"degraded", "warning", "warn"}:
        return "degraded"
    if value in {"ready", "ok", "healthy", "success", "not_applicable", "disabled"}:
        return "ready"
    ready = check.get("ready")
    if isinstance(ready, bool):
        return "ready" if ready else "not_ready"
    return value


def _readiness_error_code(check: dict[str, Any], fallback: str) -> str:
    for key in ("error_code", "reason_code", "failure_code", "code"):
        value = str(check.get(key) or "").strip()
        if value:
            return value[:96]
    return fallback[:96]


def _parse_status_time(payload: dict[str, Any]) -> datetime | None:
    for key in ("finished_at", "completed_at", "updated_at", "started_at"):
        raw = str(payload.get(key) or "").strip()
        if not raw:
            continue
        try:
            value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return None


def _recent_failed_backup_jobs(now: datetime) -> list[tuple[str, datetime]]:
    """Read only fixed, content-free backup job state files.

    The public readiness document may evolve independently. These two files
    are the durable outcome of the systemd jobs and contain no application
    content; only their status/timestamp is used here.
    """
    state_dir = Path(settings.BACKUP_STATUS_FILE).parent
    cutoff = now - timedelta(hours=max(1, settings.BACKUP_MAX_AGE_HOURS))
    failed: list[tuple[str, datetime]] = []
    for job, filename in _BACKUP_STATUS_FILES.items():
        path = state_dir / filename
        try:
            if path.stat().st_size > 64 * 1024:
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        if str(payload.get("status") or "").strip().lower() not in {
            "failed", "failure", "error",
        }:
            continue
        finished_at = _parse_status_time(payload)
        if finished_at is None or finished_at.astimezone(timezone.utc) < cutoff:
            continue
        failed.append((job, finished_at))
    return failed


def upsert_alert(
    db: Session,
    *,
    category: str,
    severity: str,
    title: str,
    message: str,
    identity: tuple[str, ...],
    metadata: dict[str, Any] | None = None,
) -> OperationalAlert:
    now = _now()
    fingerprint = _fingerprint(category, *identity)
    row = db.query(OperationalAlert).filter(OperationalAlert.fingerprint == fingerprint).first()
    if row is None:
        row = OperationalAlert(
            fingerprint=fingerprint,
            category=category[:48],
            severity=severity[:16],
            title=title[:160],
            message=message[:500],
            status="open",
            occurrence_count=1,
            metadata_json=_safe_meta(metadata or {}),
            first_seen_at=now,
            last_seen_at=now,
        )
        db.add(row)
    else:
        row.severity = severity[:16]
        row.title = title[:160]
        row.message = message[:500]
        row.metadata_json = _safe_meta(metadata or {})
        row.last_seen_at = now
        row.occurrence_count += 1
        if row.status == "resolved":
            row.status = "open"
            row.resolved_at = None
    db.commit()
    db.refresh(row)
    _notify_if_due(db, row)
    return row


def _notify_if_due(db: Session, row: OperationalAlert, *, event: str = "zhicui.operational_alert") -> None:
    url = settings.ALERT_WEBHOOK_URL.strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return
    now = _now()
    last_notified = _aware(row.last_notified_at)
    if (
        event == "zhicui.operational_alert"
        and last_notified
        and (now - last_notified).total_seconds() < max(60, settings.ALERT_WEBHOOK_COOLDOWN_SECONDS)
    ):
        return
    payload = json.dumps(
        {
            "event": event,
            "id": row.id,
            "severity": row.severity,
            "category": row.category,
            "title": row.title,
            "message": row.message,
            "occurrence_count": row.occurrence_count,
            "last_seen_at": row.last_seen_at.isoformat(),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    try:
        request = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "Zhicui-Ops/1.0"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status < 200 or response.status >= 300:
                return
        row.last_notified_at = now
        db.commit()
    except Exception:
        db.rollback()


def refresh_alerts(db: Session) -> dict[str, int]:
    now = _now()
    cutoff = now - _APPLICATION_ERROR_LOOKBACK
    groups = (
        db.query(
            ApplicationErrorLog.source,
            ApplicationErrorLog.error_type,
            ApplicationErrorLog.path,
            ApplicationErrorLog.severity,
            func.count(ApplicationErrorLog.id),
        )
        .filter(ApplicationErrorLog.created_at >= cutoff)
        .group_by(
            ApplicationErrorLog.source,
            ApplicationErrorLog.error_type,
            ApplicationErrorLog.path,
            ApplicationErrorLog.severity,
        )
        .all()
    )
    created = 0
    active_fingerprints: set[str] = set()
    for source, error_type, path, severity, count in groups:
        count = int(count or 0)
        if severity != "critical" and count < 3:
            continue
        row = upsert_alert(
            db,
            category="application_error",
            severity="critical" if severity == "critical" else "error",
            title=f"{source} 出现持续错误",
            message=f"{error_type} 在 10 分钟内出现 {count} 次，请检查运行日志。",
            identity=(str(source), str(error_type), str(path or "")),
            metadata={"count": count, "source": source, "error_type": error_type, "path": path or ""},
        )
        active_fingerprints.add(row.fingerprint)
        created += 1

    creator_cutoff = now - _CREATOR_RUN_LOOKBACK
    creator_groups = (
        db.query(
            CreatorSyncRun.platform,
            CreatorSyncRun.operation,
            CreatorSyncRun.status,
            CreatorSyncRun.needs_action,
            CreatorSyncRun.needs_action_code,
            CreatorSyncRun.error_code,
            func.count(CreatorSyncRun.id),
        )
        .filter(
            CreatorSyncRun.updated_at >= creator_cutoff,
            or_(
                CreatorSyncRun.status.in_(("failed", "partial")),
                CreatorSyncRun.needs_action.is_(True),
            ),
        )
        .group_by(
            CreatorSyncRun.platform,
            CreatorSyncRun.operation,
            CreatorSyncRun.status,
            CreatorSyncRun.needs_action,
            CreatorSyncRun.needs_action_code,
            CreatorSyncRun.error_code,
        )
        .all()
    )
    platform_labels = {"douyin": "抖音", "bilibili": "B站"}
    issue_labels = {
        "failed": "失败",
        "partial": "部分完成",
        "needs_action": "需要人工处理",
    }
    for platform, operation, status, needs_action, action_code, error_code, count in creator_groups:
        issue = "needs_action" if needs_action else str(status or "failed")
        safe_platform = str(platform or "unknown")[:24]
        safe_operation = str(operation or "unknown")[:32]
        safe_code = str(action_code if needs_action else error_code or issue)[:80]
        count = int(count or 0)
        row = upsert_alert(
            db,
            category="creator_sync",
            severity="error" if status == "failed" else "warning",
            title=(
                f"{platform_labels.get(safe_platform, '博主')}同步任务"
                f"{issue_labels.get(issue, '异常')}"
            ),
            message=f"最近 24 小时检测到 {count} 个任务需要检查，请在管理端处理。",
            identity=(safe_platform, safe_operation, issue, safe_code),
            metadata={
                "count": count,
                "platform": safe_platform,
                "operation": safe_operation,
                "status": issue,
                "error_code": safe_code,
            },
        )
        active_fingerprints.add(row.fingerprint)
        created += 1

    quality_groups = (
        db.query(
            CreatorCatalogQualityRun.platform,
            CreatorCatalogQualityRun.mode,
            func.count(CreatorCatalogQualityRun.id),
        )
        .filter(
            CreatorCatalogQualityRun.updated_at >= creator_cutoff,
            CreatorCatalogQualityRun.status == "failed",
        )
        .group_by(
            CreatorCatalogQualityRun.platform,
            CreatorCatalogQualityRun.mode,
        )
        .all()
    )
    for platform, mode, count in quality_groups:
        safe_platform = str(platform or "all")[:24]
        safe_mode = str(mode or "backfill")[:24]
        count = int(count or 0)
        row = upsert_alert(
            db,
            category="creator_catalog_quality",
            severity="error",
            title="博主目录质量任务失败",
            message=f"最近 24 小时检测到 {count} 个质量任务失败，请检查任务运行状态。",
            identity=(safe_platform, safe_mode, "failed"),
            metadata={
                "count": count,
                "platform": safe_platform,
                "mode": safe_mode,
                "status": "failed",
            },
        )
        active_fingerprints.add(row.fingerprint)
        created += 1

    failed_backup_jobs = _recent_failed_backup_jobs(now)
    for job, _finished_at in failed_backup_jobs:
        job_label = {
            "backup": "数据库备份",
            "restore_verify": "备份恢复验证",
            "offsite": "异地灾备复制与校验",
        }.get(job, "备份任务")
        row = upsert_alert(
            db,
            category="backup_job",
            severity="critical",
            title=f"{job_label}失败",
            message="最近一次任务未完成，请检查受控的 systemd 任务日志。",
            identity=(job, "failed"),
            metadata={"job": job, "status": "failed"},
        )
        active_fingerprints.add(row.fingerprint)
        created += 1

    readiness = readiness_service.get_readiness(db, force=True)
    for name, check in (readiness.get("checks") or {}).items():
        if not isinstance(check, dict):
            continue
        check_status = _normalized_readiness_status(check)
        if check_status not in {"not_ready", "degraded"}:
            continue
        error_code = _readiness_error_code(check, check_status)
        row = upsert_alert(
            db,
            category="readiness",
            severity="critical" if check_status == "not_ready" else "warning",
            title=f"生产依赖 {name} 未就绪",
            message="深度健康检查未通过，请查看管理端脱敏详情。",
            identity=(str(name), error_code),
            metadata={"check": name, "error_code": error_code},
        )
        active_fingerprints.add(row.fingerprint)
        created += 1
    resolved = 0
    for row in db.query(OperationalAlert).filter(
        OperationalAlert.status.in_(["open", "acknowledged"])
    ).all():
        if row.fingerprint in active_fingerprints:
            continue
        last_seen = _aware(row.last_seen_at) or _now()
        if row.category == "application_error" and last_seen >= cutoff:
            continue
        row.status = "resolved"
        row.resolved_at = now
        db.commit()
        _notify_if_due(db, row, event="zhicui.operational_alert.resolved")
        resolved += 1
    return {
        "observed": (
            len(groups) + len(creator_groups) + len(quality_groups)
            + len(failed_backup_jobs)
        ),
        "alerts": created,
        "resolved": resolved,
    }


def list_alerts(db: Session, *, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    query = db.query(OperationalAlert)
    if status in {"open", "acknowledged", "resolved"}:
        query = query.filter(OperationalAlert.status == status)
    rows = query.order_by(OperationalAlert.last_seen_at.desc()).limit(max(1, min(limit, 200))).all()
    return [
        {
            "id": row.id,
            "category": row.category,
            "severity": row.severity,
            "title": row.title,
            "message": row.message,
            "status": row.status,
            "occurrence_count": row.occurrence_count,
            "metadata": json.loads(row.metadata_json or "{}"),
            "first_seen_at": row.first_seen_at.isoformat(),
            "last_seen_at": row.last_seen_at.isoformat(),
            "acknowledged_at": row.acknowledged_at.isoformat() if row.acknowledged_at else None,
            "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
        }
        for row in rows
    ]


def acknowledge(db: Session, alert_id: str, admin_user_id: str) -> bool:
    row = db.query(OperationalAlert).filter(OperationalAlert.id == alert_id).first()
    if row is None:
        return False
    row.status = "acknowledged"
    row.acknowledged_at = _now()
    row.acknowledged_by = admin_user_id[:64]
    db.commit()
    return True
