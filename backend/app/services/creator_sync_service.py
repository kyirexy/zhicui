"""Saved creator CRUD and durable, user-scoped synchronization.

Catalog refreshes update ``CreatorSourceItem`` in place, while recent and
selected transcript runs keep bounded per-item progress rows. Connector
responses cross a strict allow-list before persistence.
"""

from __future__ import annotations

import json
import math
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from sqlalchemy import case, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.creator_sync import (
    ACTIVE_CREATOR_RUN_STATUSES,
    TERMINAL_CREATOR_RUN_STATUSES,
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
)
from app.models.note import Note
from app.services import (
    creator_connectors,
    douyin_binding_service,
    douyin_library,
    library_extraction_service,
    platform_library_service,
    settings_service,
)


MAX_SOURCES_PER_USER = 50
MAX_SELECTED_ITEMS = 50
DEFAULT_PAGE_SIZE = 50
ALLOWED_LIMITS = {20, 50, 100}
ALLOWED_OPERATIONS = {
    "recent_transcript",
    "catalog_all",
    "selected_transcript",
}
CATALOG_PLATFORMS = {"douyin", "bilibili"}
RETRY_DELAYS_SECONDS = (30, 120, 600)
LEASE_SECONDS = 300
LEASE_HEARTBEAT_SECONDS = 60

_PLATFORM_GATES: dict[str, threading.BoundedSemaphore] = {}
_GATES_LOCK = threading.Lock()
_PLATFORM_PAGE_HOSTS = {
    "douyin": {"douyin.com", "www.douyin.com", "v.douyin.com"},
    "bilibili": {"bilibili.com", "www.bilibili.com", "b23.tv"},
    "xiaohongshu": {
        "xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com", "www.xhslink.com",
    },
}
_NEEDS_ACTION_TOKENS = (
    "login", "auth", "captcha", "verify", "verification", "challenge", "risk",
    "风控", "验证码",
)
_TRANSIENT_TOKENS = (
    "timeout", "temporary", "transient", "unavailable", "rate_limit", "network",
    "connection", "upstream", "incomplete", "multipart_partial",
)


class CreatorSyncError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class _RunCancelled(RuntimeError):
    pass


class _PartialImportError(RuntimeError):
    def __init__(self, note_id: str):
        super().__init__("多 P 视频只完成了部分文稿")
        self.note_id = note_id


def _renew_lease(run_id: str, lease_token: str) -> bool:
    """Extend a lease from an independent short-lived database session."""
    now = _utcnow()
    with SessionLocal() as db:
        updated = db.query(CreatorSyncRun).filter(
            CreatorSyncRun.id == run_id,
            CreatorSyncRun.lease_token == lease_token,
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
            CreatorSyncRun.cancellation_requested.is_(False),
        ).update(
            {
                CreatorSyncRun.heartbeat_at: now,
                CreatorSyncRun.lease_until: now + timedelta(seconds=LEASE_SECONDS),
            },
            synchronize_session=False,
        )
        db.commit()
        return updated == 1


