"""Reviewed handlers for public ordinary-user Product Actions."""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.models.note import Note
from app.models.user import User
from app.models.video_analysis import VideoAnalysisRun
from app.services import (
    ai_juicer,
    agent_runtime_service,
    agent_runtime_worker,
    agent_service,
    auth_service,
    automation_runner,
    automation_service,
    chat_credit_billing_service,
    chat_model_catalog_service,
    creator_sync_service,
    creator_sync_worker,
    douyin_binding_service,
    douyin_library,
    email_delivery,
    feedback_service,
    knowledge_service,
    library_extraction_service,
    library_hidden_service,
    library_removal_service,
    local_douyin_library_service,
    note_service,
    note_plan_agent_service,
    plan_service,
    platform_library_service,
    privacy_account_service,
    settings_service,
    user_ai_provider_service,
    video_analysis_billing_service,
    video_analysis_catalog_service,
    video_analysis_service,
)


class ActionHandlerError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _integer(payload: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = payload.get(key, default)
    if isinstance(raw, bool):
        raise ActionHandlerError("INVALID_INPUT", f"{key} 格式无效")
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ActionHandlerError("INVALID_INPUT", f"{key} 格式无效") from exc
    if not minimum <= value <= maximum:
        raise ActionHandlerError("INVALID_INPUT", f"{key} 超出允许范围")
    return value


def _text(payload: dict[str, Any], key: str, *, required: bool = False, maximum: int = 1000) -> str:
    value = str(payload.get(key) or "").strip()
    if required and not value:
        raise ActionHandlerError("INVALID_INPUT", f"缺少 {key}")
    if len(value) > maximum:
        raise ActionHandlerError("INVALID_INPUT", f"{key} 过长")
    return value


_PUBLIC_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def _public_id(
    payload: dict[str, Any],
    key: str,
    *,
    maximum: int = 128,
) -> str:
    """Read an opaque public identifier without letting it become a path."""
    value = _text(payload, key, required=True, maximum=maximum)
    if not _PUBLIC_ID_PATTERN.fullmatch(value):
        raise ActionHandlerError("INVALID_INPUT", f"{key} 格式无效")
    return value


def _safe_sync_job(job: Any) -> dict[str, Any]:
    """Project connector jobs without URLs, paths or raw connector errors."""
    raw = job if isinstance(job, dict) else {}
    return {
        key: raw.get(key)
        for key in (
            "job_id", "status", "created_at", "started_at", "finished_at",
            "total", "success", "failed", "skipped", "processed", "mode",
            "error_code", "source_mode", "channel", "fallback_attempted",
            "retry_after_seconds", "needs_action",
        )
        if key in raw
    }


def _safe_api_base(value: Any) -> str:
    """Return endpoint metadata while stripping credentials and query secrets."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host + (f":{parsed.port}" if parsed.port else "")
    return urlunsplit((parsed.scheme, netloc, parsed.path.rstrip("/"), "", ""))


def _safe_model_payload(value: Any) -> Any:
    """Remove even masked secrets from Agent/MCP model configuration output."""
    if isinstance(value, list):
        return [_safe_model_payload(item) for item in value]
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, item in value.items():
        lowered = str(key).lower()
        if lowered in {"api_key", "api_key_masked", "encrypted_api_key"}:
            continue
        if lowered == "api_base":
            result[key] = _safe_api_base(item)
        else:
            result[key] = _safe_model_payload(item)
    return result


def account_me(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    user = ctx.user
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "is_active": bool(user.is_active),
        "email_verified": bool(user.email_verified),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def library_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    page = _integer(payload, "page", 1, 1, 100_000)
    per_page = _integer(payload, "per_page", 20, 1, 100)
    items, total = note_service.list_notes(
        ctx.db,
        page=page,
        per_page=per_page,
        user_id=ctx.user.id,
        search=_text(payload, "search", maximum=120) or None,
    )
    return {"items": [item.to_dict() for item in items], "total": total, "page": page, "per_page": per_page}


def library_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = note_service.get_note(ctx.db, _text(payload, "note_id", required=True, maximum=64), ctx.user.id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "视频资料不存在")
    return row.to_dict()


def library_import_link(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Import one cloud-readable link without accepting ephemeral media URLs.

    Douyin account collection remains a local Windows capability.  The cloud
    importer deliberately accepts only the platforms already supported by
    ``platform_library_service`` (currently Bilibili and Xiaohongshu).
    """
    try:
        return platform_library_service.import_one(
            ctx.db,
            user_id=ctx.user.id,
            value=_text(payload, "url", required=True, maximum=2_000),
            source_mode=_text(payload, "source_mode", maximum=16) or None,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    except Exception as exc:
        raise ActionHandlerError(
            "LINK_IMPORT_FAILED",
            "分享链接暂时没有导入成功，请稍后重试",
            retryable=True,
        ) from exc


def library_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    note_id = _text(payload, "note_id", required=True, maximum=64)
    note = ctx.db.query(Note).filter(
        Note.id == note_id,
        Note.user_id == ctx.user.id,
    ).first()
    if note is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "视频资料不存在")
    public = note.to_dict()
    platform = str(public.get("platform") or "").strip().lower()
    video_id = str(note.video_id or "").strip()
    if platform == "douyin" and video_id:
        library_hidden_service.hide_aweme_ids(
            ctx.db, ctx.user.id, [video_id], "permanent"
        )
    creator_sync_service.mark_note_permanently_removed(
        ctx.db, user_id=ctx.user.id, note_id=note.id
    )
    ctx.db.delete(note)
    ctx.db.commit()
    return {"deleted": True, "note_id": note_id, "permanent": True}


def library_remove_many(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    note_ids = payload.get("note_ids")
    if not isinstance(note_ids, list):
        raise ActionHandlerError("INVALID_INPUT", "note_ids 格式无效")
    try:
        return library_removal_service.remove_many(
            ctx.db,
            user_id=ctx.user.id,
            note_ids=note_ids,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def _douyin_action_error(exc: Exception) -> ActionHandlerError:
    code = str(getattr(exc, "code", "DOUYIN_CONNECTOR_FAILED") or "DOUYIN_CONNECTOR_FAILED")
    normalized = code.upper()
    retryable = normalized not in {
        "ARGUS_UIFID_MISSING", "RISK_CONTROLLED", "VERIFICATION_REQUIRED",
        "SESSION_EXPIRED",
    }
    return ActionHandlerError(normalized, str(exc), retryable=retryable)


def library_sync_status(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Return safe connector/job state without loopback URLs or session scope."""
    binding = douyin_binding_service.get_by_user(ctx.db, ctx.user.id)
    if binding is None:
        return {
            "platform": "douyin",
            "connected": False,
            "session_valid": False,
            "login_mode": "unavailable",
            "max_sync_count": 100,
            "private_list_readiness": {
                "reported": False,
                "like_ready": False,
                "collection_ready": False,
                "missing_requirements": [],
            },
            "collection_resilience": {},
            "binding": {
                "status": "disconnected",
                "cookie_count": 0,
                "bound_at": None,
                "last_verified_at": None,
                "last_sync_at": None,
            },
            "error_code": "not_bound",
            "automatic_sync": False,
            "automatic_retry": False,
        }
    job_id = _text(payload, "job_id", maximum=64)
    try:
        if job_id:
            return {
                "platform": "douyin",
                "job": _safe_sync_job(
                    douyin_library.get_job(binding.session_scope, job_id)
                ),
                "automatic_retry": False,
            }
        state = douyin_library.connection_status(binding.session_scope)
    except douyin_library.DouyinLibraryError as exc:
        raise _douyin_action_error(exc) from exc
    # base_url and session_scope are deliberately omitted: the remote Agent
    # only needs public readiness and never receives the loopback topology.
    # This READ Action also never mutates the persisted binding.
    return {
        "platform": "douyin",
        "connected": bool(state.get("connected")),
        "session_valid": bool(state.get("cookie_valid")),
        "login_mode": str(state.get("login_browser_mode") or "unavailable"),
        "max_sync_count": int(state.get("max_sync_count") or 100),
        "private_list_readiness": state.get("private_list_readiness") or {},
        "collection_resilience": state.get("collection_resilience") or {},
        "binding": binding.safe_dict(),
        "error_code": (
            "connector_unavailable"
            if not state.get("connected")
            else "session_unavailable"
            if state.get("error")
            else ""
        ),
        "automatic_sync": False,
        "automatic_retry": False,
    }


def library_sync_start(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Start exactly one manual source refresh; never queue or loop retries."""
    binding = douyin_binding_service.get_or_create(ctx.db, ctx.user.id)
    mode = _text(payload, "mode", required=True, maximum=16)
    if mode not in {"like", "collect", "post"}:
        raise ActionHandlerError("INVALID_INPUT", "mode 值无效")
    count = _integer(payload, "count", 50, 1, 100)
    try:
        job = douyin_library.trigger_collect(binding.session_scope, count, mode)
        douyin_binding_service.mark_sync_started(ctx.db, binding)
    except douyin_library.DouyinLibraryError as exc:
        raise _douyin_action_error(exc) from exc
    return {
        "platform": "douyin",
        "source_mode": mode,
        "requested_count": count,
        "job": _safe_sync_job(job),
        "manual": True,
        "automatic_retry": False,
    }


def library_transcript_generate(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return library_extraction_service.extract_library_item(
            user_id=ctx.user.id,
            aweme_id=_public_id(payload, "aweme_id"),
            operation=_text(payload, "operation", maximum=16) or "transcript",
            # Temporary playback addresses are intentionally not accepted by
            # the public Action; the trusted desktop bridge owns that channel.
            ephemeral_media_url="",
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    except douyin_library.DouyinLibraryError as exc:
        raise _douyin_action_error(exc) from exc
    except Exception as exc:
        public_message = str(getattr(exc, "public_message", "") or "").strip()
        raise ActionHandlerError(
            "TRANSCRIPT_GENERATION_FAILED",
            public_message or "视频文案提取暂时失败，请稍后重试",
            retryable=bool(getattr(exc, "retryable", True)),
        ) from exc


def library_transcript_batch(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    aweme_ids = list(dict.fromkeys(
        str(value or "").strip()
        for value in payload.get("aweme_ids", [])
        if str(value or "").strip()
    ))
    concurrency = settings_service.get_extraction_concurrency(ctx.db)
    try:
        job = library_extraction_service.create_batch_job(
            user_id=ctx.user.id,
            aweme_ids=aweme_ids,
            operation="transcript",
            asr_concurrency=concurrency["asr"],
            llm_concurrency=concurrency["llm"],
            # Agent protocols never accept or persist temporary playback URLs.
            ephemeral_media_sources=None,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    ctx.run.external_type = "library_transcript_batch"
    ctx.run.external_id = str(job["job_id"])
    ctx.db.commit()
    return {
        "batch": job,
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def library_hidden_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    limit = _integer(payload, "limit", 100, 1, 1000)
    records = library_hidden_service.list_hidden_records(
        ctx.db, ctx.user.id, "permanent", limit
    )
    return {
        "items": [
            {
                "aweme_id": row.aweme_id,
                "hidden_mode": "permanent",
                "hidden_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in records
        ],
        "total": library_hidden_service.count_hidden(
            ctx.db, ctx.user.id, "permanent"
        ),
    }


def library_hidden_restore(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    raw_ids = payload.get("aweme_ids")
    if not isinstance(raw_ids, list) or not 1 <= len(raw_ids) <= 50:
        raise ActionHandlerError("INVALID_INPUT", "恢复数量必须在 1 到 50 条之间")
    aweme_ids: list[str] = []
    for raw_id in raw_ids:
        if not isinstance(raw_id, str):
            raise ActionHandlerError("INVALID_INPUT", "aweme_ids 格式无效")
        aweme_ids.append(_public_id({"aweme_id": raw_id}, "aweme_id"))
    try:
        return library_hidden_service.restore_permanent_aweme_ids(
            ctx.db,
            ctx.user.id,
            aweme_ids,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def _visual_history(payload: dict[str, Any]) -> list[dict[str, str]]:
    raw = payload.get("history") or []
    if not isinstance(raw, list) or len(raw) > 6:
        raise ActionHandlerError("INVALID_INPUT", "history 格式无效")
    result: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ActionHandlerError("INVALID_INPUT", "history 格式无效")
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content or len(content) > 1000:
            raise ActionHandlerError("INVALID_INPUT", "history 格式无效")
        result.append({"role": role, "content": content})
    return result


def library_visual_ask(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    aweme_id = _public_id(payload, "aweme_id")
    if library_hidden_service.is_hidden(ctx.db, ctx.user.id, aweme_id):
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "作品不存在或尚未同步")
    binding = douyin_binding_service.get_or_create(ctx.db, ctx.user.id)
    item: dict[str, Any] | None = None
    try:
        item = douyin_library.get_item(
            binding.session_scope, binding.id, aweme_id
        )
    except douyin_library.DouyinLibraryError:
        item = None
    if item is None:
        item = local_douyin_library_service.get_item(
            ctx.db, user_id=ctx.user.id, video_id=aweme_id
        )
    if item is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "作品不存在或尚未同步")

    media_type = str(item.get("media_type") or "video")
    try:
        if media_type == "gallery":
            images = douyin_library.gallery_image_data_urls(
                binding.session_scope,
                aweme_id,
                len(item.get("gallery_images") or []),
                max_images=8,
            )
        else:
            images = ai_juicer.extract_video_frames(
                douyin_library.companion_media_url(aweme_id),
                max_frames=8,
                request_headers=douyin_library.companion_headers(
                    binding.session_scope
                ),
            )
        if not images:
            raise ValueError("当前作品暂时没有可读取的图片或视频画面，请稍后重试")
        result = ai_juicer.answer_visual_question(
            title=str(item.get("title") or ""),
            caption=str(item.get("caption") or ""),
            images=images,
            media_type=media_type,
            question=_text(payload, "question", required=True, maximum=600),
            history=_visual_history(payload),
            llm_config=user_ai_provider_service.effective_vision_config(
                ctx.db, ctx.user.id
            ),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    except douyin_library.DouyinLibraryError as exc:
        raise _douyin_action_error(exc) from exc
    except Exception as exc:
        raise ActionHandlerError(
            "VISUAL_ASK_FAILED",
            "图片问答暂时不可用，请确认当前模型支持图片理解后重试",
            # A fresh visual call may already have consumed upstream tokens;
            # do not invite an automatic paid retry with a new idempotency key.
            retryable=False,
        ) from exc
    return {"item_id": aweme_id, **result}


def creator_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return {"items": creator_sync_service.list_sources(ctx.db, user_id=ctx.user.id)}


def creator_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return creator_sync_service.get_source_detail(
            ctx.db, user_id=ctx.user.id,
            source_id=_text(payload, "source_id", required=True, maximum=64),
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise ActionHandlerError(str(exc.code or "RESOURCE_NOT_FOUND").upper(), str(exc)) from exc


def creator_runs_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    status = _text(payload, "status", maximum=24) or "active"
    try:
        rows = creator_sync_service.list_runs(ctx.db, user_id=ctx.user.id, status=status)
    except creator_sync_service.CreatorSyncError as exc:
        raise ActionHandlerError(str(exc.code or "INVALID_INPUT").upper(), str(exc)) from exc
    return {"items": [row.to_dict() for row in rows]}


def _creator_error(exc: Exception) -> ActionHandlerError:
    code = str(getattr(exc, "code", "CREATOR_ACTION_FAILED") or "CREATOR_ACTION_FAILED").upper()
    return ActionHandlerError(code, str(exc), retryable=getattr(exc, "http_status", 0) >= 500)


def creator_resolve(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return creator_sync_service.resolve_source(
            ctx.db,
            user_id=ctx.user.id,
            platform=_text(payload, "platform", required=True, maximum=24),
            profile_ref=_text(payload, "profile_ref", required=True, maximum=1000),
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc


def creator_create(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        source, reused = creator_sync_service.save_source(
            ctx.db,
            user_id=ctx.user.id,
            platform=_text(payload, "platform", required=True, maximum=24),
            profile_ref=_text(payload, "profile_ref", required=True, maximum=1000),
        )
        return {
            "source": creator_sync_service.serialize_source_detail(ctx.db, source),
            "already_existed": reused,
        }
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc


def creator_items_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return creator_sync_service.list_source_items(
            ctx.db,
            user_id=ctx.user.id,
            source_id=_text(payload, "source_id", required=True, maximum=64),
            page=_integer(payload, "page", 1, 1, 100_000),
            per_page=_integer(payload, "per_page", 20, 1, 50),
            search=_text(payload, "search", maximum=100),
            status=_text(payload, "status", maximum=24) or "all",
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc


def creator_sync_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = creator_sync_service.get_run(
        ctx.db,
        user_id=ctx.user.id,
        run_id=_text(payload, "run_id", required=True, maximum=64),
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "博主同步任务不存在")
    return row.to_dict()


def creator_sync_items_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return creator_sync_service.list_run_items(
            ctx.db,
            user_id=ctx.user.id,
            run_id=_text(payload, "run_id", required=True, maximum=64),
            page=_integer(payload, "page", 1, 1, 100_000),
            per_page=_integer(payload, "per_page", 50, 1, 50),
            status=_text(payload, "status", maximum=24) or "all",
        )
    except creator_sync_service.CreatorSyncError as exc:
        error = _creator_error(exc)
        if error.code == "RUN_NOT_FOUND":
            raise ActionHandlerError(
                "RESOURCE_NOT_FOUND", "博主同步任务不存在"
            ) from exc
        raise error from exc


def _attach_creator_run(ctx: Any, row: Any, *, reused: bool) -> dict[str, Any]:
    ctx.run.external_type = "creator_sync"
    ctx.run.external_id = row.id
    ctx.db.commit()
    if row.status in creator_sync_service.ACTIVE_CREATOR_RUN_STATUSES:
        creator_sync_worker.runner.submit(row.id)
    return {
        "creator_run": row.to_dict(),
        "reused": reused,
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def creator_sync_start(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        row, reused = creator_sync_service.create_run(
            ctx.db,
            user_id=ctx.user.id,
            source_id=_text(payload, "source_id", required=True, maximum=64),
            limit=payload.get("limit"),
            operation=_text(payload, "operation", maximum=32) or "recent_transcript",
            item_ids=list(payload.get("item_ids") or []),
        )
        return _attach_creator_run(ctx, row, reused=reused)
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc


def creator_sync_retry(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        row, reused = creator_sync_service.retry_run(
            ctx.db,
            user_id=ctx.user.id,
            run_id=_text(payload, "run_id", required=True, maximum=64),
        )
        return _attach_creator_run(ctx, row, reused=reused)
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc


def creator_sync_cancel(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = creator_sync_service.request_cancel(
        ctx.db,
        user_id=ctx.user.id,
        run_id=_text(payload, "run_id", required=True, maximum=64),
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "博主同步任务不存在")
    return row.to_dict()


def creator_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    source_id = _text(payload, "source_id", required=True, maximum=64)
    try:
        deleted = creator_sync_service.disable_source(
            ctx.db, user_id=ctx.user.id, source_id=source_id
        )
    except creator_sync_service.CreatorSyncError as exc:
        raise _creator_error(exc) from exc
    if not deleted:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "博主不存在")
    return {"removed": True, "source_id": source_id}


def ask_thread_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    limit = _integer(payload, "limit", 50, 1, 100)
    return {"items": agent_service.list_threads(ctx.db, user_id=ctx.user.id, limit=limit)}


def ask_thread_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    thread = agent_service.get_thread(
        ctx.db, _text(payload, "thread_id", required=True, maximum=64), ctx.user.id
    )
    if thread is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知萃 AI 会话不存在")
    return agent_service.serialize_thread(ctx.db, thread, include_messages=True, include_sources=True)


def ask_turn_start(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    thread = agent_service.get_thread(
        ctx.db, _text(payload, "thread_id", required=True, maximum=64), ctx.user.id
    )
    if thread is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知萃 AI 会话不存在")
    try:
        turn, created = agent_runtime_service.create_or_get_turn(
            ctx.db,
            thread=thread,
            client_turn_id=_text(payload, "client_turn_id", required=True, maximum=80),
            question=_text(payload, "question", required=True, maximum=600),
            requested_mode=_text(payload, "research_mode", maximum=12) or "auto",
            output_style=_text(payload, "output_style", maximum=24) or "answer",
            custom_instruction=_text(payload, "custom_instruction", maximum=600),
            web_scope=_text(payload, "web_scope", maximum=20) or "video_only",
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    ctx.run.external_type = "agent_turn"
    ctx.run.external_id = turn.id
    ctx.db.commit()
    if created or turn.status in {"queued", "retry_wait"}:
        agent_runtime_worker.runner.submit(turn.id)
    return {
        "turn": turn.to_dict(),
        "created": created,
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def ask_sources_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return agent_service.list_sources(
            ctx.db,
            user_id=ctx.user.id,
            scope=_text(payload, "scope", maximum=24) or "all_ready",
            search=_text(payload, "search", maximum=80),
            timezone_name=_text(payload, "timezone", maximum=64) or "Asia/Shanghai",
            limit=_integer(payload, "limit", 100, 1, 1_000),
            include_ids=list(payload.get("include_ids") or []),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def ask_starter_questions(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return agent_service.suggest_starter_questions(
            ctx.db,
            user_id=ctx.user.id,
            scope=_text(payload, "source_scope", maximum=24) or "all_ready",
            source_ids=list(payload.get("source_ids") or []),
            timezone_name=(
                _text(payload, "timezone", maximum=64) or "Asia/Shanghai"
            ),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def ask_sources_search(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return agent_service.smart_search_sources(
            ctx.db,
            user_id=ctx.user.id,
            query=_text(payload, "query", required=True, maximum=200),
            scope=_text(payload, "scope", maximum=24) or "all_ready",
            timezone_name=_text(payload, "timezone", maximum=64) or "Asia/Shanghai",
            limit=_integer(payload, "limit", 30, 1, 50),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def ask_thread_create(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        thread = agent_service.create_thread(
            ctx.db,
            user_id=ctx.user.id,
            scope=_text(payload, "source_scope", maximum=24) or "all_ready",
            source_ids=list(payload.get("source_ids") or []),
            title=_text(payload, "title", maximum=256),
            timezone_name=_text(payload, "timezone", maximum=64) or "Asia/Shanghai",
            context_type=_text(payload, "context_type", maximum=16) or "video",
            context_id=_text(payload, "context_id", maximum=64) or None,
        )
    except ValueError as exc:
        code = "RESOURCE_NOT_FOUND" if "不存在" in str(exc) else "INVALID_INPUT"
        raise ActionHandlerError(code, str(exc)) from exc
    return agent_service.serialize_thread(
        ctx.db, thread, include_messages=True, include_sources=True
    )


def ask_thread_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    thread = agent_service.get_thread(
        ctx.db, _text(payload, "thread_id", required=True, maximum=64), ctx.user.id
    )
    if thread is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知萃 AI 会话不存在")
    try:
        agent_service.update_thread(
            ctx.db, thread,
            title=_text(payload, "title", required=True, maximum=256),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return agent_service.serialize_thread(ctx.db, thread)


def ask_thread_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    thread_id = _text(payload, "thread_id", required=True, maximum=64)
    thread = agent_service.get_thread(ctx.db, thread_id, ctx.user.id)
    if thread is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知萃 AI 会话不存在")
    try:
        agent_service.delete_thread(ctx.db, thread)
    except ValueError as exc:
        raise ActionHandlerError("RESOURCE_CONFLICT", str(exc)) from exc
    return {"deleted": True, "thread_id": thread_id}


def _owned_turn(ctx: Any, payload: dict[str, Any]):
    thread_id = _text(payload, "thread_id", required=True, maximum=64)
    turn_id = _text(payload, "turn_id", required=True, maximum=64)
    turn = agent_runtime_service.get_turn(ctx.db, turn_id, ctx.user.id)
    if turn is None or turn.thread_id != thread_id:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "Agent Turn 不存在")
    return turn


def ask_turn_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return _owned_turn(ctx, payload).to_dict()


def ask_turn_events(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    turn = _owned_turn(ctx, payload)
    after = _integer(payload, "after", 0, 0, 2_147_483_647)
    limit = _integer(payload, "limit", 500, 1, 500)
    rows = agent_runtime_service.list_events(
        ctx.db, turn=turn, after_seq=after, limit=limit
    )
    return {"turn": turn.to_dict(), "items": [row.to_dict() for row in rows]}


def ask_turn_cancel(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return agent_runtime_service.request_cancel(
        ctx.db, _owned_turn(ctx, payload)
    ).to_dict()


def ask_turn_retry(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        turn = agent_runtime_service.retry_turn(ctx.db, _owned_turn(ctx, payload))
    except ValueError as exc:
        raise ActionHandlerError("RESOURCE_CONFLICT", str(exc)) from exc
    agent_runtime_worker.runner.submit(turn.id)
    ctx.run.external_type = "agent_turn"
    ctx.run.external_id = turn.id
    ctx.db.commit()
    return {
        "turn": turn.to_dict(),
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def _ask_analysis_decision(
    ctx: Any,
    payload: dict[str, Any],
    *,
    decision: str,
) -> dict[str, Any]:
    """Apply one reviewed branch of the persisted in-thread approval card.

    The public Action deliberately does not accept an arbitrary ``action``
    string. Each branch has its own descriptor, risk policy and stable tool
    name, while the existing service remains the single owner of the atomic
    thread/card/analysis-run transition.
    """
    thread_id = _text(payload, "thread_id", required=True, maximum=64)
    analysis_run_id = _text(payload, "run_id", required=True, maximum=64)
    thread = agent_service.get_thread(ctx.db, thread_id, ctx.user.id)
    if thread is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知萃 AI 会话不存在")
    try:
        result = agent_service.decide_agent_video_analysis(
            ctx.db,
            thread=thread,
            user_id=ctx.user.id,
            run_id=analysis_run_id,
            action=decision,
            idempotency_key=(
                str(getattr(ctx.run, "idempotency_key", "") or "").strip()
                or f"agent-action:{ctx.run.id}"
            ),
            offering_id=(
                _text(payload, "offering_id", maximum=64) or None
                if decision == "reprepare"
                else None
            ),
            use_byok=(
                bool(payload.get("use_byok", False))
                if decision == "reprepare"
                else False
            ),
        )
    except agent_service.AgentThreadConflictError as exc:
        raise ActionHandlerError("RESOURCE_CONFLICT", str(exc)) from exc
    except ValueError as exc:
        if hasattr(exc, "code"):
            raise _analysis_error(exc) from exc
        code = "RESOURCE_NOT_FOUND" if "不存在" in str(exc) else "INVALID_INPUT"
        raise ActionHandlerError(code, str(exc)) from exc

    if decision in {"approve", "reprepare"}:
        analysis = result.get("video_analysis")
        external_run = analysis.get("run") if isinstance(analysis, dict) else None
        external_run_id = (
            str(external_run.get("id") or "").strip()
            if isinstance(external_run, dict)
            else ""
        )
        if not external_run_id:
            raise ActionHandlerError(
                "VIDEO_ANALYSIS_FAILED",
                "详细解析状态未能关联到当前问答，请刷新后重试",
            )
        ctx.run.external_type = "video_analysis"
        ctx.run.external_id = external_run_id
        ctx.db.commit()
        result = {
            **result,
            "resume": {
                "run_id": ctx.run.id,
                "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
            },
        }
    return result


def ask_analysis_approve(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return _ask_analysis_decision(ctx, payload, decision="approve")


def ask_analysis_text_only(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return _ask_analysis_decision(ctx, payload, decision="text_only")


def ask_analysis_cancel(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return _ask_analysis_decision(ctx, payload, decision="cancel")


def ask_analysis_reprepare(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return _ask_analysis_decision(ctx, payload, decision="reprepare")


def knowledge_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    view = _text(payload, "view", maximum=12) or "pages"
    return knowledge_service.list_knowledge(
        ctx.db,
        ctx.user.id,
        view=view,
        page=_integer(payload, "page", 1, 1, 100_000),
        per_page=_integer(payload, "per_page", 20, 1, 50),
        search=_text(payload, "search", maximum=120),
    )


def knowledge_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    result = knowledge_service.get_entry_item(
        ctx.db, ctx.user.id, _text(payload, "entry_id", required=True, maximum=64)
    )
    if result is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知识页不存在")
    return result


def knowledge_create(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = knowledge_service.create_entry(
        ctx.db,
        ctx.user.id,
        title=_text(payload, "title", required=True, maximum=256),
        summary=_text(payload, "summary", maximum=4000),
        content=_text(payload, "content", required=True, maximum=100_000),
        source_label=_text(payload, "source_label", maximum=256),
    )
    result = knowledge_service.get_entry_item(ctx.db, ctx.user.id, row.id)
    return result or {"id": row.id}


def knowledge_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    entry_id = _text(payload, "entry_id", required=True, maximum=64)
    row = knowledge_service.get_entry(ctx.db, ctx.user.id, entry_id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知识页不存在")
    updates: dict[str, Any] = {}
    limits = {"title": 256, "summary": 4_000, "content": 100_000, "source_label": 256}
    for key, limit in limits.items():
        if key in payload:
            updates[key] = _text(
                payload, key, required=key in {"title", "content"}, maximum=limit
            )
    if not updates:
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    try:
        knowledge_service.update_entry(ctx.db, row, **updates)
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return knowledge_service.get_entry_item(ctx.db, ctx.user.id, entry_id) or {"id": entry_id}


def knowledge_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    entry_id = _text(payload, "entry_id", required=True, maximum=64)
    row = knowledge_service.get_entry(ctx.db, ctx.user.id, entry_id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "知识页不存在")
    knowledge_service.delete_entry(ctx.db, row)
    return {"deleted": True, "entry_id": entry_id}


def knowledge_candidate_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    note_id = _text(payload, "note_id", required=True, maximum=64)
    item = knowledge_service.get_candidate_item(
        ctx.db, ctx.user.id, note_id
    )
    if item is None:
        # The same non-disclosing not-found response is used whether the note
        # belongs to another user or does not exist.
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "待整理内容不存在")
    return item


def knowledge_candidate_save(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    note_id = _text(payload, "note_id", required=True, maximum=64)
    try:
        entry = knowledge_service.save_candidate(
            ctx.db, ctx.user.id, note_id
        )
    except LookupError as exc:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "待整理内容不存在") from exc
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return (
        knowledge_service.get_entry_item(ctx.db, ctx.user.id, entry.id)
        or {"id": entry.id}
    )


def plan_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    page = _integer(payload, "page", 1, 1, 100_000)
    per_page = _integer(payload, "per_page", 20, 1, 100)
    rows, total = plan_service.list_plans(ctx.db, page, per_page, ctx.user.id)
    return {"items": [row.to_dict() for row in rows], "total": total, "page": page, "per_page": per_page}


def plan_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = plan_service.get_plan(
        ctx.db, _text(payload, "plan_id", required=True, maximum=64), ctx.user.id
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划不存在")
    return row.to_dict()


def plan_overview(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    return plan_service.get_plan_overview(
        ctx.db,
        user_id=ctx.user.id,
        for_date=_text(payload, "date", maximum=10) or None,
    )


def plan_create(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    first_task = payload.get("first_task")
    tasks: list[dict[str, Any]] = []
    if first_task is not None:
        if not isinstance(first_task, dict):
            raise ActionHandlerError("INVALID_INPUT", "first_task 格式无效")
        allowed = {
            "title", "day", "scheduled_at", "reminder_at",
            "duration_minutes", "frequency", "priority",
        }
        if set(first_task) - allowed:
            raise ActionHandlerError("INVALID_INPUT", "first_task 包含未知字段")
        title_value = first_task.get("title")
        if not isinstance(title_value, str) or len(title_value) > 256:
            raise ActionHandlerError("INVALID_INPUT", "首个任务标题格式无效")
        title = title_value.strip()
        if not title:
            raise ActionHandlerError("INVALID_INPUT", "首个任务标题不能为空")
        task_payload: dict[str, Any] = {"title": title}
        if "day" in first_task:
            day = first_task["day"]
            if isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 3650:
                raise ActionHandlerError("INVALID_INPUT", "首个任务天数格式无效")
            task_payload["day"] = day
        for key, maximum in (
            ("scheduled_at", 40), ("reminder_at", 40), ("frequency", 120),
        ):
            if key not in first_task or first_task[key] is None:
                continue
            value = first_task[key]
            if not isinstance(value, str) or len(value) > maximum:
                raise ActionHandlerError("INVALID_INPUT", f"{key} 格式无效")
            task_payload[key] = value.strip()
        if "duration_minutes" in first_task and first_task["duration_minutes"] is not None:
            duration = first_task["duration_minutes"]
            if (
                isinstance(duration, bool)
                or not isinstance(duration, int)
                or not 1 <= duration <= 10080
            ):
                raise ActionHandlerError("INVALID_INPUT", "duration_minutes 格式无效")
            task_payload["duration_minutes"] = duration
        if "priority" in first_task:
            priority = first_task["priority"]
            if priority not in {"low", "medium", "high"}:
                raise ActionHandlerError("INVALID_INPUT", "priority 值无效")
            task_payload["priority"] = priority
        task_payload.update({
            "id": f"t-{uuid.uuid4().hex[:8]}",
            "done": False,
        })
        tasks.append(task_payload)
    try:
        row = plan_service.create_plan(
            ctx.db,
            note_id=None,
            title=_text(payload, "title", required=True, maximum=256),
            tasks=tasks,
            total_days=_integer(payload, "total_days", 0, 0, 3650),
            start_date=_text(payload, "start_date", maximum=10) or None,
            user_id=ctx.user.id,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return row.to_dict()


def plan_from_library_generate(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return note_plan_agent_service.generate_or_revise_from_note(
            ctx.db,
            user_id=ctx.user.id,
            note_id=_text(payload, "note_id", required=True, maximum=64),
            instruction=_text(
                payload,
                "instruction",
                required=True,
                maximum=1000,
            ),
        )
    except note_plan_agent_service.NotePlanAgentError as exc:
        raise ActionHandlerError(exc.code, str(exc)) from exc
    except Exception as exc:
        raise ActionHandlerError(
            "MODEL_UNAVAILABLE",
            "计划生成暂时不可用，请稍后重试",
            retryable=True,
        ) from exc


def plan_focus_replace(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    raw_tasks = payload.get("tasks") or []
    if not isinstance(raw_tasks, list) or len(raw_tasks) > 3:
        raise ActionHandlerError("INVALID_INPUT", "每天最多安排三项重点")
    selections: list[dict[str, str]] = []
    for item in raw_tasks:
        if not isinstance(item, dict):
            raise ActionHandlerError("INVALID_INPUT", "重点任务格式无效")
        if set(item) - {"plan_id", "task_id"}:
            raise ActionHandlerError("INVALID_INPUT", "重点任务包含未知字段")
        if not isinstance(item.get("plan_id"), str) or not isinstance(item.get("task_id"), str):
            raise ActionHandlerError("INVALID_INPUT", "重点任务格式无效")
        plan_id = item["plan_id"].strip()
        task_id = item["task_id"].strip()
        if not plan_id or len(plan_id) > 64 or not task_id or len(task_id) > 96:
            raise ActionHandlerError("INVALID_INPUT", "重点任务信息不完整")
        selections.append({"plan_id": plan_id, "task_id": task_id})
    try:
        return plan_service.replace_daily_focus(
            ctx.db,
            user_id=ctx.user.id,
            focus_date=_text(payload, "date", required=True, maximum=10),
            selections=selections,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def plan_review(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return plan_service.get_weekly_review(
            ctx.db,
            user_id=ctx.user.id,
            week_start=_text(payload, "week_start", maximum=10) or None,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def plan_task_reorder(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    task_ids = payload.get("task_ids")
    if not isinstance(task_ids, list) or len(task_ids) > 2000:
        raise ActionHandlerError("INVALID_INPUT", "task_ids 格式无效")
    if any(not isinstance(item, str) for item in task_ids):
        raise ActionHandlerError("INVALID_INPUT", "任务标识格式无效")
    normalized = [item.strip() for item in task_ids]
    if any(not item or len(item) > 96 for item in normalized):
        raise ActionHandlerError("INVALID_INPUT", "任务标识格式无效")
    try:
        row = plan_service.reorder_tasks(
            ctx.db,
            _text(payload, "plan_id", required=True, maximum=64),
            task_ids=normalized,
            user_id=ctx.user.id,
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划不存在")
    return row.to_dict()


def plan_coach_preview(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = _text(payload, "plan_id", required=True, maximum=64)
    try:
        # Reuse the durable plan-thread path so model selection, free quota /
        # credit reservation, capture, release, retries and persisted preview
        # semantics remain identical to the product UI.
        thread = agent_service.create_thread(
            ctx.db,
            user_id=ctx.user.id,
            scope="all_ready",
            source_ids=[],
            context_type="plan",
            context_id=plan_id,
        )
        turn, created = agent_runtime_service.create_or_get_turn(
            ctx.db,
            thread=thread,
            client_turn_id=f"action-{ctx.run.id}",
            question=_text(
                payload, "instruction", required=True, maximum=1000
            ),
            requested_mode="auto",
            output_style="answer",
            custom_instruction="",
            web_scope="video_only",
        )
    except ValueError as exc:
        code = "RESOURCE_NOT_FOUND" if "不存在" in str(exc) else "INVALID_INPUT"
        raise ActionHandlerError(code, str(exc)) from exc
    ctx.run.external_type = "agent_turn"
    ctx.run.external_id = turn.id
    ctx.db.commit()
    if created or turn.status in {"queued", "retry_wait"}:
        agent_runtime_worker.runner.submit(turn.id)
    return {
        "thread_id": thread.id,
        "turn": turn.to_dict(),
        "created": created,
        "apply_reference": "assistant_message_id",
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def plan_coach_apply(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    message_id = _text(
        payload, "preview_message_id", required=True, maximum=64
    )
    try:
        row, message = agent_service.apply_plan_change_message(
            ctx.db,
            message_id=message_id,
            user_id=ctx.user.id,
        )
    except plan_service.PlanConflictError as exc:
        raise ActionHandlerError("RESOURCE_CONFLICT", str(exc)) from exc
    except ValueError as exc:
        code = (
            "RESOURCE_NOT_FOUND"
            if "不存在" in str(exc) or "不属于" in str(exc)
            else "INVALID_INPUT"
        )
        raise ActionHandlerError(code, str(exc)) from exc
    return {
        "plan": row.to_dict(),
        "preview_message_id": message_id,
        "preview": message.to_dict(),
    }


def plan_task_add(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    day_raw = payload.get("day")
    day = None if day_raw is None else _integer(payload, "day", 1, 1, 3650)
    row = plan_service.add_task(
        ctx.db,
        _text(payload, "plan_id", required=True, maximum=64),
        _text(payload, "title", required=True, maximum=500),
        day=day,
        scheduled_at=_text(payload, "scheduled_at", maximum=40) or None,
        priority=_text(payload, "priority", maximum=12) or "medium",
        user_id=ctx.user.id,
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划不存在")
    return row.to_dict()


def plan_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = _text(payload, "plan_id", required=True, maximum=64)
    updates = {
        key: payload[key]
        for key in ("title", "status", "start_date", "total_days")
        if key in payload
    }
    if not updates:
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    try:
        row = plan_service.update_plan(ctx.db, plan_id, updates, user_id=ctx.user.id)
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划不存在")
    return row.to_dict()


def plan_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = _text(payload, "plan_id", required=True, maximum=64)
    if not plan_service.delete_plan(ctx.db, plan_id, user_id=ctx.user.id):
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划不存在")
    return {"deleted": True, "plan_id": plan_id}


def plan_task_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = _text(payload, "plan_id", required=True, maximum=64)
    task_id = _text(payload, "task_id", required=True, maximum=64)
    updates = {
        key: payload[key]
        for key in (
            "title", "day", "scheduled_at", "reminder_at",
            "duration_minutes", "frequency", "priority",
        )
        if key in payload
    }
    if not updates:
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    try:
        row = plan_service.update_task(
            ctx.db, plan_id, task_id, updates, user_id=ctx.user.id
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划或任务不存在")
    return row.to_dict()


def plan_task_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    plan_id = _text(payload, "plan_id", required=True, maximum=64)
    task_id = _text(payload, "task_id", required=True, maximum=64)
    row = plan_service.delete_task(ctx.db, plan_id, task_id, user_id=ctx.user.id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "计划或任务不存在")
    return row.to_dict()


def automation_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return {"items": [row.to_dict() for row in automation_service.list_automations(ctx.db, ctx.user.id)]}


def automation_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = automation_service.get_automation(
        ctx.db, _text(payload, "automation_id", required=True, maximum=64), ctx.user.id
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "自动摘要不存在")
    return row.to_dict()


def automation_status(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    runner_status = automation_runner.runner.status()
    return {
        "runner": {
            "enabled": bool(runner_status.get("enabled")),
            "running": bool(runner_status.get("running")),
            "poll_seconds": int(runner_status.get("poll_seconds") or 0),
        },
        "email": email_delivery.public_status(),
        "account_email": ctx.user.email,
        "email_verified": bool(ctx.user.email_verified),
        "recipient_policy": "account_email_only",
    }


def automation_create(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        row = automation_service.create_automation(
            ctx.db,
            user=ctx.user,
            name=_text(payload, "name", maximum=160) or "昨日视频摘要",
            enabled=bool(payload.get("enabled", True)),
            schedule_time=_text(payload, "schedule_time", maximum=5) or "08:00",
            timezone_name=_text(payload, "timezone", maximum=64) or "Asia/Shanghai",
            source_scope=_text(payload, "source_scope", maximum=24) or "yesterday_new",
            source_mode=_text(payload, "source_mode", maximum=16) or "collect",
            instruction=_text(payload, "instruction", maximum=2_000)
            or automation_service.DEFAULT_INSTRUCTION,
            recipient_email=_text(payload, "recipient_email", maximum=256),
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return {**row.to_dict(), "channel": "email", "destination": row.recipient_email}


def automation_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    row = automation_service.get_automation(
        ctx.db,
        _text(payload, "automation_id", required=True, maximum=64),
        ctx.user.id,
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "自动摘要不存在")
    allowed = {
        "name", "enabled", "schedule_time", "timezone", "source_scope",
        "source_mode", "instruction", "recipient_email",
    }
    changes = {key: payload[key] for key in allowed if key in payload}
    if not changes:
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    try:
        automation_service.update_automation(
            ctx.db, row, user=ctx.user, changes=changes
        )
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    return {**row.to_dict(), "channel": "email", "destination": row.recipient_email}


def automation_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    automation_id = _text(payload, "automation_id", required=True, maximum=64)
    row = automation_service.get_automation(ctx.db, automation_id, ctx.user.id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "自动摘要不存在")
    automation_service.delete_automation(ctx.db, row)
    return {"deleted": True, "automation_id": automation_id}


def automation_runs_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    automation_id = _text(payload, "automation_id", required=True, maximum=64)
    row = automation_service.get_automation(
        ctx.db, automation_id, ctx.user.id, include_deleted=True
    )
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "自动摘要不存在")
    rows = automation_service.list_runs(
        ctx.db,
        automation_id=automation_id,
        user_id=ctx.user.id,
        limit=_integer(payload, "limit", 30, 1, 100),
    )
    return {"items": [item.to_dict() for item in rows], "total": len(rows)}


def automation_run(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Generate a manual preview; Agent calls can never send email."""
    automation_id = _text(payload, "automation_id", required=True, maximum=64)
    row = automation_service.get_automation(ctx.db, automation_id, ctx.user.id)
    if row is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "自动摘要不存在")
    try:
        run = automation_service.create_manual_run(ctx.db, automation=row)
        completed = automation_service.execute_run(
            ctx.db, run_id=run.id, deliver=False
        )
    except ValueError as exc:
        raise ActionHandlerError("RATE_LIMITED", str(exc), retryable=True) from exc
    if completed is None:
        raise ActionHandlerError(
            "AUTOMATION_RUN_FAILED", "未能创建自动摘要运行", retryable=True
        )
    return completed.to_dict()


def account_email_status(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return {
        "account_email": ctx.user.email,
        "email_verified": bool(ctx.user.email_verified),
        "delivery": email_delivery.public_status(),
    }


def account_email_send(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    user = (
        ctx.db.query(User)
        .filter(User.id == ctx.user.id)
        .with_for_update()
        .one()
    )
    if user.email_verified:
        return {"status": "already_verified", "email_verified": True}
    if not email_delivery.is_configured():
        raise ActionHandlerError(
            "EMAIL_DELIVERY_UNAVAILABLE",
            "邮件服务尚未启用；定时摘要会先保存在知萃中，不会外发。",
            retryable=True,
        )
    now = datetime.now(timezone.utc)
    sent_at = user.email_verification_sent_at
    if sent_at is not None:
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if sent_at > now - timedelta(seconds=60):
            raise ActionHandlerError(
                "RATE_LIMITED", "验证邮件刚刚已经提交，请稍后再试。",
                retryable=True,
            )
    nonce = secrets.token_urlsafe(32)
    user.email_verification_nonce = nonce
    user.email_verification_sent_at = now
    ctx.db.commit()
    ctx.db.refresh(user)
    token = auth_service.create_email_verification_token(user, nonce)
    delivery = email_delivery.send_verification(
        recipient=user.email,
        token=token,
        message_key=f"{user.id}-{nonce}",
    )
    if delivery.get("status") != "sent":
        raise ActionHandlerError(
            "EMAIL_DELIVERY_FAILED",
            "验证邮件暂时没有提交成功，请稍后重试。",
            retryable=True,
        )
    return {"status": "submitted", "email_verified": False}


def account_email_confirm(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    token = _text(payload, "token", required=True, maximum=4096)
    decoded = auth_service.decode_email_verification_token(token)
    if decoded is None:
        raise ActionHandlerError(
            "EMAIL_VERIFICATION_INVALID", "验证链接无效或已过期，请重新发送。"
        )
    # An authenticated Agent may only confirm the account that issued its
    # credential, even if it somehow obtains another user's mail token.
    if (
        str(decoded.get("sub") or "") != ctx.user.id
        or str(decoded.get("email") or "").lower()
        != str(ctx.user.email or "").lower()
    ):
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "账号不存在或已停用。")
    user = ctx.db.query(User).filter(
        User.id == ctx.user.id,
        User.email == str(decoded.get("email") or "").lower(),
        User.is_active.is_(True),
    ).first()
    if user is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "账号不存在或已停用。")
    if user.email_verified:
        return {"email_verified": True, "status": "already_verified"}
    token_nonce = str(decoded.get("nonce") or "")
    stored_nonce = str(user.email_verification_nonce or "")
    if (
        not token_nonce
        or not stored_nonce
        or not secrets.compare_digest(token_nonce, stored_nonce)
    ):
        raise ActionHandlerError(
            "EMAIL_VERIFICATION_INVALID", "验证链接已失效，请重新发送。"
        )
    user.email_verified = True
    user.email_verification_nonce = None
    ctx.db.commit()
    return {"email_verified": True, "status": "verified"}


def account_consents(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return {
        "items": privacy_account_service.list_consents(ctx.db, ctx.user.id)
    }


def models_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    rows = chat_model_catalog_service.list_published(ctx.db)
    selected = chat_model_catalog_service.selected_offering(ctx.db, ctx.user.id)
    return {
        "items": [chat_model_catalog_service.serialize_user(ctx.db, row, ctx.user.id) for row in rows],
        "selected_offering_id": selected.id,
        "account": chat_credit_billing_service.account_summary(ctx.db, ctx.user.id),
    }


def models_settings_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    # Agent/MCP does not need even masked key fragments.  API Base metadata is
    # normalized to a public origin/path with credentials and query removed.
    return _safe_model_payload({
        "provider": user_ai_provider_service.serialize(ctx.db, ctx.user.id),
        "custom_models": user_ai_provider_service.list_custom_models(ctx.db, ctx.user.id),
    })


def models_selection_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    current = user_ai_provider_service.serialize(ctx.db, ctx.user.id)
    return _safe_model_payload({
        key: current.get(key)
        for key in (
            "mode", "enabled", "provider_name", "model",
            "selected_offering_id", "selected_offering_name",
            "selected_custom_model_id", "api_base", "api_key_set", "policy",
        )
    })


def models_selection_set(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    kind = _text(payload, "kind", required=True, maximum=16)
    if kind == "platform":
        offering_id = _text(
            payload, "offering_id", required=True, maximum=64
        )
        try:
            selected = chat_model_catalog_service.select_for_user(
                ctx.db, ctx.user.id, offering_id
            )
            user_ai_provider_service.select_platform(ctx.db, ctx.user.id)
        except ValueError as exc:
            raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
        return {
            "kind": "platform",
            "selected_offering_id": selected.id,
            "item": chat_model_catalog_service.serialize_user(
                ctx.db, selected, ctx.user.id
            ),
        }
    if kind == "custom":
        model_id = _text(payload, "model_id", required=True, maximum=64)
        try:
            return {
                "kind": "custom",
                **user_ai_provider_service.select_custom_model(
                    ctx.db, ctx.user.id, model_id
                ),
            }
        except KeyError as exc:
            raise ActionHandlerError(
                "RESOURCE_NOT_FOUND", "自定义模型不存在"
            ) from exc
        except ValueError as exc:
            raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc
    raise ActionHandlerError("INVALID_INPUT", "模型选择类型无效")


def models_custom_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return _safe_model_payload(
        user_ai_provider_service.list_custom_models(ctx.db, ctx.user.id)
    )


def models_custom_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    model_id = _text(payload, "model_id", required=True, maximum=64)
    changes = {
        key: payload[key]
        for key in ("name", "provider_name", "model", "enabled")
        if key in payload
    }
    if not changes:
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    try:
        result = user_ai_provider_service.update_custom_model(
            ctx.db,
            ctx.user.id,
            model_id,
            name=changes.get("name"),
            provider_name=changes.get("provider_name"),
            model=changes.get("model"),
            enabled=changes.get("enabled"),
            # Public Agent input never carries or changes API keys/API Base.
            api_base=None,
            api_key=None,
        )
        return _safe_model_payload(result)
    except KeyError as exc:
        raise ActionHandlerError(
            "RESOURCE_NOT_FOUND", "自定义模型不存在"
        ) from exc
    except ValueError as exc:
        raise ActionHandlerError("INVALID_INPUT", str(exc)) from exc


def models_custom_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    model_id = _text(payload, "model_id", required=True, maximum=64)
    try:
        return user_ai_provider_service.delete_custom_model(
            ctx.db, ctx.user.id, model_id
        )
    except KeyError as exc:
        raise ActionHandlerError(
            "RESOURCE_NOT_FOUND", "自定义模型不存在"
        ) from exc


def models_custom_test(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    model_id = _text(payload, "model_id", required=True, maximum=64)
    cfg = user_ai_provider_service.effective_custom_config(
        ctx.db, ctx.user.id, model_id
    )
    if cfg is None:
        raise ActionHandlerError(
            "RESOURCE_NOT_FOUND", "自定义模型不存在或不可用"
        )
    try:
        # Revalidate legacy rows immediately before the outbound call. Secure
        # create/update paths enforce the same public HTTPS rule at write time.
        video_analysis_catalog_service._validate_public_user_api_base(
            str(cfg.get("api_base") or "")
        )
    except Exception as exc:
        raise ActionHandlerError(
            "UNSAFE_API_BASE", "自定义模型 API Base 必须是可解析的公网 HTTPS 地址"
        ) from exc
    try:
        from litellm import completion

        response = completion(
            model=cfg["runtime_model"],
            api_base=cfg["api_base"] or None,
            api_key=cfg["api_key"] or None,
            messages=[{"role": "user", "content": "只回复 OK"}],
            max_tokens=8,
            temperature=0,
            timeout=20,
            num_retries=0,
        )
        message = response.choices[0].message
        if not (
            str(message.content or "").strip()
            or str(getattr(message, "reasoning_content", "") or "").strip()
            or getattr(message, "tool_calls", None)
        ):
            raise RuntimeError("模型没有返回可见内容")
    except Exception as exc:
        raise ActionHandlerError(
            "MODEL_CONNECTION_FAILED",
            "连接测试失败，请检查网关状态、模型名称和访问权限",
            retryable=True,
        ) from exc
    return {"connected": True, "provider": "custom", "model": cfg["model"]}


def _vision_with_drivers(data: dict[str, Any]) -> dict[str, Any]:
    return {
        **data,
        "supported_drivers": [
            {
                "value": "openai_compatible",
                "label": "OpenAI 兼容图片模型",
                "supports_images": True,
            },
            {
                "value": "litellm_image",
                "label": "LiteLLM 图片模型",
                "supports_images": True,
            },
        ],
    }


def _vision_action_error(exc: Exception) -> ActionHandlerError:
    return ActionHandlerError(
        str(getattr(exc, "code", "VISION_CONFIG_FAILED") or "VISION_CONFIG_FAILED").upper(),
        str(exc),
        retryable=False,
    )


def models_vision_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return _safe_model_payload(
        _vision_with_drivers(
            video_analysis_catalog_service.serialize_user_vision_config(
                ctx.db, ctx.user.id
            )
        )
    )


def models_vision_update(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    if not any(key in payload for key in ("provider_name", "model", "enabled")):
        raise ActionHandlerError("INVALID_INPUT", "请至少提供一个要更新的字段")
    current = video_analysis_catalog_service.serialize_user_vision_config(
        ctx.db, ctx.user.id
    )
    if not current.get("configured"):
        raise ActionHandlerError(
            "SECURE_INPUT_REQUIRED",
            "首次配置视觉模型需要在安全网页表单中录入 API Key",
        )
    try:
        data = video_analysis_catalog_service.save_user_vision_config(
            ctx.db,
            ctx.user.id,
            provider_name=(
                _text(payload, "provider_name", maximum=80)
                if "provider_name" in payload
                else str(current.get("provider_name") or "")
            ),
            driver=str(current.get("driver") or "openai_compatible"),
            model=(
                _text(payload, "model", maximum=160)
                if "model" in payload
                else str(current.get("model") or "")
            ),
            api_base=str(current.get("api_base") or ""),
            api_key="",
            enabled=(
                bool(payload["enabled"])
                if "enabled" in payload
                else bool(current.get("enabled"))
            ),
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _vision_action_error(exc) from exc
        raise
    return _safe_model_payload(_vision_with_drivers(data))


def models_vision_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    return _safe_model_payload(
        _vision_with_drivers(
            video_analysis_catalog_service.delete_user_vision_config(
                ctx.db, ctx.user.id
            )
        )
    )


def models_vision_test(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    try:
        result = video_analysis_catalog_service.test_user_vision_config(
            ctx.db, ctx.user.id
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _vision_action_error(exc) from exc
        raise
    result["connected"] = bool(result.get("ok"))
    result["config"] = _vision_with_drivers(result["config"])
    return _safe_model_payload(result)


def feedback_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    page = _integer(payload, "page", 1, 1, 100_000)
    per_page = _integer(payload, "per_page", 20, 1, 100)
    rows, total = feedback_service.list_user_feedback(
        ctx.db, user_id=ctx.user.id, page=page, per_page=per_page
    )
    return {"items": [feedback_service.to_dict(row) for row in rows], "total": total, "page": page, "per_page": per_page}


def feedback_submit(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    if feedback_service.recent_submission_count(ctx.db, user_id=ctx.user.id) >= 5:
        raise ActionHandlerError("RATE_LIMITED", "反馈提交过于频繁，请稍后再试", retryable=True)
    category = _text(payload, "category", required=True, maximum=32)
    if category not in feedback_service.FEEDBACK_CATEGORIES:
        raise ActionHandlerError("INVALID_INPUT", "反馈分类无效")
    row = feedback_service.create_feedback(
        ctx.db,
        user_id=ctx.user.id,
        category=category,
        subject=_text(payload, "subject", required=True, maximum=160),
        content=_text(payload, "content", required=True, maximum=2000),
        page_path=_text(payload, "page_path", maximum=512) or None,
        client_context={"platform": "agent", "app_version": "v1"},
    )
    return feedback_service.to_dict(row)


def analysis_catalog(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    trigger = _text(payload, "trigger", maximum=16) or "manual"
    data = video_analysis_catalog_service.published_catalog(ctx.db, trigger=trigger)
    account = video_analysis_billing_service.get_or_create_account(ctx.db, ctx.user.id)
    ctx.db.commit()
    data["account"] = video_analysis_billing_service.serialize_account(ctx.db, account, ledger_limit=5)
    return data


def analysis_runs_list(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    page = _integer(payload, "page", 1, 1, 100_000)
    per_page = _integer(payload, "per_page", 20, 1, 100)
    status = _text(payload, "status", maximum=32) or "active"
    query = ctx.db.query(VideoAnalysisRun).filter(VideoAnalysisRun.user_id == ctx.user.id)
    if status == "active":
        query = query.filter(VideoAnalysisRun.status.in_(video_analysis_service.ACTIVE_RUN_STATUSES))
    elif status == "recent":
        query = query.filter(~VideoAnalysisRun.status.in_(["prepared"]))
    elif status != "all":
        query = query.filter(VideoAnalysisRun.status == status)
    total = query.count()
    rows = query.order_by(VideoAnalysisRun.created_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    return {
        "items": [video_analysis_service.serialize_run(row, items=video_analysis_service._run_items(ctx.db, row.id)) for row in rows],
        "total": total, "page": page, "per_page": per_page,
    }


def _analysis_error(exc: Exception) -> ActionHandlerError:
    code = str(getattr(exc, "code", "VIDEO_ANALYSIS_FAILED") or "VIDEO_ANALYSIS_FAILED").upper()
    retryable = int(getattr(exc, "status_code", 0) or 0) >= 500
    return ActionHandlerError(code, str(exc), retryable=retryable)


def analysis_run_prepare(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    note_ids = list(dict.fromkeys(
        str(value or "").strip() for value in payload.get("note_ids", [])
        if str(value or "").strip()
    ))
    try:
        # Preparing only creates a time-bound quote.  It never reserves points
        # or auto-confirms, even when the legacy browser route may auto-start a
        # free single-item run.
        return video_analysis_service.prepare_run(
            ctx.db,
            user_id=ctx.user.id,
            note_ids=note_ids,
            offering_id=_text(payload, "offering_id", maximum=64) or None,
            use_byok=bool(payload.get("use_byok", False)),
            trigger=_text(payload, "trigger", maximum=16) or "manual",
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _analysis_error(exc) from exc
        raise


def analysis_run_confirm(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    run_id = _text(payload, "run_id", required=True, maximum=64)
    try:
        result = video_analysis_service.confirm_run(
            ctx.db,
            user_id=ctx.user.id,
            run_id=run_id,
            idempotency_key=ctx.run.idempotency_key or f"agent:{ctx.run.id}",
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _analysis_error(exc) from exc
        raise
    ctx.run.external_type = "video_analysis"
    ctx.run.external_id = run_id
    ctx.db.commit()
    return {
        **result,
        "resume": {
            "run_id": ctx.run.id,
            "events_path": f"/api/agent-interface/v1/runs/{ctx.run.id}/events",
        },
    }


def analysis_run_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    run = video_analysis_service.get_run(
        ctx.db,
        user_id=ctx.user.id,
        run_id=_text(payload, "run_id", required=True, maximum=64),
    )
    if run is None:
        raise ActionHandlerError("RESOURCE_NOT_FOUND", "解析任务不存在")
    items = video_analysis_service._run_items(ctx.db, run.id)
    return {
        "run": video_analysis_service.serialize_run(run, items=items),
        "items": [video_analysis_service.serialize_item(item) for item in items],
    }


def analysis_run_cancel(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return video_analysis_service.cancel_run(
            ctx.db,
            user_id=ctx.user.id,
            run_id=_text(payload, "run_id", required=True, maximum=64),
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _analysis_error(exc) from exc
        raise


def analysis_run_remove(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Use the existing billing-aware removal/cancel semantics.

    The legacy DELETE route intentionally retains the durable audit record and
    releases any uncaptured reservation.  The public Action mirrors that
    behavior instead of hard-deleting billing history.
    """
    run_id = _text(payload, "run_id", required=True, maximum=64)
    try:
        result = video_analysis_service.cancel_run(
            ctx.db, user_id=ctx.user.id, run_id=run_id
        )
    except Exception as exc:
        if hasattr(exc, "code"):
            raise _analysis_error(exc) from exc
        raise
    return {
        **result,
        "removed_from_active": True,
        "audit_retained": True,
    }


def analysis_account_get(ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    account = video_analysis_billing_service.get_or_create_account(
        ctx.db, ctx.user.id
    )
    ctx.db.commit()
    return video_analysis_billing_service.serialize_account(ctx.db, account)


HANDLERS = {
    name: value
    for name, value in globals().items()
    if callable(value) and not name.startswith("_") and name not in {"Any", "ActionHandlerError"}
}


def get_handler(name: str):
    handler = HANDLERS.get(name)
    if handler is None:
        raise RuntimeError(f"Product Action handler 未注册: {name}")
    return handler
