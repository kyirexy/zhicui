"""
API route definitions for VideoCapsule.
"""

from __future__ import annotations

import json
import traceback
from typing import Any
from urllib.parse import unquote

import requests as http_requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.auth import get_current_user, get_current_user_optional
from app.models.note import Note
from app.models.user import User as UserModel
from app.services import ai_juicer, note_service, plan_service, video_extractor
from app.services import auth_service
from app.services.video_extractor import _detect_platform
from app.services.wechat_extractor import extract_wechat_article

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class Envelope(BaseModel):
    """Standard response envelope."""
    success: bool
    data: Any = None
    error: str | None = None


class VideoURLRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


class ExtractRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Douyin share link or text containing one")


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: Any) -> dict:
    return {"success": True, "data": data, "error": None}


def _err(msg: str) -> dict:
    return {"success": False, "data": None, "error": msg}


# ---------------------------------------------------------------------------
# Content type display labels (for progress messages)
# ---------------------------------------------------------------------------

_TYPE_LABELS: dict[str, str] = {
    "recipe": "食谱",
    "insight": "洞察",
    "history": "历史",
    "product": "产品",
    "plan": "计划",
    "general": "通用知识",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/health")
def health_check() -> dict:
    """Simple liveness probe."""
    return _ok({"status": "ok", "service": "zhicui-knowbrew"})


# ---------------------------------------------------------------------------
# Auth endpoints — email + password + JWT
# ---------------------------------------------------------------------------

@router.post("/api/auth/register")
def auth_register(body: RegisterRequest, db: Session = Depends(get_db)) -> dict:
    user, error = auth_service.register(db, body.email, body.password)
    if error:
        return _err(error)
    token = auth_service.create_access_token(user.id, user.email)
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/login")
def auth_login(body: LoginRequest, db: Session = Depends(get_db)) -> dict:
    token, user, error = auth_service.login(db, body.email, body.password)
    if error:
        return _err(error)
    return _ok({"token": token, "user": user.to_dict()})


@router.get("/api/auth/me")
def auth_me(
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(current_user.to_dict())


@router.post("/api/video/info")
def get_video_info(
    body: VideoURLRequest,
    current_user: UserModel = Depends(get_current_user_optional),
) -> dict:
    """Parse a video link and return metadata without downloading."""
    try:
        info = video_extractor.parse_video_info(body.url)
        return _ok(info)
    except Exception as exc:
        return _err(f"解析视频链接失败: {exc}")


@router.post("/api/extract")
def extract(
    body: ExtractRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Full pipeline: parse -> transcribe -> AI -> save -> return note."""
    try:
        platform = _detect_platform(body.url)

        # ── Xiaohongshu path: note content IS the transcript ──────────────
        if platform == "xiaohongshu":
            from app.services.xhs_extractor import parse_xhs_note, extract_xhs_content
            import os as _os
            cookie = _os.environ.get('XHS_COOKIE', '')
            note_data = parse_xhs_note(body.url, cookie=cookie)
            video_info = {
                "video_id": note_data.get("note_id", ""),
                "title": note_data.get("title", "小红书笔记"),
                "download_url": "",
                "platform": "xiaohongshu",
            }
            transcript = extract_xhs_content(body.url, cookie=cookie)

            if not transcript or not transcript.strip():
                return _err("未能从小红书笔记中提取到文本内容。")

            # AI processing -- mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            # Save to database
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

            # Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id

            result = note.to_dict()
            result["plan_id"] = plan_id
            return _ok(result)

        # ── WeChat path: article content IS the transcript ──────────────
        if platform == "wechat":
            article = extract_wechat_article(body.url)
            video_info = {
                "video_id": article["video_id"],
                "title": article["title"],
                "download_url": article["download_url"],
                "platform": "wechat",
            }
            transcript = article["content"]

            if not transcript or not transcript.strip():
                return _err("未能从微信公众号文章中提取到文本内容。")

            # AI processing — mini agent chain
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            if plan_data:
                ai_result["plan"] = plan_data

            # Save to database
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

            # Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id

            result = note.to_dict()
            result["plan_id"] = plan_id
            return _ok(result)

        # ── Video path (Douyin / Bilibili) ──────────────────────────────
        # 1. Parse video metadata
        video_info = video_extractor.parse_video_info(body.url)

        # 2. Extract transcript (with fallback)
        transcript = None

        # Try primary ASR (SiliconFlow/DashScope)
        if settings.API_KEY:
            try:
                transcript = video_extractor.extract_transcript(
                    body.url,
                    settings.API_KEY,
                    settings.ASR_API_BASE_URL,
                    settings.ASR_MODEL,
                )
            except Exception:
                traceback.print_exc()
                # Fall through to local ASR

        # Fallback: local yt-dlp + faster-whisper
        if not transcript or not transcript.strip():
            try:
                transcript = video_extractor.fallback_local_asr(body.url)
            except Exception:
                traceback.print_exc()
                return _err("语音识别失败，请稍后重试或检查视频链接。")

        # 3. AI processing — mini agent chain
        use_images = False
        if not transcript or not transcript.strip():
            # Try image-based extraction as fallback
            video_url = video_info.get("download_url") or video_info.get("url", "")
            frames = ai_juicer.extract_video_frames(video_url)
            if frames:
                ai_result = ai_juicer.generate_card_from_images(
                    frames, video_info["title"],
                )
                if ai_result:
                    use_images = True
                    transcript = "[no audio transcript — analysed from video frames]"
                else:
                    return _err("未能从视频中提取到文本内容，截图分析也失败了。")
            else:
                return _err("未能从视频中提取到文本内容。")

        if not use_images:
            # Mini Agent 1: classify intent
            intent = ai_juicer.classify_intent(transcript)
            card_type = intent["card_type"]
            is_plan = intent["is_plan"]

            # Mini Agent 2: generate plan (if applicable)
            plan_data = None
            if is_plan:
                plan_data = ai_juicer.generate_plan(transcript)

            # Mini Agent 3: generate card
            ai_result = ai_juicer.generate_card(
                transcript=transcript,
                content_type=card_type,
                video_title=video_info["title"],
            )
            # Attach plan data to ai_result for persistence
            if plan_data:
                ai_result["plan"] = plan_data

        # 4. Save to database
        note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)

        # 5. Auto-create plan
        plan_id: str | None = None
        plan = ai_result.get("plan")
        if isinstance(plan, dict) and plan.get("tasks"):
            fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
            days_data = plan.get("days") or []
            plan_obj = plan_service.create_plan(
                db=db,
                note_id=note.id,
                title=plan.get("goal") or note.video_title,
                user_id=current_user.id,
                fields=fields,
                tasks=tasks,
                total_days=total_days,
                days=days_data,
            )
            plan_id = plan_obj.id

        result = note.to_dict()
        result["plan_id"] = plan_id
        return _ok(result)

    except NotImplementedError as exc:
        return _err(str(exc))
    except Exception as exc:
        # Log the full traceback on the server for debugging.
        traceback.print_exc()
        return _err(f"处理失败: {exc}")


@router.get("/api/extract/stream")
def extract_stream(
    url: str = Query(..., min_length=1, description="Douyin share link"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
):
    """Full pipeline with SSE progress events.

    Returns ``text/event-stream`` with one event per pipeline step.
    Each event is a JSON line::

        data: {"step":"parse","message":"...","status":"active"}

    Final event has ``step: "done"`` with ``data`` containing the note.
    """
    def _event(step: str, message: str, status: str = "active", data: Any = None) -> str:
        payload: dict[str, Any] = {"step": step, "message": message, "status": status}
        if data is not None:
            payload["data"] = data
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def _generate():
        try:
            platform = _detect_platform(url)

            # ═══ WeChat path: article content IS the transcript ═══════════
            if platform == "wechat":
                yield _event("parse", "正在获取微信公众号文章...", "active")
                article = extract_wechat_article(url)
                video_info = {
                    "video_id": article["video_id"],
                    "title": article["title"],
                    "download_url": article["download_url"],
                    "platform": "wechat",
                }
                transcript = article["content"]
                yield _event("parse", f"文章获取完成：{video_info.get('title', '未知标题')}", "done")

                if not transcript or not transcript.strip():
                    yield _event("transcribe", "未能从微信公众号文章中提取到文本内容", "error")
                    yield _event("error", "未能从微信公众号文章中提取到文本内容。", "error")
                    return

                char_count = len(transcript)
                yield _event("transcribe", f"文章文本提取完成，共 {char_count} 字", "done")

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

                # Save to database
                yield _event("save", "正在保存笔记...", "active")
                note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)
                yield _event("save", "保存成功", "done")

                # Auto-create plan
                plan_id: str | None = None
                plan = ai_result.get("plan")
                if isinstance(plan, dict) and plan.get("tasks"):
                    fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                    days_data = plan.get("days") or []
                    plan_obj = plan_service.create_plan(
                        db=db,
                        note_id=note.id,
                        title=plan.get("goal") or note.video_title,
                        user_id=current_user.id,
                        fields=fields,
                        tasks=tasks,
                        total_days=total_days,
                        days=days_data,
                    )
                    plan_id = plan_obj.id
                    yield _event("plan", "已为文章中的计划自动建立任务清单", "done")

                result = note.to_dict()
                result["plan_id"] = plan_id
                yield _event("done", "提取完成", "done", result)
                return

            # ═══ Video path (Douyin / Bilibili) ════════════════════════════
            # Step 1: Parse video metadata
            yield _event("parse", "正在解析视频链接...", "active")
            try:
                video_info = video_extractor.parse_video_info(url)
                yield _event("parse", f"解析完成：{video_info.get('title', '未知标题')}", "done")
            except NotImplementedError as exc:
                yield _event("parse", f"解析失败: {exc}", "error")
                yield _event("error", str(exc), "error")
                return
            except Exception as exc:
                traceback.print_exc()
                yield _event("parse", f"解析失败: {exc}", "error")
                yield _event("error", str(exc), "error")
                return

            # Step 2: Extract transcript
            yield _event("transcribe", "正在提取视频文案...", "active")
            transcript: str | None = None

            if settings.API_KEY:
                try:
                    transcript = video_extractor.extract_transcript(
                        url,
                        settings.API_KEY,
                        settings.ASR_API_BASE_URL,
                        settings.ASR_MODEL,
                    )
                except Exception:
                    traceback.print_exc()

            if not transcript or not transcript.strip():
                try:
                    yield _event("transcribe", "本地语音识别启动,长视频需要1-3分钟,请耐心等待...", "active")
                    transcript = video_extractor.fallback_local_asr(url)
                except Exception:
                    traceback.print_exc()
                    yield _event("transcribe", "文案提取失败，请稍后重试或检查视频链接。", "error")
                    yield _event("error", "语音识别失败，请稍后重试或检查视频链接。", "error")
                    return

            use_images = False
            if not transcript or not transcript.strip():
                # Try image-based extraction
                video_url = video_info.get("download_url") or video_info.get("url", "")
                frames = ai_juicer.extract_video_frames(video_url)
                if frames:
                    yield _event("ai", f"未提取到音频文案，正在分析 {len(frames)} 张视频截图...", "active")
                    ai_result = ai_juicer.generate_card_from_images(frames, video_info["title"])
                    if ai_result:
                        use_images = True
                        transcript = "[no audio — analysed from video frames]"
                        yield _event("transcribe", f"截图分析完成，共 {len(frames)} 张", "done")
                    else:
                        yield _event("transcribe", "未能从视频中提取到文本内容", "error")
                        yield _event("error", "未能从视频中提取到文本内容，截图分析也失败。", "error")
                        return
                else:
                    yield _event("transcribe", "未能从视频中提取到文本内容", "error")
                    yield _event("error", "未能从视频中提取到文本内容。", "error")
                    return

            if not use_images:
                char_count = len(transcript)
                yield _event("transcribe", f"文案提取完成，共 {char_count} 字", "done")

                # Mini Agent 1: classify intent
                yield _event("ai", "AI 正在识别内容类型...", "active")
                intent = ai_juicer.classify_intent(transcript)
                card_type = intent["card_type"]
                is_plan = intent["is_plan"]
                type_label = _TYPE_LABELS.get(card_type, card_type)
                yield _event("ai", f"识别为「{type_label}」类型{'（含计划）' if is_plan else ''}，正在生成知识卡片...", "active")

                # Mini Agent 2: generate plan if applicable
                plan_data = None
                if is_plan:
                    plan_data = ai_juicer.generate_plan(transcript)
                    if plan_data and plan_data.get("tasks"):
                        yield _event("plan", f"已提取 {len(plan_data['tasks'])} 项计划任务", "active")

                # Mini Agent 3: generate card
                ai_result = ai_juicer.generate_card(
                    transcript=transcript, content_type=card_type,
                    video_title=video_info["title"],
                )
                if plan_data:
                    ai_result["plan"] = plan_data

                section_count = len(ai_result.get("sections", []))
                yield _event("ai", f"AI 卡片生成完成，共 {section_count} 个章节", "done")

            # Step 4: Save to database
            yield _event("save", "正在保存笔记...", "active")
            note = note_service.create_note(db, video_info, transcript, ai_result, current_user.id)
            yield _event("save", "保存成功", "done")

            # Step 5: Auto-create plan
            plan_id: str | None = None
            plan = ai_result.get("plan")
            if isinstance(plan, dict) and plan.get("tasks"):
                fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
                days_data = plan.get("days") or []
                plan_obj = plan_service.create_plan(
                    db=db,
                    note_id=note.id,
                    title=plan.get("goal") or note.video_title,
                    user_id=current_user.id,
                    fields=fields,
                    tasks=tasks,
                    total_days=total_days,
                    days=days_data,
                )
                plan_id = plan_obj.id
                yield _event("plan", "已为视频中的计划自动建立任务清单", "done")


            result = note.to_dict()
            result["plan_id"] = plan_id
            yield _event("done", "提取完成", "done", result)

        except Exception as exc:
            traceback.print_exc()
            yield _event("error", f"处理失败: {exc}", "error")

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/api/notes")
def list_notes(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return a paginated list of saved notes."""
    notes, total = note_service.list_notes(db, page=page, per_page=per_page, user_id=current_user.id)
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [n.to_dict() for n in notes],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/notes/{note_id}")
def get_note(note_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    """Fetch a single note by ID. Includes plan_id if a plan exists."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    result = note.to_dict()
    # Attach plan_id for plan-type notes so the frontend can show a CTA.
    if note.card_type == "plan":
        plan = plan_service.get_plan_by_note(db, note_id)
        result["plan_id"] = plan.id if plan else None
    else:
        result["plan_id"] = None
    return _ok(result)


# ---------------------------------------------------------------------------
# Plan endpoints
# ---------------------------------------------------------------------------

class AddTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    day: int | None = None
    scheduled_at: str | None = None
    reminder_at: str | None = None


@router.get("/api/plans")
def list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    plans, total = plan_service.list_plans(db, page=page, per_page=per_page)
    total_pages = max(1, (total + per_page - 1) // per_page)
    return _ok({
        "items": [p.to_dict() for p in plans],
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
    })


@router.get("/api/plans/stats")
def get_plan_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    stats = plan_service.get_plan_stats(db)
    return _ok(stats)


@router.get("/api/plans/{plan_id}")
def get_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.get_plan(db, plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}/tasks/{task_id}")
def toggle_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.toggle_task(db, plan_id, task_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.post("/api/plans/{plan_id}/tasks")
def add_plan_task(plan_id: str, body: AddTaskRequest, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.add_task(
        db, plan_id,
        title=body.title,
        day=body.day,
        scheduled_at=body.scheduled_at,
        reminder_at=body.reminder_at,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}/tasks/{task_id}")
def delete_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.delete_task(db, plan_id, task_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    deleted = plan_service.delete_plan(db, plan_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok({"deleted": True})


@router.get("/api/video/proxy")
def proxy_video(
    url: str = Query(..., min_length=1, description="Douyin video play URL"),
    note_id: str = Query("", description="Optional note ID to refresh expired URL"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
):
    """Proxy a video stream with Douyin-required headers.

    If ``note_id`` is provided and the stored video URL has expired, we re-parse
    the share link to get a fresh play URL (requires a source_url to be saved).

    Returns a ``video/mp4`` stream suitable for a ``<video>`` element.
    """
    target_url = unquote(url)

    # Try to refresh the URL if a note_id is given and the URL looks expired.
    if note_id:
        note = note_service.get_note(db, note_id, user_id=current_user.id)
        if note is not None:
            # Re-extract a fresh video URL from the source share link.
            try:
                fresh_info = video_extractor.parse_video_info(
                    f"https://www.douyin.com/video/{note.video_id}"
                )
                fresh_url = fresh_info.get("download_url") or fresh_info.get("url", "")
                if fresh_url:
                    target_url = fresh_url
            except Exception:
                pass  # use the original target_url

    VIDEO_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 "
            "Version/17.0 Mobile/15E148 Safari/604.1"
        ),
        "Referer": "https://www.douyin.com/",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
    }

    try:
        resp = http_requests.get(
            target_url,
            headers=VIDEO_HEADERS,
            stream=True,
            timeout=30,
            allow_redirects=True,
        )
        resp.raise_for_status()

        content_length = resp.headers.get("content-length", "")
        headers = {
            "Content-Type": "video/mp4",
            "Cache-Control": "public, max-age=86400",
        }
        if content_length:
            headers["Content-Length"] = content_length

        def _iter():
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        return StreamingResponse(
            _iter(),
            media_type="video/mp4",
            headers=headers,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"视频代理失败: {exc}")
