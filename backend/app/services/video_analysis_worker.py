"""数据库驱动的视频详细解析后台执行器。

数据库中的 Run/Item 是唯一状态真相。线程池只负责受限消费已提交的 Item；
进程重启后由服务层重新排队安全任务并释放无法续跑的预留。本模块不保存
媒体地址、图片或凭证，也不在内存中维护任务快照。
"""

from __future__ import annotations

import inspect
import json
import os
import socket
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.request_context import reset_request_context, set_request_context
from app.services import error_log_service
from app.services.video_analysis_engine import (
    AnalysisCancelled,
    AnalysisOutcome,
    VideoAnalysisError,
    analyze_video_details,
    cached_result_payload,
    cleanup_stale_media_workspaces,
)


TERMINAL_ITEM_STATUSES = {
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "cached",
    "unsupported",
}


class WorkerLeaseLost(VideoAnalysisError):
    code = "worker_lease_lost"

    def __init__(self) -> None:
        super().__init__("视频解析任务执行权已转移")


@dataclass(frozen=True)
class VideoAnalysisCompletionEvent:
    item_id: str
    run_id: str
    user_id: str
    note_id: str
    status: str
    analysis_id: str = ""
    error_code: str = ""


CompletionHook = Callable[[VideoAnalysisCompletionEvent], None]


@dataclass(frozen=True)
class _ItemIdentity:
    id: str
    run_id: str
    user_id: str
    note_id: str
    offering_version_id: str
    provider_id: str
    source_fingerprint: str
    use_byok: bool
    reserved_points: int
    worker_id: str


class _StageState:
    def __init__(self, initial: str = "prepared") -> None:
        self._stage = initial
        self._lock = threading.Lock()

    def set(self, stage: str) -> None:
        with self._lock:
            self._stage = str(stage or "prepared")[:48]

    def get(self) -> str:
        with self._lock:
            return self._stage


_COMPLETION_HOOKS: list[CompletionHook] = []
_COMPLETION_HOOKS_LOCK = threading.Lock()


def register_completion_hook(hook: CompletionHook) -> None:
    """注册任务终态通知；hook 只接收安全标识与状态。"""
    with _COMPLETION_HOOKS_LOCK:
        if hook not in _COMPLETION_HOOKS:
            _COMPLETION_HOOKS.append(hook)


def unregister_completion_hook(hook: CompletionHook) -> None:
    with _COMPLETION_HOOKS_LOCK:
        if hook in _COMPLETION_HOOKS:
            _COMPLETION_HOOKS.remove(hook)


def _emit_completion(event: VideoAnalysisCompletionEvent) -> None:
    with _COMPLETION_HOOKS_LOCK:
        hooks = list(_COMPLETION_HOOKS)
    for hook in hooks:
        try:
            hook(event)
        except Exception:
            # Agent 恢复通知失败不能改变已完成的解析与结算。
            error_log_service.record_error_safely(
                source="backend",
                severity="warning",
                error_type="VideoAnalysisCompletionHookError",
                message="视频解析完成通知处理失败",
                status_code=500,
                user_id=event.user_id,
                metadata={"operation": "video_analysis_completion_hook"},
            )


def _video_analysis_service() -> Any:
    # 局部导入允许模型/编排服务独立初始化，也避免应用导入时要求视觉依赖。
    from app.services import video_analysis_service

    return video_analysis_service


