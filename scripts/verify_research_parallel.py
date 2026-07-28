"""Focused verification for web research and parallel library extraction.

This is intentionally a standalone smoke/contract check instead of a new test
framework. Run from the repository root with:

    python scripts/verify_research_parallel.py
"""
from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.models.note import Note  # noqa: E402
from app.services import (  # noqa: E402
    ai_juicer,
    library_extraction_service,
    settings_service,
    video_extractor,
    web_research,
)


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def verify_search_safety_and_provenance() -> None:
    blocked = (
        "file:///etc/passwd",
        "http://localhost:8000/api/admin",
        "http://127.0.0.1/",
        "http://10.0.0.8/",
        "http://169.254.169.254/latest/meta-data/",
        "http://user:pass@example.com/",
        "http://198.18.0.1/",
    )
    for url in blocked:
        _check(
            not web_research.is_public_http_url(url),
            f"不安全地址未被拦截：{url}",
        )

    class RateLimitedResponse:
        is_redirect = False
        is_permanent_redirect = False
        status_code = 429
        headers: dict[str, str] = {}
        url = "https://example.com/search"

        def raise_for_status(self) -> None:
            raise web_research.requests.HTTPError("rate limited")

        def close(self) -> None:
            return None

    with (
        patch.object(web_research, "is_public_http_url", return_value=True),
        patch.object(
            web_research.requests,
            "get",
            return_value=RateLimitedResponse(),
        ),
    ):
        try:
            web_research._bounded_public_get("https://example.com/search")
        except web_research.WebResearchError:
            pass
        else:
            raise AssertionError("搜索源 HTTP 限流没有被安全降级")

    searched_source = {
        "title": "ayghri/i-have-adhd",
        "url": "https://github.com/ayghri/i-have-adhd",
        "domain": "github.com",
        "snippet": "A concise AI skill repository.",
        "query": "ADHD skill GitHub 9000 stars",
        "verified": True,
    }
    model_payload = json.dumps(
        {
            "answer": "根据外部查证，候选项目是 ayghri/i-have-adhd。",
            "evidence": [],
            "web_source_ids": ["WEB-1", "WEB-99"],
            "follow_up_questions": ["要我继续核对项目 README 吗？"],
        },
        ensure_ascii=False,
    )
    plan = {
        "needs_web": True,
        "queries": ["ADHD skill GitHub 9000 stars"],
        "reason": "用户要求项目链接",
    }
    with (
        patch.object(ai_juicer, "_plan_web_research", return_value=plan),
        patch.object(
            web_research,
            "research_web",
            return_value={"queries": plan["queries"], "sources": [searched_source]},
        ) as research_mock,
        patch.object(web_research, "is_public_http_url", return_value=True),
        patch.object(ai_juicer, "_call_llm", return_value=model_payload),
    ):
        result = ai_juicer.answer_note_question(
            title="让 AI 少说废话的 ADHD skill",
            transcript="视频只提到 GitHub 九千多星，没有给出仓库地址。",
            ai_summary=None,
            question="给出这个项目的 GitHub 链接",
            research_scope="auto",
        )
    _check(research_mock.call_count == 1, "自动模式没有触发受控联网检索")
    _check(result["grounded"] is True, "已验证网页来源没有形成可追溯回答")
    _check(len(result["web_sources"]) == 1, "外部来源 ID 未按真实候选集校验")
    _check(result["evidence"] == [], "网页来源被错误混入视频原文证据")
    _check(
        result["source_context"]["web_search_used"] is True,
        "来源上下文没有记录联网检索状态",
    )

    with (
        patch.object(web_research, "research_web") as research_mock,
        patch.object(ai_juicer, "_call_llm", return_value=model_payload),
    ):
        video_only = ai_juicer.answer_note_question(
            title="测试视频",
            transcript="只有这段视频文稿。",
            ai_summary=None,
            question="查一下最新链接",
            research_scope="video_only",
        )
    research_mock.assert_not_called()
    _check(
        video_only["research_scope"] == "video_only",
        "仅视频模式没有保持确定性",
    )