class _LeaseHeartbeat:
    """Renew a claimed run while a connector/ASR call is blocking."""

    def __init__(
        self,
        run_id: str,
        lease_token: str,
        interval_seconds: float = LEASE_HEARTBEAT_SECONDS,
    ) -> None:
        self.run_id = run_id
        self.lease_token = lease_token
        self.interval_seconds = max(0.01, float(interval_seconds))
        self._stop = threading.Event()
        self._lost = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def lost(self) -> bool:
        return self._lost.is_set()

    def __enter__(self) -> "_LeaseHeartbeat":
        self._thread = threading.Thread(
            target=self._loop,
            name=f"creator-lease-{self.run_id[-8:]}",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                renewed = _renew_lease(self.run_id, self.lease_token)
            except Exception:
                renewed = False
            if not renewed:
                self._lost.set()
                return

    def ensure(self) -> None:
        if self.lost:
            raise _RunCancelled("任务租约已转移或取消")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _feature_config(db: Session, *, include_secret: bool = False) -> dict[str, Any]:
    return settings_service.get_creator_sync_config(db, include_secret=include_secret)


def catalog(db: Session) -> dict[str, Any]:
    config = _feature_config(db)
    catalog_platforms = config.get("catalog_platforms") or config["platforms"]
    catalog_operations = {
        "recent_transcript": dict(config["platforms"]),
        "selected_transcript": {
            platform: bool(enabled and platform in CATALOG_PLATFORMS)
            for platform, enabled in config["platforms"].items()
        },
        "catalog_all": {
            platform: bool(
                enabled
                and platform in CATALOG_PLATFORMS
                and catalog_platforms.get(platform, False)
            )
            for platform, enabled in config["platforms"].items()
        },
    }
    return {
        "enabled": bool(config["enabled"]),
        "platforms": config["platforms"],
        "limits": [20, 50, 100],
        "operations": sorted(ALLOWED_OPERATIONS),
        "catalog_operations": catalog_operations,
        "catalog_platforms": sorted(CATALOG_PLATFORMS),
        "max_sources": MAX_SOURCES_PER_USER,
        "max_selected_items": MAX_SELECTED_ITEMS,
        "catalog_page_size": DEFAULT_PAGE_SIZE,
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
    result = {
        "douyin_session_scope": "",
        "douyin_binding_ref": "",
        "xhs_cookie": str(config.get("xhs_cookie") or ""),
    }
    if platform == "douyin":
        binding = douyin_binding_service.get_or_create(db, user_id)
        result["douyin_session_scope"] = binding.session_scope
        result["douyin_binding_ref"] = binding.id
    return result


def _source_snapshot(source: CreatorSource) -> dict[str, str]:
    return {
        "id": source.id,
        "platform": source.platform,
        "creator_id": source.creator_id,
        "profile_url": source.profile_url,
        "display_name": source.display_name,
        "avatar_url": source.avatar_url,
    }


def _snapshot_json(source: CreatorSource) -> str:
    return json.dumps(_source_snapshot(source), ensure_ascii=False, separators=(",", ":"))


def _get_source(
    db: Session, *, user_id: str, source_id: str, active_only: bool = False,
) -> CreatorSource:
    query = db.query(CreatorSource).filter(
        CreatorSource.id == source_id, CreatorSource.user_id == user_id,
    )
    if active_only:
        query = query.filter(CreatorSource.status == "active")
    source = query.first()
    if source is None:
        raise CreatorSyncError("source_not_found", "博主不存在或已停用", 404)
    return source


def resolve_source(
    db: Session, *, user_id: str, platform: str, profile_ref: str,
) -> dict[str, Any]:
    credentials = _connector_credentials(db, user_id, platform)
    try:
        preview = creator_connectors.resolve_creator(
            platform,
            profile_ref,
            douyin_session_scope=credentials.get("douyin_session_scope", ""),
            xhs_cookie=credentials.get("xhs_cookie", ""),
        )
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
    db: Session, *, user_id: str, platform: str, profile_ref: str,
) -> tuple[CreatorSource, bool]:
    preview = resolve_source(db, user_id=user_id, platform=platform, profile_ref=profile_ref)
    existing = db.query(CreatorSource).filter(
        CreatorSource.user_id == user_id,
        CreatorSource.platform == preview["platform"],
        CreatorSource.creator_id == preview["creator_id"],
    ).first()
    if existing is not None:
        existing.profile_url = preview["profile_url"]
        existing.display_name = preview["display_name"]
        existing.avatar_url = preview["avatar_url"]
        existing.status = "active"
        existing.updated_at = _utcnow()
        db.commit()
        db.refresh(existing)
        return existing, True
    source_count = db.query(CreatorSource).filter(
        CreatorSource.user_id == user_id, CreatorSource.status == "active",
    ).count()
    if source_count >= MAX_SOURCES_PER_USER:
        raise CreatorSyncError("source_limit_reached", "每位用户最多保存 50 个博主", 409)
    source = CreatorSource(user_id=user_id, status="active", **preview)
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        winner = db.query(CreatorSource).filter(
            CreatorSource.user_id == user_id,
            CreatorSource.platform == preview["platform"],
            CreatorSource.creator_id == preview["creator_id"],
        ).first()
        if winner is None:
            raise
        return winner, True
    db.refresh(source)
    return source, False


def _last_run(db: Session, user_id: str, source_id: str) -> CreatorSyncRun | None:
    return db.query(CreatorSyncRun).filter(
        CreatorSyncRun.user_id == user_id, CreatorSyncRun.source_id == source_id,
    ).order_by(CreatorSyncRun.created_at.desc(), CreatorSyncRun.id.desc()).first()


def _source_counts(db: Session, source: CreatorSource) -> dict[str, int]:
    base = db.query(CreatorSourceItem).filter(
        CreatorSourceItem.user_id == source.user_id,
        CreatorSourceItem.source_id == source.id,
        CreatorSourceItem.removed_at.is_(None),
        CreatorSourceItem.state != "removed",
        CreatorSourceItem.is_available.is_(True),
    )
    return {
        "total": base.count(),
        "untranscribed": base.filter(
            CreatorSourceItem.note_id.is_(None), CreatorSourceItem.state != "failed",
        ).count(),
        "imported": base.filter(CreatorSourceItem.note_id.is_not(None)).count(),
        "failed": base.filter(CreatorSourceItem.state == "failed").count(),
    }


def serialize_source_detail(db: Session, source: CreatorSource) -> dict[str, Any]:
    data = source.to_dict()
    data["catalog_counts"] = _source_counts(db, source)
    last_run = _last_run(db, source.user_id, source.id)
    data["last_run"] = last_run.to_dict() if last_run else None
    return data


def get_source_detail(db: Session, *, user_id: str, source_id: str) -> dict[str, Any]:
    return serialize_source_detail(
        db,
        _get_source(db, user_id=user_id, source_id=source_id, active_only=True),
    )


def list_sources(db: Session, *, user_id: str) -> list[dict[str, Any]]:
    sources = db.query(CreatorSource).filter(
        CreatorSource.user_id == user_id, CreatorSource.status != "disabled",
    ).order_by(CreatorSource.updated_at.desc(), CreatorSource.id.desc()).all()
    return [serialize_source_detail(db, source) for source in sources]


def disable_source(db: Session, *, user_id: str, source_id: str) -> bool:
    source = db.query(CreatorSource).filter(
        CreatorSource.id == source_id, CreatorSource.user_id == user_id,
    ).first()
    if source is None:
        return False
    active = db.query(CreatorSyncRun).filter(
        CreatorSyncRun.user_id == user_id,
        CreatorSyncRun.source_id == source_id,
        CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
    ).first()
    if active is not None:
        raise CreatorSyncError("run_active", "请先取消该博主正在运行的同步任务", 409)
    source.status = "disabled"
    source.updated_at = _utcnow()
    db.commit()
    return True


def _normalize_operation(
    operation: str | None, limit: int | None, item_ids: list[str] | None,
) -> tuple[str, int, list[str]]:
    normalized = str(operation or "recent_transcript").strip()
    if normalized not in ALLOWED_OPERATIONS:
        raise CreatorSyncError("invalid_operation", "博主任务类型无效", 422)
    selected = list(dict.fromkeys(str(item_id or "").strip() for item_id in (item_ids or [])))
    selected = [item_id for item_id in selected if item_id]
    if normalized == "recent_transcript":
        requested = 50 if limit is None else int(limit)
        if requested not in ALLOWED_LIMITS:
            raise CreatorSyncError("invalid_limit", "同步数量只支持 20、50 或 100", 422)
        if selected:
            raise CreatorSyncError("unexpected_item_ids", "近期任务不能提交作品选择", 422)
        return normalized, requested, []
    if normalized == "catalog_all":
        if selected:
            raise CreatorSyncError("unexpected_item_ids", "目录刷新不能提交作品选择", 422)
        return normalized, 100, []
    if not 1 <= len(selected) <= MAX_SELECTED_ITEMS:
        raise CreatorSyncError("invalid_selection", "每次请选择 1 至 50 条作品", 422)
    return normalized, 20 if len(selected) <= 20 else 50, selected


def _require_catalog_health(
    db: Session, source: CreatorSource, credentials: dict[str, str],
) -> None:
    config = _feature_config(db)
    catalog_platforms = config.get("catalog_platforms") or config["platforms"]
    if not bool(catalog_platforms.get(source.platform, False)):
        raise CreatorSyncError(
            "catalog_connector_unhealthy", "全部作品连接器尚未通过健康检查", 503,
        )
    health_check = getattr(creator_connectors, "catalog_health", None)
    if not callable(health_check):
        return
    health = health_check(
        source.platform,
        douyin_session_scope=credentials.get("douyin_session_scope", ""),
    )
    if isinstance(health, dict) and not bool(
        health.get("supports_catalog_all", health.get("available", True))
    ):
        raise CreatorSyncError(
            "catalog_connector_unhealthy", "全部作品连接器尚未通过健康检查", 503,
        )


def create_run(
    db: Session,
    *,
    user_id: str,
    source_id: str,
    limit: int | None = None,
    operation: str | None = None,
    item_ids: list[str] | None = None,
) -> tuple[CreatorSyncRun, bool]:
    _require_enabled(db)
    normalized, requested_limit, selected_ids = _normalize_operation(operation, limit, item_ids)
    source = _get_source(db, user_id=user_id, source_id=source_id, active_only=True)
    credentials = _connector_credentials(db, user_id, source.platform)
    if normalized == "catalog_all":
        if source.platform not in CATALOG_PLATFORMS:
            raise CreatorSyncError("catalog_unsupported", "该平台暂不支持全部作品目录", 422)
        _require_catalog_health(db, source, credentials)
    active_for_user = db.query(CreatorSyncRun).filter(
        CreatorSyncRun.user_id == user_id,
        CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
    ).order_by(CreatorSyncRun.created_at.desc()).first()
    if active_for_user is not None:
        if active_for_user.source_id == source.id:
            return active_for_user, True
        raise CreatorSyncError("user_run_active", "当前已有博主同步任务正在运行", 409)

    selected_items: list[CreatorSourceItem] = []
    if normalized == "selected_transcript":
        rows = db.query(CreatorSourceItem).filter(
            CreatorSourceItem.user_id == user_id,
            CreatorSourceItem.source_id == source.id,
            CreatorSourceItem.id.in_(selected_ids),
        ).all()
        by_id = {row.id: row for row in rows}
        if len(by_id) != len(selected_ids):
            raise CreatorSyncError("selection_not_owned", "选择中包含不属于该博主的作品", 422)
        selected_items = [by_id[item_id] for item_id in selected_ids]
        if any(
            item.removed_at is not None or item.state == "removed" or not item.is_available
            for item in selected_items
        ):
            raise CreatorSyncError("selection_unavailable", "选择中包含已移除或当前不可用的作品", 422)

    target_count = (
        len(selected_items) if normalized == "selected_transcript"
        else requested_limit if normalized == "recent_transcript" else 0
    )
    run = CreatorSyncRun(
        user_id=user_id,
        source_id=source.id,
        platform=source.platform,
        status="queued",
        operation=normalized,
        requested_limit=requested_limit,
        target_count=target_count,
        source_snapshot_json=_snapshot_json(source),
        discovery_complete=normalized == "selected_transcript",
        discovered_count=len(selected_items),
        total_count=len(selected_items) if normalized == "selected_transcript" else None,
    )
    db.add(run)
    try:
        db.flush()
        for ordinal, item in enumerate(selected_items, start=1):
            db.add(CreatorSyncRunItem(
                run_id=run.id,
                user_id=user_id,
                source_id=source.id,
                source_item_id=item.id,
                external_id=item.external_id,
                ordinal=ordinal,
            ))
        db.commit()
    except IntegrityError:
        db.rollback()
        active = db.query(CreatorSyncRun).filter(
            CreatorSyncRun.user_id == user_id,
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
        ).order_by(CreatorSyncRun.created_at.desc()).first()
        if active is not None and active.source_id == source.id:
            return active, True
        raise CreatorSyncError("user_run_active", "当前已有博主同步任务正在运行", 409)
    db.refresh(run)
    return run, False


def _hydrate_legacy_snapshot(db: Session, run: CreatorSyncRun) -> None:
    if str(run.source_snapshot_json or "{}").strip() not in {"", "{}"}:
        return
    source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
    if source is not None:
        run.source_snapshot_json = _snapshot_json(source)


def list_runs(db: Session, *, user_id: str, status: str) -> list[CreatorSyncRun]:
    query = db.query(CreatorSyncRun).filter(CreatorSyncRun.user_id == user_id)
    if status == "active":
        query = query.filter(CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES))
    elif status == "recent":
        query = query.filter(~CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES))
    else:
        raise CreatorSyncError("invalid_status", "任务筛选状态无效", 422)
    rows = query.order_by(CreatorSyncRun.created_at.desc()).limit(20).all()
    for run in rows:
        _hydrate_legacy_snapshot(db, run)
    return rows


