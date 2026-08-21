"""Bound repeated domain-tool calls inside one Agent Turn.

Adapted from DeepSeek Harness' ``repeat-tool-reminder`` plugin (MIT,
commit 528c682e0616).  Zhicui keeps the useful canonical-argument chain but
uses an explicit hard stop at the fifth identical call because its video
research tools are bounded server operations rather than an open plugin loop.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RepeatToolDecision:
    count: int
    reminder: str = ""
    blocked: bool = False


def _sorted_json(value: Any) -> Any:
    if isinstance(value, list):
        return [_sorted_json(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): _sorted_json(value[key])
            for key in sorted(value, key=lambda item: str(item))
        }
    return value


def canonical_arguments(arguments: Any) -> str:
    """Return a stable key even when object property order differs."""
    return json.dumps(
        _sorted_json(arguments),
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    )


class RepeatToolGuard:
    """Track exact consecutive calls per durable Turn.

    Calls excluded from tracking are transparent: they neither increment nor
    reset the current chain. A real user interjection must call ``reset``.
    """

    def __init__(
        self,
        *,
        remind_at: int = 3,
        block_at: int = 5,
        include: tuple[str, ...] = (),
        exclude: tuple[str, ...] = (),
        arguments_preview_chars: int = 500,
    ) -> None:
        if remind_at < 2 or block_at <= remind_at:
            raise ValueError("重复工具阈值必须满足 2 <= remind_at < block_at")
        if arguments_preview_chars < 1:
            raise ValueError("arguments_preview_chars 必须大于 0")
        self.remind_at = remind_at
        self.block_at = block_at
        self.include = include
        self.exclude = exclude
        self.arguments_preview_chars = arguments_preview_chars
        self._chains: dict[str, tuple[str, int]] = {}

    def _tracked(self, tool_name: str) -> bool:
        if self.include and not any(
            fnmatch.fnmatchcase(tool_name, pattern) for pattern in self.include
        ):
            return False
        return not any(
            fnmatch.fnmatchcase(tool_name, pattern) for pattern in self.exclude
        )

    def reset(self, turn_id: str) -> None:
        self._chains.pop(turn_id, None)

    def observe(
        self, turn_id: str, tool_name: str, arguments: Any
    ) -> RepeatToolDecision:
        if not self._tracked(tool_name):
            return RepeatToolDecision(count=0)
        canonical = canonical_arguments(arguments)
        key = json.dumps([tool_name, canonical], ensure_ascii=False)
        previous = self._chains.get(turn_id)
        count = previous[1] + 1 if previous and previous[0] == key else 1
        self._chains[turn_id] = (key, count)
        if count < self.remind_at:
            return RepeatToolDecision(count=count)
        preview = canonical[: self.arguments_preview_chars]
        if len(canonical) > self.arguments_preview_chars:
            preview += f"…（省略 {len(canonical) - self.arguments_preview_chars} 字符）"
        if count >= self.block_at:
            return RepeatToolDecision(
                count=count,
                blocked=True,
                reminder=(
                    f"工具 {tool_name} 已用相同参数连续调用 {count} 次；"
                    "该路径已终止，请基于现有证据给出有限结论或改用不同参数。"
                ),
            )
        return RepeatToolDecision(
            count=count,
            reminder=(
                f"工具 {tool_name} 已用相同参数连续调用 {count} 次：{preview}。"
                "请先检查上次结果，再改变参数、换路径或结束研究。"
            ),
        )
