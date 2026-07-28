"""
API route definitions for VideoCapsule.
"""

from __future__ import annotations

import json
import time
import traceback
from typing import Any, Literal
from urllib.parse import unquote

import requests as http_requests
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.auth import get_current_user, get_current_user_optional, get_current_admin
from app.models.note import Note
from app.models.user import User as UserModel, list_users, count_users
from app.services import (
    ai_juicer,
    activity_service,
    app_release_service,
    audit_service,
    douyin_binding_service,
    douyin_library,
    error_log_service,
    feedback_service,
    library_hidden_service,
    llm_usage_service,
    note_service,
    plan_service,
    settings_service,
    video_extractor,
)
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


class NoteChatHistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=1000)


class NoteAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=600)
    history: list[NoteChatHistoryItem] = Field(default_factory=list, max_length=6)


class LibraryCollectRequest(BaseModel):
    count: int = Field(
        default=50,
        ge=1,
        le=100,
        description="本次同步最近 1–100 条，最多 100 条",
    )
    mode: Literal["like", "post", "collect"] = "like"


class LibraryLoginRequest(BaseModel):
    browser: Literal["chromium", "firefox", "webkit"] = "chromium"


class LibraryHandoffCompleteRequest(BaseModel):
    token: str = Field(..., min_length=32, max_length=4096)
    cookies: dict[str, str]

    @field_validator("cookies")
    @classmethod
    def validate_cookies(cls, value: dict[str, str]) -> dict[str, str]:
        if not 1 <= len(value) <= 100:
            raise ValueError("登录 Cookie 数量无效")
        normalized: dict[str, str] = {}
        for raw_name, raw_value in value.items():
            name = str(raw_name or "").strip()
            cookie_value = str(raw_value or "")
            if not name or len(name) > 128 or len(cookie_value) > 8192:
                raise ValueError("登录 Cookie 格式无效")
            normalized[name] = cookie_value
        return normalized


class LibraryExtractRequest(BaseModel):
    aweme_id: str = Field(..., min_length=1, max_length=128)


class LibraryRemoveRequest(BaseModel):
    aweme_ids: list[str] = Field(..., min_length=1, max_length=50)

    @field_validator("aweme_ids")
    @classmethod
    def validate_aweme_ids(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_id in value:
            aweme_id = str(raw_id or "").strip()
            if not 1 <= len(aweme_id) <= 128:
                raise ValueError("视频标识长度无效")
            if any(
                not (
                    character.isascii()
                    and (character.isalnum() or character in {"_", "-"})
                )
                for character in aweme_id
            ):
                raise ValueError("视频标识格式无效")
            if aweme_id not in seen:
                seen.add(aweme_id)
                normalized.append(aweme_id)
        if not normalized:
            raise ValueError("至少选择一条视频")
        return normalized


class LibraryAskRequest(BaseModel):
    note_ids: list[str] = Field(..., min_length=1, max_length=50)
    question: str = Field(..., min_length=1, max_length=600)
    history: list[NoteChatHistoryItem] = Field(default_factory=list, max_length=6)
    research_mode: Literal["fast", "deep"] = "fast"
    output_style: Literal[
        "answer", "summary", "comparison", "action_plan", "custom"
    ] = "answer"
    custom_instruction: str = Field(default="", max_length=600)


class PlanAgentRequest(BaseModel):
    instruction: str = Field(..., min_length=2, max_length=1000)


class ClientErrorRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    stack: str = Field(default="", max_length=16000)
    path: str = Field(default="", max_length=512)
    error_type: str = Field(default="ClientError", max_length=128)
    environment: Literal["web", "capacitor"] = "web"
    component: str = Field(default="", max_length=128)
    digest: str = Field(default="", max_length=128)


class FeedbackCreateRequest(BaseModel):
    category: Literal["bug", "suggestion", "content", "account", "other"]
    subject: str = Field(..., min_length=2, max_length=160)
    content: str = Field(..., min_length=5, max_length=2000)
    page_path: str = Field(default="", max_length=512)
    platform: Literal["web", "android", "capacitor"] = "web"
    user_agent: str = Field(default="", max_length=512)
    viewport: str = Field(default="", max_length=64)
    app_version: str = Field(default="", max_length=64)


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    password: str = Field(..., min_length=6, max_length=128)
    username: str = Field(..., min_length=2, max_length=128)


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


def _save_generated_note(
    db: Session,
    video_info: dict[str, Any],
    transcript: str,
    ai_result: dict[str, Any],
    user_id: str,
) -> tuple[dict[str, Any], bool]:
    """Persist one generated note and its optional plan in a single code path."""
    note = note_service.create_note(
        db,
        video_info,
        transcript,
        ai_result,
        user_id,
    )

    plan_id: str | None = None
    plan = ai_result.get("plan")
    if isinstance(plan, dict) and plan.get("tasks"):
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan)
        plan_obj = plan_service.create_plan(
            db=db,
            note_id=note.id,
            title=plan.get("goal") or note.video_title,
            user_id=user_id,
            fields=fields,
            tasks=tasks,
            total_days=total_days,
            days=plan.get("days") or [],
        )
        plan_id = plan_obj.id

    result = note.to_dict()
    result["plan_id"] = plan_id
    return result, plan_id is not None


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