def _runtime_worker_settings() -> dict[str, Any]:
    """每轮读取数据库热设置，使管理端调整无需重启进程。"""
    try:
        from app.services import video_analysis_catalog_service

        with SessionLocal() as db:
            runtime = video_analysis_catalog_service.get_runtime_settings(db)
        return {
            "enabled": bool(runtime.get("enabled")),
            # 首版线程池物理容量锁定为 4；管理端可在 1–4 间
            # 实时降低/提高提交容量，已运行任务不会被粗暴中断。
            "global_concurrency": max(
                1, min(4, int(runtime.get("global_concurrency") or 1))
            ),
            "scene_concurrency": max(
                1, min(4, int(runtime.get("scene_concurrency") or 1))
            ),
            "vision_concurrency": max(
                1, min(4, int(runtime.get("vision_concurrency") or 1))
            ),
            "temporary_file_ttl_minutes": max(
                5,
                min(1440, int(runtime.get("temporary_file_ttl_minutes") or 60)),
            ),
        }
    except Exception:
        return {
            "enabled": bool(getattr(settings, "VIDEO_ANALYSIS_ENABLED", False)),
            "global_concurrency": max(
                1,
                min(4, int(getattr(settings, "VIDEO_ANALYSIS_MAX_WORKERS", 1))),
            ),
            "scene_concurrency": 1,
            "vision_concurrency": 1,
            "temporary_file_ttl_minutes": 60,
        }


def _runtime_feature_enabled() -> bool:
    return bool(_runtime_worker_settings()["enabled"])


class _StageConcurrencyController:
    """按真实执行阶段限流，避免把整个 VLM Item 错当成纯视觉阶段。"""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._active = {"scene": 0, "vision": 0}

    def acquire(self, kind: str, cancel_check: Callable[[], bool]) -> None:
        setting_key = f"{kind}_concurrency"
        with self._condition:
            while True:
                if cancel_check():
                    raise AnalysisCancelled()
                limit = max(
                    1,
                    min(4, int(_runtime_worker_settings().get(setting_key) or 1)),
                )
                if self._active[kind] < limit:
                    self._active[kind] += 1
                    return
                self._condition.wait(timeout=0.5)

    def release(self, kind: str) -> None:
        with self._condition:
            self._active[kind] = max(0, self._active[kind] - 1)
            self._condition.notify_all()


class _StageConcurrencyLease:
    def __init__(self, cancel_check: Callable[[], bool]) -> None:
        self._cancel_check = cancel_check
        self._held: str | None = None

    def transition(self, stage: str) -> None:
        desired = (
            "scene"
            if stage == "detecting_scenes"
            else "vision" if stage == "analyzing_visuals" else None
        )
        if desired == self._held:
            return
        self.release()
        if desired:
            _STAGE_CONCURRENCY.acquire(desired, self._cancel_check)
            self._held = desired

    def release(self) -> None:
        held = self._held
        self._held = None
        if held:
            _STAGE_CONCURRENCY.release(held)


_STAGE_CONCURRENCY = _StageConcurrencyController()


def _call_compatible(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """仅过滤尚未被服务层接收的可选关键字，不吞掉函数内部 TypeError。"""
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return function(*args, **kwargs)
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values()):
        return function(*args, **kwargs)
    accepted = {key: value for key, value in kwargs.items() if key in signature.parameters}
    return function(*args, **accepted)


def _identity(item: Any) -> _ItemIdentity:
    return _ItemIdentity(
        id=str(getattr(item, "id", "")),
        run_id=str(getattr(item, "run_id", "")),
        user_id=str(getattr(item, "user_id", "")),
        note_id=str(getattr(item, "note_id", "") or ""),
        offering_version_id=str(getattr(item, "offering_version_id", "")),
        provider_id=str(getattr(item, "provider_id", "") or ""),
        source_fingerprint=str(getattr(item, "source_fingerprint", "") or ""),
        use_byok=bool(getattr(item, "use_byok", False)),
        reserved_points=max(0, int(getattr(item, "reserved_points", 0) or 0)),
        worker_id=str(getattr(item, "worker_id", "") or ""),
    )


def _load_item(item_id: str) -> Any | None:
    try:
        from app.models.video_analysis import VideoAnalysisItem

        with SessionLocal() as db:
            return db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id).first()
    except Exception:
        return None


def _load_identity(item_id: str) -> _ItemIdentity | None:
    item = _load_item(item_id)
    return _identity(item) if item is not None else None