def get_run(db: Session, *, user_id: str, run_id: str) -> CreatorSyncRun | None:
    run = db.query(CreatorSyncRun).filter(
        CreatorSyncRun.id == run_id, CreatorSyncRun.user_id == user_id,
    ).first()
    if run is not None:
        _hydrate_legacy_snapshot(db, run)
    return run


def _validate_page(page: int, per_page: int) -> tuple[int, int]:
    if page < 1:
        raise CreatorSyncError("invalid_page", "页码无效", 422)
    if not 1 <= per_page <= DEFAULT_PAGE_SIZE:
        raise CreatorSyncError("invalid_page_size", "每页最多 50 条", 422)
    return page, per_page


def _page_payload(
    items: list[dict[str, Any]], page: int, per_page: int, total: int,
) -> dict[str, Any]:
    total_pages = math.ceil(total / per_page) if total else 0
    return {
        "items": items,
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
        "next_cursor": str(page + 1) if page < total_pages else None,
    }


def _escaped_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_source_items(
    db: Session,
    *,
    user_id: str,
    source_id: str,
    page: int = 1,
    per_page: int = DEFAULT_PAGE_SIZE,
    search: str = "",
    status: str = "all",
) -> dict[str, Any]:
    page, per_page = _validate_page(page, per_page)
    source = _get_source(
        db, user_id=user_id, source_id=source_id, active_only=True,
    )
    if status not in {"all", "untranscribed", "imported", "failed"}:
        raise CreatorSyncError("invalid_item_status", "作品筛选状态无效", 422)
    query = db.query(CreatorSourceItem).filter(
        CreatorSourceItem.user_id == user_id,
        CreatorSourceItem.source_id == source_id,
        CreatorSourceItem.removed_at.is_(None),
        CreatorSourceItem.state != "removed",
        CreatorSourceItem.is_available.is_(True),
    )
    term = str(search or "").strip()[:100]
    if term:
        pattern = f"%{_escaped_like(term)}%"
        query = query.filter(or_(
            CreatorSourceItem.title.ilike(pattern, escape="\\"),
            CreatorSourceItem.description.ilike(pattern, escape="\\"),
            CreatorSourceItem.author_name.ilike(pattern, escape="\\"),
            CreatorSourceItem.external_id.ilike(pattern, escape="\\"),
        ))
    if status == "untranscribed":
        query = query.filter(
            CreatorSourceItem.note_id.is_(None), CreatorSourceItem.state != "failed",
        )
    elif status == "imported":
        query = query.filter(CreatorSourceItem.note_id.is_not(None))
    elif status == "failed":
        query = query.filter(CreatorSourceItem.state == "failed")
    total = query.count()
    rows = query.order_by(
        case((CreatorSourceItem.published_at.is_(None), 1), else_=0),
        CreatorSourceItem.published_at.desc(),
        CreatorSourceItem.order_index.asc(),
        CreatorSourceItem.external_id.desc(),
    ).offset((page - 1) * per_page).limit(per_page).all()
    items: list[dict[str, Any]] = []
    binding_ref = ""
    if source.platform == "douyin":
        binding_ref = douyin_binding_service.get_or_create(db, user_id).id
    for row in rows:
        item = row.to_dict()
        if binding_ref and row.external_id:
            # Douyin CDN cover URLs are signed and short-lived, so they must
            # not be persisted in CreatorSourceItem. Return a renewable,
            # same-origin capability that proxies the image through Zhicui.
            item["cover_url"] = douyin_library.public_cover_url(
                row.external_id, binding_ref,
            )
        items.append(item)
    return _page_payload(items, page, per_page, total)


def list_run_items(
    db: Session,
    *,
    user_id: str,
    run_id: str,
    page: int = 1,
    per_page: int = DEFAULT_PAGE_SIZE,
    status: str = "all",
) -> dict[str, Any]:
    page, per_page = _validate_page(page, per_page)
    if get_run(db, user_id=user_id, run_id=run_id) is None:
        raise CreatorSyncError("run_not_found", "同步任务不存在", 404)
    if status not in {"all", "pending", "succeeded", "failed"}:
        raise CreatorSyncError("invalid_run_item_status", "任务明细筛选状态无效", 422)
    query = db.query(CreatorSyncRunItem).filter(
        CreatorSyncRunItem.user_id == user_id, CreatorSyncRunItem.run_id == run_id,
    )
    if status == "pending":
        query = query.filter(CreatorSyncRunItem.state.in_(("pending", "importing")))
    elif status == "succeeded":
        query = query.filter(CreatorSyncRunItem.state.in_((
            "succeeded", "reused", "skipped_removed",
        )))
    elif status == "failed":
        query = query.filter(CreatorSyncRunItem.state == "failed")
    total = query.count()
    rows = query.order_by(
        CreatorSyncRunItem.ordinal.asc(), CreatorSyncRunItem.id.asc(),
    ).offset((page - 1) * per_page).limit(per_page).all()
    return _page_payload([row.to_dict() for row in rows], page, per_page, total)


def request_cancel(db: Session, *, user_id: str, run_id: str) -> CreatorSyncRun | None:
    run = get_run(db, user_id=user_id, run_id=run_id)
    if run is None:
        return None
    should_signal = run.status in ACTIVE_CREATOR_RUN_STATUSES
    if run.status == "queued":
        run.status = "cancelled"
        run.cancellation_requested = True
        run.finished_at = _utcnow()
        run.next_retry_at = None
        run.lease_token = None
        run.lease_until = None
    elif run.status in ACTIVE_CREATOR_RUN_STATUSES:
        run.cancellation_requested = True
    db.commit()
    db.refresh(run)
    if should_signal:
        cancel = getattr(creator_connectors, "cancel_catalog", None)
        if callable(cancel):
            try:
                cancel(run.id)
            except Exception:
                pass
    return run


