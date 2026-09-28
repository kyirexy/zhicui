"""Agent 手动同步后的元数据登记；不触发媒体下载、ASR 或模型请求。"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select

from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_hidden_item import LibraryHiddenItem
from app.services import (
    agent_video_link_service, daily_recap_service, library_sync_service,
    note_service, video_source_ledger_service,
)


def _active(ctx):
    from app.core.config import settings
    from app.services.agent_credential_service import require_active_credential
    from app.services.agent_rollout_service import action_is_enabled
    from app.services.product_action_run_service import ProductActionError
    ctx.db.expire_all()
    ctx.db.refresh(ctx.run)
    if ctx.run.cancellation_requested:
        raise ProductActionError("RUN_CANCELED", "运行已取消")
    if not settings.AGENT_INTERFACE_ENABLED or not action_is_enabled(ctx.run.action_id):
        raise ProductActionError("ACTION_UNAVAILABLE", "该能力已暂停")
    if not ctx.user.is_active:
        raise ProductActionError("INVALID_CREDENTIAL", "账号已停用")
    if ctx.credential is not None:
        require_active_credential(ctx.db, credential_id=ctx.credential.id, user_id=ctx.user.id)
    ctx.db.commit()


def record_snapshot(ctx, payload):
    from app.services.product_action_run_service import append_event
    platform, mode = payload["platform"], payload["mode"]
    pattern = r"[0-9]{5,32}" if platform == "douyin" else r"BV[0-9A-Za-z]{3,30}"
    items = payload["items"]
    if platform not in {"douyin", "bilibili"} or mode not in {"like", "collect"}:
        raise ValueError("同步来源无效")
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("每次同步需要 1–100 条公开作品")
    if any(not re.fullmatch(pattern, str(item.get("video_id", ""))) for item in items):
        raise ValueError("作品标识与平台不符")
    if len({item["video_id"] for item in items}) != len(items):
        raise ValueError("同步清单包含重复作品")
    db, user_id = ctx.db, ctx.user.id
    # 日期由已鉴权的服务端 Run 确定，不接收可倒填的点赞或同步时间。
    stamp = ctx.run.created_at.replace(tzinfo=ctx.run.created_at.tzinfo or timezone.utc)
    sync = library_sync_service.start_run(
        db, user_id=user_id, platform=platform, source_mode=mode,
        source_synced_at=stamp, requested_count=len(items), coverage="partial", order_reliable=False,
        request_fingerprint=hashlib.sha256(json.dumps(items, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
    )
    if getattr(sync, "_sync_duplicate_running", False):
        raise ValueError("这批同步仍在处理中，请继续查询原运行")
    hidden = set(db.scalars(select(LibraryHiddenItem.aweme_id).where(LibraryHiddenItem.user_id == user_id)))
    result = {"accepted": 0, "created": 0, "reused": 0, "ready": 0, "skipped": 0, "failed": 0, "items": [], "video_ids": []}
    try:
        for index, raw in enumerate(items):
            _active(ctx)
            video_id = raw["video_id"]
            if video_id in hidden:
                result["skipped"] += 1
                continue
            note = note_service.get_note_by_video_id(db, video_id, user_id)
            created = note is None
            try:
                if note is None:
                    snapshot = db.scalar(select(DouyinLocalLibraryItem).where(
                        DouyinLocalLibraryItem.user_id == user_id, DouyinLocalLibraryItem.video_id == video_id,
                    )) if platform == "douyin" else None
                    title = str(raw.get("title") or (snapshot.title if snapshot else "")).strip()
                    info = {}
                    source_url = f"https://www.{'douyin.com' if platform == 'douyin' else 'bilibili.com'}/video/{video_id}"
                    if not title:
                        # 旧 B站桥只返回 BV 号；仅补元数据，已有资料完全复用。
                        info = agent_video_link_service._public_info(source_url, platform)
                        title = str(info.get("title") or "").strip()
                    if not title:
                        raise ValueError("作品缺少标题")
                    meta = {
                        "source_kind": "agent-link-import", "platform": platform,
                        "source_url": source_url, "source_mode": mode,
                        "source_synced_at": stamp.isoformat(), "media_type": "video",
                        "transcript_source": "pending", "speech_ready": False,
                        "author_name": str(raw.get("author_name") or (snapshot.author_name if snapshot else "") or info.get("author_name") or ""),
                        "caption": str(raw.get("caption") or ""),
                        "cover_url": (snapshot.cover_url if snapshot else "") or info.get("cover_url") or "",
                    }
                    with library_sync_service.import_lease(db, user_id=user_id, platform=platform, video_id=video_id):
                        note = note_service.get_note_by_video_id(db, video_id, user_id)
                        created = note is None
                        if note is None:
                            note = note_service.create_transcript_note(
                                db, video_info={"video_id": video_id, "title": title, "source_url": source_url, "platform": platform},
                                transcript="", source_meta=meta, user_id=user_id,
                            )
                ledger = video_source_ledger_service.upsert_source(
                    db, user_id=user_id, video_id=video_id, note_id=note.id, source_mode=mode,
                    observed_at=stamp, source_synced_at=stamp,
                )
                ready = bool((note.transcript_raw or "").strip())
                result["accepted"] += 1
                result["created" if created else "reused"] += 1
                result["ready"] += int(ready)
                result["video_ids"].append(video_id)
                result["items"].append({"video_id": video_id, "note_id": note.id, "title": note.video_title,
                                        "transcript_ready": ready, "first_seen_at": ledger.first_seen_at.replace(tzinfo=ledger.first_seen_at.tzinfo or timezone.utc).isoformat()})
            except agent_video_link_service.VideoLinkError as exc:
                db.rollback()
                result["failed"] += 1
                result["items"].append({"video_id": video_id, "error_code": exc.code})
                if exc.code == "PLATFORM_AUTH_REQUIRED":
                    result["failed"] += len(items) - index - 1
                    break
            append_event(db, run=ctx.run, event_type="activity.recording", status="running",
                         data={"processed": index + 1, "total": len(items), "accepted": result["accepted"]})
        library_sync_service.finish_run(db, sync, result)
    except BaseException:
        db.rollback()
        library_sync_service.finish_run(db, sync, result, status="failed", error_code="import_failed")
        raise
    return {**result, "sync_run_id": sync.id, "platform": platform, "mode": mode,
            "coverage": "partial", "time_basis": "first_discovered", "media_downloaded": False,
            "transcribed": False, "message": "只更新本次采集范围内的清单；平台未提供真实点赞日期，已有文稿直接复用。"}


def get_recap(db, *, user_id, payload):
    day = payload.get("day", "yesterday")
    zone = payload.get("timezone", "Asia/Shanghai")
    if day not in {"today", "yesterday"}:
        raise ValueError("日期只支持 today 或 yesterday")
    try:
        anchor = datetime.now(timezone.utc).astimezone(ZoneInfo(zone))
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("请选择有效时区") from exc
    target = anchor.date() - timedelta(days=day == "yesterday")
    data = daily_recap_service.get_daily_recap(
        db, user_id=user_id, target_date=target, timezone_name=zone,
        limit=payload.get("limit", 100), include_import_meta=False,
        source_mode=None if payload.get("mode", "all") == "all" else payload["mode"],
        platform_filter=None if payload.get("platform", "all") == "all" else payload["platform"],
    )
    for item in data["items"]:
        item.pop("cover_url", None)
    data["preview"] = data["items"][:3]
    data["day"] = day
    data["message"] = "按知萃首次同步日期统计，包含待提取文稿；平台未提供真实点赞、收藏时间。"
    return data