def _terminal_event(item_id: str, *, fallback: _ItemIdentity, error_code: str = "") -> VideoAnalysisCompletionEvent:
    item = _load_item(item_id)
    identity = _identity(item) if item is not None else fallback
    return VideoAnalysisCompletionEvent(
        item_id=identity.id,
        run_id=identity.run_id,
        user_id=identity.user_id,
        note_id=identity.note_id,
        status=str(getattr(item, "status", "failed") if item is not None else "failed"),
        analysis_id=str(getattr(item, "analysis_id", "") or "") if item is not None else "",
        error_code=str(getattr(item, "error_code", "") or error_code) if item is not None else error_code,
    )


def _is_cancel_requested(item_id: str, *, worker_id: str, lease_lost: threading.Event) -> bool:
    if lease_lost.is_set():
        raise WorkerLeaseLost()
    item = _load_item(item_id)
    if item is None:
        raise WorkerLeaseLost()
    status = str(getattr(item, "status", "") or "")
    if status == "cancelled" or bool(getattr(item, "cancel_requested", False)) or getattr(item, "cancel_requested_at", None):
        return True
    current_worker = str(getattr(item, "worker_id", "") or "")
    if current_worker and current_worker != worker_id and status == "running":
        raise WorkerLeaseLost()
    if status in TERMINAL_ITEM_STATUSES:
        raise WorkerLeaseLost()
    return False


def _heartbeat(
    item_id: str,
    worker_id: str,
    stage: str,
) -> bool:
    service = _video_analysis_service()
    with SessionLocal() as db:
        result = _call_compatible(
            service.heartbeat_item,
            db,
            item_id,
            worker_id,
            stage=stage,
        )
    return result is not False


def _heartbeat_loop(
    item_id: str,
    worker_id: str,
    stage_state: _StageState,
    stop: threading.Event,
    lease_lost: threading.Event,
) -> None:
    interval = max(5, min(60, int(getattr(settings, "VIDEO_ANALYSIS_HEARTBEAT_SECONDS", 15))))
    while not stop.wait(interval):
        try:
            if not _heartbeat(item_id, worker_id, stage_state.get()):
                lease_lost.set()
                return
        except Exception:
            # 短暂数据库故障由下一次心跳重试；过期租约由恢复器最终处理。
            continue


def _runtime_context(item_id: str) -> dict[str, Any]:
    service = _video_analysis_service()
    with SessionLocal() as db:
        value = service.get_execution_context(db, item_id)
    if not isinstance(value, Mapping):
        raise VideoAnalysisError("视频解析执行上下文不可用")
    return dict(value)


def _find_cached(identity: _ItemIdentity) -> Any | None:
    if not identity.source_fingerprint:
        return None
    service = _video_analysis_service()
    with SessionLocal() as db:
        return service.find_cached_analysis(
            db,
            user_id=identity.user_id,
            note_id=identity.note_id,
            offering_version_id=identity.offering_version_id,
            source_fingerprint=identity.source_fingerprint,
        )


def _cached_outcome(cached: Any) -> AnalysisOutcome:
    payload = cached_result_payload(cached)
    return AnalysisOutcome(
        status="cached",
        result_payload=payload,
        scene_count=max(0, int(getattr(cached, "scene_count", payload.get("scene_count", 0)) or 0)),
        frame_count=max(0, int(getattr(cached, "frame_count", payload.get("frame_count", 0)) or 0)),
        duration_ms=max(0, int(getattr(cached, "duration_ms", payload.get("duration_ms", 0)) or 0)),
        degraded_reason=str(payload.get("degraded_reason") or "")[:120],
        result_usage={
            "calls": 0,
            "image_count": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "provider_units": 0,
            "platform_cost_micros": 0,
            "failure_cost_micros": 0,
            "cache_hit": 1,
        },
    )