def retry_run(
    db: Session, *, user_id: str, run_id: str,
) -> tuple[CreatorSyncRun, bool]:
    run = get_run(db, user_id=user_id, run_id=run_id)
    if run is None:
        raise CreatorSyncError("run_not_found", "同步任务不存在", 404)
    if run.status in ACTIVE_CREATOR_RUN_STATUSES:
        return run, True
    if run.status == "succeeded":
        raise CreatorSyncError("run_not_retryable", "成功任务无需重试", 409)
    active_other = db.query(CreatorSyncRun).filter(
        CreatorSyncRun.user_id == user_id,
        CreatorSyncRun.id != run.id,
        CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
    ).first()
    if active_other is not None:
        raise CreatorSyncError("user_run_active", "当前已有博主同步任务正在运行", 409)
    if run.operation != "catalog_all":
        failed_items = db.query(CreatorSyncRunItem).filter(
            CreatorSyncRunItem.run_id == run.id,
            CreatorSyncRunItem.user_id == user_id,
            CreatorSyncRunItem.state.in_(("failed", "importing")),
        ).all()
        for run_item in failed_items:
            run_item.state = "pending"
            run_item.error_code = ""
            run_item.error_message = ""
            run_item.next_retry_at = None
            run_item.attempt_count = 0
            item = db.query(CreatorSourceItem).filter(
                CreatorSourceItem.id == run_item.source_item_id,
            ).first()
            if item is not None and item.removed_at is None and not item.note_id:
                item.state = "discovered"
                item.error_code = ""
        if run.operation == "recent_transcript" and not failed_items and not run.discovery_complete:
            run.discovery_complete = False
    else:
        run.discovery_complete = False
        run.total_count = None
    run.status = "queued"
    run.cancellation_requested = False
    run.error_code = ""
    run.error_message = ""
    run.needs_action = False
    run.needs_action_code = ""
    run.needs_action_message = ""
    run.attempt_count = 0
    run.next_retry_at = None
    run.lease_token = None
    run.lease_until = None
    run.finished_at = None
    _recompute_run_counts(db, run)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise CreatorSyncError(
            "user_run_active", "当前已有博主同步任务正在运行", 409,
        ) from exc
    db.refresh(run)
    return run, False


def _safe_error(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, creator_connectors.CreatorConnectorError):
        return str(exc.code or "connector_failed")[:80], str(exc)[:240]
    if isinstance(exc, CreatorSyncError):
        return exc.code[:80], str(exc)[:240]
    if isinstance(exc, _RunCancelled):
        return "cancelled", "任务已取消"
    if isinstance(exc, _PartialImportError):
        return "multipart_partial", "部分分 P 文稿准备失败，可重试失败作品"
    if isinstance(exc, ValueError):
        return "item_invalid", "作品数据不完整"
    return "item_failed", "作品文稿准备失败"


def _is_needs_action(code: str) -> bool:
    lowered = str(code or "").lower()
    return any(token in lowered for token in _NEEDS_ACTION_TOKENS)


def _is_transient(code: str) -> bool:
    lowered = str(code or "").lower()
    return any(token in lowered for token in _TRANSIENT_TOKENS)


def _gate(platform: str, limit: int) -> threading.BoundedSemaphore:
    key = f"{platform}:{limit}"
    with _GATES_LOCK:
        gate = _PLATFORM_GATES.get(key)
        if gate is None:
            gate = threading.BoundedSemaphore(limit)
            _PLATFORM_GATES[key] = gate
        return gate


def _claim_run(run_id: str) -> str | None:
    now = _utcnow()
    token = uuid.uuid4().hex
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.status not in ACTIVE_CREATOR_RUN_STATUSES:
            return None
        if run.cancellation_requested:
            run.status = "cancelled"
            run.finished_at = now
            run.lease_token = None
            run.lease_until = None
            db.commit()
            return None
        next_retry_at = _aware(run.next_retry_at)
        if next_retry_at is not None and next_retry_at > now:
            return None
        updated = db.query(CreatorSyncRun).filter(
            CreatorSyncRun.id == run_id,
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
            CreatorSyncRun.cancellation_requested.is_(False),
            or_(CreatorSyncRun.lease_until.is_(None), CreatorSyncRun.lease_until < now),
            or_(CreatorSyncRun.next_retry_at.is_(None), CreatorSyncRun.next_retry_at <= now),
        ).update(
            {
                CreatorSyncRun.lease_token: token,
                CreatorSyncRun.lease_until: now + timedelta(seconds=LEASE_SECONDS),
                CreatorSyncRun.heartbeat_at: now,
                CreatorSyncRun.started_at: func.coalesce(CreatorSyncRun.started_at, now),
            },
            synchronize_session=False,
        )
        db.commit()
        return token if updated == 1 else None


def _heartbeat(
    db: Session, run: CreatorSyncRun, lease_token: str, status: str | None = None,
) -> None:
    now = _utcnow()
    if run.lease_token != lease_token:
        raise _RunCancelled("任务租约已转移")
    if run.cancellation_requested:
        raise _RunCancelled("任务已取消")
    if status:
        run.status = status
    run.heartbeat_at = now
    run.lease_until = now + timedelta(seconds=LEASE_SECONDS)
    db.commit()


def _canonical_page_url(value: Any, platform: str, *, part: bool = False) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.username
        or parsed.password
        or hostname not in _PLATFORM_PAGE_HOSTS.get(platform, set())
    ):
        return ""
    query = ""
    if part and platform == "bilibili":
        raw_page = parse_qs(parsed.query).get("p", [""])[0]
        if str(raw_page).isdigit() and 1 <= int(raw_page) <= 9999:
            query = urlencode({"p": int(raw_page)})
    return urlunsplit(("https", parsed.netloc, parsed.path, query, ""))[:1024]


def _safe_cover_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    if parsed.username or parsed.password:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))[:2048]