def verify_parallel_coordinator() -> None:
    total = 12
    state_lock = threading.Lock()
    started = 0
    asr_active = 0
    asr_peak = 0
    llm_active = 0
    llm_peak = 0

    def fake_extract(
        *,
        user_id: str,
        aweme_id: str,
        asr_gate: threading.Semaphore,
        llm_gate: threading.Semaphore,
        progress,
        operation: str = "full",
    ) -> dict[str, object]:
        nonlocal started, asr_active, asr_peak, llm_active, llm_peak
        with state_lock:
            started += 1
        with asr_gate:
            progress("transcribing")
            with state_lock:
                asr_active += 1
                asr_peak = max(asr_peak, asr_active)
            time.sleep(0.025)
            with state_lock:
                asr_active -= 1
        with llm_gate:
            progress("analyzing")
            with state_lock:
                llm_active += 1
                llm_peak = max(llm_peak, llm_active)
            time.sleep(0.02)
            with state_lock:
                llm_active -= 1
        return {
            "id": f"note-{aweme_id}",
            "transcript_chars": 128,
            "card_type": "general",
            "ai_initialized": True,
            "already_existed": False,
        }

    with patch.object(
        library_extraction_service,
        "extract_library_item",
        side_effect=fake_extract,
    ):
        job = library_extraction_service.create_batch_job(
            user_id="verify-user",
            aweme_ids=[f"video-{index}" for index in range(total)],
            asr_concurrency=3,
            llm_concurrency=2,
        )
        deadline = time.monotonic() + 5
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.025)
            job = library_extraction_service.get_batch_job(
                job["job_id"],
                "verify-user",
            )
            _check(job is not None, "批处理任务未按用户隔离保存")

    _check(started == total, "并非所有已接受视频都立即提交了任务")
    _check(job["status"] == "success", "并发任务没有全部完成")
    _check(job["success"] == total, "并发任务完成计数错误")
    _check(job["operation"] == "full", "批处理任务没有保留操作类型")
    _check(asr_peak == 3, "ASR 阶段并发门限没有生效")
    _check(llm_peak == 2, "LLM 阶段并发门限没有生效")
    _check(job["database_stores_media"] is False, "任务错误声明会持久化视频")
    _check(
        library_extraction_service.get_batch_job(job["job_id"], "other-user")
        is None,
        "其他用户可以读取不属于自己的批处理任务",
    )