def _calculate_charge(
    item_id: str,
    identity: _ItemIdentity,
    context: Mapping[str, Any],
    result_usage: Mapping[str, Any],
) -> tuple[int, int]:
    service = _video_analysis_service()
    points = 0
    cost_micros = 0
    with SessionLocal() as db:
        try:
            from app.models.video_analysis import VideoAnalysisItem

            item = db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item_id).first()
        except Exception:
            item = None
        calculator = getattr(service, "calculate_actual_charge", None)
        if callable(calculator) and item is not None:
            calculated = _call_compatible(
                calculator,
                db,
                item,
                result_usage=result_usage,
            )
            if isinstance(calculated, Mapping):
                points = int(calculated.get("points") or calculated.get("actual_points") or 0)
                cost_micros = int(calculated.get("cost_micros") or calculated.get("platform_cost_micros") or 0)
            elif isinstance(calculated, (tuple, list)) and len(calculated) >= 2:
                points, cost_micros = int(calculated[0] or 0), int(calculated[1] or 0)
        else:
            snapshot = context.get("billing_snapshot")
            if isinstance(snapshot, Mapping):
                points = int(snapshot.get("actual_points") or 0)
                cost_micros = int(snapshot.get("platform_cost_micros") or 0)
    points = min(identity.reserved_points, max(0, int(points)))
    cost_micros = max(0, int(cost_micros))
    if identity.use_byok:
        cost_micros = 0
    return points, cost_micros


def _complete_item(
    item_id: str,
    identity: _ItemIdentity,
    outcome: AnalysisOutcome,
    context: Mapping[str, Any],
) -> None:
    service = _video_analysis_service()
    result_usage = dict(outcome.result_usage)
    result_usage["billable_duration_ms"] = max(0, int(outcome.duration_ms))
    result_usage["frame_count"] = max(0, int(outcome.frame_count))
    result_usage.setdefault("model_calls", max(0, int(result_usage.get("calls") or 0)))
    if outcome.status == "cached":
        actual_points, platform_cost_micros = 0, 0
    else:
        actual_points, platform_cost_micros = _calculate_charge(
            item_id,
            identity,
            context,
            result_usage,
        )
    with SessionLocal() as db:
        _call_compatible(
            service.complete_item,
            db,
            item_id,
            result_payload=outcome.result_payload,
            status=outcome.status,
            scene_count=outcome.scene_count,
            frame_count=outcome.frame_count,
            duration_ms=outcome.duration_ms,
            actual_points=actual_points,
            platform_cost_micros=platform_cost_micros,
            degraded_reason=outcome.degraded_reason,
            result_usage=result_usage,
        )


def _fail_item(
    item_id: str,
    *,
    error_code: str,
    error_detail: str,
    partial_result: Mapping[str, Any] | None = None,
    actual_points: int = 0,
    platform_cost_micros: int = 0,
    result_usage: Mapping[str, Any] | None = None,
    verified_duration_ms: int = 0,
) -> None:
    service = _video_analysis_service()
    with SessionLocal() as db:
        _call_compatible(
            service.fail_item,
            db,
            item_id,
            error_code=error_code[:64],
            error_detail=error_detail[:240],
            partial_result=dict(partial_result) if partial_result else None,
            actual_points=max(0, int(actual_points)),
            platform_cost_micros=max(0, int(platform_cost_micros)),
            result_usage=dict(result_usage or {}),
            verified_duration_ms=max(0, int(verified_duration_ms or 0)),
        )


def _cancel_item(
    item_id: str,
    *,
    user_id: str | None = None,
    reason_code: str = "user_cancelled",
    partial_result: Mapping[str, Any] | None = None,
    actual_points: int = 0,
    platform_cost_micros: int = 0,
    result_usage: Mapping[str, Any] | None = None,
) -> Any:
    service = _video_analysis_service()
    with SessionLocal() as db:
        return _call_compatible(
            service.cancel_item,
            db,
            item_id,
            user_id=user_id,
            reason_code=reason_code[:64],
            partial_result=dict(partial_result) if partial_result else None,
            actual_points=max(0, int(actual_points)),
            platform_cost_micros=max(0, int(platform_cost_micros)),
            result_usage=dict(result_usage or {}),
        )