_PLATFORM_LABELS: dict[str, str] = {
    "douyin": "抖音",
    "bilibili": "B站",
    "wechat": "微信公众号",
    "xiaohongshu": "小红书",
    "unknown": "未知平台",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/health")
def health_check() -> dict:
    """Simple liveness probe."""
    return _ok({"status": "ok", "service": "zhicui-knowbrew"})


@router.get("/api/app/releases/latest")
def latest_android_release(response: Response) -> dict:
    """Return public, cache-resistant Android release metadata."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    try:
        return _ok(app_release_service.get_latest_android_release())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Auth endpoints — email + password + JWT
# ---------------------------------------------------------------------------

@router.post("/api/auth/register")
def auth_register(
    body: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    user, error = auth_service.register(db, body.email, body.password, body.username)
    if error:
        return _err(error)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_register",
        method="POST",
        path="/api/auth/register",
        status_code=200,
        ip=request.client.host if request.client else None,
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/login")
def auth_login(
    body: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    token, user, error = auth_service.login(db, body.email, body.password)
    if error:
        return _err(error)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_login",
        method="POST",
        path="/api/auth/login",
        status_code=200,
        ip=request.client.host if request.client else None,
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.post("/api/auth/dev-session", include_in_schema=False)
def auth_dev_session(request: Request, db: Session = Depends(get_db)) -> dict:
    """Issue a normal JWT only for explicitly enabled loopback development."""
    if not settings.DEV_AUTH_BYPASS:
        raise HTTPException(status_code=404, detail="Not Found")

    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="开发会话仅允许本机访问")

    user = auth_service.get_or_create_dev_user(db)
    token = auth_service.create_access_token(user.id, user.email)
    activity_service.log_activity_safely(
        user_id=user.id,
        action="account_dev_session",
        method="POST",
        path="/api/auth/dev-session",
        status_code=200,
        ip=request.client.host if request.client else None,
    )
    return _ok({"token": token, "user": user.to_dict()})


@router.get("/api/auth/me")
def auth_me(
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(current_user.to_dict())


@router.post("/api/client-errors")
def report_client_error(
    body: ClientErrorRequest,
    request: Request,
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Accept bounded runtime diagnostics from authenticated app clients."""
    error_log_service.record_error_safely(
        source="frontend",
        severity="error",
        error_type=body.error_type,
        message=body.message,
        traceback=body.stack or None,
        method="CLIENT",
        path=body.path,
        user_id=current_user.id,
        ip=request.client.host if request.client else None,
        metadata={
            "environment": body.environment,
            "component": body.component,
            "digest": body.digest,
        },
    )
    return _ok({"accepted": True})


@router.post("/api/feedback")
def submit_feedback(
    body: FeedbackCreateRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """提交有边界的文字反馈，不接收文件、页面正文或认证信息。"""
    if len(body.subject.strip()) < 2:
        raise HTTPException(status_code=400, detail="反馈主题至少 2 个字符")
    if len(body.content.strip()) < 5:
        raise HTTPException(status_code=400, detail="请再具体描述一下问题或建议")
    if feedback_service.recent_submission_count(db, user_id=current_user.id) >= 5:
        raise HTTPException(status_code=429, detail="提交得有点频繁，请 10 分钟后再试")

    feedback = feedback_service.create_feedback(
        db,
        user_id=current_user.id,
        category=body.category,
        subject=body.subject,
        content=body.content,
        page_path=body.page_path,
        client_context={
            "platform": body.platform,
            "user_agent": body.user_agent,
            "viewport": body.viewport,
            "app_version": body.app_version,
        },
    )
    return _ok(feedback_service.to_dict(feedback))


@router.get("/api/feedback")
def list_my_feedback(
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    items, total = feedback_service.list_user_feedback(
        db,
        user_id=current_user.id,
        page=page,
        per_page=per_page,
    )
    return _ok({
        "items": [feedback_service.to_dict(item) for item in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


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

            result, _ = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
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

            result, _ = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
            return _ok(result)

        # ── Video path (Douyin / Bilibili) ──────────────────────────────
        # 1. Parse video metadata
        video_info = video_extractor.parse_video_info(body.url)

        # 2. Extract transcript (with fallback)
        transcript = None

        # Try primary ASR (SiliconFlow/DashScope) — config from DB (admin-tunable)
        asr_cfg = settings_service.get_asr_config(db)
        if asr_cfg["api_key"]:
            try:
                transcript = video_extractor.extract_transcript(
                    body.url,
                    asr_cfg["api_key"],
                    asr_cfg["api_base_url"],
                    asr_cfg["model"],
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

        result, _ = _save_generated_note(
            db, video_info, transcript, ai_result, current_user.id,
        )
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
        started_at = time.monotonic()

        def _progress(
            step: str,
            message: str,
            status: str = "active",
            data: dict[str, Any] | None = None,
        ) -> str:
            event_data: dict[str, Any] = {**(data or {})}
            event_data.setdefault("elapsed_ms", int((time.monotonic() - started_at) * 1000))
            return _event(step, message, status, event_data)

        try:
            platform = _detect_platform(url)
            yield _progress(
                "parse",
                f"已识别平台：{_PLATFORM_LABELS.get(platform, platform)}",
                "active",
                {"phase": "platform_detected", "platform": platform},
            )

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
                result, plan_created = _save_generated_note(
                    db, video_info, transcript, ai_result, current_user.id,
                )
                yield _event("save", "保存成功", "done")

                if plan_created:
                    yield _event("plan", "已为文章中的计划自动建立任务清单", "done")

                yield _event("done", "提取完成", "done", result)
                return

            # ═══ Video path (Douyin / Bilibili) ════════════════════════════
            # Step 1: Parse video metadata
            yield _progress(
                "parse",
                "正在解析视频链接...",
                "active",
                {"phase": "parse_start", "platform": platform},
            )
            try:
                video_info = video_extractor.parse_video_info(url)
                yield _progress(
                    "parse",
                    f"解析完成：{video_info.get('title', '未知标题')}",
                    "done",
                    {"phase": "parse_done", "platform": platform},
                )
            except NotImplementedError as exc:
                yield _progress("parse", f"解析失败: {exc}", "error", {"phase": "parse_error", "platform": platform})
                yield _progress("error", str(exc), "error", {"phase": "fatal_error", "platform": platform})
                return
            except Exception as exc:
                traceback.print_exc()
                yield _progress("parse", f"解析失败: {exc}", "error", {"phase": "parse_error", "platform": platform})
                yield _progress("error", str(exc), "error", {"phase": "fatal_error", "platform": platform})
                return

            # Step 2: Extract transcript
            yield _progress(
                "transcribe",
                "正在准备语音识别配置...",
                "active",
                {"phase": "asr_prepare", "platform": platform},
            )
            transcript: str | None = None

            asr_cfg = settings_service.get_asr_config(db)
            remote_asr_started = time.monotonic()
            if asr_cfg["api_key"]:
                try:
                    yield _progress(
                        "transcribe",
                        f"正在使用云端 ASR（{asr_cfg['model']}）识别音频，长视频可能需要数分钟...",
                        "active",
                        {
                            "phase": "remote_asr_start",
                            "platform": platform,
                            "provider": "siliconflow",
                            "model": asr_cfg["model"],
                        },
                    )
                    transcript = video_extractor.extract_transcript(
                        url,
                        asr_cfg["api_key"],
                        asr_cfg["api_base_url"],
                        asr_cfg["model"],
                    )
                    if transcript and transcript.strip():
                        yield _progress(
                            "transcribe",
                            f"云端 ASR 完成，共 {len(transcript)} 字",
                            "active",
                            {
                                "phase": "remote_asr_done",
                                "platform": platform,
                                "provider": "siliconflow",
                                "model": asr_cfg["model"],
                                "duration_ms": int((time.monotonic() - remote_asr_started) * 1000),
                                "transcript_chars": len(transcript),
                            },
                        )
                    else:
                        yield _progress(
                            "transcribe",
                            "云端 ASR 未返回有效文本，正在切换本地识别...",
                            "active",
                            {
                                "phase": "remote_asr_empty",
                                "platform": platform,
                                "provider": "siliconflow",
                                "fallback": True,
                                "level": "warning",
                            },
                        )
                except Exception:
                    traceback.print_exc()
                    yield _progress(
                        "transcribe",
                        "云端 ASR 暂未成功，正在切换本地识别...",
                        "active",
                        {
                            "phase": "remote_asr_error",
                            "platform": platform,
                            "provider": "siliconflow",
                            "fallback": True,
                            "level": "warning",
                            "duration_ms": int((time.monotonic() - remote_asr_started) * 1000),
                        },
                    )
            else:
                yield _progress(
                    "transcribe",
                    "未配置云端 ASR，将直接使用本地识别...",
                    "active",
                    {
                        "phase": "remote_asr_skipped",
                        "platform": platform,
                        "fallback": True,
                        "level": "warning",
                    },
                )

            if not transcript or not transcript.strip():
                try:
                    local_asr_started = time.monotonic()
                    yield _progress(
                        "transcribe",
                        "本地语音识别启动：正在下载视频并提取音频，长视频请耐心等待...",
                        "active",
                        {
                            "phase": "local_asr_start",
                            "platform": platform,
                            "provider": "local",
                            "fallback": True,
                        },
                    )
                    transcript = video_extractor.fallback_local_asr(url)
                    if transcript and transcript.strip():
                        yield _progress(
                            "transcribe",
                            f"本地 ASR 完成，共 {len(transcript)} 字",
                            "active",
                            {
                                "phase": "local_asr_done",
                                "platform": platform,
                                "provider": "local",
                                "fallback": True,
                                "duration_ms": int((time.monotonic() - local_asr_started) * 1000),
                                "transcript_chars": len(transcript),
                            },
                        )
                except Exception:
                    traceback.print_exc()
                    yield _progress(
                        "transcribe",
                        "文案提取失败，请稍后重试或检查视频链接。",
                        "error",
                        {"phase": "local_asr_error", "platform": platform, "provider": "local"},
                    )
                    yield _progress(
                        "error",
                        "语音识别失败，请稍后重试或检查视频链接。",
                        "error",
                        {"phase": "fatal_error", "platform": platform},
                    )
                    return

            use_images = False
            if not transcript or not transcript.strip():
                # Try image-based extraction
                video_url = video_info.get("download_url") or video_info.get("url", "")
                yield _progress(
                    "ai",
                    "未识别到音频文本，正在尝试截图分析...",
                    "active",
                    {"phase": "image_fallback_start", "platform": platform, "fallback": True},
                )
                frames = ai_juicer.extract_video_frames(video_url)
                if frames:
                    yield _progress(
                        "ai",
                        f"已抽取 {len(frames)} 张关键帧，正在进行视觉分析...",
                        "active",
                        {"phase": "image_frames_done", "platform": platform, "fallback": True},
                    )
                    ai_result = ai_juicer.generate_card_from_images(frames, video_info["title"])
                    if ai_result:
                        use_images = True
                        transcript = "[no audio — analysed from video frames]"
                        yield _progress(
                            "transcribe",
                            f"截图分析完成，共 {len(frames)} 张",
                            "done",
                            {"phase": "image_fallback_done", "platform": platform, "fallback": True},
                        )
                    else:
                        yield _progress("transcribe", "未能从视频中提取到文本内容", "error", {"phase": "image_fallback_error", "platform": platform})
                        yield _progress("error", "未能从视频中提取到文本内容，截图分析也失败。", "error", {"phase": "fatal_error", "platform": platform})
                        return
                else:
                    yield _progress("transcribe", "未能从视频中提取到文本内容", "error", {"phase": "no_transcript", "platform": platform})
                    yield _progress("error", "未能从视频中提取到文本内容。", "error", {"phase": "fatal_error", "platform": platform})
                    return

            if not use_images:
                char_count = len(transcript)
                yield _progress(
                    "transcribe",
                    f"文案提取完成，共 {char_count} 字",
                    "done",
                    {"phase": "transcribe_done", "platform": platform, "transcript_chars": char_count},
                )

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
            result, plan_created = _save_generated_note(
                db, video_info, transcript, ai_result, current_user.id,
            )
            yield _event("save", "保存成功", "done")

            if plan_created:
                yield _event("plan", "已为视频中的计划自动建立任务清单", "done")

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


# ---------------------------------------------------------------------------
# Douyin batch library endpoints
# ---------------------------------------------------------------------------

@router.get("/api/library/douyin/status")
def get_douyin_library_status(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Report whether the optional local downloader is ready."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    status = douyin_library.connection_status(binding.session_scope)
    if status["connected"]:
        douyin_binding_service.update_connection(
            db,
            binding,
            connected=bool(status["cookie_valid"]),
            cookie_count=int(status["cookie_count"]),
        )
    status["binding"] = binding.safe_dict()
    return _ok(status)


@router.post("/api/library/douyin/login")
def start_douyin_library_login(
    body: LibraryLoginRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Open Chrome only when the connector is visible on this desktop."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        connection = douyin_library.connection_status(binding.session_scope)
        if connection.get("login_browser_mode") != "visible_chrome":
            raise HTTPException(
                status_code=409,
                detail=(
                    "异地服务器二维码已停用。请在这台电脑启动本地连接器，"
                    "再使用本机 Chrome 完成抖音绑定。"
                ),
            )
        current = douyin_library.login_status(binding.session_scope)
        if current["running"]:
            return _ok({**current, "started": False})
        result = douyin_library.start_login(binding.session_scope, body.browser)
        douyin_binding_service.mark_login_pending(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/logout")
def logout_douyin_library(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Clear the companion login session without deleting library data."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.clear_session(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/rebind")
def rebind_douyin_library(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Clear the current session before the client starts a new QR login."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.clear_session(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/local-handoff")
def create_douyin_local_handoff(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Issue a short-lived handoff for a connector on the user's computer."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    token = douyin_library.create_local_handoff_token(
        binding.id,
        current_user.id,
        binding.session_scope,
    )
    douyin_binding_service.mark_login_pending(db, binding)
    return _ok(
        {
            "token": token,
            "connector_url": "http://127.0.0.1:9000/api/v1/local-handoff",
            "expires_in": 600,
        }
    )


@router.post("/api/library/douyin/local-handoff/complete")
def complete_douyin_local_handoff(
    body: LibraryHandoffCompleteRequest,
    db: Session = Depends(get_db),
) -> dict:
    """Accept a local Chrome result and forward it to the scoped sidecar."""
    payload = douyin_library.verify_local_handoff_token(body.token)
    if payload is None:
        raise HTTPException(status_code=401, detail="本机登录交接已失效，请重新发起")
    binding = douyin_binding_service.get_by_id(db, str(payload["binding_id"]))
    if (
        binding is None
        or binding.user_id != str(payload["user_id"])
        or binding.session_scope != str(payload["session_scope"])
    ):
        raise HTTPException(status_code=403, detail="本机登录交接与当前账号不匹配")
    try:
        result = douyin_library.import_session_cookies(
            binding.session_scope,
            body.cookies,
        )
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not result.get("valid"):
        douyin_binding_service.mark_disconnected(db, binding)
        raise HTTPException(status_code=400, detail="抖音未返回真实登录会话，请重新扫码")
    douyin_binding_service.update_connection(
        db,
        binding,
        connected=True,
        cookie_count=int(result.get("count") or 0),
    )
    return _ok(
        {
            "connected": True,
            "cookie_count": int(result.get("count") or 0),
        }
    )


@router.get("/api/library/douyin/login")
def get_douyin_library_login(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return QR-login progress without exposing cookie values."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        state = douyin_library.login_status(binding.session_scope)
        state["cookie_valid"] = False
        state["cookie_count"] = 0
        if state["authenticated"] or not state["running"]:
            connection = douyin_library.connection_status(binding.session_scope)
            if connection["connected"]:
                douyin_binding_service.update_connection(
                    db,
                    binding,
                    connected=bool(connection["cookie_valid"]),
                    cookie_count=int(connection["cookie_count"]),
                )
            state["cookie_valid"] = bool(connection["cookie_valid"])
            state["cookie_count"] = int(connection["cookie_count"])
        return _ok(state)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/api/library/douyin/login")
def cancel_douyin_library_login(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Cancel only this user's transient browser login task."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        result = douyin_library.cancel_login(binding.session_scope)
        douyin_binding_service.mark_disconnected(db, binding)
        return _ok(result)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/api/library/douyin/login/qr")
def get_douyin_library_login_qr(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Proxy the QR image without exposing the companion to the public."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        return _ok(douyin_library.login_qr(binding.session_scope))
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/library/douyin/collect")
def collect_douyin_library(
    body: LibraryCollectRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Ask the companion to refresh the user's Douyin collection."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        job = douyin_library.trigger_collect(
            binding.session_scope,
            body.count,
            body.mode,
        )
        douyin_binding_service.mark_sync_started(db, binding)
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _ok(job)


@router.get("/api/library/douyin/jobs/{job_id}")
def get_douyin_library_job(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return one downloader collection job."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        return _ok(douyin_library.get_job(binding.session_scope, job_id))
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/api/library/douyin/media/{aweme_id}")
def stream_douyin_library_media(
    request: Request,
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    expires: int = Query(..., ge=1),
    signature: str = Query(..., min_length=64, max_length=64),
    binding: str = Query(
        ...,
        min_length=24,
        max_length=24,
        pattern=r"^dyb-[0-9a-f]{20}$",
    ),
    db: Session = Depends(get_db),
):
    """Proxy a short-lived Douyin stream without persisting it on the server."""
    if not douyin_library.verify_media_signature(
        aweme_id,
        binding,
        expires,
        signature,
    ):
        raise HTTPException(status_code=403, detail="视频播放地址已失效，请刷新页面")
    account_binding = douyin_binding_service.get_by_id(db, binding)
    if account_binding is None:
        raise HTTPException(status_code=404, detail="抖音账号绑定不存在")
    target_url = douyin_library.companion_media_url(aweme_id)
    request_headers = {
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        **douyin_library.companion_headers(account_binding.session_scope),
    }
    range_header = request.headers.get("range")
    if range_header:
        request_headers["Range"] = range_header
    try:
        response = http_requests.get(
            target_url,
            headers=request_headers,
            stream=True,
            timeout=(10, 600),
        )
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"视频临时流读取失败：{exc}") from exc

    response_headers = {
        "Cache-Control": "private, no-store",
        "Accept-Ranges": response.headers.get("Accept-Ranges", "bytes"),
    }
    for source, target in (
        ("Content-Length", "Content-Length"),
        ("Content-Range", "Content-Range"),
    ):
        value = response.headers.get(source)
        if value:
            response_headers[target] = value

    def body():
        try:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk:
                    yield chunk
        finally:
            response.close()

    return StreamingResponse(
        body(),
        status_code=response.status_code,
        media_type=response.headers.get("Content-Type", "video/mp4"),
        headers=response_headers,
    )


@router.get("/api/library/douyin/items")
def list_douyin_library_items(
    limit: int = Query(
        default=0,
        ge=0,
        le=10000,
        description="返回数量；0 表示返回下载器 manifest 中的全部条目",
    ),
    mode: Literal["like", "collect", "post"] | None = Query(default=None),
    sort: Literal["collection", "published"] = Query(
        default="collection",
        description="收藏来源默认按最近收藏；也可切换为发布时间",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return downloader items enriched with this user's extraction state."""
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        items = douyin_library.list_items(
            binding.session_scope,
            binding.id,
            0,
            mode=mode,
            sort_by=sort,
        )
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    hidden_ids = library_hidden_service.list_hidden_aweme_ids(
        db,
        current_user.id,
        [item["aweme_id"] for item in items],
    )
    items = [
        item for item in items
        if item["aweme_id"] not in hidden_ids
    ]
    if limit > 0:
        items = items[:limit]

    note_map = note_service.get_notes_by_video_ids(
        db,
        [item["aweme_id"] for item in items],
        user_id=current_user.id,
    )
    for item in items:
        note = note_map.get(item["aweme_id"])
        item["extracted"] = note is not None
        item["extracted_note_id"] = note.id if note else None
        item["transcript_chars"] = len(note.transcript_raw or "") if note else 0
        item["card_type"] = note.card_type if note else None
    return _ok({"items": items, "total": len(items)})


@router.post("/api/library/douyin/items/remove")
def remove_douyin_library_items(
    body: LibraryRemoveRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Hide selected items for this user without deleting source or knowledge."""
    try:
        result = library_hidden_service.hide_aweme_ids(
            db,
            current_user.id,
            body.aweme_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _ok(result)


@router.get("/api/library/douyin/items/{aweme_id}")
def get_douyin_library_item(
    aweme_id: str = Path(
        ...,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Compose live downloader media with this user's durable knowledge."""
    if library_hidden_service.is_hidden(db, current_user.id, aweme_id):
        raise HTTPException(status_code=404, detail="视频已从当前资料库移除")
    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        item = douyin_library.get_item(
            binding.session_scope,
            binding.id,
            aweme_id,
        )
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="视频不存在或尚未同步")

    note = note_service.get_note_by_video_id(
        db,
        aweme_id,
        user_id=current_user.id,
    )
    plan = (
        plan_service.get_plan_by_note(db, note.id, user_id=current_user.id)
        if note is not None
        else None
    )
    item["extracted"] = note is not None
    item["extracted_note_id"] = note.id if note else None
    item["transcript_chars"] = len(note.transcript_raw or "") if note else 0
    item["card_type"] = note.card_type if note else None
    return _ok({
        "item": item,
        "note": note.to_dict() if note else None,
        "plan": plan.to_dict() if plan else None,
        "media_storage": {
            "provider": "douyin-downloader",
            "mode": "external",
            "database_stores_media": False,
        },
    })


@router.post("/api/library/douyin/extract")
def extract_douyin_library_item(
    body: LibraryExtractRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Temporarily stream one video, transcribe it, then persist text only."""
    existing = note_service.get_note_by_video_id(
        db,
        body.aweme_id,
        user_id=current_user.id,
    )
    if existing is not None:
        result = existing.to_dict()
        result["already_existed"] = True
        return _ok(result)

    binding = douyin_binding_service.get_or_create(db, current_user.id)
    try:
        item = douyin_library.get_item(
            binding.session_scope,
            binding.id,
            body.aweme_id,
        )
    except douyin_library.DouyinLibraryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="收藏视频不存在或尚未同步")
    if not item["can_extract"]:
        raise HTTPException(status_code=422, detail="该作品没有可提取的视频文件")

    try:
        asr_config = settings_service.get_asr_config(db)
        transcript = video_extractor.extract_media_url_transcript(
            douyin_library.companion_media_url(item["aweme_id"]),
            asr_config["api_key"],
            asr_config["api_base_url"],
            asr_config["model"],
            request_headers=douyin_library.companion_headers(
                binding.session_scope,
            ),
        )
        if not transcript.strip():
            raise RuntimeError("语音识别没有返回文案")

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
        ai_result["source_meta"] = {
            "source_kind": "douyin-library",
            "platform": "douyin",
            "source_url": item["source_url"],
            "cover_url": item["cover_url"],
            "author_name": item["author_name"],
            "recorded_at": item["recorded_at"],
            "caption": item["caption"],
        }
        video_info = {
            "video_id": item["aweme_id"],
            "title": item["title"],
            "download_url": item["source_url"],
            "platform": "douyin",
        }
        result, _ = _save_generated_note(
            db,
            video_info,
            transcript,
            ai_result,
            current_user.id,
        )
        result["already_existed"] = False
        return _ok(result)
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail=f"视频文案提取失败：{exc}",
        ) from exc


@router.delete("/api/library/douyin/extractions/{note_id}")
def delete_douyin_library_extraction(
    note_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Delete one current-user library result, not the downloader media."""
    deleted, plans_deleted = note_service.delete_user_library_note(
        db,
        note_id,
        current_user.id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="视频知识结果不存在")
    return _ok({
        "deleted": True,
        "plans_deleted": plans_deleted,
        "media_preserved": True,
    })


@router.post("/api/library/ask")
def ask_video_library(
    body: LibraryAskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Answer using the requested, user-owned video Notes."""
    note_ids = list(dict.fromkeys(note_id.strip() for note_id in body.note_ids))
    notes = [
        note_service.get_note(db, note_id, user_id=current_user.id)
        for note_id in note_ids
    ]
    if any(note is None for note in notes):
        # Missing and cross-user IDs deliberately share one response.
        raise HTTPException(status_code=404, detail="所选视频不存在")

    try:
        result = ai_juicer.answer_library_question(
            sources=[
                {
                    "note_id": note.id,
                    "title": note.video_title,
                    "transcript": note.transcript_raw,
                    "ai_summary": note.ai_summary,
                }
                for note in notes
                if note is not None
            ],
            question=body.question,
            history=[item.model_dump() for item in body.history[-6:]],
            research_mode=body.research_mode,
            output_style=body.output_style,
            custom_instruction=body.custom_instruction,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=502, detail="集合问答暂时不可用，请稍后重试") from exc

    return _ok({
        "note_ids": note_ids,
        "answer": result["answer"],
        "grounded": result["grounded"],
        "evidence": result["evidence"],
        "follow_up_questions": result["follow_up_questions"],
        "source_context": result["source_context"],
    })


@router.get("/api/notes")
def list_notes(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    q: str | None = Query(None, min_length=1, max_length=80, description="Search note title or summary"),
    card_type: Literal["recipe", "insight", "history", "product", "plan", "general"] | None = Query(
        None,
        description="Filter by card type",
    ),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Return a paginated, user-scoped list of saved notes."""
    notes, total = note_service.list_notes(
        db,
        page=page,
        per_page=per_page,
        user_id=current_user.id,
        search=q,
        card_type=card_type,
    )
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
    plan = plan_service.get_plan_by_note(
        db,
        note_id,
        user_id=current_user.id,
    )
    result["plan_id"] = plan.id if plan else None
    return _ok(result)


@router.post("/api/notes/{note_id}/ask")
def ask_note(
    note_id: str,
    body: NoteAskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Answer a question using one user-owned note as the source."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        # Keep the same response for missing notes and notes owned by another
        # user so this endpoint does not reveal cross-user resource existence.
        raise HTTPException(status_code=404, detail="Note not found")

    try:
        result = ai_juicer.answer_note_question(
            title=note.video_title,
            transcript=note.transcript_raw,
            ai_summary=note.ai_summary,
            question=body.question,
            history=[item.model_dump() for item in body.history[-6:]],
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=502, detail="内容问答暂时不可用，请稍后重试") from exc

    return _ok({
        "note_id": note.id,
        "answer": result["answer"],
        "answer_mode": result["answer_mode"],
        "grounded": result["grounded"],
        "evidence": result["evidence"],
        "follow_up_questions": result["follow_up_questions"],
        "source_context": result.get("source_context"),
    })


@router.post("/api/notes/{note_id}/plan-agent")
def run_note_plan_agent(
    note_id: str,
    body: PlanAgentRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    """Create or revise one note-linked plan through a validated Agent target."""
    note = note_service.get_note(db, note_id, user_id=current_user.id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    existing = plan_service.get_plan_by_note(
        db,
        note_id,
        user_id=current_user.id,
    )
    try:
        agent_result = ai_juicer.generate_or_revise_plan(
            title=note.video_title,
            transcript=note.transcript_raw,
            ai_summary=note.ai_summary,
            instruction=body.instruction,
            existing_plan=existing.to_dict() if existing else None,
        )
        plan_data = agent_result["plan"]
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan_data)
        plan, created = plan_service.upsert_agent_plan(
            db,
            note_id=note.id,
            title=plan_data.get("goal") or note.video_title,
            fields=fields,
            tasks=tasks,
            days=plan_data.get("days") or [],
            total_days=total_days,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail="计划 Agent 暂时不可用，请稍后重试",
        ) from exc

    return _ok({
        "plan": plan.to_dict(),
        "created": created,
        "change_summary": agent_result["change_summary"],
        "source_context": agent_result["source_context"],
    })


# ---------------------------------------------------------------------------
# Plan endpoints
# ---------------------------------------------------------------------------

class AddTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    day: int | None = Field(default=None, ge=1, le=3650)
    scheduled_at: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$",
    )
    reminder_at: str | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=10080)
    frequency: str | None = Field(default=None, max_length=120)
    priority: Literal["low", "medium", "high"] = "medium"


class UpdatePlanRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    status: Literal["active", "done"] | None = None


class UpdateTaskRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    day: int | None = Field(default=None, ge=1, le=3650)
    scheduled_at: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$",
    )
    reminder_at: str | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=10080)
    frequency: str | None = Field(default=None, max_length=120)
    priority: Literal["low", "medium", "high"] | None = None


@router.get("/api/plans")
def list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    plans, total = plan_service.list_plans(
        db,
        page=page,
        per_page=per_page,
        user_id=current_user.id,
    )
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
    stats = plan_service.get_plan_stats(db, user_id=current_user.id)
    return _ok(stats)


@router.get("/api/plans/overview")
def get_plan_overview(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    return _ok(plan_service.get_plan_overview(db, user_id=current_user.id))


@router.get("/api/plans/{plan_id}")
def get_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.get_plan(db, plan_id, user_id=current_user.id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}")
def update_plan(
    plan_id: str,
    body: UpdatePlanRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="至少提供一个计划更新字段")
    try:
        plan = plan_service.update_plan(
            db,
            plan_id,
            updates=updates,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.patch("/api/plans/{plan_id}/tasks/{task_id}")
def toggle_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.toggle_task(
        db,
        plan_id,
        task_id,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.put("/api/plans/{plan_id}/tasks/{task_id}")
def update_plan_task(
    plan_id: str,
    task_id: str,
    body: UpdateTaskRequest,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="至少提供一个任务更新字段")
    try:
        plan = plan_service.update_task(
            db,
            plan_id,
            task_id,
            updates=updates,
            user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
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
        duration_minutes=body.duration_minutes,
        frequency=body.frequency,
        priority=body.priority,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}/tasks/{task_id}")
def delete_plan_task(plan_id: str, task_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    plan = plan_service.delete_task(
        db,
        plan_id,
        task_id,
        user_id=current_user.id,
    )
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan or task not found")
    return _ok(plan.to_dict())


@router.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: str, db: Session = Depends(get_db),
        current_user: UserModel = Depends(get_current_user)) -> dict:
    deleted = plan_service.delete_plan(db, plan_id, user_id=current_user.id)
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


# ---------------------------------------------------------------------------
# Admin endpoints — manage users (admin only)
# ---------------------------------------------------------------------------
def _validate_http_url(value: str, field: str) -> None:
    """Validate http(s) URL or empty. Raises HTTPException(400) on invalid."""
    if not value:
        return
    from urllib.parse import urlparse
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{field} 必须是合法的 http/https URL")


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP (X-Forwarded-For or client host)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


class AdminUserPatch(BaseModel):
    is_active: bool | None = None
    is_admin: bool | None = None
    username: str | None = None
    email: str | None = None


class AdminFeedbackUpdateRequest(BaseModel):
    status: Literal["pending", "processing", "resolved", "closed"] | None = None
    admin_reply: str | None = Field(default=None, max_length=2000)


@router.get("/api/admin/stats")
def admin_stats(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan
    from sqlalchemy import func as _func

    recent_users_rows = (
        db.query(UserModel).order_by(UserModel.created_at.desc()).limit(5).all()
    )
    recent_users = [
        {
            "username": u.username or u.email,
            "email": u.email,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in recent_users_rows
    ]

    type_rows = (
        db.query(Note.card_type, _func.count(Note.id)).group_by(Note.card_type).all()
    )
    type_dist = {ct or "general": cnt for ct, cnt in type_rows}

    return _ok({
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
        "recent_users": recent_users,
        "type_dist": type_dist,
    })


@router.get("/api/admin/users")
def admin_list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按邮箱或用户名模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    query = db.query(UserModel)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (UserModel.email.ilike(like)) | (UserModel.username.ilike(like))
        )
    total = query.count()
    users = (
        query.order_by(UserModel.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return _ok({
        "items": [u.to_dict() for u in users],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.patch("/api/admin/users/{user_id}")
def admin_patch_user(
    user_id: str,
    body: AdminUserPatch,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")

    # Guard: cannot disable or demote yourself (would lock you out).
    if user_id == current_user.id:
        if body.is_active is False:
            return _err("不能禁用自己")
        if body.is_admin is False:
            return _err("不能取消自己的管理员权限")

    # Guard: must keep at least one enabled admin.
    demoting_admin = user.is_admin and (body.is_admin is False or body.is_active is False)
    if demoting_admin:
        active_admins = (
            db.query(UserModel)
            .filter(UserModel.is_admin.is_(True), UserModel.is_active.is_(True))
            .count()
        )
        if active_admins <= 1:
            return _err("至少保留一个启用的管理员")

    if body.is_active is not None:
        user.is_active = body.is_active
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.username is not None:
        new_username = body.username.strip()
        if len(new_username) < 2:
            return _err("用户名至少 2 个字符")
        dup = (
            db.query(UserModel)
            .filter(UserModel.username == new_username, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该用户名已被使用")
        user.username = new_username
    if body.email is not None:
        new_email = body.email.strip().lower()
        if "@" not in new_email:
            return _err("邮箱格式无效")
        dup = (
            db.query(UserModel)
            .filter(UserModel.email == new_email, UserModel.id != user_id)
            .first()
        )
        if dup:
            return _err("该邮箱已被使用")
        user.email = new_email
    db.commit()
    db.refresh(user)
    # Audit: record the specific action taken.
    if body.is_admin is not None:
        action = "user_promote" if body.is_admin else "user_demote"
    elif body.is_active is not None:
        action = "user_enable" if body.is_active else "user_disable"
    elif body.username is not None or body.email is not None:
        action = "user_edit"
    else:
        action = None
    if action:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action=action,
            target_type="user",
            target_id=user_id,
            detail={"username": user.username or user.email},
            ip=_client_ip(request),
        )
    return _ok(user.to_dict())


@router.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if user_id == current_user.id:
        return _err("不能删除自己")
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    username = user.username or user.email
    db.delete(user)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_delete",
        target_type="user",
        target_id=user_id,
        detail={"username": username},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


class AdminResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=128)


@router.get("/api/admin/users/{user_id}")
def admin_get_user_detail(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """用户详情聚合：基本信息 + 笔记/计划计数 + 最近 5 条笔记 + 最近 3 条计划。"""
    from app.models.plan import Plan

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    notes_count = db.query(Note).filter(Note.user_id == user_id).count()
    plans_count = db.query(Plan).filter(Plan.user_id == user_id).count()
    recent_notes = (
        db.query(Note)
        .filter(Note.user_id == user_id)
        .order_by(Note.created_at.desc())
        .limit(5)
        .all()
    )
    recent_plans = (
        db.query(Plan)
        .filter(Plan.user_id == user_id)
        .order_by(Plan.created_at.desc())
        .limit(3)
        .all()
    )
    return _ok({
        **user.to_dict(),
        "notes_count": notes_count,
        "plans_count": plans_count,
        "recent_notes": [
            {
                "id": n.id,
                "video_title": n.video_title,
                "card_type": n.card_type,
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in recent_notes
        ],
        "recent_plans": [
            {
                "id": p.id,
                "title": p.title,
                "status": p.status,
                "total_days": p.total_days,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in recent_plans
        ],
    })


@router.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_user_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """管理员重置任意用户密码。新密码经 werkzeug 哈希后存储。"""
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        return _err("用户不存在")
    user.hashed_password = auth_service.hash_password(body.new_password)
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="user_reset_password",
        target_type="user",
        target_id=user_id,
        detail={"username": user.username or user.email},
        ip=_client_ip(request),
    )
    return _ok({"reset": True})


# ---------------------------------------------------------------------------
# Admin endpoints — runtime LLM/ASR configuration (no restart needed)
# ---------------------------------------------------------------------------
class LlmConfigRequest(BaseModel):
    provider: Literal["deepseek", "custom"] | None = None
    model: str | None = None
    api_base: str | None = None
    api_key: str | None = None  # None/empty = leave unchanged


class AsrConfigRequest(BaseModel):
    api_key: str | None = None
    api_base_url: str | None = None
    model: str | None = None


@router.get("/api/admin/llm-config")
def admin_get_llm_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_llm_config_masked(db))


@router.put("/api/admin/llm-config")
def admin_put_llm_config(
    body: LlmConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    current = settings_service.get_llm_config(db)
    provider = body.provider or current["provider"]
    model = body.model if body.model is not None else current["model"]
    api_base = body.api_base if body.api_base is not None else current["api_base"]
    try:
        normalized = settings_service.validate_llm_preset(
            provider,
            model,
            api_base,
        )
    except ValueError as exc:
        return _err(str(exc))
    if normalized["api_base"]:
        _validate_http_url(normalized["api_base"], "API Base")

    changed: dict = {}
    if normalized["provider"] != current["provider"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_PROVIDER_KEY,
            normalized["provider"],
        )
        changed["provider"] = normalized["provider"]
    if normalized["model"] != current["model"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_MODEL_KEY,
            normalized["model"],
        )
        changed["model"] = normalized["model"]
    if normalized["api_base"] != current["api_base"]:
        settings_service.set_setting(
            db,
            settings_service.LLM_API_BASE_KEY,
            normalized["api_base"],
        )
        changed["api_base"] = normalized["api_base"]
    if body.api_key:  # empty string = leave unchanged
        settings_service.set_secret(db, settings_service.LLM_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="llm_config_update",
            target_type="config",
            target_id="llm",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_llm_config_masked(db))


@router.get("/api/admin/asr-config")
def admin_get_asr_config(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(settings_service.get_asr_config_masked(db))


@router.put("/api/admin/asr-config")
def admin_put_asr_config(
    body: AsrConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if body.api_base_url:
        _validate_http_url(body.api_base_url, "API Base URL")
    changed: dict = {}
    if body.api_key:  # empty = leave unchanged
        settings_service.set_secret(db, settings_service.ASR_API_KEY_KEY, body.api_key)
        changed["api_key"] = "***updated***"
    if body.api_base_url is not None:
        settings_service.set_setting(db, settings_service.ASR_API_BASE_URL_KEY, body.api_base_url)
        changed["api_base_url"] = body.api_base_url
    if body.model is not None:
        settings_service.set_setting(db, settings_service.ASR_MODEL_KEY, body.model)
        changed["model"] = body.model
    if changed:
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="asr_config_update",
            target_type="config",
            target_id="asr",
            detail=changed,
            ip=_client_ip(request),
        )
    return _ok(settings_service.get_asr_config_masked(db))


# ---------------------------------------------------------------------------
# Admin endpoints — note management
# ---------------------------------------------------------------------------
@router.get("/api/admin/notes")
def admin_list_notes(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    card_type: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = note_service.list_notes_admin(
        db, page=page, per_page=per_page, search=search, card_type=card_type
    )
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/notes/{note_id}")
def admin_delete_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    title = note.video_title if note else None
    if not note_service.delete_note(db, note_id):
        return _err("笔记不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_delete",
        target_type="note",
        target_id=note_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


@router.post("/api/admin/notes/{note_id}/re-extract")
def admin_re_extract_note(
    note_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return _err("笔记不存在")
    transcript = note.transcript_raw or ""
    if not transcript.strip():
        return _err("该笔记没有转录文本，无法重新抽取")
    # Re-run AI on the existing transcript with current LLM config.
    content_type = ai_juicer.detect_content_type(transcript)
    ai_result = ai_juicer.generate_card(transcript, content_type, note.video_title)
    note = note_service.update_note_ai(db, note, ai_result)
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_reextract",
        target_type="note",
        target_id=note_id,
        detail={"title": note.video_title, "content_type": content_type},
        ip=_client_ip(request),
    )
    return _ok(note.to_dict())


class AdminBatchDeleteNotesRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=200)


@router.post("/api/admin/notes/batch-delete")
def admin_batch_delete_notes(
    body: AdminBatchDeleteNotesRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    deleted = 0
    titles: list[str] = []
    for nid in body.ids:
        note = db.query(Note).filter(Note.id == nid).first()
        if note:
            titles.append(note.video_title)
            db.delete(note)
            deleted += 1
    db.commit()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="note_batch_delete",
        target_type="note",
        target_id=",".join(body.ids[:8]),
        detail={"count": deleted, "titles": titles[:5]},
        ip=_client_ip(request),
    )
    return _ok({"deleted": deleted})


# ---------------------------------------------------------------------------
# Admin endpoints — user feedback
# ---------------------------------------------------------------------------
@router.get("/api/admin/feedback")
def admin_list_feedback(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status: Literal["pending", "processing", "resolved", "closed"] | None = Query(None),
    category: Literal["bug", "suggestion", "content", "account", "other"] | None = Query(None),
    q: str | None = Query(None, max_length=160),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total, counts = feedback_service.list_admin_feedback(
        db,
        page=page,
        per_page=per_page,
        status=status,
        category=category,
        q=q,
    )
    return _ok({
        "items": [
            feedback_service.to_dict(
                feedback,
                user=user,
                include_client_context=True,
            )
            for feedback, user in items
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
        "counts": counts,
    })


@router.patch("/api/admin/feedback/{feedback_id}")
def admin_update_feedback(
    feedback_id: str,
    body: AdminFeedbackUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    if not body.model_fields_set:
        raise HTTPException(status_code=400, detail="请至少更新处理状态或回复内容")
    feedback = feedback_service.get_feedback(db, feedback_id)
    if not feedback:
        raise HTTPException(status_code=404, detail="反馈不存在")

    updated = feedback_service.update_feedback(
        db,
        feedback,
        status=body.status,
        admin_reply=body.admin_reply if "admin_reply" in body.model_fields_set else None,
        handled_by=current_user.id,
    )
    owner = db.query(UserModel).filter(UserModel.id == updated.user_id).first()
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="feedback_update",
        target_type="feedback",
        target_id=feedback_id,
        detail={
            "status": updated.status,
            "has_reply": bool(updated.admin_reply),
            "subject": updated.subject[:80],
        },
        ip=_client_ip(request),
    )
    return _ok(
        feedback_service.to_dict(
            updated,
            user=owner,
            include_client_context=True,
        )
    )


# ---------------------------------------------------------------------------
# Admin endpoints — audit log viewer
# ---------------------------------------------------------------------------
@router.get("/api/admin/audit-logs")
def admin_list_audit_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    items, total = audit_service.list_audit_logs(
        db, page=page, per_page=per_page, action=action
    )
    # Join admin username for display.
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    return _ok({
        "items": [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items],
        "total": total,
        "page": page,
        "per_page": per_page,
    })


@router.get("/api/admin/llm-usage")
def admin_get_llm_usage(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    model: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(llm_usage_service.get_usage_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        model=model,
    ))


@router.get("/api/admin/user-activity")
def admin_get_user_activity(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    user_id: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(activity_service.get_activity_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        action=action,
        user_id=user_id,
    ))


@router.get("/api/admin/error-logs")
def admin_get_error_logs(
    days: int = Query(30, ge=1, le=365),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    source: str | None = Query(None),
    severity: str | None = Query(None),
    status_code: int | None = Query(None, ge=400, le=599),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    return _ok(error_log_service.get_error_report(
        db,
        days=days,
        page=page,
        per_page=per_page,
        source=source,
        severity=severity,
        status_code=status_code,
    ))


# ---------------------------------------------------------------------------
# Admin endpoints — plan management
# ---------------------------------------------------------------------------
@router.get("/api/admin/plans")
def admin_list_plans(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="按标题模糊搜索"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    from app.models.plan import Plan

    query = db.query(Plan)
    if q:
        query = query.filter(Plan.title.ilike(f"%{q.strip()}%"))
    total = query.count()
    plans = (
        query.order_by(Plan.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    user_ids = {p.user_id for p in plans if p.user_id}
    user_map: dict[str, str] = {}
    if user_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
        user_map = {r.id: (r.username or r.email) for r in rows}
    items = [{
        "id": p.id,
        "title": p.title,
        "user_id": p.user_id,
        "author": user_map.get(p.user_id, ""),
        "status": p.status,
        "total_days": p.total_days,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    } for p in plans]
    return _ok({"items": items, "total": total, "page": page, "per_page": per_page})


@router.delete("/api/admin/plans/{plan_id}")
def admin_delete_plan(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    plan = plan_service.get_plan(db, plan_id)
    title = plan.title if plan else None
    if not plan_service.delete_plan(db, plan_id):
        return _err("计划不存在")
    audit_service.log_action(
        db,
        admin_user_id=current_user.id,
        action="plan_delete",
        target_type="plan",
        target_id=plan_id,
        detail={"title": title},
        ip=_client_ip(request),
    )
    return _ok({"deleted": True})


# ---------------------------------------------------------------------------
# Admin endpoints — config connection test
# ---------------------------------------------------------------------------
@router.post("/api/admin/llm-config/test")
def admin_test_llm_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current LLM config with a minimal completion request."""
    cfg = settings_service.get_llm_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    try:
        from litellm import completion
        kwargs: dict = {
            "model": cfg["runtime_model"],
            "messages": [{"role": "user", "content": "请只回复两个字：成功"}],
            "max_tokens": 16,
            "timeout": 20,
        }
        if cfg["api_base"]:
            kwargs["api_base"] = cfg["api_base"]
        kwargs["api_key"] = cfg["api_key"]
        resp = completion(**kwargs)
        llm_usage_service.record_response_usage(
            resp,
            provider=cfg["provider"],
            model=cfg["model"],
            operation="admin_llm_test",
        )
        reply = (resp.choices[0].message.content or "").strip()
        audit_service.log_action(
            db, admin_user_id=current_user.id, action="llm_config_test",
            target_type="config", target_id="llm", ip=_client_ip(request),
        )
        return _ok({"ok": True, "reply": reply[:80], "model": cfg["model"]})
    except Exception as e:
        error_log_service.record_exception_safely(
            e,
            source="llm",
            status_code=502,
            method="POST",
            path="/api/admin/llm-config/test",
            user_id=current_user.id,
            ip=_client_ip(request),
            metadata={
                "provider": cfg["provider"],
                "model": cfg["model"],
                "operation": "admin_llm_test",
            },
        )
        return _ok({"ok": False, "error": str(e)[:200]})


@router.post("/api/admin/asr-config/test")
def admin_test_asr_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Test current ASR config by probing the endpoint with the configured key.

    A 400/422 on an empty audio payload means the key was accepted (auth ok)
    and only the payload was rejected — that counts as a pass. 401/403 means
    the key is invalid.
    """
    cfg = settings_service.get_asr_config(db)
    if not cfg["api_key"]:
        return _ok({"ok": False, "error": "未配置 API Key"})
    if not cfg["api_base_url"]:
        return _ok({"ok": False, "error": "未配置 API Base URL"})
    try:
        headers = {"Authorization": f"Bearer {cfg['api_key']}"}
        files = {"file": ("test.wav", b"", "audio/wav"), "model": (None, cfg["model"])}
        r = http_requests.post(cfg["api_base_url"], headers=headers, files=files, timeout=20)
        if r.status_code in (401, 403):
            return _ok({"ok": False, "error": f"API Key 无效 (HTTP {r.status_code})", "status": r.status_code})
        if r.status_code in (400, 422):
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "Key 有效（空音频被拒绝属正常）", "status": r.status_code})
        if r.status_code == 200:
            audit_service.log_action(
                db, admin_user_id=current_user.id, action="asr_config_test",
                target_type="config", target_id="asr", ip=_client_ip(request),
            )
            return _ok({"ok": True, "note": "连接成功", "status": 200})
        return _ok({"ok": False, "error": f"HTTP {r.status_code}: {r.text[:120]}", "status": r.status_code})
    except Exception as e:
        error_log_service.record_exception_safely(
            e,
            source="asr",
            status_code=502,
            method="POST",
            path="/api/admin/asr-config/test",
            user_id=current_user.id,
            ip=_client_ip(request),
            metadata={
                "model": cfg["model"],
                "operation": "admin_asr_test",
            },
        )
        return _ok({"ok": False, "error": str(e)[:200]})


# ---------------------------------------------------------------------------
# Admin endpoints — system info (read-only, no secrets exposed)
# ---------------------------------------------------------------------------
@router.get("/api/admin/system-info")
def admin_system_info(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """Read-only system info for the settings page. Secret keys are reported
    only as booleans (set / not set), never plaintext."""
    from app.models.plan import Plan

    db_type = "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite"
    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    return _ok({
        "db_type": db_type,
        "llm_model": llm_cfg["model"],
        "llm_api_base": llm_cfg["api_base"] or "(官方默认)",
        "llm_key_set": bool(llm_cfg["api_key_masked"]),
        "asr_model": asr_cfg["model"],
        "asr_api_base_url": asr_cfg["api_base_url"],
        "asr_key_set": bool(asr_cfg["api_key_masked"]),
        "encryption_key_set": bool(settings.ENCRYPTION_KEY),
        "jwt_secret_set": bool(settings.JWT_SECRET),
        "users": count_users(db),
        "notes": db.query(Note).count(),
        "plans": db.query(Plan).count(),
    })


# ---------------------------------------------------------------------------
# Admin endpoints — operations dashboard (health + table counts + recent audit)
# ---------------------------------------------------------------------------
@router.get("/api/admin/ops")
def admin_ops(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_admin),
) -> dict:
    """运维概览：各表行数、最近 5 条审计、密钥配置状态。只读，不暴露明文。"""
    from app.models.plan import Plan
    from app.models.admin_audit_log import AdminAuditLog
    from app.models.llm_usage_log import LlmUsageLog
    from app.models.user_activity_log import UserActivityLog
    from app.models.application_error_log import ApplicationErrorLog

    llm_cfg = settings_service.get_llm_config_masked(db)
    asr_cfg = settings_service.get_asr_config_masked(db)
    items, _ = audit_service.list_audit_logs(db, page=1, per_page=5)
    admin_ids = {it.admin_user_id for it in items}
    admin_map: dict[str, str] = {}
    if admin_ids:
        rows = db.query(UserModel).filter(UserModel.id.in_(admin_ids)).all()
        admin_map = {r.id: (r.username or r.email) for r in rows}
    recent = [audit_service.to_dict(it, admin_map.get(it.admin_user_id)) for it in items]

    return _ok({
        "table_counts": {
            "users": count_users(db),
            "notes": db.query(Note).count(),
            "plans": db.query(Plan).count(),
            "audit_logs": db.query(AdminAuditLog).count(),
            "llm_usage_logs": db.query(LlmUsageLog).count(),
            "user_activity_logs": db.query(UserActivityLog).count(),
            "application_error_logs": db.query(ApplicationErrorLog).count(),
        },
        "recent_audit": recent,
        "keys": {
            "llm_key_set": bool(llm_cfg["api_key_masked"]),
            "asr_key_set": bool(asr_cfg["api_key_masked"]),
            "encryption_key_set": bool(settings.ENCRYPTION_KEY),
            "jwt_secret_set": bool(settings.JWT_SECRET),
        },
        "db_type": "PostgreSQL" if settings.DATABASE_URL.startswith("postgresql") else "SQLite",
    })