def verify_transcript_stage_split() -> None:
    item = {
        "aweme_id": "transcript-first",
        "title": "先文案后总结",
        "source_url": "https://www.douyin.com/video/transcript-first",
        "cover_url": "https://example.com/cover.jpg",
        "author_name": "测试作者",
        "recorded_at": "",
        "caption": "",
        "can_extract": True,
    }

    class DummySession:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

    class TranscriptNote:
        id = "note-transcript-first"
        video_title = item["title"]
        transcript_raw = "这是完整视频文案"
        ai_initialized = False

        def to_dict(self) -> dict[str, object]:
            return {
                "id": self.id,
                "transcript_chars": len(self.transcript_raw),
                "card_type": "general",
                "ai_initialized": self.ai_initialized,
            }

    transcript_note = TranscriptNote()
    def enter_common_patches(stack: ExitStack) -> None:
        stack.enter_context(
            patch.object(library_extraction_service, "SessionLocal", DummySession)
        )
        stack.enter_context(patch.object(
            library_extraction_service.douyin_binding_service,
            "get_or_create",
            return_value=SimpleNamespace(session_scope="scope", id="binding"),
        ))
        stack.enter_context(patch.object(
            library_extraction_service.douyin_library,
            "get_item",
            return_value=item,
        ))
        stack.enter_context(patch.object(
            library_extraction_service.douyin_library,
            "companion_media_url",
            return_value="https://example.com/video.mp4",
        ))
        stack.enter_context(patch.object(
            library_extraction_service.douyin_library,
            "companion_headers",
            return_value={},
        ))

    with ExitStack() as stack:
        enter_common_patches(stack)
        stack.enter_context(patch.object(
            library_extraction_service.note_service,
            "get_note_by_video_id",
            return_value=None,
        ))
        stack.enter_context(patch.object(
            library_extraction_service.settings_service,
            "get_asr_config",
            return_value={
                "api_key": "test",
                "api_base_url": "https://example.com",
                "model": "test",
            },
        ))
        asr_mock = stack.enter_context(patch.object(
            library_extraction_service.video_extractor,
            "extract_media_url_transcript",
            return_value=transcript_note.transcript_raw,
        ))
        create_mock = stack.enter_context(patch.object(
            library_extraction_service.note_service,
            "create_transcript_note",
            return_value=transcript_note,
        ))
        classify_mock = stack.enter_context(patch.object(
            library_extraction_service.ai_juicer,
            "classify_intent",
        ))
        card_mock = stack.enter_context(patch.object(
            library_extraction_service.ai_juicer,
            "generate_card",
        ))
        transcript_result = library_extraction_service.extract_library_item(
            user_id="verify-user",
            aweme_id=item["aweme_id"],
            operation="transcript",
        )
    _check(asr_mock.call_count == 1, "文案阶段没有运行一次 ASR")
    _check(create_mock.call_count == 1, "文案阶段没有持久化 transcript-only Note")
    classify_mock.assert_not_called()
    card_mock.assert_not_called()
    _check(
        transcript_result["ai_initialized"] is False,
        "文案阶段被错误标记为已完成 AI 初始化",
    )

    def update_ai(_db, note, _ai_result):
        note.ai_initialized = True
        return note

    transcript_note.ai_initialized = False
    with ExitStack() as stack:
        enter_common_patches(stack)
        stack.enter_context(patch.object(
            library_extraction_service.note_service,
            "get_note_by_video_id",
            return_value=transcript_note,
        ))
        asr_mock = stack.enter_context(patch.object(
            library_extraction_service.video_extractor,
            "extract_media_url_transcript",
        ))
        classify_mock = stack.enter_context(patch.object(
            library_extraction_service.ai_juicer,
            "classify_intent",
            return_value={"card_type": "general", "is_plan": False},
        ))
        card_mock = stack.enter_context(patch.object(
            library_extraction_service.ai_juicer,
            "generate_card",
            return_value={"card_type": "general", "sections": [], "conclusion": ""},
        ))
        update_mock = stack.enter_context(patch.object(
            library_extraction_service.note_service,
            "update_note_ai",
            side_effect=update_ai,
        ))
        stack.enter_context(patch.object(
            library_extraction_service,
            "_persist_generated_plan",
            return_value=None,
        ))
        ai_result = library_extraction_service.extract_library_item(
            user_id="verify-user",
            aweme_id=item["aweme_id"],
            operation="ai",
        )
    asr_mock.assert_not_called()
    _check(classify_mock.call_count == 1, "AI 阶段没有执行分类")
    _check(card_mock.call_count == 1, "AI 阶段没有生成知识卡")
    _check(update_mock.call_count == 1, "AI 阶段没有原位更新 transcript-only Note")
    _check(ai_result["id"] == transcript_note.id, "AI 阶段创建了重复 Note")
    _check(ai_result["ai_initialized"] is True, "AI 阶段完成后状态没有更新")
    _check(
        ai_juicer._note_ai_summary_context({
            "ai_initialized": False,
            "source_meta": {"platform": "douyin"},
        }) == "",
        "文案占位数据被错误当作 AI 摘要",
    )