def _record_worker_error(
    *,
    identity: _ItemIdentity,
    error_type: str,
    message: str,
    operation: str,
) -> None:
    error_log_service.record_error_safely(
        source="backend",
        severity="error",
        error_type=error_type[:128],
        message=message[:240],
        status_code=500,
        user_id=identity.user_id,
        metadata={"operation": operation},
    )


def execute_persistent_item(item_id: str, *, worker_id: str | None = None) -> None:
    """同步执行一个已 claim 的 Item，供线程池与单元测试共用。"""
    identity = _load_identity(item_id)
    if identity is None:
        return
    active_worker_id = str(
        worker_id or identity.worker_id or f"manual-{uuid.uuid4().hex[:16]}"
    )[:64]
    tokens = set_request_context(identity.user_id, f"/system/video-analysis/items/{identity.id}")
    stage_state = _StageState("prepared")
    heartbeat_stop = threading.Event()
    lease_lost = threading.Event()
    heartbeat_thread = threading.Thread(
        target=_heartbeat_loop,
        args=(identity.id, active_worker_id, stage_state, heartbeat_stop, lease_lost),
        name=f"video-analysis-heartbeat-{identity.id[:8]}",
        daemon=True,
    )
    heartbeat_thread.start()
    terminal_emitted = False
    context: dict[str, Any] = {}
    stage_lease: _StageConcurrencyLease | None = None
    try:
        context = _runtime_context(identity.id)
        context.setdefault("user_id", identity.user_id)
        context.setdefault("note_id", identity.note_id)
        context.setdefault("offering_version_id", identity.offering_version_id)
        context.setdefault("source_fingerprint", identity.source_fingerprint)
        context.setdefault("use_byok", identity.use_byok)

        def cancel_check() -> bool:
            return _is_cancel_requested(identity.id, worker_id=active_worker_id, lease_lost=lease_lost)

        stage_lease = _StageConcurrencyLease(cancel_check)

        def stage_callback(stage: str) -> None:
            stage_lease.transition(stage)
            stage_state.set(stage)
            if not _heartbeat(identity.id, active_worker_id, stage):
                lease_lost.set()
                raise WorkerLeaseLost()

        if cancel_check():
            raise AnalysisCancelled()
        cached = _find_cached(identity)
        outcome = _cached_outcome(cached) if cached is not None else analyze_video_details(
            context,
            cancel_check=cancel_check,
            stage_callback=stage_callback,
        )
        stage_callback("persisting")
        _complete_item(identity.id, identity, outcome, context)
        event = _terminal_event(identity.id, fallback=identity)
        _emit_completion(event)
        terminal_emitted = True
    except WorkerLeaseLost:
        # 另一执行器或取消事务已取得控制权；本 worker 不再改变状态/账务。
        return
    except AnalysisCancelled as exc:
        points, cost_micros = _calculate_charge(identity.id, identity, context, exc.result_usage)
        _cancel_item(
            identity.id,
            user_id=identity.user_id,
            partial_result=exc.partial_result,
            actual_points=points,
            platform_cost_micros=cost_micros,
            result_usage=exc.result_usage,
        )
        event = _terminal_event(identity.id, fallback=identity, error_code=exc.code)
        _emit_completion(event)
        terminal_emitted = True
    except VideoAnalysisError as exc:
        _fail_item(
            identity.id,
            error_code=exc.code,
            error_detail=str(exc),
            verified_duration_ms=max(
                0, int(getattr(exc, "verified_duration_ms", 0) or 0)
            ),
        )
        _record_worker_error(
            identity=identity,
            error_type=type(exc).__name__,
            message=str(exc),
            operation="video_analysis_execute",
        )
        event = _terminal_event(identity.id, fallback=identity, error_code=exc.code)
        _emit_completion(event)
        terminal_emitted = True
    except Exception:
        # 未知上游异常可能携带 URL/Key，持久日志只写固定安全消息。
        _fail_item(
            identity.id,
            error_code="internal_error",
            error_detail="视频详细解析内部错误",
        )
        _record_worker_error(
            identity=identity,
            error_type="VideoAnalysisInternalError",
            message="视频详细解析内部错误",
            operation="video_analysis_execute",
        )
        event = _terminal_event(identity.id, fallback=identity, error_code="internal_error")
        _emit_completion(event)
        terminal_emitted = True
    finally:
        if stage_lease is not None:
            stage_lease.release()
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)
        reset_request_context(tokens)
        # terminal_emitted 是故障诊断信号，显式保留避免未来误发重复通知。
        _ = terminal_emitted