def _published_at(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        if len(raw) == 8:
            try:
                return datetime.strptime(raw, "%Y%m%d").replace(tzinfo=timezone.utc)
            except ValueError:
                return None
        return _published_at(int(raw))
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware(parsed)


def _duration_seconds(value: Any) -> int | None:
    try:
        duration = int(float(value))
    except (TypeError, ValueError):
        return None
    return duration if 0 <= duration <= 2_678_400 else None


def _safe_parts(raw_parts: Any, platform: str, source_url: str) -> list[dict[str, Any]]:
    if platform != "bilibili" or not isinstance(raw_parts, list):
        return []
    parts: list[dict[str, Any]] = []
    for fallback_page, raw in enumerate(raw_parts[:200], start=1):
        if not isinstance(raw, dict):
            continue
        try:
            page = max(1, min(9999, int(raw.get("page") or fallback_page)))
        except (TypeError, ValueError):
            page = fallback_page
        page_url = _canonical_page_url(
            raw.get("page_url") or raw.get("source_url"), platform, part=True,
        )
        if not page_url and source_url:
            parsed = urlsplit(source_url)
            page_url = urlunsplit(
                (parsed.scheme, parsed.netloc, parsed.path, urlencode({"p": page}), "")
            )
        parts.append({
            "cid": str(raw.get("cid") or "")[:80],
            "page": page,
            "title": str(raw.get("title") or "")[:240],
            "page_url": page_url[:1024],
        })
    return sorted(parts, key=lambda part: (part["page"], part["cid"]))


def _upsert_source_item(
    db: Session,
    run: CreatorSyncRun,
    work: dict[str, Any],
    *,
    ordinal: int = 0,
) -> tuple[CreatorSourceItem | None, bool]:
    external_id = str(work.get("external_id") or "").strip()[:192]
    if not external_id:
        return None, False
    item = db.query(CreatorSourceItem).filter(
        CreatorSourceItem.user_id == run.user_id,
        CreatorSourceItem.platform == run.platform,
        CreatorSourceItem.external_id == external_id,
    ).first()
    now = _utcnow()
    is_new = item is None
    if is_new:
        item = CreatorSourceItem(
            user_id=run.user_id,
            source_id=run.source_id,
            platform=run.platform,
            external_id=external_id,
        )
        db.add(item)
        db.flush()
    newly_seen = item.last_seen_run_id != run.id
    if "source_url" in work:
        source_url = _canonical_page_url(work.get("source_url"), run.platform)
        if source_url:
            item.source_url = source_url
    item.source_id = run.source_id
    if "title" in work:
        item.title = str(work.get("title") or "")[:512]
    if "cover_url" in work:
        item.cover_url = _safe_cover_url(work.get("cover_url"))
    if "description" in work:
        item.description = str(work.get("description") or "")[:4000]
    if "author_name" in work:
        item.author_name = str(work.get("author_name") or "")[:160]
    if "published_at" in work:
        item.published_at = _published_at(work.get("published_at"))
    if "duration_seconds" in work:
        item.duration_seconds = _duration_seconds(work.get("duration_seconds"))
    if "order_index" in work or is_new:
        try:
            item.order_index = max(0, int(work.get("order_index") or ordinal or 0))
        except (TypeError, ValueError):
            item.order_index = max(0, ordinal)
    if "parts" in work:
        item.parts_json = json.dumps(
            _safe_parts(work.get("parts"), run.platform, item.source_url),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    item.last_seen_run_id = run.id
    item.last_seen_at = now
    if item.removed_at is None and item.state != "removed":
        item.is_available = True
        item.unavailable_at = None
    return item, newly_seen


def _catalog_should_cancel(run_id: str, lease_token: str | None = None) -> bool:
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        return bool(
            run is None
            or run.cancellation_requested
            or run.status in TERMINAL_CREATOR_RUN_STATUSES
            or (lease_token is not None and run.lease_token != lease_token)
        )


def _catalog_on_item(run_id: str, lease_token: str, raw: dict[str, Any]) -> None:
    if not isinstance(raw, dict):
        return
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.cancellation_requested or run.lease_token != lease_token:
            raise _RunCancelled("任务已取消")
        item, newly_seen = _upsert_source_item(
            db, run, raw, ordinal=run.discovered_count + 1,
        )
        if item is None:
            return
        if newly_seen:
            run.discovered_count += 1
            run.checked_count = run.discovered_count
        if item.author_name:
            source = db.query(CreatorSource).filter(
                CreatorSource.id == run.source_id,
            ).first()
            if source is not None and not source.display_name:
                source.display_name = item.author_name
        _heartbeat(db, run, lease_token, "discovering")


def _persist_catalog_result_items(
    run_id: str, lease_token: str, items: Any,
) -> None:
    """Persist connectors that do not stream, without re-committing streamed rows."""
    if not isinstance(items, list) or not items:
        return
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.lease_token != lease_token or run.cancellation_requested:
            raise _RunCancelled("任务已取消")
        for raw in items:
            if not isinstance(raw, dict):
                continue
            external_id = str(raw.get("external_id") or "").strip()[:192]
            if not external_id:
                continue
            # Final connector results may aggregate data that was incomplete
            # in an earlier streamed event (notably additional Bilibili parts).
            # Always apply the metadata; newly_seen alone gates the counter.
            item, newly_seen = _upsert_source_item(
                db, run, raw, ordinal=run.discovered_count + 1,
            )
            if item is not None and newly_seen:
                run.discovered_count += 1
                run.checked_count = run.discovered_count
        _heartbeat(db, run, lease_token, "discovering")


def _failure_details(failures: Any) -> tuple[str, str, int]:
    if not isinstance(failures, list) or not failures:
        return "", "", 0
    first = failures[0]
    if isinstance(first, dict):
        code = str(
            first.get("error_code") or first.get("code") or "catalog_partial"
        )[:80]
        message = str(first.get("message") or "目录只完成了部分发现")[:240]
    else:
        code = "catalog_partial"
        message = "目录只完成了部分发现"
    return code, message, len(failures)


def _finish_cancelled(run_id: str, lease_token: str | None = None) -> None:
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.status in TERMINAL_CREATOR_RUN_STATUSES:
            return
        if lease_token is not None and run.lease_token not in {None, lease_token}:
            return
        now = _utcnow()
        run.status = "cancelled"
        run.cancellation_requested = True
        run.finished_at = now
        run.heartbeat_at = now
        run.lease_token = None
        run.lease_until = None
        run.next_retry_at = None
        db.commit()


def _process_catalog(
    run_id: str,
    lease_token: str,
    source_snapshot: SimpleNamespace,
    credentials: dict[str, str],
) -> None:
    discover = getattr(creator_connectors, "discover_catalog", None)
    if not callable(discover):
        raise creator_connectors.CreatorConnectorError(
            "connector_unavailable", "全部作品连接器暂不可用",
        )
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        # A retry is a fresh full scan. Rows discovered by an earlier partial
        # attempt must not count as seen for this attempt, otherwise they can
        # never become unavailable after the retry completes successfully.
        db.query(CreatorSourceItem).filter(
            CreatorSourceItem.user_id == run.user_id,
            CreatorSourceItem.source_id == run.source_id,
            CreatorSourceItem.last_seen_run_id == run.id,
        ).update(
            {CreatorSourceItem.last_seen_run_id: None},
            synchronize_session=False,
        )
        run.discovered_count = 0
        run.checked_count = 0
        run.failed_count = 0
        run.error_code = ""
        run.error_message = ""
        run.discovery_complete = False
        _heartbeat(db, run, lease_token, "discovering")
    with _LeaseHeartbeat(run_id, lease_token) as lease_guard:
        result = discover(
            source_snapshot,
            douyin_session_scope=credentials.get("douyin_session_scope", ""),
            douyin_binding_ref=credentials.get("douyin_binding_ref", ""),
            on_item=lambda item, *_progress: _catalog_on_item(run_id, lease_token, item),
            should_cancel=lambda: (
                lease_guard.lost or _catalog_should_cancel(run_id, lease_token)
            ),
            run_id=run_id,
        )
    lease_guard.ensure()
    if _catalog_should_cancel(run_id, lease_token):
        _finish_cancelled(run_id, lease_token)
        return
    if not isinstance(result, dict):
        raise creator_connectors.CreatorConnectorError(
            "invalid_upstream_response", "全部作品连接器返回格式异常",
        )
    _persist_catalog_result_items(
        run_id, lease_token, result.get("items") or [],
    )
    code, message, failure_count = _failure_details(result.get("failures"))
    complete = bool(result.get("complete")) and failure_count == 0
    if not complete and not code:
        code, message = "catalog_incomplete", "目录扫描尚未完整结束"
    if not complete and (_is_needs_action(code) or _is_transient(code)):
        raise creator_connectors.CreatorConnectorError(code, message)

    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.lease_token != lease_token:
            return
        if run.cancellation_requested:
            raise _RunCancelled("任务已取消")
        now = _utcnow()
        run.discovery_complete = complete
        run.failed_count = failure_count
        run.error_code = code
        run.error_message = message
        run.checked_count = run.discovered_count
        if complete:
            try:
                total_count = max(0, int(result.get("total_count")))
            except (TypeError, ValueError):
                total_count = run.discovered_count
            run.total_count = total_count
            run.target_count = total_count
            db.query(CreatorSourceItem).filter(
                CreatorSourceItem.user_id == run.user_id,
                CreatorSourceItem.source_id == run.source_id,
                CreatorSourceItem.removed_at.is_(None),
                CreatorSourceItem.state != "removed",
                CreatorSourceItem.is_available.is_(True),
                or_(
                    CreatorSourceItem.last_seen_run_id.is_(None),
                    CreatorSourceItem.last_seen_run_id != run.id,
                ),
            ).update(
                {
                    CreatorSourceItem.is_available: False,
                    CreatorSourceItem.unavailable_at: now,
                },
                synchronize_session=False,
            )
            run.status = "succeeded"
        else:
            run.total_count = None
            run.status = "partial"
        run.finished_at = now
        run.heartbeat_at = now
        run.lease_token = None
        run.lease_until = None
        run.next_retry_at = None
        source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
        if source is not None:
            source.last_synced_at = now
            if run.status == "succeeded":
                source.last_success_at = now
                source.last_error_code = ""
            else:
                source.last_error_code = code
        db.commit()


def _persist_recent_discovery(
    run_id: str, lease_token: str, works: list[dict[str, Any]],
) -> None:
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.lease_token != lease_token:
            raise _RunCancelled("任务租约已转移")
        for ordinal, raw in enumerate(works[: run.requested_limit], start=1):
            if not isinstance(raw, dict):
                continue
            item, _newly_seen = _upsert_source_item(db, run, raw, ordinal=ordinal)
            if item is None:
                continue
            run_item = db.query(CreatorSyncRunItem).filter(
                CreatorSyncRunItem.run_id == run.id,
                CreatorSyncRunItem.source_item_id == item.id,
            ).first()
            if run_item is None:
                run_item = CreatorSyncRunItem(
                    run_id=run.id,
                    user_id=run.user_id,
                    source_id=run.source_id,
                    source_item_id=item.id,
                    external_id=item.external_id,
                    ordinal=ordinal,
                )
                if (
                    run.platform == "xiaohongshu"
                    and str(raw.get("media_type") or "video") != "video"
                ):
                    run_item.state = "skipped_removed"
                    run_item.error_code = "non_video"
                    run_item.error_message = "图文作品不准备视频文稿"
                db.add(run_item)
        db.flush()
        count = db.query(CreatorSyncRunItem).filter(
            CreatorSyncRunItem.run_id == run.id,
        ).count()
        run.discovery_complete = True
        run.discovered_count = count
        run.total_count = count
        _recompute_run_counts(db, run)
        _heartbeat(db, run, lease_token, "importing")


def _work_from_item(item: CreatorSourceItem) -> dict[str, Any]:
    return {
        "external_id": item.external_id,
        "source_url": item.source_url,
        "fetch_url": item.source_url,
        "title": item.title,
        "cover_url": item.cover_url,
        "description": item.description,
        "author_name": item.author_name,
        "published_at": item.published_at,
        "duration_seconds": item.duration_seconds,
        "order_index": item.order_index,
        "parts": item.safe_parts(),
        "media_type": "video",
    }


def _import_bilibili_parts(
    run: CreatorSyncRun | SimpleNamespace,
    work: dict[str, Any],
    should_cancel: Callable[[], bool] | None = None,
) -> tuple[str, str | None]:
    parts = work.get("parts") if isinstance(work.get("parts"), list) else []
    if len(parts) <= 1:
        if should_cancel is not None and should_cancel():
            raise _RunCancelled("任务已取消或租约已转移")
        with SessionLocal() as item_db:
            result = platform_library_service.import_one(
                item_db,
                user_id=run.user_id,
                value=work.get("fetch_url") or work["source_url"],
            )
        item = result.get("item") if isinstance(result, dict) else None
        return (
            str(result.get("status") or "imported"),
            str((item or {}).get("id") or "") or None,
        )

    transcripts: list[str] = []
    failed_pages: list[int] = []
    base_info: dict[str, Any] | None = None
    base_meta: dict[str, Any] | None = None
    with SessionLocal() as item_db:
        for fallback_page, part in enumerate(
            sorted(parts, key=lambda value: int(value.get("page") or 0)), start=1,
        ):
            if should_cancel is not None and should_cancel():
                raise _RunCancelled("任务已取消或租约已转移")
            page = int(part.get("page") or fallback_page)
            page_url = str(part.get("page_url") or work.get("source_url") or "")
            try:
                info, transcript, source_meta = platform_library_service._extract_bilibili(
                    page_url, item_db,
                )
                platform_library_service.ensure_bilibili_result_ready(
                    info,
                    transcript,
                    source_meta,
                )
            except _RunCancelled:
                raise
            except Exception:
                failed_pages.append(page)
                continue
            if base_info is None:
                base_info = info
                base_meta = source_meta
            title = str(part.get("title") or info.get("title") or f"P{page}")
            transcripts.append(f"【P{page} · {title}】\n{transcript.strip()}")
        if base_info is None or base_meta is None or not transcripts:
            raise RuntimeError("B站多 P 视频没有可用文稿")
        if should_cancel is not None and should_cancel():
            raise _RunCancelled("任务已取消或租约已转移")
        base_info["video_id"] = work["external_id"]
        base_info["title"] = work.get("title") or base_info.get("title") or "B站视频"
        base_meta["source_url"] = work.get("source_url") or base_meta.get("source_url") or ""
        base_meta["parts"] = [
            {
                "cid": str(part.get("cid") or "")[:80],
                "page": int(part.get("page") or index),
                "title": str(part.get("title") or "")[:240],
            }
            for index, part in enumerate(parts, start=1)
        ]
        note, reused = platform_library_service._save_or_refresh(
            item_db,
            user_id=run.user_id,
            platform="bilibili",
            info=base_info,
            transcript="\n\n".join(transcripts),
            source_meta=base_meta,
        )
        if failed_pages:
            raise _PartialImportError(str(note.id))
        return ("reused" if reused else "imported"), str(note.id)


def _import_work(
    run: CreatorSyncRun | SimpleNamespace,
    work: dict[str, Any],
    should_cancel: Callable[[], bool] | None = None,
) -> tuple[str, str | None]:
    if should_cancel is not None and should_cancel():
        raise _RunCancelled("任务已取消或租约已转移")
    if run.platform == "douyin":
        safe_item = None
        if getattr(run, "operation", "recent_transcript") == "selected_transcript":
            published = work.get("published_at")
            if isinstance(published, datetime):
                recorded_at = _aware(published).isoformat()
            else:
                recorded_at = str(published or "").strip() or _utcnow().isoformat()
            safe_item = {
                "aweme_id": str(work["external_id"])[:192],
                "can_extract": True,
                "title": str(work.get("title") or "抖音作品")[:512],
                "source_url": _canonical_page_url(work.get("source_url"), "douyin"),
                "cover_url": _safe_cover_url(work.get("cover_url")),
                "author_name": str(work.get("author_name") or "")[:160],
                "recorded_at": recorded_at[:64],
                "caption": str(work.get("description") or "")[:4000],
                "source_mode": "creator_catalog",
                "source_rank": int(work.get("order_index") or 0),
                "source_synced_at": _utcnow().isoformat(),
            }
        result = library_extraction_service.extract_library_item(
            user_id=run.user_id,
            aweme_id=work["external_id"],
            operation="transcript",
            item=safe_item,
        )
        return (
            "reused" if result.get("already_existed") else "imported",
            str(result.get("id") or "") or None,
        )
    if run.platform == "bilibili":
        return _import_bilibili_parts(run, work, should_cancel=should_cancel)
    with SessionLocal() as item_db:
        result = platform_library_service.import_one(
            item_db,
            user_id=run.user_id,
            value=work.get("fetch_url") or work["source_url"],
        )
    item = result.get("item") if isinstance(result, dict) else None
    return (
        str(result.get("status") or "imported"),
        str((item or {}).get("id") or "") or None,
    )


def _recompute_run_counts(db: Session, run: CreatorSyncRun) -> None:
    rows = db.query(
        CreatorSyncRunItem.state, func.count(CreatorSyncRunItem.id),
    ).filter(CreatorSyncRunItem.run_id == run.id).group_by(
        CreatorSyncRunItem.state,
    ).all()
    counts = {state: int(count) for state, count in rows}
    run.new_count = counts.get("succeeded", 0)
    run.reused_count = counts.get("reused", 0)
    run.failed_count = counts.get("failed", 0)
    run.skipped_count = counts.get("skipped_removed", 0) + counts.get("cancelled", 0)
    run.processed_count = run.new_count + run.reused_count + run.failed_count + run.skipped_count
    run.checked_count = run.processed_count
    run.total_count = sum(counts.values()) if rows else run.total_count
    results = db.query(CreatorSyncRunItem).filter(
        CreatorSyncRunItem.run_id == run.id,
        ~CreatorSyncRunItem.state.in_(("pending", "importing")),
    ).order_by(CreatorSyncRunItem.ordinal.asc()).limit(100).all()
    status_map = {
        "succeeded": "imported",
        "reused": "reused",
        "failed": "failed",
        "skipped_removed": "removed",
        "cancelled": "cancelled",
    }
    run.results_json = json.dumps([
        {
            "external_id": row.external_id,
            "status": status_map.get(row.state, row.state),
            "note_id": row.note_id,
            "error_code": row.error_code,
        }
        for row in results
    ], ensure_ascii=False, separators=(",", ":"))


def _mark_item_result(
    db: Session,
    run: CreatorSyncRun,
    run_item: CreatorSyncRunItem,
    item: CreatorSourceItem | None,
    *,
    state: str,
    note_id: str | None = None,
    error_code: str = "",
    error_message: str = "",
) -> None:
    run_item.state = state
    run_item.note_id = note_id
    run_item.error_code = error_code[:80]
    run_item.error_message = error_message[:240]
    run_item.next_retry_at = None
    if state == "failed" and not run.error_code:
        run.error_code = error_code[:80]
        run.error_message = error_message[:240]
    if item is not None:
        if state in {"succeeded", "reused"}:
            item.note_id = note_id
            item.state = "ready"
            item.error_code = ""
        elif state == "failed" and item.removed_at is None:
            item.state = "failed"
            item.error_code = error_code[:80]
    _recompute_run_counts(db, run)


def _schedule_item_retry(
    db: Session,
    run: CreatorSyncRun,
    run_item: CreatorSyncRunItem,
    *,
    code: str,
    message: str,
) -> bool:
    retry_number = run_item.attempt_count
    if not 1 <= retry_number <= len(RETRY_DELAYS_SECONDS):
        return False
    retry_at = _utcnow() + timedelta(seconds=RETRY_DELAYS_SECONDS[retry_number - 1])
    run_item.state = "pending"
    run_item.error_code = code[:80]
    run_item.error_message = message[:240]
    run_item.next_retry_at = retry_at
    run.status = "queued"
    run.next_retry_at = retry_at
    run.attempt_count = max(run.attempt_count, retry_number)
    run.error_code = code[:80]
    run.error_message = message[:240]
    run.lease_token = None
    run.lease_until = None
    _recompute_run_counts(db, run)
    db.commit()
    return True


def _process_transcript_run(
    run_id: str,
    lease_token: str,
    source_snapshot: SimpleNamespace,
    run_snapshot: SimpleNamespace,
    credentials: dict[str, str],
) -> None:
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if not run.discovery_complete:
            _heartbeat(db, run, lease_token, "discovering")
            with _LeaseHeartbeat(run_id, lease_token) as lease_guard:
                works = creator_connectors.discover_works(
                    source_snapshot, run.requested_limit, **credentials,
                )
            lease_guard.ensure()
            if not isinstance(works, list):
                raise creator_connectors.CreatorConnectorError(
                    "invalid_upstream_response", "博主连接器返回格式异常",
                )
            _persist_recent_discovery(run_id, lease_token, works)

    with SessionLocal() as db:
        run_item_ids = [
            row.id
            for row in db.query(CreatorSyncRunItem).filter(
                CreatorSyncRunItem.run_id == run_id,
                CreatorSyncRunItem.state.in_(("pending", "importing")),
            ).order_by(CreatorSyncRunItem.ordinal.asc()).all()
        ]

    for run_item_id in run_item_ids:
        with SessionLocal() as db:
            run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
            if run is None or run.lease_token != lease_token:
                return
            if run.cancellation_requested:
                _finish_cancelled(run_id, lease_token)
                return
            run_item = db.query(CreatorSyncRunItem).filter(
                CreatorSyncRunItem.id == run_item_id,
                CreatorSyncRunItem.run_id == run_id,
            ).first()
            if run_item is None or run_item.state not in {"pending", "importing"}:
                continue
            retry_at = _aware(run_item.next_retry_at)
            if retry_at is not None and retry_at > _utcnow():
                run.status = "queued"
                run.next_retry_at = retry_at
                run.lease_token = None
                run.lease_until = None
                db.commit()
                return
            item = db.query(CreatorSourceItem).filter(
                CreatorSourceItem.id == run_item.source_item_id,
                CreatorSourceItem.user_id == run.user_id,
            ).first()
            if item is None:
                _mark_item_result(
                    db, run, run_item, None,
                    state="failed",
                    error_code="item_missing",
                    error_message="目录作品不存在",
                )
                db.commit()
                continue
            if item.removed_at is not None or item.state == "removed":
                _mark_item_result(
                    db, run, run_item, item,
                    state="skipped_removed",
                    error_code="removed",
                )
                db.commit()
                continue
            if item.note_id and db.query(Note).filter(Note.id == item.note_id).first():
                _mark_item_result(
                    db, run, run_item, item,
                    state="reused",
                    note_id=item.note_id,
                )
                db.commit()
                continue
            if item.note_id:
                item.note_id = None
            run_item.state = "importing"
            run_item.attempt_count += 1
            run_item.next_retry_at = None
            work = _work_from_item(item)
            _heartbeat(db, run, lease_token, "transcribing")

        try:
            with _LeaseHeartbeat(run_id, lease_token) as lease_guard:
                status, note_id = _import_work(
                    run_snapshot,
                    work,
                    should_cancel=lambda: (
                        lease_guard.lost
                        or _catalog_should_cancel(run_id, lease_token)
                    ),
                )
            lease_guard.ensure()
        except _RunCancelled:
            raise
        except Exception as exc:
            code, message = _safe_error(exc)
            partial_note_id = exc.note_id if isinstance(exc, _PartialImportError) else None
            with SessionLocal() as db:
                run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
                run_item = db.query(CreatorSyncRunItem).filter(
                    CreatorSyncRunItem.id == run_item_id,
                ).first()
                item = (
                    db.query(CreatorSourceItem).filter(
                        CreatorSourceItem.id == run_item.source_item_id,
                    ).first()
                    if run_item is not None else None
                )
                if run is None or run_item is None:
                    return
                if run.lease_token != lease_token:
                    raise _RunCancelled("任务租约已转移")
                if _is_needs_action(code):
                    _mark_item_result(
                        db, run, run_item, item,
                        state="failed", error_code=code, error_message=message,
                    )
                    now = _utcnow()
                    run.status = "failed"
                    run.needs_action = True
                    run.needs_action_code = code
                    run.needs_action_message = message
                    run.error_code = code
                    run.error_message = message
                    run.finished_at = now
                    run.lease_token = None
                    run.lease_until = None
                    db.commit()
                    return
                if _is_transient(code) and _schedule_item_retry(
                    db, run, run_item, code=code, message=message,
                ):
                    return
                _mark_item_result(
                    db, run, run_item, item,
                    state="failed",
                    note_id=partial_note_id,
                    error_code=code,
                    error_message=message,
                )
                db.commit()
            continue

        with SessionLocal() as db:
            run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
            run_item = db.query(CreatorSyncRunItem).filter(
                CreatorSyncRunItem.id == run_item_id,
            ).first()
            item = (
                db.query(CreatorSourceItem).filter(
                    CreatorSourceItem.id == run_item.source_item_id,
                ).first()
                if run_item is not None else None
            )
            if run is None or run_item is None:
                return
            if run.lease_token != lease_token:
                raise _RunCancelled("任务租约已转移")
            _mark_item_result(
                db,
                run,
                run_item,
                item,
                state="reused" if status == "reused" else "succeeded",
                note_id=note_id,
            )
            _heartbeat(db, run, lease_token, "importing")

    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.lease_token != lease_token:
            return
        _recompute_run_counts(db, run)
        now = _utcnow()
        run.status = "partial" if run.failed_count else "succeeded"
        run.finished_at = now
        run.heartbeat_at = now
        run.lease_token = None
        run.lease_until = None
        run.next_retry_at = None
        source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
        if source is not None:
            source.last_synced_at = now
            if run.status == "succeeded":
                source.last_success_at = now
                source.last_error_code = ""
            else:
                source.last_error_code = run.error_code or "item_failed"
        db.commit()


def _handle_run_exception(run_id: str, lease_token: str, exc: Exception) -> None:
    code, message = _safe_error(exc)
    if code == "cancelled" or isinstance(exc, _RunCancelled):
        _finish_cancelled(run_id, lease_token)
        return
    with SessionLocal() as db:
        run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
        if run is None or run.status in TERMINAL_CREATOR_RUN_STATUSES:
            return
        if run.lease_token not in {None, lease_token}:
            return
        if run.cancellation_requested:
            _finish_cancelled(run_id, lease_token)
            return
        now = _utcnow()
        run.error_code = code
        run.error_message = message
        run.lease_token = None
        run.lease_until = None
        if _is_needs_action(code):
            run.status = "failed"
            run.needs_action = True
            run.needs_action_code = code
            run.needs_action_message = message
            run.finished_at = now
        elif _is_transient(code) and run.attempt_count < len(RETRY_DELAYS_SECONDS):
            delay = RETRY_DELAYS_SECONDS[run.attempt_count]
            run.attempt_count += 1
            run.status = "queued"
            run.next_retry_at = now + timedelta(seconds=delay)
        else:
            run.status = (
                "partial"
                if run.operation == "catalog_all" and run.discovered_count > 0
                else "failed"
            )
            run.finished_at = now
            run.next_retry_at = None
        source = db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
        if source is not None and run.status in {"failed", "partial"}:
            source.last_synced_at = now
            source.last_error_code = code
        db.commit()


def process_run(run_id: str) -> None:
    """Conditionally claim and execute one durable run."""
    lease_token = _claim_run(run_id)
    if lease_token is None:
        return
    try:
        with SessionLocal() as db:
            run = db.query(CreatorSyncRun).filter(CreatorSyncRun.id == run_id).first()
            source = (
                db.query(CreatorSource).filter(CreatorSource.id == run.source_id).first()
                if run is not None else None
            )
            if run is None or source is None or source.status != "active":
                raise CreatorSyncError("source_unavailable", "博主不存在或已停用", 404)
            config = _feature_config(db, include_secret=True)
            if not config["enabled"] or not config["platforms"].get(run.platform, False):
                raise CreatorSyncError("feature_disabled", "指定博主同步已关闭", 403)
            binding = (
                douyin_binding_service.get_or_create(db, run.user_id)
                if run.platform == "douyin" else None
            )
            credentials = {
                "douyin_session_scope": binding.session_scope if binding else "",
                "douyin_binding_ref": binding.id if binding else "",
                "xhs_cookie": str(config.get("xhs_cookie") or ""),
            }
            concurrency = int(config["concurrency"].get(run.platform) or 1)
            run_snapshot = SimpleNamespace(
                id=run.id,
                user_id=run.user_id,
                source_id=run.source_id,
                platform=run.platform,
                operation=run.operation,
                requested_limit=run.requested_limit,
                target_count=run.target_count,
            )
            source_snapshot = SimpleNamespace(
                id=source.id,
                platform=source.platform,
                creator_id=source.creator_id,
                profile_url=source.profile_url,
                display_name=source.display_name,
                avatar_url=source.avatar_url,
            )
            _heartbeat(db, run, lease_token, "resolving")

        with _gate(run_snapshot.platform, concurrency):
            if run_snapshot.operation == "catalog_all":
                _process_catalog(run_id, lease_token, source_snapshot, credentials)
            else:
                _process_transcript_run(
                    run_id, lease_token, source_snapshot, run_snapshot, credentials,
                )
    except Exception as exc:
        _handle_run_exception(run_id, lease_token, exc)


def mark_note_permanently_removed(db: Session, *, user_id: str, note_id: str) -> int:
    now = _utcnow()
    return db.query(CreatorSourceItem).filter(
        CreatorSourceItem.user_id == user_id, CreatorSourceItem.note_id == note_id,
    ).update(
        {
            CreatorSourceItem.state: "removed",
            CreatorSourceItem.removed_at: now,
            CreatorSourceItem.note_id: None,
            CreatorSourceItem.is_available: False,
            CreatorSourceItem.unavailable_at: now,
        },
        synchronize_session=False,
    )


def due_run_ids(limit: int = 100) -> list[str]:
    now = _utcnow()
    with SessionLocal() as db:
        rows = db.query(CreatorSyncRun.id).filter(
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
            CreatorSyncRun.cancellation_requested.is_(False),
            or_(CreatorSyncRun.next_retry_at.is_(None), CreatorSyncRun.next_retry_at <= now),
            or_(CreatorSyncRun.lease_until.is_(None), CreatorSyncRun.lease_until < now),
        ).order_by(CreatorSyncRun.created_at.asc()).limit(
            max(1, min(500, int(limit))),
        ).all()
        return [row[0] for row in rows]


def recover_incomplete_runs() -> list[str]:
    """Release expired leases and return work that is due now."""
    now = _utcnow()
    with SessionLocal() as db:
        rows = db.query(CreatorSyncRun).filter(
            CreatorSyncRun.status.in_(ACTIVE_CREATOR_RUN_STATUSES),
        ).all()
        recovered: list[str] = []
        for run in rows:
            lease_until = _aware(run.lease_until)
            next_retry_at = _aware(run.next_retry_at)
            stale = lease_until is None or lease_until < now
            if run.cancellation_requested and stale:
                run.status = "cancelled"
                run.finished_at = now
                run.lease_token = None
                run.lease_until = None
                continue
            if stale:
                run.status = "queued"
                run.lease_token = None
                run.lease_until = None
                if next_retry_at is None or next_retry_at <= now:
                    recovered.append(run.id)
        db.commit()
        return recovered