def verify_transcript_batch_admission() -> None:
    total = 100

    def fake_extract(
        *,
        user_id: str,
        aweme_id: str,
        asr_gate: threading.Semaphore,
        llm_gate: threading.Semaphore,
        progress,
        operation: str,
    ) -> dict[str, object]:
        _check(operation == "transcript", "100 条任务不是纯文案操作")
        progress("transcribing")
        return {
            "id": f"note-{aweme_id}",
            "transcript_chars": 64,
            "card_type": "general",
            "ai_initialized": False,
            "already_existed": False,
        }

    with patch.object(
        library_extraction_service,
        "extract_library_item",
        side_effect=fake_extract,
    ):
        job = library_extraction_service.create_batch_job(
            user_id="verify-hundred",
            aweme_ids=[f"transcript-{index}" for index in range(total)],
            operation="transcript",
            asr_concurrency=200,
            llm_concurrency=12,
        )
        deadline = time.monotonic() + 5
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.02)
            job = library_extraction_service.get_batch_job(
                job["job_id"],
                "verify-hundred",
            )
            _check(job is not None, "100 条文案任务状态丢失")
    _check(job["status"] == "success", "100 条文案任务没有完成")
    _check(job["total"] == total, "文案任务没有接收完整的 100 条")
    _check(job["concurrency"]["asr"] == 200, "任务没有接受 200 ASR 并发配置")
    _check(
        library_extraction_service._EXECUTOR._max_workers == 200,
        "进程执行器仍受旧的 100 线程上限限制",
    )
    _check(
        all(item["ai_initialized"] is False for item in job["items"]),
        "纯文案任务错误触发了 AI 初始化",
    )


def verify_configurable_asr_capacity() -> None:
    with patch.object(settings_service, "get_setting", return_value=""):
        defaults = settings_service.get_extraction_concurrency(object())
    _check(defaults["asr"] == 200, "ASR 默认并发不是 200")
    _check(defaults["llm"] == 12, "LLM 默认并发被意外修改")

    with patch.object(settings_service, "set_setting") as setter:
        saved = settings_service.set_extraction_concurrency(
            object(),
            asr=200,
            llm=50,
        )
    _check(saved == {"asr": 200, "llm": 50}, "并发配置没有保存合法上限")
    _check(setter.call_count == 2, "ASR/LLM 并发没有分别持久化")

    with patch.object(settings_service, "set_setting"):
        bounded = settings_service.set_extraction_concurrency(
            object(),
            asr=999,
            llm=999,
        )
    _check(
        bounded == {"asr": 200, "llm": 50},
        "服务层没有按 ASR 200 / LLM 50 上限收敛",
    )


def verify_idempotency() -> None:
    state_lock = threading.Lock()
    saved_note: object | None = None
    persist_calls = 0
    asr_calls = 0
    active_sessions = 0

    class DummySession:
        def __enter__(self):
            nonlocal active_sessions
            active_sessions += 1
            return self

        def __exit__(self, exc_type, exc, traceback):
            nonlocal active_sessions
            active_sessions -= 1
            return False

    class ExistingNote:
        transcript_raw = "测试视频文稿"
        ai_initialized = True

        def to_dict(self) -> dict[str, object]:
            return {
                "id": "note-once",
                "transcript_chars": 10,
                "ai_initialized": True,
            }

    def get_note(*args, **kwargs):
        with state_lock:
            return saved_note

    def persist(*args, **kwargs):
        nonlocal saved_note, persist_calls
        _check(active_sessions == 1, "持久化阶段没有使用独立短数据库会话")
        with state_lock:
            persist_calls += 1
            saved_note = ExistingNote()
        return {
            "id": "note-once",
            "transcript_chars": 10,
            "card_type": "general",
            "already_existed": False,
        }

    def transcribe(*args, **kwargs):
        nonlocal asr_calls
        _check(active_sessions == 0, "外部转录期间仍占用数据库连接")
        asr_calls += 1
        time.sleep(0.03)
        return "测试视频文稿"

    item = {
        "aweme_id": "same-video",
        "title": "同一条视频",
        "source_url": "https://www.douyin.com/video/same-video",
        "cover_url": "https://example.com/cover.jpg",
        "author_name": "测试作者",
        "recorded_at": "",
        "caption": "",
        "can_extract": True,
    }
    with (
        patch.object(library_extraction_service, "SessionLocal", DummySession),
        patch.object(
            library_extraction_service.note_service,
            "get_note_by_video_id",
            side_effect=get_note,
        ),
        patch.object(
            library_extraction_service.douyin_binding_service,
            "get_or_create",
            return_value=SimpleNamespace(session_scope="scope", id="binding"),
        ),
        patch.object(
            library_extraction_service.douyin_library,
            "get_item",
            return_value=item,
        ),
        patch.object(
            library_extraction_service.douyin_library,
            "companion_media_url",
            return_value="https://example.com/video.mp4",
        ),
        patch.object(
            library_extraction_service.douyin_library,
            "companion_headers",
            return_value={},
        ),
        patch.object(
            library_extraction_service.settings_service,
            "get_asr_config",
            return_value={
                "api_key": "test",
                "api_base_url": "https://example.com",
                "model": "test",
            },
        ),
        patch.object(
            library_extraction_service.video_extractor,
            "extract_media_url_transcript",
            side_effect=transcribe,
        ),
        patch.object(
            library_extraction_service.ai_juicer,
            "classify_intent",
            return_value={"card_type": "general", "is_plan": False},
        ),
        patch.object(
            library_extraction_service.ai_juicer,
            "generate_card",
            return_value={"sections": [], "conclusion": ""},
        ),
        patch.object(
            library_extraction_service,
            "_persist_generated_note",
            side_effect=persist,
        ),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda _: library_extraction_service.extract_library_item(
                        user_id="same-user",
                        aweme_id="same-video",
                    ),
                    range(2),
                )
            )
    _check(persist_calls == 1, "同一用户同一视频被重复写入")
    _check(asr_calls == 1, "重复请求执行了重复转录")
    _check(
        sum(bool(result.get("already_existed")) for result in results) == 1,
        "幂等结果没有标记已存在记录",
    )