def recover_persistent_items() -> Any:
    """重排安全任务并释放卡死预留；返回值由服务层定义。"""
    service = _video_analysis_service()
    with SessionLocal() as db:
        result = service.requeue_or_release_stale_items(db)
    _emit_recovery_completions(result)
    runner.wake()
    return result


def _emit_recovery_completions(result: Any) -> None:
    if not isinstance(result, Mapping):
        return
    item_ids = result.get("terminal_item_ids")
    if not isinstance(item_ids, list):
        return
    for item_id in item_ids[:500]:
        identity = _load_identity(str(item_id))
        if identity is None:
            continue
        _emit_completion(
            _terminal_event(
                identity.id,
                fallback=identity,
                error_code="worker_stale",
            )
        )


def notify_item_enqueued(item_id: str | None = None) -> None:
    """任务事务提交后唤醒 poller；item_id 只用于调用语义，不进内存队列。"""
    _ = item_id
    runner.wake()


def cancel_persistent_item(
    item_id: str,
    *,
    user_id: str | None = None,
    reason_code: str = "user_cancelled",
) -> bool:
    """请求取消并立即唤醒 worker；服务层负责幂等释放或已用量结算。"""
    identity = _load_identity(item_id)
    if identity is None or (user_id and identity.user_id != user_id):
        return False
    result = _cancel_item(item_id, user_id=user_id, reason_code=reason_code)
    runner.wake()
    return result is not False


