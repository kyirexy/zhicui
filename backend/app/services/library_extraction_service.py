"""Concurrent, metadata-only extraction for the Douyin video library."""
from __future__ import annotations

import json
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal
from urllib.parse import urlsplit

from app.core.database import SessionLocal
from app.services import (
    ai_juicer,
    douyin_binding_service,
    douyin_library,
    local_douyin_library_service,
    note_service,
    plan_service,
    settings_service,
    video_source_ledger_service,
    video_extractor,
)

ProgressCallback = Callable[[str], None]
LibraryExtractionOperation = Literal["transcript", "ai", "full"]

_MAX_BATCH_ITEMS = 100
_MAX_AI_BATCH_ITEMS = 50
_MAX_EXECUTION_WORKERS = settings_service.MAX_EXTRACTION_ASR_CONCURRENCY
_EXECUTOR = ThreadPoolExecutor(
    max_workers=_MAX_EXECUTION_WORKERS,
    thread_name_prefix="zhicui-extract",
)
_JOBS_LOCK = threading.RLock()
_JOBS: dict[str, dict[str, Any]] = {}
_ITEM_LOCKS_GUARD = threading.Lock()
_ITEM_LOCKS: dict[tuple[str, str], threading.Lock] = {}
logger = logging.getLogger(__name__)
_EPHEMERAL_MEDIA_HOST_SUFFIXES = (
    ".douyinvod.com",
    ".bytecdn.cn",
    ".bytecdn.com",
    ".snssdk.com",
    ".ibytedtos.com",
    ".douyin.com",
    ".iesdouyin.com",
    ".pstatp.com",
    ".zjcdn.com",
    ".volccdn.com",
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utcnow().isoformat()


def _item_lock(user_id: str, aweme_id: str) -> threading.Lock:
    key = (user_id, aweme_id)
    with _ITEM_LOCKS_GUARD:
        lock = _ITEM_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _ITEM_LOCKS[key] = lock
        return lock


def normalize_ephemeral_media_url(value: object) -> str:
    """Validate a one-job Douyin media capability without persisting it."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) > 8192:
        raise ValueError("临时播放地址过长")
    parsed = urlsplit(raw)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.port not in (None, 443)
        or not any(host.endswith(suffix) for suffix in _EPHEMERAL_MEDIA_HOST_SUFFIXES)
    ):
        raise ValueError("临时播放地址不是受信任的抖音媒体地址")
    return raw


def optional_ephemeral_media_url(value: object) -> str:
    """Use a trusted desktop capability or safely fall back to the connector.

    The temporary URL is an optional acceleration hint. A stale desktop build
    can return a newly introduced CDN hostname, so rejecting the whole batch
    would turn a recoverable hint mismatch into a user-visible extraction
    failure. Unknown hosts are never fetched; the bound account connector is
    used instead.
    """
    try:
        return normalize_ephemeral_media_url(value)
    except ValueError:
        try:
            host = (urlsplit(str(value or "").strip()).hostname or "").lower()
        except ValueError:
            host = "invalid"
        logger.info(
            "Ignored untrusted optional Douyin media capability host=%s",
            host[:255] or "missing",
        )
        return ""


def _has_retryable_ai_failure(note: Any) -> bool:
    """Recognise current and legacy fallback cards so AI can be retried."""
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (TypeError, json.JSONDecodeError):
        return False
    return (
        payload.get("generation_status") == "fallback"
        or "AI 暂时无法生成结构化卡片" in str(payload.get("key_insight") or "")
        or "AI 处理暂时不可用" in str(payload.get("conclusion") or "")
    )


def _persist_generated_note(
    db,
    *,
    item: dict[str, Any],
    transcript: str,
    ai_result: dict[str, Any],
    user_id: str,
) -> dict[str, Any]:
    video_info = {
        "video_id": item["aweme_id"],
        "title": item["title"],
        "download_url": item["source_url"],
        "platform": "douyin",
    }
    note = note_service.create_note(
        db,
        video_info,
        transcript,
        ai_result,
        user_id,
    )
    video_source_ledger_service.upsert_item(
        db,
        user_id=user_id,
        item=item,
        note_id=note.id,
    )
    plan_id = _persist_generated_plan(db, note, ai_result, user_id)
    result = note.to_dict()
    result["plan_id"] = plan_id
    result["already_existed"] = False
    return result


def _persist_generated_plan(
    db,
    note,
    ai_result: dict[str, Any],
    user_id: str,
) -> str | None:
    """Persist a generated plan once for a newly initialized Note."""
    plan_id: str | None = None
    plan = ai_result.get("plan")
    if isinstance(plan, dict) and plan.get("tasks"):
        existing_plan = plan_service.get_plan_by_note(
            db,
            note.id,
            user_id=user_id,
        )
        if existing_plan is not None:
            return existing_plan.id
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
        plan_id = plan_service.create_plan(
            db=db,
            note_id=note.id,
            title=plan.get("goal") or note.video_title,
            user_id=user_id,
            fields=fields,
            tasks=tasks,
            total_days=total_days,
            days=plan.get("days") or [],
        ).id
    return plan_id


def _source_meta(item: dict[str, Any]) -> dict[str, Any]:
    source_synced_at = (
        str(item.get("source_synced_at") or "").strip()
        or str(item.get("recorded_at") or "").strip()
        or _iso_now()
    )
    metadata = {
        "source_kind": "douyin-library",
        "platform": "douyin",
        "source_url": item["source_url"],
        "cover_url": item["cover_url"],
        "author_name": item["author_name"],
        "recorded_at": item["recorded_at"],
        "caption": item["caption"],
        "source_mode": str(item.get("source_mode") or "unknown"),
        "source_rank": item.get("source_rank"),
        "source_synced_at": source_synced_at,
        # The downloader does not expose an exact Douyin favourite timestamp.
        # This is the first reliable time the item entered Zhicui's text store.
        "first_seen_at": source_synced_at,
    }
    transcript_source = str(item.get("transcript_source") or "").strip()
    transcript_notice = str(item.get("transcript_notice") or "").strip()
    if transcript_source:
        metadata["transcript_source"] = transcript_source
    if transcript_notice:
        metadata["transcript_notice"] = transcript_notice
    return metadata


def _video_info(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "video_id": item["aweme_id"],
        "title": item["title"],
        "download_url": item["source_url"],
        "platform": "douyin",
    }


def _metadata_transcript_fallback(item: dict[str, Any]) -> str:
    """Build a truthful text fallback for silent, caption-led Douyin works."""
    title = str(item.get("title") or "").strip()
    caption = str(item.get("caption") or "").strip()
    if len(caption) < 12:
        return ""
    if title and title not in caption:
        return f"【作品标题】\n{title}\n\n【作品发布文案】\n{caption}"
    return f"【作品发布文案】\n{caption}"


def _generate_ai_result(
    *,
    transcript: str,
    item: dict[str, Any],
    llm_gate: threading.Semaphore | None,
    progress: ProgressCallback | None,
) -> dict[str, Any]:
    gate = llm_gate or threading.Semaphore(1)
    with gate:
        if progress:
            progress("analyzing")
        intent = ai_juicer.classify_intent(transcript)
        plan_data = (
            ai_juicer.generate_plan(transcript)
            if intent["is_plan"]
            else None
        )
        ai_result = ai_juicer.generate_card(
            transcript=transcript,
            content_type=intent["card_type"],
            video_title=item["title"],
        )
        if plan_data:
            ai_result["plan"] = plan_data
    ai_result["ai_initialized"] = True
    ai_result["source_meta"] = _source_meta(item)
    return ai_result


def extract_library_item(
    *,
    user_id: str,
    aweme_id: str,
    asr_gate: threading.Semaphore | None = None,
    llm_gate: threading.Semaphore | None = None,
    progress: ProgressCallback | None = None,
    operation: LibraryExtractionOperation = "full",
    item: dict[str, Any] | None = None,
    ephemeral_media_url: str = "",
) -> dict[str, Any]:
    """Run one idempotent transcript or AI stage with text-only persistence."""
    clean_id = aweme_id.strip()
    if not clean_id:
        raise ValueError("视频标识不能为空")
    if operation not in {"transcript", "ai", "full"}:
        raise ValueError("不支持的资料库处理类型")

    with _item_lock(user_id, clean_id):
        # Keep database connections short-lived. External ASR/LLM calls can
        # take minutes, so holding a pooled connection while waiting would
        # silently cap a 50-item job at the SQLAlchemy pool size.
        with SessionLocal() as db:
            existing = note_service.get_note_by_video_id(
                db,
                clean_id,
                user_id=user_id,
            )
            existing_transcript = (
                (existing.transcript_raw or "").strip()
                if existing is not None
                else ""
            )
            if (
                existing is not None
                and operation == "transcript"
                and existing_transcript
            ):
                result = existing.to_dict()
                result["already_existed"] = True
                return result
            if (
                existing is not None
                and operation in {"ai", "full"}
                and existing.ai_initialized
                and not _has_retryable_ai_failure(existing)
            ):
                result = existing.to_dict()
                result["already_existed"] = True
                return result
            if operation == "ai" and not existing_transcript:
                raise ValueError("完整文案尚未就绪，请先完成文案提取")

            binding = douyin_binding_service.get_or_create(db, user_id)
            if item is None:
                try:
                    item = douyin_library.get_item(
                        binding.session_scope,
                        binding.id,
                        clean_id,
                    )
                except douyin_library.DouyinLibraryError:
                    item = None
            if item is None:
                item = local_douyin_library_service.get_item(
                    db,
                    user_id=user_id,
                    video_id=clean_id,
                )
            if item is None:
                raise ValueError("收藏视频不存在或尚未同步")
            if not item.get("can_extract"):
                raise ValueError("该作品没有可提取的视频文件")
            asr_config = (
                settings_service.get_asr_config(db)
                if not existing_transcript
                else None
            )
            session_scope = binding.session_scope

        transcript = existing_transcript
        if not transcript:
            gate = asr_gate or threading.Semaphore(1)
            with gate:
                if progress:
                    progress("transcribing")
                try:
                    if item.get("provider") == "desktop-local":
                        media_url = optional_ephemeral_media_url(ephemeral_media_url)
                        if media_url:
                            request_headers = {
                                "Referer": "https://www.douyin.com/",
                                "User-Agent": (
                                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                                    "Chrome/124.0.0.0 Safari/537.36"
                                ),
                            }
                        else:
                            # The local catalog stores stable metadata only.
                            # Reuse the user's bound session instead of hitting
                            # the risk-controlled public page for every item.
                            media_url = douyin_library.companion_media_url(
                                item["aweme_id"]
                            )
                            request_headers = douyin_library.companion_headers(
                                session_scope,
                            )
                    else:
                        media_url = douyin_library.companion_media_url(
                            item["aweme_id"]
                        )
                        request_headers = douyin_library.companion_headers(
                            session_scope,
                        )
                    transcript = video_extractor.extract_media_url_transcript(
                        media_url,
                        asr_config["api_key"],
                        asr_config["api_base_url"],
                        asr_config["model"],
                        request_headers=request_headers,
                    )
                except RuntimeError as exc:
                    # Short Douyin works are often silent and communicate through
                    # on-screen copy plus their publishing caption. In that case
                    # cloud ASR truthfully returns no speech. Preserve the creator's
                    # own text as a searchable document instead of marking the item
                    # as a generic extraction failure. Media/network failures still
                    # raise normally and remain retryable.
                    fallback = (
                        _metadata_transcript_fallback(item)
                        if "云端 ASR 返回空文案" in str(exc)
                        else ""
                    )
                    if not fallback:
                        raise
                    transcript = fallback
                    item["transcript_source"] = "creator-caption"
                    item["transcript_notice"] = "视频未识别到有效语音，文稿来自作品发布文案"
        if not transcript.strip():
            raise RuntimeError("语音识别没有返回文案")

        if operation == "transcript":
            with SessionLocal() as db:
                current = note_service.get_note_by_video_id(
                    db,
                    clean_id,
                    user_id=user_id,
                )
                if current is not None and (current.transcript_raw or "").strip():
                    result = current.to_dict()
                    result["already_existed"] = True
                    return result
                note = note_service.create_transcript_note(
                    db,
                    video_info=_video_info(item),
                    transcript=transcript,
                    source_meta=_source_meta(item),
                    user_id=user_id,
                )
                video_source_ledger_service.upsert_item(
                    db,
                    user_id=user_id,
                    item=item,
                    note_id=note.id,
                )
                result = note.to_dict()
                result["already_existed"] = False
                return result

        ai_result = _generate_ai_result(
            transcript=transcript,
            item=item,
            llm_gate=llm_gate,
            progress=progress,
        )
        with SessionLocal() as db:
            # Recheck inside the per-user/video lock immediately before the
            # write so concurrent single and batch callers cannot duplicate.
            existing = note_service.get_note_by_video_id(
                db,
                clean_id,
                user_id=user_id,
            )
            if existing is not None:
                if existing.ai_initialized and not _has_retryable_ai_failure(existing):
                    result = existing.to_dict()
                    result["already_existed"] = True
                    return result
                existing.transcript_raw = transcript
                note = note_service.update_note_ai(db, existing, ai_result)
                video_source_ledger_service.upsert_item(
                    db,
                    user_id=user_id,
                    item=item,
                    note_id=note.id,
                )
                plan_id = _persist_generated_plan(
                    db,
                    note,
                    ai_result,
                    user_id,
                )
                result = note.to_dict()
                result["plan_id"] = plan_id
                result["already_existed"] = False
                return result
            return _persist_generated_note(
                db,
                item=item,
                transcript=transcript,
                ai_result=ai_result,
                user_id=user_id,
            )


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, video_extractor.CloudAsrError):
        return exc.public_message[:360]
    if isinstance(exc, KeyError) and "videoInfoRes" in str(exc):
        return "抖音公开页面没有返回播放信息，请在桌面端重新同步后再提取文案"
    message = str(exc).strip()
    if not message:
        message = type(exc).__name__
    return message[:360]


def _job_counts(job: dict[str, Any]) -> dict[str, int]:
    states = [item["state"] for item in job["items"].values()]
    return {
        "total": len(states),
        "success": sum(state == "done" for state in states),
        "failed": sum(state == "error" for state in states),
        "active": sum(state in {"transcribing", "analyzing"} for state in states),
        "queued": sum(state == "queued" for state in states),
    }


def _snapshot(job: dict[str, Any]) -> dict[str, Any]:
    counts = _job_counts(job)
    return {
        "job_id": job["job_id"],
        "operation": job["operation"],
        "status": job["status"],
        "created_at": job["created_at"],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
        "concurrency": dict(job["concurrency"]),
        **counts,
        "items": [
            {
                "aweme_id": aweme_id,
                "state": item["state"],
                "error": item["error"],
                "note_id": item["note_id"],
                "transcript_chars": item["transcript_chars"],
                "card_type": item["card_type"],
                "ai_initialized": item["ai_initialized"],
                "already_existed": item["already_existed"],
                "updated_at": item["updated_at"],
            }
            for aweme_id, item in job["items"].items()
        ],
        "database_stores_media": False,
    }


def _update_item(job_id: str, aweme_id: str, **updates: Any) -> None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
        item = job["items"].get(aweme_id)
        if item is None:
            return
        item.update(updates)
        item["updated_at"] = _iso_now()


def _finish_job_if_ready(job_id: str) -> None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
        counts = _job_counts(job)
        if counts["active"] or counts["queued"]:
            return
        if counts["failed"] == 0:
            job["status"] = "success"
        elif counts["success"] == 0:
            job["status"] = "failed"
        else:
            job["status"] = "partial"
        job["finished_at"] = _iso_now()


def _run_job_item(
    job_id: str,
    user_id: str,
    aweme_id: str,
    operation: LibraryExtractionOperation,
    asr_gate: threading.Semaphore,
    llm_gate: threading.Semaphore,
    item: dict[str, Any] | None = None,
    ephemeral_media_url: str = "",
) -> None:
    def progress(state: str) -> None:
        _update_item(job_id, aweme_id, state=state, error="")

    try:
        result = extract_library_item(
            user_id=user_id,
            aweme_id=aweme_id,
            asr_gate=asr_gate,
            llm_gate=llm_gate,
            progress=progress,
            operation=operation,
            item=item,
            ephemeral_media_url=ephemeral_media_url,
        )
        _update_item(
            job_id,
            aweme_id,
            state="done",
            error="",
            note_id=result.get("id"),
            transcript_chars=int(result.get("transcript_chars") or 0),
            card_type=result.get("card_type"),
            ai_initialized=bool(result.get("ai_initialized")),
            already_existed=bool(result.get("already_existed")),
        )
    except Exception as exc:
        logger.warning(
            "Douyin extraction failed job=%s item=%s error_type=%s error=%s",
            job_id,
            aweme_id,
            type(exc).__name__,
            _safe_error(exc),
        )
        _update_item(
            job_id,
            aweme_id,
            state="error",
            error=_safe_error(exc),
        )
    finally:
        _finish_job_if_ready(job_id)


def _prune_jobs() -> None:
    cutoff = _utcnow() - timedelta(hours=6)
    with _JOBS_LOCK:
        expired = []
        for job_id, job in _JOBS.items():
            if job["status"] == "running":
                continue
            try:
                finished = datetime.fromisoformat(job["finished_at"])
            except (TypeError, ValueError):
                continue
            if finished < cutoff:
                expired.append(job_id)
        for job_id in expired:
            _JOBS.pop(job_id, None)


def create_batch_job(
    *,
    user_id: str,
    aweme_ids: list[str],
    operation: LibraryExtractionOperation = "full",
    asr_concurrency: int,
    llm_concurrency: int,
    ephemeral_media_sources: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Submit every accepted item immediately and return a user-scoped job."""
    clean_ids = list(dict.fromkeys(
        str(aweme_id or "").strip()
        for aweme_id in aweme_ids
        if str(aweme_id or "").strip()
    ))
    if operation not in {"transcript", "ai", "full"}:
        raise ValueError("不支持的资料库处理类型")
    max_items = (
        _MAX_BATCH_ITEMS
        if operation == "transcript"
        else _MAX_AI_BATCH_ITEMS
    )
    if not 1 <= len(clean_ids) <= max_items:
        raise ValueError(f"本次{operation}任务请选择 1–{max_items} 条视频")
    clean_id_set = set(clean_ids)
    media_sources: dict[str, str] = {}
    for aweme_id, media_url in (ephemeral_media_sources or {}).items():
        clean_aweme_id = str(aweme_id or "").strip()
        if clean_aweme_id not in clean_id_set or not str(media_url or "").strip():
            continue
        trusted_media_url = optional_ephemeral_media_url(media_url)
        if trusted_media_url:
            media_sources[clean_aweme_id] = trusted_media_url
    safe_asr = max(
        1,
        min(
            int(asr_concurrency),
            settings_service.MAX_EXTRACTION_ASR_CONCURRENCY,
        ),
    )
    safe_llm = max(
        1,
        min(
            int(llm_concurrency),
            settings_service.MAX_EXTRACTION_LLM_CONCURRENCY,
        ),
    )
    now = _iso_now()
    job_id = f"extract-{uuid.uuid4().hex[:20]}"
    job = {
        "job_id": job_id,
        "user_id": user_id,
        "operation": operation,
        "status": "running",
        "created_at": now,
        "started_at": now,
        "finished_at": None,
        "concurrency": {"asr": safe_asr, "llm": safe_llm},
        "items": {
            aweme_id: {
                "state": "queued",
                "error": "",
                "note_id": None,
                "transcript_chars": 0,
                "card_type": None,
                "ai_initialized": False,
                "already_existed": False,
                "updated_at": now,
            }
            for aweme_id in clean_ids
        },
    }
    _prune_jobs()
    with _JOBS_LOCK:
        _JOBS[job_id] = job

    # 一次性预取全量条目，避免每条任务各自重新拉取完整 manifest；
    # 同一用户同批任务共享同一份快照，落库前仍会在锁内复核。
    item_by_id: dict[str, dict[str, Any]] = {}
    try:
        with SessionLocal() as db:
            binding = douyin_binding_service.get_or_create(db, user_id)
            try:
                sidecar_items = douyin_library.list_items(
                    binding.session_scope,
                    binding.id,
                    limit=0,
                )
            except douyin_library.DouyinLibraryError:
                sidecar_items = []
            local_items = local_douyin_library_service.list_items(
                db,
                user_id=user_id,
            )
            item_by_id = {
                str(item.get("aweme_id") or "").strip(): item
                for item in sidecar_items
                if str(item.get("aweme_id") or "").strip()
            }
            for local_item in local_items:
                aweme_id = str(local_item.get("aweme_id") or "").strip()
                if aweme_id and aweme_id not in item_by_id:
                    item_by_id[aweme_id] = local_item
    except Exception:
        # 预取失败不阻塞任务：任务内会退回逐条 get_item。
        item_by_id = {}

    asr_gate = threading.Semaphore(safe_asr)
    llm_gate = threading.Semaphore(safe_llm)
    for aweme_id in clean_ids:
        _EXECUTOR.submit(
            _run_job_item,
            job_id,
            user_id,
            aweme_id,
            operation,
            asr_gate,
            llm_gate,
            item_by_id.get(aweme_id),
            media_sources.get(aweme_id, ""),
        )
    with _JOBS_LOCK:
        return _snapshot(job)


def get_batch_job(job_id: str, user_id: str) -> dict[str, Any] | None:
    """Return progress only when the job belongs to the current user."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None or job["user_id"] != user_id:
            return None
        return _snapshot(job)