def verify_no_media_persistence() -> None:
    binary_columns = [
        column.name
        for column in Note.__table__.columns
        if "binary" in type(column.type).__name__.lower()
        or "blob" in type(column.type).__name__.lower()
    ]
    _check(not binary_columns, f"Note 表出现二进制媒体字段：{binary_columns}")

    root = Path(tempfile.mkdtemp(prefix="zhicui-verify-"))
    task_dir = root / "task"
    audio_path = task_dir / "audio.mp3"

    class FakeStdin:
        def __init__(self) -> None:
            self.bytes_written = 0

        def write(self, chunk: bytes) -> None:
            self.bytes_written += len(chunk)

        def close(self) -> None:
            return None

    class FakeProcess:
        def __init__(self) -> None:
            self.stdin = FakeStdin()
            self.stderr = io.BytesIO()
            self._done = False

        def wait(self, timeout=None) -> int:
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(b"temporary audio")
            self._done = True
            return 0

        def poll(self):
            return 0 if self._done else None

        def kill(self) -> None:
            self._done = True

    class FakeResponse:
        headers = {"Content-Length": "12"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, chunk_size: int):
            yield b"video-bytes"

    class FakeSession:
        trust_env = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def get(self, *args, **kwargs):
            return FakeResponse()

    try:
        with (
            patch.object(video_extractor.tempfile, "mkdtemp", return_value=str(task_dir)),
            patch.object(video_extractor, "_get_ffmpeg_path", return_value="ffmpeg"),
            patch.object(video_extractor.subprocess, "Popen", return_value=FakeProcess()),
            patch("requests.Session", FakeSession),
            patch.object(
                video_extractor,
                "_asr_audio_file",
                return_value="已提取的文案",
            ),
        ):
            transcript = video_extractor.extract_media_url_transcript(
                "https://example.com/video.mp4",
                "test-key",
            )
        _check(transcript == "已提取的文案", "流式媒体转录没有返回文案")
        _check(not task_dir.exists(), "任务结束后临时音频目录没有被删除")
        _check(
            not any(root.rglob("*.mp4")),
            "流式转录过程中创建了视频文件",
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> None:
    checks = (
        ("联网安全与来源追踪", verify_search_safety_and_provenance),
        ("并发协调器", verify_parallel_coordinator),
        ("文案与 AI 阶段拆分", verify_transcript_stage_split),
        ("100 条文案任务", verify_transcript_batch_admission),
        ("ASR 200 并发配置", verify_configurable_asr_capacity),
        ("重复请求幂等", verify_idempotency),
        ("不持久化视频", verify_no_media_persistence),
    )
    for label, check in checks:
        check()
        print(f"PASS  {label}")
    print("PASS  research + parallel extraction verification")


if __name__ == "__main__":
    main()