class VideoAnalysisWorker:
    """单进程受限消费者；默认并发 1，start/stop 可重复调用。"""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._futures: dict[Future[None], tuple[str, str]] = {}
        self._lock = threading.RLock()
        self._last_error = ""
        self._runtime_limit = 1
        host = re_safe_worker_part(socket.gethostname())
        self._worker_prefix = f"{host}-{os.getpid()}-{uuid.uuid4().hex[:8]}"[:40]
        self._last_recovery_at = 0.0

    @property
    def max_workers(self) -> int:
        """当前数据库提交上限，非线程池物理容量。"""
        return max(1, min(4, int(self._runtime_limit or 1)))

    @property
    def executor_capacity(self) -> int:
        return 4

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._wake.clear()
            self._executor = ThreadPoolExecutor(
                max_workers=self.executor_capacity,
                thread_name_prefix="video-analysis",
            )
            self._thread = threading.Thread(
                target=self._loop,
                name="video-analysis-poller",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stop.set()
            self._wake.set()
            thread = self._thread
            executor = self._executor
            futures = list(self._futures)
            self._thread = None
            self._executor = None
            self._futures = {}
        if thread and thread.is_alive():
            thread.join(timeout=5)
        if executor:
            # 正在调用上游的任务保持数据库 running，由下次启动恢复器判定。
            executor.shutdown(wait=False, cancel_futures=True)
        for future in futures:
            future.cancel()

    def wake(self) -> None:
        self._wake.set()

    def _recover(self) -> None:
        service = _video_analysis_service()
        with SessionLocal() as db:
            result = service.requeue_or_release_stale_items(db)
        _emit_recovery_completions(result)
        cleanup_stale_media_workspaces(
            max_age_minutes=int(
                _runtime_worker_settings()["temporary_file_ttl_minutes"]
            )
        )
        self._last_recovery_at = time.monotonic()

    def _claim(self, worker_id: str) -> str | None:
        service = _video_analysis_service()
        with SessionLocal() as db:
            item = service.claim_next_item(db, worker_id)
            return str(getattr(item, "id", "") or "") or None

    def _loop(self) -> None:
        try:
            self._recover()
        except Exception:
            self._record_loop_error("video_analysis_recovery")
        poll_seconds = max(1, min(60, int(getattr(settings, "VIDEO_ANALYSIS_POLL_SECONDS", 5))))
        recovery_interval = max(30, int(getattr(settings, "VIDEO_ANALYSIS_RECOVERY_SECONDS", 60)))
        while not self._stop.is_set():
            try:
                runtime = _runtime_worker_settings()
                runtime_limit = max(
                    1, min(self.executor_capacity, int(runtime["global_concurrency"]))
                )
                with self._lock:
                    self._runtime_limit = runtime_limit
                    self._futures = {
                        future: identity
                        for future, identity in self._futures.items()
                        if not future.done()
                    }
                    executor = self._executor
                    free_slots = max(0, runtime_limit - len(self._futures))
                if time.monotonic() - self._last_recovery_at >= recovery_interval:
                    self._recover()
                # 总开关只阻止新 prepare；已确认 queued 任务必须继续 drain，
                # 否则会把用户预留萃点永久冻结在队列中。
                if executor and free_slots:
                    for _ in range(free_slots):
                        worker_id = f"{self._worker_prefix}-{uuid.uuid4().hex[:10]}"[:64]
                        item_id = self._claim(worker_id)
                        if not item_id:
                            break
                        future = executor.submit(execute_persistent_item, item_id, worker_id=worker_id)
                        with self._lock:
                            self._futures[future] = (item_id, worker_id)
            except Exception:
                self._record_loop_error("video_analysis_poll")
            self._wake.wait(poll_seconds)
            self._wake.clear()

    def _record_loop_error(self, operation: str) -> None:
        self._last_error = "视频解析后台执行器暂时不可用"
        error_log_service.record_error_safely(
            source="backend",
            severity="error",
            error_type="VideoAnalysisWorkerError",
            message=self._last_error,
            status_code=500,
            metadata={"operation": operation},
        )

    def status(self) -> dict[str, Any]:
        thread = self._thread
        runtime = _runtime_worker_settings()
        with self._lock:
            self._runtime_limit = max(
                1, min(self.executor_capacity, int(runtime["global_concurrency"]))
            )
            active = len([future for future in self._futures if not future.done()])
        return {
            "enabled": bool(runtime["enabled"]),
            "running": bool(thread and thread.is_alive()),
            "max_workers": self.max_workers,
            "executor_capacity": self.executor_capacity,
            "scene_concurrency": int(runtime["scene_concurrency"]),
            "vision_concurrency": int(runtime["vision_concurrency"]),
            "active_workers": active,
            "poll_seconds": max(1, min(60, int(getattr(settings, "VIDEO_ANALYSIS_POLL_SECONDS", 5)))),
            "last_error": self._last_error,
        }


def re_safe_worker_part(value: str) -> str:
    clean = "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in str(value or "worker"))
    return clean[:20] or "worker"


runner = VideoAnalysisWorker()


__all__ = [
    "CompletionHook",
    "VideoAnalysisCompletionEvent",
    "VideoAnalysisWorker",
    "cancel_persistent_item",
    "execute_persistent_item",
    "notify_item_enqueued",
    "recover_persistent_items",
    "register_completion_hook",
    "runner",
    "unregister_completion_hook",
]
