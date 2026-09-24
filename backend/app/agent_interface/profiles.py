"""Agent 发布范围：core 是独立的资料接入产品，不能冒充 full Stable。"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.core.config import settings


# 固定清单不使用前缀匹配，新 Action 必须明确审核后才能进入 core。
CORE_ACTION_IDS = frozenset({
    "account.me", "library.list", "library.get",
    "library.import_link", "library.transcript.generate", "library.media.download",
    "creator.list", "creator.get", "creator.items.list",
    "ask.sources.list", "ask.sources.search",
    "ask.thread.list", "ask.thread.get", "ask.thread.create",
    "ask.thread.update", "ask.thread.remove",
    "ask.turn.start", "ask.turn.get", "ask.turn.events", "ask.turn.cancel", "ask.turn.retry",
    "knowledge.list", "knowledge.get", "knowledge.create", "knowledge.update", "knowledge.remove",
    "plan.list", "plan.get", "plan.overview", "plan.create", "plan.update", "plan.remove",
    "plan.task.add", "plan.task.update", "plan.task.set_completion", "plan.task.remove",
    "plan.focus.replace", "plan.task.reorder", "plan.review",
    "models.list", "models.custom.list",
})
CORE_SCOPE_IDS = frozenset({
    "account:read", "library:read", "library:write", "creator:read", "ask:read", "ask:run",
    "knowledge:read", "knowledge:write", "plan:read", "plan:write", "models:read",
})
CORE_LIMITATIONS = (
    "可导入明确指定的抖音、B站公开链接、提取文稿并下载视频，围绕文稿问答和整理知识与计划。",
    "平台登录或验证限制会明确返回；暂不开放账号批量同步、画面解析、自动摘要和邮件。",
    "暂不开放本机桥接及密码、API Key 等安全设置；问答仅使用已有资料。",
)


def profile_name() -> str:
    """未知值一律关闭；即使运行时误改设置，也不会退回 full。"""
    value = str(settings.AGENT_INTERFACE_PROFILE)
    return value if value in {"full", "core"} else "invalid"


def allowed_scope_ids() -> frozenset[str]:
    profile = profile_name()
    return ALL_SCOPE_IDS if profile == "full" else CORE_SCOPE_IDS if profile == "core" else frozenset()


def profile_allows_action(action_id: str) -> bool:
    profile = profile_name()
    return profile == "full" or (profile == "core" and action_id in CORE_ACTION_IDS)


def profile_input_schema(action_id: str, schema: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(schema)
    if profile_name() == "core" and action_id == "ask.turn.start":
        result["properties"]["web_scope"] = {
            "type": "string", "enum": ["video_only"],
            "description": "基础接入仅使用已有文稿，不发起联网研究。",
        }
    if profile_name() == "core" and action_id == "library.transcript.generate":
        result["properties"]["operation"] = {
            "type": "string", "enum": ["transcript"],
            "description": "基础接入只提取文稿；知识问答使用独立 Action。",
        }
    return result


def profile_metadata() -> dict[str, Any]:
    profile = profile_name()
    return {
        "release_profile": profile,
        "limitations": list(CORE_LIMITATIONS) if profile == "core" else [],
    }
