"""Durable preview, repair and quarantine workflow for creator catalogs.

The workflow is intentionally conservative: it only copies already persisted
public metadata from the same user's linked Note/CreatorSource.  It never
replays a platform request, restores a tombstone, or touches cookies/media
URLs.  Network refreshes remain explicit user sync operations and therefore
keep their existing platform cooldown and cancellation semantics.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.core.database import SessionLocal
from app.models.creator_sync import (
    CreatorCatalogQualityRun,
    CreatorCatalogQualityRunItem,
    CreatorSource,
    CreatorSourceItem,
)
from app.models.note import Note
from app.services.creator_item_quality import assess_catalog_metadata


SUPPORTED_PLATFORMS = {"douyin", "bilibili"}
RUN_MODES = {"backfill", "quarantine"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
MIN_TRANSCRIPT_CHARS = 80
LEASE_SECONDS = 30
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{8,96}$")
_BILI_COVER_HOSTS = {
    "i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com", "archive.biliimg.com",
}


class CatalogQualityError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _note_source_meta(note: Note | None) -> dict[str, Any]:
    if note is None or not note.ai_summary:
        return {}
    try:
        value = json.loads(note.ai_summary)
    except (TypeError, json.JSONDecodeError):
        return {}
    meta = value.get("source_meta") if isinstance(value, dict) else None
    return meta if isinstance(meta, dict) else {}


def _published_at(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware(parsed)


def _safe_bilibili_cover(value: object) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or (parsed.hostname or "").lower() not in _BILI_COVER_HOSTS
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return urlunparse(("https", parsed.netloc, parsed.path, "", "", ""))[:2048]


def _issues(item: CreatorSourceItem, note: Note | None = None) -> dict[str, Any]:
    decision = assess_catalog_metadata(item)
    issues = list(decision["quality_issues"])
    if note is not None and len((note.transcript_raw or "").strip()) < MIN_TRANSCRIPT_CHARS:
        issues.append("short_transcript")
    decision["quality_issues"] = list(dict.fromkeys(issues))
    decision["needs_enrichment"] = bool(issues)
    return decision


def _apply_decision(
    item: CreatorSourceItem,
    decision: dict[str, Any],
    *,
    quarantine: bool = False,
) -> None:
    now = _utcnow()
    issues = list(decision.get("quality_issues") or [])
    should_quarantine = quarantine and bool(
        decision.get("transcription_blocked") or "short_transcript" in issues
    )
    item.metadata_quality = (
        "quarantined" if should_quarantine else str(decision["metadata_quality"])
    )
    item.quality_issues_json = json.dumps(
        issues, ensure_ascii=True, separators=(",", ":"),
    )
    item.needs_enrichment = bool(issues)
    item.transcription_blocked = bool(
        should_quarantine or decision.get("transcription_blocked")
    )
    item.quality_checked_at = now
    item.quarantined_at = now if should_quarantine else None


def _backfill_local_metadata(
    item: CreatorSourceItem,
    source: CreatorSource | None,
    note: Note | None,
) -> bool:
    """Copy only trusted, already persisted display metadata for this row."""
    before = (
        item.title, item.cover_url, item.description, item.author_name,
        item.published_at,
    )
    meta = _note_source_meta(note)
    if not item.author_name:
        item.author_name = str(
            meta.get("author_name") or (source.display_name if source else "") or ""
        ).strip()[:160]
    current = assess_catalog_metadata(item)
    if (
        note is not None
        and any(issue in current["quality_issues"] for issue in ("missing_title", "placeholder_title"))
    ):
        candidate = str(note.video_title or "").strip()[:512]
        if candidate:
            candidate_decision = assess_catalog_metadata({
                "title": candidate,
                "author_name": item.author_name,
                "source_url": item.source_url,
                "cover_url": item.cover_url,
                "description": item.description,
                "published_at": item.published_at,
            })
            if "placeholder_title" not in candidate_decision["quality_issues"]:
                item.title = candidate
    if not item.description:
        item.description = str(
            meta.get("description") or meta.get("caption") or ""
        ).strip()[:4000]
    if not item.cover_url and item.platform == "bilibili":
        item.cover_url = _safe_bilibili_cover(meta.get("cover_url"))
    if item.published_at is None:
        item.published_at = _published_at(meta.get("published_at"))
    after = (
        item.title, item.cover_url, item.description, item.author_name,
        item.published_at,
    )
    return after != before


def preview(db: Session, *, platform: str = "") -> dict[str, Any]:
    normalized = str(platform or "").strip().lower()
    if normalized and normalized not in SUPPORTED_PLATFORMS:
        raise CatalogQualityError("invalid_platform", "目录质量平台筛选无效", 422)
    query = db.query(CreatorSourceItem).filter(
        CreatorSourceItem.removed_at.is_(None),
        CreatorSourceItem.state != "removed",
    )
    if normalized:
        query = query.filter(CreatorSourceItem.platform == normalized)
    rows = query.order_by(CreatorSourceItem.id.asc()).all()
    note_ids = {row.note_id for row in rows if row.note_id}
    notes = (
        db.query(Note).filter(Note.id.in_(note_ids)).all() if note_ids else []
    )
    note_map = {note.id: note for note in notes}
    by_platform: dict[str, int] = {}
    by_issue: dict[str, int] = {}
    affected = 0
    blocked = 0
    quarantined = 0
    samples: list[dict[str, str]] = []
    for item in rows:
        decision = _issues(item, note_map.get(item.note_id or ""))
        issues = decision["quality_issues"]
        if not issues:
            continue
        affected += 1
        by_platform[item.platform] = by_platform.get(item.platform, 0) + 1
        for issue in issues:
            by_issue[issue] = by_issue.get(issue, 0) + 1
        if decision["transcription_blocked"] or "short_transcript" in issues:
            blocked += 1
        if item.metadata_quality == "quarantined":
            quarantined += 1
        if len(samples) < 20:
            samples.append({
                "item_id": item.id,
                "platform": item.platform,
                "external_id": item.external_id,
            })
    return {
        "read_only": True,
        "platform": normalized or None,
        "total": len(rows),
        "affected": affected,
        "transcription_blocked": blocked,
        "quarantined": quarantined,
        "by_platform": by_platform,
        "by_issue": by_issue,
        "samples": samples,
        "checked_at": _utcnow().isoformat(),
    }


def create_run(
    db: Session,
    *,
    requested_by_id: str,
    mode: str,
    idempotency_key: str,
    platform: str = "",
    batch_size: int = 50,
    cooldown_seconds: int = 5,
) -> tuple[CreatorCatalogQualityRun, bool]:
    normalized_mode = str(mode or "").strip().lower()
    normalized_platform = str(platform or "").strip().lower()
    key = str(idempotency_key or "").strip()
    if normalized_mode not in RUN_MODES:
        raise CatalogQualityError("invalid_mode", "质量任务类型无效", 422)
    if normalized_platform and normalized_platform not in SUPPORTED_PLATFORMS:
        raise CatalogQualityError("invalid_platform", "目录质量平台筛选无效", 422)
    if not _IDEMPOTENCY_KEY.fullmatch(key):
        raise CatalogQualityError("invalid_idempotency_key", "幂等键格式无效", 422)
    if not 1 <= int(batch_size) <= 200:
        raise CatalogQualityError("invalid_batch_size", "每批只能处理 1 至 200 条", 422)
    if not 0 <= int(cooldown_seconds) <= 3600:
        raise CatalogQualityError("invalid_cooldown", "批次冷却时间无效", 422)
    existing = db.query(CreatorCatalogQualityRun).filter(
        CreatorCatalogQualityRun.requested_by_id == requested_by_id,
        CreatorCatalogQualityRun.idempotency_key == key,
    ).first()
    if existing is not None:
        return existing, True
    run = CreatorCatalogQualityRun(
        requested_by_id=requested_by_id,
        idempotency_key=key,
        mode=normalized_mode,
        platform=normalized_platform,
        batch_size=int(batch_size),
        cooldown_seconds=int(cooldown_seconds),
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(CreatorCatalogQualityRun).filter(
            CreatorCatalogQualityRun.requested_by_id == requested_by_id,
            CreatorCatalogQualityRun.idempotency_key == key,
        ).first()
        if existing is not None:
            return existing, True
        raise
    db.refresh(run)
    return run, False


def get_run(db: Session, run_id: str) -> CreatorCatalogQualityRun | None:
    return db.query(CreatorCatalogQualityRun).filter(
        CreatorCatalogQualityRun.id == run_id,
    ).first()


def list_runs(db: Session, *, limit: int = 30) -> list[CreatorCatalogQualityRun]:
    return db.query(CreatorCatalogQualityRun).order_by(
        CreatorCatalogQualityRun.created_at.desc(),
    ).limit(max(1, min(int(limit), 100))).all()


def list_run_items(
    db: Session, *, run_id: str, limit: int = 100,
) -> list[CreatorCatalogQualityRunItem]:
    return db.query(CreatorCatalogQualityRunItem).filter(
        CreatorCatalogQualityRunItem.run_id == run_id,
    ).order_by(CreatorCatalogQualityRunItem.created_at.asc()).limit(
        max(1, min(int(limit), 200))
    ).all()


def request_cancel(
    db: Session, run_id: str,
) -> CreatorCatalogQualityRun | None:
    run = get_run(db, run_id)
    if run is None:
        return None
    if run.status not in TERMINAL_STATUSES:
        run.cancellation_requested = True
        run.status = "cancelled"
        run.finished_at = _utcnow()
        run.next_batch_at = None
        run.lease_token = ""
        run.lease_expires_at = None
        db.commit()
        db.refresh(run)
    return run


def process_batch(run_id: str) -> dict[str, Any] | None:
    """Process at most one bounded batch and persist a resumable cursor."""
    with SessionLocal() as db:
        run = get_run(db, run_id)
        if run is None:
            return None
        if run.status in TERMINAL_STATUSES:
            return run.to_dict()
        now = _utcnow()
        next_batch_at = _aware(run.next_batch_at)
        lease_expires_at = _aware(run.lease_expires_at)
        if run.status == "queued" and next_batch_at is not None and next_batch_at > now:
            return run.to_dict()
        if run.status == "running" and lease_expires_at is not None and lease_expires_at > now:
            return run.to_dict()
        if run.cancellation_requested:
            run.status = "cancelled"
            run.finished_at = now
            run.next_batch_at = None
            run.lease_token = ""
            run.lease_expires_at = None
            db.commit()
            return run.to_dict()
        # Claim the batch atomically.  Admin retries and duplicate background
        # deliveries must observe the running claim instead of processing the
        # same cursor window concurrently.
        lease_token = uuid.uuid4().hex
        claimed = db.query(CreatorCatalogQualityRun).filter(
            CreatorCatalogQualityRun.id == run_id,
            CreatorCatalogQualityRun.cancellation_requested.is_(False),
            or_(
                (
                    (CreatorCatalogQualityRun.status == "queued")
                    & or_(
                        CreatorCatalogQualityRun.next_batch_at.is_(None),
                        CreatorCatalogQualityRun.next_batch_at <= now,
                    )
                ),
                (
                    (CreatorCatalogQualityRun.status == "running")
                    & or_(
                        CreatorCatalogQualityRun.lease_expires_at.is_(None),
                        CreatorCatalogQualityRun.lease_expires_at <= now,
                    )
                ),
            ),
        ).update(
            {
                CreatorCatalogQualityRun.status: "running",
                CreatorCatalogQualityRun.started_at: (
                    run.started_at or now
                ),
                CreatorCatalogQualityRun.next_batch_at: None,
                CreatorCatalogQualityRun.lease_token: lease_token,
                CreatorCatalogQualityRun.lease_expires_at: (
                    now + timedelta(seconds=LEASE_SECONDS)
                ),
            },
            synchronize_session=False,
        )
        db.commit()
        if claimed != 1:
            current = get_run(db, run_id)
            return current.to_dict() if current is not None else None
        run = get_run(db, run_id)
        if run is None:
            return None

        query = db.query(CreatorSourceItem).filter(
            CreatorSourceItem.removed_at.is_(None),
            CreatorSourceItem.state != "removed",
            CreatorSourceItem.first_seen_at <= run.created_at,
        )
        if run.platform:
            query = query.filter(CreatorSourceItem.platform == run.platform)
        if run.cursor:
            query = query.filter(CreatorSourceItem.id > run.cursor)
        rows = query.order_by(CreatorSourceItem.id.asc()).limit(run.batch_size).all()

        for item in rows:
            db.expire(run)
            db.refresh(run)
            if run.lease_token != lease_token:
                # Another worker reclaimed an expired lease.  Do not overwrite
                # its state; the per-item unique key keeps retry idempotent.
                return run.to_dict()
            if run.cancellation_requested or run.status == "cancelled":
                run.status = "cancelled"
                run.finished_at = _utcnow()
                run.next_batch_at = None
                run.lease_token = ""
                run.lease_expires_at = None
                db.commit()
                return run.to_dict()
            run.lease_expires_at = _utcnow() + timedelta(seconds=LEASE_SECONDS)
            run.cursor = item.id
            # Re-check after selection: a user may have removed the item while
            # this durable admin task was waiting in its cooldown window.
            if item.removed_at is not None or item.state == "removed":
                run.skipped_count += 1
                db.commit()
                continue
            existing = db.query(CreatorCatalogQualityRunItem).filter(
                CreatorCatalogQualityRunItem.run_id == run.id,
                CreatorCatalogQualityRunItem.source_item_id == item.id,
            ).first()
            if existing is not None:
                run.skipped_count += 1
                db.commit()
                continue
            note = db.query(Note).filter(Note.id == item.note_id).first() if item.note_id else None
            source = db.query(CreatorSource).filter(
                CreatorSource.id == item.source_id,
                CreatorSource.user_id == item.user_id,
            ).first()
            before = _issues(item, note)
            changed = False
            status = "unchanged"
            if before["quality_issues"]:
                run.eligible_count += 1
                if run.mode == "backfill":
                    changed = _backfill_local_metadata(item, source, note)
                    after = _issues(item, note)
                    _apply_decision(item, after)
                    if changed:
                        run.updated_count += 1
                        status = "updated"
                else:
                    after = before
                    should_quarantine = bool(
                        before["transcription_blocked"]
                        or "short_transcript" in before["quality_issues"]
                    )
                    _apply_decision(item, before, quarantine=should_quarantine)
                    if should_quarantine:
                        run.quarantined_count += 1
                        status = "quarantined"
            else:
                after = before
                _apply_decision(item, before)
            run.scanned_count += 1
            db.add(CreatorCatalogQualityRunItem(
                run_id=run.id,
                source_item_id=item.id,
                user_id=item.user_id,
                source_id=item.source_id,
                platform=item.platform,
                external_id=item.external_id,
                action=run.mode,
                status=status,
                issues_before_json=json.dumps(before["quality_issues"], separators=(",", ":")),
                issues_after_json=json.dumps(after["quality_issues"], separators=(",", ":")),
            ))
            db.commit()

        db.expire(run)
        db.refresh(run)
        if run.lease_token != lease_token:
            return run.to_dict()
        if run.cancellation_requested or run.status == "cancelled":
            run.status = "cancelled"
            run.finished_at = _utcnow()
            run.next_batch_at = None
        elif len(rows) < run.batch_size:
            run.status = "completed"
            run.finished_at = _utcnow()
            run.next_batch_at = None
        else:
            run.status = "queued"
            run.next_batch_at = _utcnow() + timedelta(seconds=run.cooldown_seconds)
        run.lease_token = ""
        run.lease_expires_at = None
        run.summary_json = json.dumps({
            "last_cursor": run.cursor,
            "batch_processed": len(rows),
            "network_requests": 0,
            "tombstones_restored": 0,
        }, separators=(",", ":"))
        db.commit()
        db.refresh(run)
        return run.to_dict()


def due_run_ids(*, limit: int = 20) -> list[str]:
    """Return due or lease-expired runs for the persistent worker scanner."""
    now = _utcnow()
    with SessionLocal() as db:
        rows = db.query(CreatorCatalogQualityRun.id).filter(
            CreatorCatalogQualityRun.cancellation_requested.is_(False),
            or_(
                (
                    (CreatorCatalogQualityRun.status == "queued")
                    & or_(
                        CreatorCatalogQualityRun.next_batch_at.is_(None),
                        CreatorCatalogQualityRun.next_batch_at <= now,
                    )
                ),
                (
                    (CreatorCatalogQualityRun.status == "running")
                    & or_(
                        CreatorCatalogQualityRun.lease_expires_at.is_(None),
                        CreatorCatalogQualityRun.lease_expires_at <= now,
                    )
                ),
            ),
        ).order_by(
            CreatorCatalogQualityRun.created_at.asc(),
        ).limit(max(1, min(int(limit), 100))).all()
        return [str(row[0]) for row in rows]
