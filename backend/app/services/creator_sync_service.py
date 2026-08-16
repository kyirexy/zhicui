"""Saved creator CRUD and idempotent background synchronization."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.creator_sync import (
    ACTIVE_CREATOR_RUN_STATUSES,
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
)
from app.models.note import Note
from app.services import (
    creator_connectors,
    douyin_binding_service,
    library_extraction_service,
    platform_library_service,
    settings_service,
)


MAX_SOURCES_PER_USER = 50
ALLOWED_LIMITS = {20, 50, 100}
_PLATFORM_GATES: dict[str, threading.BoundedSemaphore] = {}
_GATES_LOCK = threading.Lock()


class CreatorSyncError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _feature_config(db: Session, *, include_secret: bool = False) -> dict[str, Any]:
    return settings_service.get_creator_sync_config(db, include_secret=include_secret)


def catalog(db: Session) -> dict[str, Any]:
    config = _feature_config(db)
    return {
        "enabled": bool(config["enabled"]),
        "platforms": config["platforms"],
        "limits": [20, 50, 100],
        "max_sources": MAX_SOURCES_PER_USER,
    }


def _require_enabled(db: Session, platform: str | None = None) -> dict[str, Any]:
    config = _feature_config(db, include_secret=True)
    if not config["enabled"]:
        raise CreatorSyncError("feature_disabled", "指定博主同步尚未开放", 403)
    if platform and not config["platforms"].get(platform, False):
        raise CreatorSyncError("platform_disabled", "该平台的博主连接器尚未开放", 403)
    return config


def _connector_credentials(db: Session, user_id: str, platform: str) -> dict[str, str]:
    config = _require_enabled(db, platform)
    result = {"douyin_session_scope": "", "xhs_cookie": str(config.get("xhs_cookie") or "")}
    if platform == "douyin":
        binding = douyin_binding_service.get_or_create(db, user_id)
        result["douyin_session_scope"] = binding.session_scope
    return result


def resolve_source(db: Session, *, user_id: str, platform: str, profile_ref: str) -> dict[str, Any]:
    credentials = _connector_credentials(db, user_id, platform)
    try:
        preview = creator_connectors.resolve_creator(platform, profile_ref, **credentials)
    except creator_connectors.CreatorConnectorError as exc:
        raise CreatorSyncError(exc.code, str(exc), 422) from exc
    return {
        "platform": preview["platform"],
        "creator_id": preview["creator_id"],
        "profile_url": preview["profile_url"],
        "display_name": preview.get("display_name") or "未命名博主",
        "avatar_url": preview.get("avatar_url") or "",
    }


def save_source(
    db: Session,
    *,
    user_id: str,
    platform: str,
    profile_ref: str,
) -> tuple[CreatorSource, bool]:
    preview = resolve_source(
        db, user_id=user_id, platform=platform, profile_ref=profile_ref
    )
    existing = (
        db.query(CreatorSource)
        .filter(
            CreatorSource.user_id == user_id,
            CreatorSource.platform == preview["platform"],
            CreatorSource.creator_id == preview["creator_id"],
        )
        .first()
    )
    if existing is not None:
        existing.profile_url = preview["profile_url"]
        existing.display_name = preview["display_name"]
        existing.avatar_url = preview["avatar_url"]
        existing.status = "active"
        existing.updated_at = _utcnow()
        db.commit()
        db.refresh(existing)
        return existing, True
    source_count = (
        db.query(CreatorSource)
        .filter(CreatorSource.user_id == user_id, CreatorSource.status == "active")
        .count()
    )
    if source_count >= MAX_SOURCES_PER_USER:
        raise CreatorSyncError("source_limit_reached", "每位用户最多保存 50 个博主", 409)
    source = CreatorSource(user_id=user_id, status="active", **preview)
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        winner = (
            db.query(CreatorSource)
            .filter(
                CreatorSource.user_id == user_id,
                CreatorSource.platform == preview["platform"],
                CreatorSource.creator_id == preview["creator_id"],
            )
            .first()
        )
        if winner is None:
            raise
        return winner, True
    db.refresh(source)
    return source, False


def list_sources(db: Session, *, user_id: str) -> list[dict[str, Any]]:
    sources = (
        db.query(CreatorSource)
        .filter(CreatorSource.user_id == user_id, CreatorSource.status != "disabled")
        .order_by(CreatorSource.updated_at.desc())
        .all()
    )
    result: list[dict[str, Any]] = []
    for source in sources:
        data = source.to_dict()
        last_run = (
            db.query(CreatorSyncRun)
            .filter(CreatorSyncRun.user_id == user_id, CreatorSyncRun.source_id == source.id)
            .order_by(CreatorSyncRun.created_at.desc())
            .first()
        )
        data["last_run"] = last_run.to_dict() if last_run else None
        result.append(data)
    return result


def disable_source(db: Session, *, user_id: str, source_id: str) -> bool:
    source = (
        db.query(CreatorSource)
        .filter(CreatorSource.id == source_id, CreatorSource.user_id == user_id)
        .first()
    )
    if source is None:
        return False
    active = (
        db.query(CreatorSyncRun)
        .filter(
            CreatorSyncRun.user_id == user_id,
            CreatorSyncRun.source_id == source_id,
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
        )
        .first()
    )
    if active is not None:
        raise CreatorSyncError("run_active", "请先取消该博主正在运行的同步任务", 409)
    source.status = "disabled"
    source.updated_at = _utcnow()
    db.commit()
    return True


def create_run(
    db: Session,
    *,
    user_id: str,
    source_id: str,
    limit: int,
) -> tuple[CreatorSyncRun, bool]:
    _require_enabled(db)
    if int(limit) not in ALLOWED_LIMITS:
        raise CreatorSyncError("invalid_limit", "同步数量只支持 20、50 或 100", 422)
    source = (
        db.query(CreatorSource)
        .filter(
            CreatorSource.id == source_id,
            CreatorSource.user_id == user_id,
            CreatorSource.status == "active",
        )
        .first()
    )
    if source is None:
        raise CreatorSyncError("source_not_found", "博主不存在或已停用", 404)
    _require_enabled(db, source.platform)
    active_for_user = (
        db.query(CreatorSyncRun)
        .filter(
            CreatorSyncRun.user_id == user_id,
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
        )
        .order_by(CreatorSyncRun.created_at.desc())
        .first()
    )
    if active_for_user is not None:
        if active_for_user.source_id == source.id:
            return active_for_user, True
        raise CreatorSyncError("user_run_active", "当前已有博主同步任务正在运行", 409)
    run = CreatorSyncRun(
        user_id=user_id,
        source_id=source.id,
        platform=source.platform,
        status="queued",
        requested_limit=int(limit),
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        active = (
            db.query(CreatorSyncRun)
            .filter(
                CreatorSyncRun.user_id == user_id,
                CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
            )
            .order_by(CreatorSyncRun.created_at.desc())
            .first()
        )
        if active is not None and active.source_id == source.id:
            return active, True
        raise CreatorSyncError("user_run_active", "当前已有博主同步任务正在运行", 409)
    db.refresh(run)
    return run, False


def list_runs(db: Session, *, user_id: str, status: str) -> list[CreatorSyncRun]:
    query = db.query(CreatorSyncRun).filter(CreatorSyncRun.user_id == user_id)
    if status == "active":
        query = query.filter(CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES))
    elif status == "recent":
        query = query.filter(~CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES))
    else:
        raise CreatorSyncError("invalid_status", "任务筛选状态无效", 422)
    return query.order_by(CreatorSyncRun.created_at.desc()).limit(20).all()


def get_run(db: Session, *, user_id: str, run_id: str) -> CreatorSyncRun | None:
    return (
        db.query(CreatorSyncRun)
        .filter(CreatorSyncRun.id == run_id, CreatorSyncRun.user_id == user_id)
        .first()
    )


def request_cancel(db: Session, *, user_id: str, run_id: str) -> CreatorSyncRun | None:
    run = get_run(db, user_id=user_id, run_id=run_id)
    if run is None:
        return None
    if run.status == "queued":
        run.status = "cancelled"
        run.finished_at = _utcnow()
    elif run.status in ACTIVE_CREATOR_RUN_STATUSES:
        run.cancellation_requested = True
    db.commit()
    db.refresh(run)
    return run


def _safe_error(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, creator_connectors.CreatorConnectorError):
        return exc.code[:80], str(exc)[:240]
    if isinstance(exc, CreatorSyncError):
        return exc.code[:80], str(exc)[:240]
    if isinstance(exc, ValueError):
        return "item_invalid", str(exc)[:240]
    return "item_failed", "作品文稿准备失败"


def _update_run(db: Session, run: CreatorSyncRun, status: str) -> None:
    now = _utcnow()
    run.status = status
    run.heartbeat_at = now
    run.lease_until = now + timedelta(minutes=5)
    if run.started_at is None:
        run.started_at = now
    db.commit()


def _gate(platform: str, limit: int) -> threading.BoundedSemaphore:
    key = f"{platform}:{limit}"
    with _GATES_LOCK:
        gate = _PLATFORM_GATES.get(key)
        if gate is None:
            gate = threading.BoundedSemaphore(limit)
            _PLATFORM_GATES[key] = gate
        return gate


def _import_work(run: CreatorSyncRun, work: dict[str, Any]) -> tuple[str, str | None]:
    if run.platform == "douyin":
        result = library_extraction_service.extract_library_item(
            user_id=run.user_id,
            aweme_id=work["external_id"],
            operation="transcript",
        )
        return ("reused" if result.get("already_existed") else "imported"), str(result.get("id") or "") or None
    with SessionLocal() as item_db:
        result = platform_library_service.import_one(
            item_db,
            user_id=run.user_id,
            value=work.get("fetch_url") or work["source_url"],
        )
    item = result.get("item") if isinstance(result, dict) else None
    return str(result.get("status") or "imported"), str((item or {}).get("id") or "") or None


def process_run(run_id: str) -> None:
    """Execute one durable run. Safe to call again after process restart."""
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.status in {"succeeded", "partial", "failed", "cancelled"}:
            return
        source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
        if source is None or source.status != "active":
            run.status = "failed"
            run.error_code = "source_unavailable"
            run.error_message = "博主不存在或已停用"
            run.finished_at = _utcnow()
            db.commit()
            return
        config = _feature_config(db, include_secret=True)
        if not config["enabled"]:
            run.status = "failed"
            run.error_code = "feature_disabled"
            run.error_message = "指定博主同步已关闭"
            run.finished_at = _utcnow()
            db.commit()
            return
        binding = douyin_binding_service.get_or_create(db, run.user_id) if run.platform == "douyin" else None
        concurrency = int(config["concurrency"].get(run.platform) or 1)
        credentials = {
            "douyin_session_scope": binding.session_scope if binding else "",
            "douyin_binding_ref": binding.id if binding else "",
            "xhs_cookie": str(config.get("xhs_cookie") or ""),
        }
        run_snapshot = SimpleNamespace(
            id=run.id,
            user_id=run.user_id,
            source_id=run.source_id,
            platform=run.platform,
            requested_limit=run.requested_limit,
        )
        source_snapshot = SimpleNamespace(
            id=source.id,
            platform=source.platform,
            creator_id=source.creator_id,
            profile_url=source.profile_url,
        )
        _update_run(db, run, "resolving")

    gate = _gate(run_snapshot.platform, concurrency)
    try:
        with gate:
            with SessionLocal() as db:
                run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
                if run.cancellation_requested:
                    run.status = "cancelled"
                    run.finished_at = _utcnow()
                    db.commit()
                    return
                _update_run(db, run, "discovering")
            works = creator_connectors.discover_works(
                source_snapshot, run_snapshot.requested_limit, **credentials
            )
            discovered_author = next(
                (
                    str(work.get("author_name") or "").strip()[:160]
                    for work in works
                    if str(work.get("author_name") or "").strip()
                ),
                "",
            )
            if discovered_author:
                with SessionLocal() as db:
                    current_source = db.query(CreatorSource).filter(
                        CreatorSource.id == run_snapshot.source_id
                    ).first()
                    if current_source is not None:
                        current_source.display_name = discovered_author
                        db.commit()
            results: list[dict[str, Any]] = []
            for work in works[: run_snapshot.requested_limit]:
                external_id = str(work.get("external_id") or "")[:192]
                if not external_id:
                    continue
                with SessionLocal() as db:
                    run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                    if run.cancellation_requested:
                        run.status = "cancelled"
                        run.results_json = json.dumps(results, ensure_ascii=False)
                        run.finished_at = _utcnow()
                        db.commit()
                        return
                    run.status = "importing"
                    run.checked_count += 1
                    run.heartbeat_at = _utcnow()
                    item = (
                        db.query(CreatorSourceItem)
                        .filter(
                            CreatorSourceItem.user_id == run.user_id,
                            CreatorSourceItem.platform == run.platform,
                            CreatorSourceItem.external_id == external_id,
                        )
                        .first()
                    )
                    if item is None:
                        item = CreatorSourceItem(
                            user_id=run.user_id,
                            source_id=run.source_id,
                            platform=run.platform,
                            external_id=external_id,
                            source_url=str(work.get("source_url") or "")[:1024],
                        )
                        db.add(item)
                    else:
                        item.last_seen_at = _utcnow()
                    if item.removed_at is not None or item.state == "removed":
                        run.skipped_count += 1
                        results.append({"external_id": external_id, "status": "removed", "error_code": ""})
                        run.results_json = json.dumps(results, ensure_ascii=False)
                        db.commit()
                        continue
                    if item.note_id and db.query(Note).filter(Note.id == item.note_id).first():
                        run.reused_count += 1
                        results.append({"external_id": external_id, "status": "reused", "note_id": item.note_id, "error_code": ""})
                        run.results_json = json.dumps(results, ensure_ascii=False)
                        db.commit()
                        continue
                    db.commit()
                try:
                    with SessionLocal() as db:
                        current = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                        _update_run(db, current, "transcribing")
                    status, note_id = _import_work(run_snapshot, work)
                    with SessionLocal() as db:
                        current = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                        item = (
                            db.query(CreatorSourceItem)
                            .filter(
                                CreatorSourceItem.user_id == current.user_id,
                                CreatorSourceItem.platform == current.platform,
                                CreatorSourceItem.external_id == external_id,
                            )
                            .first()
                        )
                        item.note_id = note_id
                        item.state = "ready"
                        item.error_code = ""
                        if status == "reused":
                            current.reused_count += 1
                        else:
                            current.new_count += 1
                        results.append({"external_id": external_id, "status": status, "note_id": note_id, "error_code": ""})
                        current.results_json = json.dumps(results, ensure_ascii=False)
                        db.commit()
                except Exception as exc:
                    code, _message = _safe_error(exc)
                    with SessionLocal() as db:
                        current = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                        item = (
                            db.query(CreatorSourceItem)
                            .filter(
                                CreatorSourceItem.user_id == current.user_id,
                                CreatorSourceItem.platform == current.platform,
                                CreatorSourceItem.external_id == external_id,
                            )
                            .first()
                        )
                        if item:
                            item.state = "failed"
                            item.error_code = code
                        current.failed_count += 1
                        results.append({"external_id": external_id, "status": "failed", "error_code": code})
                        current.results_json = json.dumps(results, ensure_ascii=False)
                        db.commit()

            with SessionLocal() as db:
                run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
                now = _utcnow()
                run.status = "partial" if run.failed_count else "succeeded"
                run.finished_at = now
                run.heartbeat_at = now
                run.lease_until = None
                source.last_synced_at = now
                if run.status == "succeeded":
                    source.last_success_at = now
                    source.last_error_code = ""
                db.commit()
    except Exception as exc:
        code, message = _safe_error(exc)
        with SessionLocal() as db:
            failed = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
            if failed is not None and failed.status not in {"cancelled", "succeeded", "partial"}:
                failed.status = "failed"
                failed.error_code = code
                failed.error_message = message
                failed.finished_at = _utcnow()
                failed.lease_until = None
                source = db.query(CreatorSource).filter(CreatorSource.id == failed.source_id).first()
                if source:
                    source.last_synced_at = _utcnow()
                    source.last_error_code = code
                db.commit()


def mark_note_permanently_removed(db: Session, *, user_id: str, note_id: str) -> int:
    now = _utcnow()
    return (
        db.query(CreatorSourceItem)
        .filter(CreatorSourceItem.user_id == user_id, CreatorSourceItem.note_id == note_id)
        .update(
            {
                CreatorSourceItem.state: "removed",
                CreatorSourceItem.removed_at: now,
                CreatorSourceItem.note_id: None,
            },
            synchronize_session=False,
        )
    )


def recover_incomplete_runs() -> list[str]:
    """Requeue interrupted work; idempotent item mappings prevent duplicate import."""
    now = _utcnow()
    with SessionLocal() as db:
        rows = (
            db.query(CreatorSyncRun)
            .filter(CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES))
            .all()
        )
        recovered: list[str] = []
        for run in rows:
            lease_until = run.lease_until
            if lease_until is not None and lease_until.tzinfo is None:
                lease_until = lease_until.replace(tzinfo=timezone.utc)
            if run.status == "queued" or lease_until is None or lease_until < now:
                run.status = "queued"
                run.lease_token = None
                run.lease_until = None
                recovered.append(run.id)
        db.commit()
        return recovered
