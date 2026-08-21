"""Bounded, allowlisted domain-tool execution for one Agent Turn.

The runtime intentionally has no dynamic import or plugin discovery.  A caller
must register every handler explicitly for the current Turn, which keeps frozen
video sources and user ownership inside the surrounding orchestration scope.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from app.services.agent_repeat_tool_guard import RepeatToolGuard


ToolArguments = Mapping[str, Any]
ToolHandler = Callable[[ToolArguments], Any]
BoundaryCheck = Callable[[], None]
ToolEventCallback = Callable[[str, str, dict[str, Any]], None]
ToolReminderCallback = Callable[[str], None]

_TOOL_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{2,63}$")


class AgentToolRuntimeError(RuntimeError):
    """Base class for stable, user-safe tool runtime failures."""


class AgentToolUnknown(AgentToolRuntimeError):
    pass


class AgentToolAlreadyRegistered(AgentToolRuntimeError):
    pass


class AgentToolBudgetExceeded(AgentToolRuntimeError):
    pass


class AgentToolRepeatBlocked(AgentToolRuntimeError):
    pass


class AgentToolResultTooLarge(AgentToolRuntimeError):
    pass


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    handler: ToolHandler
    max_result_chars: int = 2_000_000

    def __post_init__(self) -> None:
        if not _TOOL_NAME_PATTERN.fullmatch(self.name):
            raise ValueError(f"无效的 Agent 工具名称: {self.name}")
        if not self.description.strip():
            raise ValueError("Agent 工具必须提供说明")
        if not callable(self.handler):
            raise ValueError("Agent 工具 handler 必须可调用")
        if self.max_result_chars < 1:
            raise ValueError("Agent 工具结果上限必须大于 0")


class AgentToolRegistry:
    """An explicit per-Turn allowlist; unknown tools fail closed."""

    def __init__(self) -> None:
        self._tools: dict[str, AgentTool] = {}

    def register(self, tool: AgentTool) -> None:
        if tool.name in self._tools:
            raise AgentToolAlreadyRegistered(f"Agent 工具已注册: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> AgentTool:
        tool = self._tools.get(name)
        if tool is None:
            raise AgentToolUnknown(f"未授权的 Agent 工具: {name}")
        return tool

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._tools)


def _serialized_result_chars(value: Any) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, default=str))
    except Exception as exc:
        raise AgentToolRuntimeError("Agent 工具返回了不可序列化的结果") from exc


def _result_summary(value: Any, *, result_chars: int) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "result_kind": type(value).__name__[:40],
        "result_chars": max(0, result_chars),
    }
    if isinstance(value, (dict, list, tuple, set)):
        summary["item_count"] = len(value)
    elif isinstance(value, str):
        summary["item_count"] = 1 if value else 0
    return summary


class AgentToolExecutor:
    """Execute registered tools inside cancellation, lease and loop bounds."""

    def __init__(
        self,
        *,
        turn_id: str,
        registry: AgentToolRegistry | None = None,
        max_calls: int = 24,
        boundary_check: BoundaryCheck | None = None,
        event_callback: ToolEventCallback | None = None,
        reminder_callback: ToolReminderCallback | None = None,
        repeat_guard: RepeatToolGuard | None = None,
    ) -> None:
        if not turn_id.strip():
            raise ValueError("Agent Turn ID 不能为空")
        if max_calls < 1:
            raise ValueError("Agent 工具调用预算必须大于 0")
        self.turn_id = turn_id
        self.registry = registry or AgentToolRegistry()
        self.max_calls = max_calls
        self.boundary_check = boundary_check or (lambda: None)
        self.event_callback = event_callback
        self.reminder_callback = reminder_callback
        self.repeat_guard = repeat_guard or RepeatToolGuard()
        self.call_count = 0
        self.reminders: list[str] = []

    def register(self, tool: AgentTool) -> None:
        self.registry.register(tool)

    def _emit(
        self,
        event_type: str,
        message: str,
        *,
        tool_name: str,
        **payload: Any,
    ) -> None:
        if self.event_callback is None:
            return
        self.event_callback(
            event_type,
            message,
            {
                "tool_name": tool_name,
                "call_index": self.call_count,
                **payload,
            },
        )

    def execute(
        self,
        tool_name: str,
        arguments: ToolArguments | None = None,
    ) -> Any:
        tool = self.registry.get(tool_name)
        safe_arguments = dict(arguments or {})
        self.boundary_check()
        if self.call_count >= self.max_calls:
            self._emit(
                "turn.tool.budget_exceeded",
                "研究工具调用已达到本轮安全上限",
                tool_name=tool_name,
                max_calls=self.max_calls,
            )
            raise AgentToolBudgetExceeded(
                f"Agent Turn {self.turn_id} 已达到 {self.max_calls} 次工具调用上限"
            )

        self.call_count += 1
        repeat = self.repeat_guard.observe(
            self.turn_id,
            tool_name,
            safe_arguments,
        )
        if repeat.reminder:
            self.reminders.append(repeat.reminder)
            if self.reminder_callback is not None:
                self.reminder_callback(repeat.reminder)
            self._emit(
                (
                    "turn.tool.repeat_blocked"
                    if repeat.blocked
                    else "turn.tool.repeat_reminder"
                ),
                (
                    "相同研究步骤重复过多，已终止这条路径"
                    if repeat.blocked
                    else "检测到重复研究步骤，正在调整路径"
                ),
                tool_name=tool_name,
                repeat_count=repeat.count,
            )
        if repeat.blocked:
            raise AgentToolRepeatBlocked(
                f"工具 {tool_name} 的相同参数调用已被重复保护终止"
            )

        self._emit(
            "turn.tool.started",
            f"正在执行研究步骤：{tool.description}",
            tool_name=tool_name,
            repeat_count=repeat.count,
        )
        started_at = time.perf_counter()
        try:
            result = tool.handler(safe_arguments)
        except Exception as exc:
            # A cancellation or lease transfer discovered after a failed call
            # takes precedence over exposing the handler's stale failure.
            self.boundary_check()
            duration_ms = max(0, round((time.perf_counter() - started_at) * 1000))
            self._emit(
                "turn.tool.failed",
                f"研究步骤未完成：{tool.description}",
                tool_name=tool_name,
                duration_ms=duration_ms,
                error_code=type(exc).__name__[:80],
            )
            raise

        # Discard a result when the user cancelled or this worker lost the
        # lease while the handler was running.
        self.boundary_check()
        duration_ms = max(0, round((time.perf_counter() - started_at) * 1000))
        result_chars = _serialized_result_chars(result)
        if result_chars > tool.max_result_chars:
            self._emit(
                "turn.tool.result_rejected",
                f"研究步骤结果超过安全上限：{tool.description}",
                tool_name=tool_name,
                duration_ms=duration_ms,
                result_chars=result_chars,
                max_result_chars=tool.max_result_chars,
            )
            raise AgentToolResultTooLarge(
                f"工具 {tool_name} 返回 {result_chars} 字符，超过 {tool.max_result_chars} 字符上限"
            )
        self._emit(
            "turn.tool.completed",
            f"已完成研究步骤：{tool.description}",
            tool_name=tool_name,
            duration_ms=duration_ms,
            **_result_summary(result, result_chars=result_chars),
        )
        return result
