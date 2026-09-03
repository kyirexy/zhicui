"""Explicit ordinary-user Product Action Registry.

Nothing in this module reflects FastAPI routes.  Adding an HTTP endpoint does
not make it an Agent tool; an Action must be reviewed and registered here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Mapping

from app.agent_interface.contracts import (
    ALL_SCOPE_IDS,
    ActionDescriptor,
    ExecutionLocation,
    IdempotencyStrategy,
    RiskLevel,
    RunType,
)


ActionHandler = Callable[[Any, dict[str, Any]], Any]
_ACTION_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$")

# Errors raised by the transport/run policy are part of every ordinary cloud
# Action's public contract even when an individual handler never raises them
# directly.  Keeping this derivation next to the descriptor prevents a newly
# added Action from silently omitting rate-limit, output-validation,
# idempotency or confirmation failures from capability discovery.
_RUNTIME_ERROR_CODES = (
    "INVALID_INPUT",
    "INVALID_OUTPUT",
    "SCOPE_DENIED",
    "RESOURCE_NOT_FOUND",
    "RESOURCE_CONFLICT",
    "ACTION_UNAVAILABLE",
    "RATE_LIMITED",
    "RUN_CANCELED",
    "INTERNAL_ERROR",
)
_CONFIRMATION_ERROR_CODES = (
    "CONFIRMATION_REQUIRED",
    "CONFIRMATION_INVALID",
    "CONFIRMATION_NOT_FOUND",
    "CONFIRMATION_EXPIRED",
    "CONFIRMATION_MISMATCH",
    "CONFIRMATION_REPLAYED",
)
_DOUYIN_CONNECTOR_ERROR_CODES = (
    "ARGUS_UIFID_MISSING",
    "RISK_CONTROLLED",
    "VERIFICATION_REQUIRED",
    "SESSION_EXPIRED",
    "NETWORK_ERROR",
    "CONNECTOR_ERROR",
)
_VIDEO_ANALYSIS_ERROR_CODES = (
    "QUOTE_EXPIRED",
    "INSUFFICIENT_CREDITS",
    "VIDEO_ANALYSIS_FAILED",
)


@dataclass(frozen=True)
class ProductActionDefinition:
    id: str
    title: str
    description: str
    scopes: tuple[str, ...]
    handler_name: str | None
    input_schema: Mapping[str, Any] = field(default_factory=lambda: {"type": "object", "additionalProperties": False})
    output_schema: Mapping[str, Any] = field(default_factory=lambda: {"type": "object"})
    version: str = "1.0.0"
    risk: tuple[RiskLevel, ...] = (RiskLevel.READ,)
    run_type: RunType = RunType.SYNC
    execution_location: ExecutionLocation = ExecutionLocation.CLOUD
    idempotency: IdempotencyStrategy = IdempotencyStrategy.OPTIONAL
    error_codes: tuple[str, ...] = (
        "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR",
    )
    available: bool = True
    unavailable_reason: str | None = None
    confirmation_required: bool = False
    rate_limit_per_minute: int = 60
    secure_direct: bool = False
    mcp_exposed: bool = True

    def advertised_error_codes(self) -> tuple[str, ...]:
        """Return the complete, stable error surface advertised to clients."""
        codes: list[str] = []

        def extend(values: tuple[str, ...]) -> None:
            for value in values:
                if value not in codes:
                    codes.append(value)

        extend(self.error_codes)
        if self.secure_direct:
            # Secure-direct handlers do not create a generic ProductActionRun,
            # so output validation and run cancellation cannot occur there.
            extend(("INVALID_INPUT", "SCOPE_DENIED", "RATE_LIMITED", "INTERNAL_ERROR"))
        else:
            extend(_RUNTIME_ERROR_CODES)
            if self.idempotency != IdempotencyStrategy.NONE:
                extend(("IDEMPOTENCY_CONFLICT", "RUN_NOT_FOUND"))
            if self.idempotency == IdempotencyStrategy.REQUIRED:
                extend(("IDEMPOTENCY_KEY_REQUIRED",))
        if self.confirmation_required:
            extend(_CONFIRMATION_ERROR_CODES)
        return tuple(codes)

    def descriptor(self) -> ActionDescriptor:
        return ActionDescriptor(
            id=self.id,
            version=self.version,
            title=self.title,
            description=self.description,
            input_schema=dict(self.input_schema),
            output_schema=dict(self.output_schema),
            scopes=list(self.scopes),
            risk=list(self.risk),
            run_type=self.run_type,
            execution_location=self.execution_location,
            idempotency=self.idempotency,
            error_codes=list(self.advertised_error_codes()),
            available=self.available,
            unavailable_reason=self.unavailable_reason,
            secure_direct=self.secure_direct,
            mcp_exposed=self.mcp_exposed,
        )


class ProductActionRegistry:
    def __init__(self, definitions: tuple[ProductActionDefinition, ...]):
        indexed: dict[str, ProductActionDefinition] = {}
        for definition in definitions:
            self._validate(definition)
            if definition.id in indexed:
                raise RuntimeError(f"重复的 Product Action: {definition.id}")
            indexed[definition.id] = definition
        self._definitions = MappingProxyType(indexed)

    @staticmethod
    def _validate(definition: ProductActionDefinition) -> None:
        if not _ACTION_ID.fullmatch(definition.id):
            raise RuntimeError(f"Product Action ID 格式无效: {definition.id}")
        invalid_scopes = set(definition.scopes) - ALL_SCOPE_IDS
        if invalid_scopes:
            raise RuntimeError(f"Product Action scope 无效: {sorted(invalid_scopes)}")
        if definition.id.startswith("admin.") or "admin:" in definition.scopes:
            raise RuntimeError("Product Action Registry 禁止管理端能力")
        if (
            definition.execution_location == ExecutionLocation.CLOUD
            and definition.available
            and not definition.handler_name
            and not definition.secure_direct
        ):
            raise RuntimeError(f"可用云端 Action 缺少处理器: {definition.id}")
        if definition.secure_direct and definition.mcp_exposed:
            raise RuntimeError(f"安全直连 Action 禁止暴露 MCP: {definition.id}")
        if definition.secure_direct and definition.handler_name:
            raise RuntimeError(f"安全直连 Action 不得进入通用 Run 处理器: {definition.id}")
        if RiskLevel.DESTRUCTIVE in definition.risk and not definition.confirmation_required:
            raise RuntimeError(f"破坏性 Action 必须要求一次用户确认: {definition.id}")
        schema = definition.input_schema
        if schema.get("type") != "object":
            raise RuntimeError(f"Action 输入 Schema 必须为 object: {definition.id}")
        if definition.output_schema.get("type") != "object":
            raise RuntimeError(f"Action 输出 Schema 必须为 object: {definition.id}")

    def get(self, action_id: str) -> ProductActionDefinition | None:
        return self._definitions.get(action_id)

    def all(self) -> tuple[ProductActionDefinition, ...]:
        return tuple(self._definitions.values())

    def capabilities(
        self,
        *,
        scopes: set[str] | frozenset[str] | None = None,
        execution_location: ExecutionLocation | None = None,
    ) -> list[ActionDescriptor]:
        rows: list[ActionDescriptor] = []
        for definition in self._definitions.values():
            if execution_location is not None and definition.execution_location != execution_location:
                continue
            if scopes is not None and not set(definition.scopes).issubset(scopes):
                continue
            rows.append(definition.descriptor())
        return rows


def _object(properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": False,
    }


_PAGE = {
    "page": {"type": "integer", "minimum": 1, "maximum": 100000},
    "per_page": {"type": "integer", "minimum": 1, "maximum": 100},
}


def _ask_analysis_output(terminal: str, *, resume: bool = False) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "terminal": {"type": "string", "enum": [terminal]},
        "thread": {"type": "object"},
        "user_message": {"type": "object"},
        "assistant_message": {"type": "object"},
        "video_analysis": {"type": "object"},
    }
    required = list(properties)
    if resume:
        properties["resume"] = {
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
                "events_path": {"type": "string", "minLength": 1, "maxLength": 256},
            },
            "required": ["run_id", "events_path"],
            "additionalProperties": False,
        }
        required.append("resume")
    return _object(properties, required)

_UUID_PATTERN = (
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    "[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


def _read(
    action_id: str,
    title: str,
    description: str,
    scope: str,
    handler: str,
    input_schema: dict[str, Any] | None = None,
    *,
    error_codes: tuple[str, ...] | None = None,
) -> ProductActionDefinition:
    return ProductActionDefinition(
        id=action_id,
        title=title,
        description=description,
        scopes=(scope,),
        handler_name=handler,
        input_schema=input_schema or _object(),
        **({"error_codes": error_codes} if error_codes is not None else {}),
    )


def _unavailable(
    action_id: str,
    title: str,
    description: str,
    scope: str,
    *,
    local: bool = False,
    risk: tuple[RiskLevel, ...] = (RiskLevel.WRITE,),
    input_schema: dict[str, Any] | None = None,
    reason: str,
) -> ProductActionDefinition:
    return ProductActionDefinition(
        id=action_id,
        title=title,
        description=description,
        scopes=(scope,),
        handler_name=None,
        input_schema=input_schema or _object(),
        risk=risk,
        execution_location=ExecutionLocation.LOCAL_WINDOWS if local else ExecutionLocation.CLOUD,
        available=False,
        unavailable_reason=reason,
        confirmation_required=RiskLevel.DESTRUCTIVE in risk,
    )


_CORE_DEFINITIONS: tuple[ProductActionDefinition, ...] = (
    _read("account.me", "读取当前账号", "返回当前用户的公开账号资料，不包含管理员权限字段。", "account:read", "account_me"),
    _read("library.list", "列出视频资料", "分页读取当前用户已经整理的视频资料。", "library:read", "library_list", _object({**_PAGE, "search": {"type": "string", "maxLength": 120}})),
    _read("library.get", "读取视频资料", "读取一条归属于当前用户的资料与文稿。", "library:read", "library_get", _object({"note_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["note_id"])),
    _read("creator.list", "列出博主", "读取当前用户保存的博主来源。", "creator:read", "creator_list"),
    _read("creator.get", "读取博主", "读取一个博主及作品概览。", "creator:read", "creator_get", _object({"source_id": {"type": "string", "maxLength": 64}}, ["source_id"])),
    _read("creator.runs.list", "列出博主同步", "读取当前用户的博主同步运行。", "creator:read", "creator_runs_list", _object({"status": {"type": "string", "maxLength": 24}})),
    _read("creator.resolve", "解析博主", "解析用户明确提供的公开博主主页，不保存来源。", "creator:read", "creator_resolve", _object({
        "platform": {"type": "string", "enum": ["douyin", "bilibili", "xiaohongshu"]},
        "profile_ref": {"type": "string", "minLength": 1, "maxLength": 1000},
    }, ["platform", "profile_ref"])),
    _read("creator.items.list", "列出博主作品", "分页读取一个已保存博主的公开作品目录。", "creator:read", "creator_items_list", _object({
        "source_id": {"type": "string", "minLength": 1, "maxLength": 64},
        **_PAGE,
        "search": {"type": "string", "maxLength": 100},
        "status": {"type": "string", "enum": ["all", "untranscribed", "imported", "failed"]},
    }, ["source_id"])),
    _read("creator.sync.get", "读取博主同步", "读取一个归属于当前用户的博主同步任务。", "creator:read", "creator_sync_get", _object({
        "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
    }, ["run_id"])),
    _read(
        "creator.sync.items.list",
        "列出博主同步明细",
        "分页读取一个归属于当前用户的博主同步任务逐项状态与失败明细。",
        "creator:read",
        "creator_sync_items_list",
        _object({
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "page": {"type": "integer", "minimum": 1, "maximum": 100000},
            "per_page": {"type": "integer", "minimum": 1, "maximum": 50},
            "status": {
                "type": "string",
                "enum": ["all", "pending", "succeeded", "failed"],
            },
        }, ["run_id"]),
    ),
    ProductActionDefinition(
        id="creator.create", title="保存博主", description="解析并保存用户明确提供的公开博主主页。",
        scopes=("creator:sync",), handler_name="creator_create",
        input_schema=_object({
            "platform": {"type": "string", "enum": ["douyin", "bilibili", "xiaohongshu"]},
            "profile_ref": {"type": "string", "minLength": 1, "maxLength": 1000},
        }, ["platform", "profile_ref"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="creator.sync.start", title="同步博主作品",
        description="由用户或 Agent 明确发起一次近期、目录或所选作品任务；不会自动连续风控重试。",
        scopes=("creator:sync",), handler_name="creator_sync_start",
        input_schema=_object({
            "source_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "operation": {"type": "string", "enum": ["recent_transcript", "catalog_all", "selected_transcript"]},
            "limit": {"type": ["integer", "null"], "enum": [20, 50, 100, None]},
            "item_ids": {"type": "array", "maxItems": 50, "items": {"type": "string", "maxLength": 64}},
        }, ["source_id"]), risk=(RiskLevel.WRITE,), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=6,
    ),
    ProductActionDefinition(
        id="creator.sync.retry", title="重试博主同步",
        description="由用户明确重试一次失败或取消的博主同步，不进行循环重试。",
        scopes=("creator:sync",), handler_name="creator_sync_retry",
        input_schema=_object({"run_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["run_id"]),
        risk=(RiskLevel.WRITE,), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=6,
    ),
    ProductActionDefinition(
        id="creator.sync.cancel", title="取消博主同步", description="取消当前用户正在运行的博主同步。",
        scopes=("creator:sync",), handler_name="creator_sync_cancel",
        input_schema=_object({"run_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["run_id"]),
        risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="creator.remove", title="移除博主", description="停止展示一个已保存博主；已有资料不会被删除。",
        scopes=("creator:sync",), handler_name="creator_remove",
        input_schema=_object({"source_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["source_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    _read("ask.thread.list", "列出 AI 会话", "读取当前用户的知萃 AI 会话。", "ask:read", "ask_thread_list", _object({"limit": {"type": "integer", "minimum": 1, "maximum": 100}})),
    _read("ask.thread.get", "读取 AI 会话", "读取一个当前用户会话及消息。", "ask:read", "ask_thread_get", _object({"thread_id": {"type": "string", "maxLength": 64}}, ["thread_id"])),
    _read("knowledge.list", "列出知识", "分页读取知识页或待整理内容。", "knowledge:read", "knowledge_list", _object({**_PAGE, "view": {"type": "string", "enum": ["pages", "inbox"]}, "search": {"type": "string", "maxLength": 120}})),
    _read("knowledge.get", "读取知识页", "读取一个归属于当前用户的知识页。", "knowledge:read", "knowledge_get", _object({"entry_id": {"type": "string", "maxLength": 64}}, ["entry_id"])),
    _read("plan.list", "列出计划", "分页读取当前用户的行动计划。", "plan:read", "plan_list", _object(_PAGE)),
    _read("plan.get", "读取计划", "读取一个归属于当前用户的计划。", "plan:read", "plan_get", _object({"plan_id": {"type": "string", "maxLength": 64}}, ["plan_id"])),
    _read("plan.overview", "读取计划概览", "读取今天、逾期、即将开始与焦点任务。", "plan:read", "plan_overview", _object({"date": {"type": "string", "format": "date"}})),
    _read("automation.list", "列出自动摘要", "读取当前用户的自动摘要配置。", "automation:read", "automation_list"),
    _read("automation.get", "读取自动摘要", "读取一条自动摘要配置。", "automation:read", "automation_get", _object({"automation_id": {"type": "string", "maxLength": 64}}, ["automation_id"])),
    _read("models.list", "列出回答模型", "读取可用平台模型及当前用户额度。", "models:read", "models_list"),
    _read("models.settings.get", "读取模型设置", "读取脱敏后的回答模型设置，不返回 API Key。", "models:read", "models_settings_get"),
    _read("analysis.catalog", "读取详细解析方案", "读取已发布的详细解析方案、报价和当前用户额度。", "analysis:read", "analysis_catalog", _object({"trigger": {"type": "string", "enum": ["manual", "batch", "agent"]}})),
    _read("analysis.runs.list", "列出详细解析", "分页读取当前用户的详细解析运行。", "analysis:read", "analysis_runs_list", _object({**_PAGE, "status": {"type": "string", "maxLength": 32}})),
    _read("feedback.list", "列出我的反馈", "分页读取当前用户提交的反馈。", "feedback:read", "feedback_list", _object(_PAGE)),
    ProductActionDefinition(
        id="feedback.submit", title="提交反馈", description="提交一条普通用户产品反馈。",
        scopes=("feedback:write",), handler_name="feedback_submit",
        input_schema=_object({
            "category": {"type": "string", "enum": ["bug", "suggestion", "content", "account", "other"]},
            "subject": {"type": "string", "minLength": 2, "maxLength": 160},
            "content": {"type": "string", "minLength": 5, "maxLength": 2000},
            "page_path": {"type": "string", "maxLength": 512},
        }, ["category", "subject", "content"]),
        risk=(RiskLevel.WRITE,), rate_limit_per_minute=6,
    ),
    ProductActionDefinition(
        id="knowledge.create", title="创建知识页", description="在当前用户知识库中创建一页。",
        scopes=("knowledge:write",), handler_name="knowledge_create",
        input_schema=_object({
            "title": {"type": "string", "minLength": 1, "maxLength": 256},
            "summary": {"type": "string", "maxLength": 4000},
            "content": {"type": "string", "minLength": 1, "maxLength": 100000},
            "source_label": {"type": "string", "maxLength": 256},
        }, ["title", "content"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="knowledge.update", title="更新知识页", description="更新当前用户的一页知识。",
        scopes=("knowledge:write",), handler_name="knowledge_update",
        input_schema=_object({
            "entry_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "title": {"type": "string", "minLength": 1, "maxLength": 256},
            "summary": {"type": "string", "maxLength": 4000},
            "content": {"type": "string", "minLength": 1, "maxLength": 100000},
            "source_label": {"type": "string", "maxLength": 256},
        }, ["entry_id"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="knowledge.remove", title="删除知识页", description="删除当前用户的一页知识。",
        scopes=("knowledge:write",), handler_name="knowledge_remove",
        input_schema=_object({"entry_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["entry_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    ProductActionDefinition(
        id="plan.task.add", title="新增计划任务", description="向当前用户的一项计划新增任务。",
        scopes=("plan:write",), handler_name="plan_task_add",
        input_schema=_object({
            "plan_id": {"type": "string", "maxLength": 64},
            "title": {"type": "string", "minLength": 1, "maxLength": 500},
            "day": {"type": "integer", "minimum": 1, "maximum": 3650},
            "scheduled_at": {"type": ["string", "null"], "maxLength": 40},
            "priority": {"type": "string", "enum": ["high", "medium", "low"]},
        }, ["plan_id", "title"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="plan.update", title="更新计划", description="更新当前用户计划的标题、日期或状态。",
        scopes=("plan:write",), handler_name="plan_update",
        input_schema=_object({
            "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "title": {"type": "string", "minLength": 1, "maxLength": 500},
            "status": {"type": "string", "enum": ["active", "done"]},
            "start_date": {"type": ["string", "null"], "maxLength": 10},
            "total_days": {"type": "integer", "minimum": 1, "maximum": 3650},
        }, ["plan_id"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="plan.remove", title="删除计划", description="删除当前用户的一项计划。",
        scopes=("plan:write",), handler_name="plan_remove",
        input_schema=_object({"plan_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["plan_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    ProductActionDefinition(
        id="plan.task.update", title="更新计划任务", description="更新当前用户计划中的一条任务。",
        scopes=("plan:write",), handler_name="plan_task_update",
        input_schema=_object({
            "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "task_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "title": {"type": "string", "minLength": 1, "maxLength": 500},
            "day": {"type": "integer", "minimum": 1, "maximum": 3650},
            "scheduled_at": {"type": ["string", "null"], "maxLength": 40},
            "reminder_at": {"type": ["string", "null"], "maxLength": 40},
            "duration_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 1440},
            "frequency": {"type": ["string", "null"], "maxLength": 32},
            "priority": {"type": "string", "enum": ["high", "medium", "low"]},
        }, ["plan_id", "task_id"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="plan.task.remove", title="删除计划任务", description="删除当前用户计划中的一条任务。",
        scopes=("plan:write",), handler_name="plan_task_remove",
        input_schema=_object({
            "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "task_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["plan_id", "task_id"]), risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    ProductActionDefinition(
        id="library.import_link", title="导入分享链接",
        description="解析并导入用户明确提供的一条 B站或小红书链接；抖音账号采集仍由 Windows 客户端执行。",
        scopes=("library:write",), handler_name="library_import_link",
        input_schema=_object({
            "url": {"type": "string", "minLength": 1, "maxLength": 2000},
            "source_mode": {"type": "string", "enum": ["collect", "like", "post", "import"]},
        }, ["url"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4,
        error_codes=("LINK_IMPORT_FAILED",),
    ),
    ProductActionDefinition(
        id="library.remove", title="删除资料",
        description="永久删除当前用户选定的视频资料，并保留防止下次同步静默恢复的移除记录。",
        scopes=("library:write",), handler_name="library_remove",
        input_schema=_object({
            "note_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["note_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    ProductActionDefinition(
        id="library.remove_many", title="批量删除资料",
        description="永久删除当前用户选定的 1 至 50 条视频资料，并保留防止后续同步静默恢复的移除记录。",
        scopes=("library:write",), handler_name="library_remove_many",
        input_schema=_object({
            "note_ids": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                    "type": "string",
                    "pattern": _UUID_PATTERN,
                },
            },
        }, ["note_ids"]),
        output_schema=_object({
            "deleted": {"type": "integer", "minimum": 0, "maximum": 50},
            "deleted_ids": {
                "type": "array", "maxItems": 50,
                "items": {"type": "string", "pattern": _UUID_PATTERN},
            },
            "missing_ids": {
                "type": "array", "maxItems": 50,
                "items": {"type": "string", "pattern": _UUID_PATTERN},
            },
            "permanent": {"type": "boolean"},
        }, ["deleted", "deleted_ids", "missing_ids", "permanent"]),
        risk=(RiskLevel.DESTRUCTIVE,),
        confirmation_required=True,
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "CONFIRMATION_REQUIRED",
            "CONFIRMATION_INVALID", "CONFIRMATION_REPLAYED",
            "IDEMPOTENCY_KEY_REQUIRED", "IDEMPOTENCY_CONFLICT",
        ),
    ),
    _read("ask.sources.list", "列出问答资料", "列出可用于多视频问答的当前用户资料。", "ask:read", "ask_sources_list", _object({
        "scope": {"type": "string", "enum": ["all", "all_ready", "yesterday", "yesterday_new", "collect", "like", "post"]},
        "search": {"type": "string", "maxLength": 80},
        "timezone": {"type": "string", "maxLength": 64},
        "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
        "include_ids": {"type": "array", "maxItems": 100, "items": {"type": "string", "maxLength": 64}},
    })),
    ProductActionDefinition(
        id="ask.starter_questions",
        title="生成推荐问题",
        description="基于当前用户明确选择的文稿范围生成可直接提问的推荐问题。",
        scopes=("ask:read",),
        handler_name="ask_starter_questions",
        input_schema=_object({
            "source_scope": {
                "type": "string",
                "enum": [
                    "all", "all_ready", "yesterday", "yesterday_new",
                    "collect", "like", "post", "selected",
                ],
            },
            "source_ids": {
                "type": "array",
                "maxItems": 100,
                "items": {"type": "string", "minLength": 1, "maxLength": 64},
            },
            "timezone": {"type": "string", "maxLength": 64},
        }),
        risk=(RiskLevel.READ,),
        rate_limit_per_minute=12,
    ),
    _read("ask.sources.search", "搜索问答资料", "按标题和文稿搜索当前用户资料。", "ask:read", "ask_sources_search", _object({
        "query": {"type": "string", "minLength": 2, "maxLength": 200},
        "scope": {"type": "string", "enum": ["all", "all_ready", "yesterday", "yesterday_new", "collect", "like", "post"]},
        "timezone": {"type": "string", "maxLength": 64},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
    }, ["query"])),
    ProductActionDefinition(
        id="ask.thread.create", title="创建 AI 会话",
        description="使用当前用户明确选择的资料创建知萃 AI 会话。",
        scopes=("ask:run",), handler_name="ask_thread_create",
        input_schema=_object({
            "title": {"type": "string", "maxLength": 256},
            "source_scope": {"type": "string", "enum": ["all", "all_ready", "yesterday", "yesterday_new", "collect", "like", "post", "selected"]},
            "source_ids": {"type": "array", "maxItems": 100, "items": {"type": "string", "maxLength": 64}},
            "timezone": {"type": "string", "maxLength": 64},
            "context_type": {"type": "string", "enum": ["video", "plan"]},
            "context_id": {"type": ["string", "null"], "maxLength": 64},
        }), risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="ask.thread.update", title="修改 AI 会话", description="修改当前用户会话标题。",
        scopes=("ask:run",), handler_name="ask_thread_update",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "title": {"type": "string", "minLength": 1, "maxLength": 256},
        }, ["thread_id", "title"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="ask.thread.remove", title="删除 AI 会话", description="删除当前用户的一条会话。",
        scopes=("ask:run",), handler_name="ask_thread_remove",
        input_schema=_object({"thread_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["thread_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "RESOURCE_CONFLICT", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    ProductActionDefinition(
        id="ask.turn.start", title="向视频提问",
        description="基于当前用户已创建的会话启动持久问答；沿用现有额度与计费门槛。",
        scopes=("ask:run",), handler_name="ask_turn_start",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "client_turn_id": {"type": "string", "minLength": 1, "maxLength": 80},
            "question": {"type": "string", "minLength": 1, "maxLength": 600},
            "research_mode": {"type": "string", "enum": ["auto", "fast", "deep"]},
            "output_style": {"type": "string", "maxLength": 24},
            "custom_instruction": {"type": "string", "maxLength": 600},
            "web_scope": {"type": "string", "enum": ["video_only", "auto"]},
        }, ["thread_id", "client_turn_id", "question"]),
        risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=10,
    ),
    _read("ask.turn.get", "读取问答运行", "读取一个归属于当前用户的持久 Agent Turn。", "ask:read", "ask_turn_get", _object({
        "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
        "turn_id": {"type": "string", "minLength": 1, "maxLength": 64},
    }, ["thread_id", "turn_id"])),
    _read("ask.turn.events", "读取问答事件", "从指定序号续读一个持久 Agent Turn 的单调事件。", "ask:read", "ask_turn_events", _object({
        "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
        "turn_id": {"type": "string", "minLength": 1, "maxLength": 64},
        "after": {"type": "integer", "minimum": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 500},
    }, ["thread_id", "turn_id"])),
    ProductActionDefinition(
        id="ask.turn.cancel", title="取消问答", description="停止一个当前用户正在运行的问答。",
        scopes=("ask:run",), handler_name="ask_turn_cancel",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "turn_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["thread_id", "turn_id"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="ask.turn.retry", title="重试问答", description="明确重试一个失败或取消的问答。",
        scopes=("ask:run",), handler_name="ask_turn_retry",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "turn_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["thread_id", "turn_id"]), risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,),
        run_type=RunType.LONG_TASK, idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=("RESOURCE_CONFLICT",),
    ),
    ProductActionDefinition(
        id="ask.analysis.approve", title="确认问答详细解析",
        description="确认当前问答中的详细解析报价；完成一次普通确认后才会预留额度并继续原问题。",
        scopes=("ask:run", "analysis:run"), handler_name="ask_analysis_approve",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["thread_id", "run_id"]),
        output_schema=_ask_analysis_output("analysis_started", resume=True),
        risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,),
        run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED,
        confirmation_required=True,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RESOURCE_CONFLICT", "CONFIRMATION_REQUIRED",
            "CONFIRMATION_INVALID", *_VIDEO_ANALYSIS_ERROR_CODES,
        ),
        rate_limit_per_minute=10,
    ),
    ProductActionDefinition(
        id="ask.analysis.text_only", title="仅按文稿继续回答",
        description="取消当前问答的画面解析，明确改用已有文稿和摘要继续回答原问题。",
        scopes=("ask:run", "analysis:run"), handler_name="ask_analysis_text_only",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["thread_id", "run_id"]),
        output_schema=_ask_analysis_output("done"),
        risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,),
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RESOURCE_CONFLICT", "VIDEO_ANALYSIS_FAILED",
        ),
        rate_limit_per_minute=10,
    ),
    ProductActionDefinition(
        id="ask.analysis.cancel", title="取消本次详细解析提问",
        description="取消当前问答的详细解析审批并将会话恢复为可继续提问状态。",
        scopes=("ask:run", "analysis:run"), handler_name="ask_analysis_cancel",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["thread_id", "run_id"]),
        output_schema=_ask_analysis_output("cancelled"),
        risk=(RiskLevel.WRITE,),
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RESOURCE_CONFLICT", "VIDEO_ANALYSIS_FAILED",
        ),
        rate_limit_per_minute=10,
    ),
    ProductActionDefinition(
        id="ask.analysis.reprepare", title="重新生成问答解析报价",
        description="取消失效报价并为同一问答重新准备详细解析，随后等待用户重新确认。",
        scopes=("ask:run", "analysis:run"), handler_name="ask_analysis_reprepare",
        input_schema=_object({
            "thread_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "offering_id": {"type": ["string", "null"], "maxLength": 64},
            "use_byok": {"type": "boolean"},
        }, ["thread_id", "run_id"]),
        output_schema=_ask_analysis_output("approval_required", resume=True),
        risk=(RiskLevel.WRITE,),
        run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RESOURCE_CONFLICT", *_VIDEO_ANALYSIS_ERROR_CODES,
        ),
        rate_limit_per_minute=10,
    ),
    _read("automation.status", "读取自动摘要状态", "读取自动摘要运行器与当前账号邮箱验证状态。", "automation:read", "automation_status"),
    ProductActionDefinition(
        id="automation.create", title="创建自动摘要", description="创建一个用户明确配置的每日摘要。",
        scopes=("automation:write",), handler_name="automation_create",
        input_schema=_object({
            "name": {"type": "string", "minLength": 1, "maxLength": 160},
            "enabled": {"type": "boolean"},
            "schedule_time": {"type": "string", "minLength": 5, "maxLength": 5},
            "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
            "source_scope": {"type": "string", "enum": ["yesterday", "yesterday_new"]},
            "source_mode": {"type": "string", "enum": ["all", "collect", "like", "post"]},
            "instruction": {"type": "string", "minLength": 1, "maxLength": 2000},
            "recipient_email": {"type": "string", "maxLength": 256},
        }), risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="automation.update", title="更新自动摘要", description="更新当前用户自动摘要。",
        scopes=("automation:write",), handler_name="automation_update",
        input_schema=_object({
            "automation_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "name": {"type": "string", "minLength": 1, "maxLength": 160},
            "enabled": {"type": "boolean"},
            "schedule_time": {"type": "string", "minLength": 5, "maxLength": 5},
            "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
            "source_scope": {"type": "string", "enum": ["yesterday", "yesterday_new"]},
            "source_mode": {"type": "string", "enum": ["all", "collect", "like", "post"]},
            "instruction": {"type": "string", "minLength": 1, "maxLength": 2000},
            "recipient_email": {"type": "string", "maxLength": 256},
        }, ["automation_id"]), risk=(RiskLevel.WRITE,),
    ),
    ProductActionDefinition(
        id="automation.remove", title="删除自动摘要", description="停止并软删除当前用户自动摘要，保留运行审计。",
        scopes=("automation:write",), handler_name="automation_remove",
        input_schema=_object({"automation_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["automation_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        error_codes=("INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID"),
    ),
    _read("automation.runs.list", "读取自动摘要运行", "读取当前用户一项自动摘要的运行记录。", "automation:read", "automation_runs_list", _object({
        "automation_id": {"type": "string", "minLength": 1, "maxLength": 64},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
    }, ["automation_id"])),
    ProductActionDefinition(
        id="automation.run", title="运行自动摘要",
        description="手动生成一次摘要预览；Agent 调用永远不会发送邮件。",
        scopes=("automation:write",), handler_name="automation_run",
        input_schema=_object({"automation_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["automation_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=5,
        error_codes=("AUTOMATION_RUN_FAILED",),
    ),
    ProductActionDefinition(
        id="analysis.run.prepare", title="准备详细解析",
        description="为 1–50 条当前用户资料创建时效报价；准备阶段不扣费、不自动确认。",
        scopes=("analysis:run",), handler_name="analysis_run_prepare",
        input_schema=_object({
            "note_ids": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "string", "maxLength": 64}},
            "offering_id": {"type": ["string", "null"], "maxLength": 64},
            "use_byok": {"type": "boolean"},
            "trigger": {"type": "string", "enum": ["manual", "batch"]},
        }, ["note_ids"]), risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,),
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=6,
        error_codes=_VIDEO_ANALYSIS_ERROR_CODES,
    ),
    ProductActionDefinition(
        id="analysis.run.confirm", title="确认详细解析",
        description="在用户查看报价并完成一次普通确认后预留额度并开始详细解析。",
        scopes=("analysis:run",), handler_name="analysis_run_confirm",
        input_schema=_object({"run_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["run_id"]),
        risk=(RiskLevel.WRITE, RiskLevel.BILLABLE,), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED, confirmation_required=True,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
            *_VIDEO_ANALYSIS_ERROR_CODES,
        ),
    ),
    _read("analysis.run.get", "读取详细解析", "读取当前用户一条详细解析运行与项目状态。", "analysis:read", "analysis_run_get", _object({
        "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
    }, ["run_id"])),
    ProductActionDefinition(
        id="analysis.run.cancel", title="取消详细解析", description="取消当前用户详细解析运行并释放尚未使用的预留额度。",
        scopes=("analysis:run",), handler_name="analysis_run_cancel",
        input_schema=_object({"run_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["run_id"]),
        risk=(RiskLevel.WRITE,),
        error_codes=_VIDEO_ANALYSIS_ERROR_CODES,
    ),
    _read("analysis.account.get", "读取解析额度", "读取当前用户详细解析额度和最近流水。", "analysis:read", "analysis_account_get"),
    _read(
        "library.sync.status", "读取平台同步状态",
        "读取安全的平台连接或指定单次同步任务状态，不返回会话、Cookie 或本机地址。",
        "library:read", "library_sync_status",
        _object({"job_id": {"type": "string", "minLength": 1, "maxLength": 64}}),
        error_codes=_DOUYIN_CONNECTOR_ERROR_CODES,
    ),
    ProductActionDefinition(
        id="library.sync.start", title="同步喜欢收藏作品",
        description="明确发起一次手动抖音来源同步；不会自动同步、离线排队或连续风控重试。",
        scopes=("library:write",), handler_name="library_sync_start",
        input_schema=_object({
            "mode": {"type": "string", "enum": ["like", "collect", "post"]},
            "count": {"type": "integer", "minimum": 1, "maximum": 100},
        }, ["mode"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4,
        error_codes=_DOUYIN_CONNECTOR_ERROR_CODES,
    ),
    ProductActionDefinition(
        id="library.transcript.generate", title="生成完整文稿",
        description="为当前用户的一条已同步抖音资料生成文稿或完成后续整理；不接收临时媒体地址。",
        scopes=("library:write",), handler_name="library_transcript_generate",
        input_schema=_object({
            "aweme_id": {
                "type": "string", "minLength": 1, "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$",
            },
            "operation": {"type": "string", "enum": ["transcript", "ai", "full"]},
        }, ["aweme_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4,
        error_codes=("TRANSCRIPT_GENERATION_FAILED", *_DOUYIN_CONNECTOR_ERROR_CODES),
    ),
    _read(
        "library.hidden.list", "读取已隐藏资料",
        "读取当前用户永久隐藏的抖音作品标识，不返回临时封面或媒体地址。",
        "library:read", "library_hidden_list",
        _object({"limit": {"type": "integer", "minimum": 1, "maximum": 1000}}),
    ),
    ProductActionDefinition(
        id="library.hidden.restore", title="恢复隐藏资料",
        description="恢复当前用户明确选择的永久隐藏抖音资料。",
        scopes=("library:write",), handler_name="library_hidden_restore",
        input_schema=_object({
            "aweme_ids": {
                "type": "array", "minItems": 1, "maxItems": 50,
                "items": {
                    "type": "string", "minLength": 1, "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$",
                },
            },
        }, ["aweme_ids"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="library.visual.ask", title="询问视频画面",
        description="基于一条当前用户已同步作品的临时画面证据回答问题；画面与媒体地址不会写入输出。",
        scopes=("ask:run",), handler_name="library_visual_ask",
        input_schema=_object({
            "aweme_id": {
                "type": "string", "minLength": 1, "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$",
            },
            "question": {"type": "string", "minLength": 1, "maxLength": 600},
            "history": {
                "type": "array", "maxItems": 6,
                "items": _object({
                    "role": {"type": "string", "enum": ["user", "assistant"]},
                    "content": {"type": "string", "minLength": 1, "maxLength": 1000},
                }, ["role", "content"]),
            },
        }, ["aweme_id", "question"]),
        # This is the existing lightweight visual-question path, not the
        # quoted detailed-analysis product. It performs no user billing.
        risk=(RiskLevel.WRITE,),
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=4,
        error_codes=("VISUAL_ASK_FAILED", *_DOUYIN_CONNECTOR_ERROR_CODES),
    ),
    _read(
        "knowledge.candidate.list", "读取待整理知识",
        "读取当前用户一条视频资料的知识候选。",
        "knowledge:read", "knowledge_candidate_list",
        _object({"note_id": {"type": "string", "minLength": 1, "maxLength": 64}}, ["note_id"]),
    ),
    ProductActionDefinition(
        id="knowledge.candidate.save", title="保存知识候选",
        description="将当前用户一条视频候选保存为知识页。",
        scopes=("knowledge:write",), handler_name="knowledge_candidate_save",
        input_schema=_object({
            "note_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["note_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="plan.create", title="创建计划", description="为当前用户创建一项手动行动计划。",
        scopes=("plan:write",), handler_name="plan_create",
        input_schema=_object({
            "title": {"type": "string", "minLength": 1, "maxLength": 256},
            "start_date": {"type": ["string", "null"], "maxLength": 10},
            "total_days": {"type": "integer", "minimum": 0, "maximum": 3650},
            "first_task": {
                "type": ["object", "null"],
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 256},
                    "day": {"type": "integer", "minimum": 1, "maximum": 3650},
                    "scheduled_at": {"type": ["string", "null"], "maxLength": 40},
                    "reminder_at": {"type": ["string", "null"], "maxLength": 40},
                    "duration_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 10080},
                    "frequency": {"type": ["string", "null"], "maxLength": 120},
                    "priority": {"type": "string", "enum": ["low", "medium", "high"]},
                },
                "required": ["title"], "additionalProperties": False,
            },
        }, ["title"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="plan.from_library.generate",
        title="从资料生成计划",
        description="基于当前用户的一条视频资料生成行动计划；已有同源计划时安全修订并保留已完成任务。",
        scopes=("plan:write",),
        handler_name="plan_from_library_generate",
        input_schema=_object({
            "note_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "instruction": {"type": "string", "minLength": 2, "maxLength": 1000},
        }, ["note_id", "instruction"]),
        risk=(RiskLevel.WRITE,),
        idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RATE_LIMITED", "MODEL_UNAVAILABLE", "INTERNAL_ERROR",
        ),
    ),
    ProductActionDefinition(
        id="plan.focus.replace", title="安排今日重点",
        description="原子替换当前用户指定日期最多三项重点任务。",
        scopes=("plan:write",), handler_name="plan_focus_replace",
        input_schema=_object({
            "date": {"type": "string", "minLength": 10, "maxLength": 10},
            "tasks": {
                "type": "array", "maxItems": 3,
                "items": _object({
                    "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
                    "task_id": {"type": "string", "minLength": 1, "maxLength": 96},
                }, ["plan_id", "task_id"]),
            },
        }, ["date", "tasks"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    _read(
        "plan.review", "读取计划复盘", "读取当前用户一周真实排期与完成记录的复盘。",
        "plan:read", "plan_review",
        _object({"week_start": {"type": ["string", "null"], "maxLength": 10}}),
    ),
    ProductActionDefinition(
        id="plan.task.reorder", title="调整任务顺序",
        description="以完整任务标识列表调整当前用户计划中的任务顺序。",
        scopes=("plan:write",), handler_name="plan_task_reorder",
        input_schema=_object({
            "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "task_ids": {
                "type": "array", "maxItems": 2000,
                "items": {"type": "string", "minLength": 1, "maxLength": 96},
            },
        }, ["plan_id", "task_ids"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="plan.coach.preview", title="预览 AI 调整",
        description="通过知萃 AI 持久 Turn 为当前用户计划生成不写入的调整预览，复用当前模型与计费规则。",
        scopes=("plan:write",), handler_name="plan_coach_preview",
        input_schema=_object({
            "plan_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "instruction": {"type": "string", "minLength": 2, "maxLength": 600},
        }, ["plan_id", "instruction"]),
        risk=(RiskLevel.WRITE, RiskLevel.BILLABLE), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=4,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RATE_LIMITED", "INSUFFICIENT_CREDITS", "MODEL_UNAVAILABLE",
            "INTERNAL_ERROR",
        ),
    ),
    ProductActionDefinition(
        id="plan.coach.apply", title="应用 AI 调整",
        description="经一次用户确认后，应用当前用户计划会话中已持久化且版本未变化的调整预览。",
        scopes=("plan:write",), handler_name="plan_coach_apply",
        input_schema=_object({
            "preview_message_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["preview_message_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        confirmation_required=True,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RESOURCE_CONFLICT", "CONFIRMATION_REQUIRED",
            "CONFIRMATION_INVALID", "INTERNAL_ERROR",
        ),
    ),
    _read(
        "account.email.status", "读取邮箱验证状态",
        "读取当前账号邮箱验证和邮件投递公共状态。",
        "account:read", "account_email_status",
    ),
    ProductActionDefinition(
        id="account.email.send", title="发送邮箱验证",
        description="向当前账号邮箱发送一封验证邮件，受服务端冷却与调用限流保护。",
        scopes=("account:manage",), handler_name="account_email_send",
        input_schema=_object(), risk=(RiskLevel.WRITE,),
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=2,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RATE_LIMITED",
            "EMAIL_DELIVERY_UNAVAILABLE", "EMAIL_DELIVERY_FAILED",
            "INTERNAL_ERROR",
        ),
    ),
    ProductActionDefinition(
        id="account.email.confirm", title="确认邮箱验证",
        description="使用当前账号收到的一次性验证令牌确认邮箱。",
        scopes=("account:manage",), handler_name="account_email_confirm",
        input_schema=_object({
            "token": {"type": "string", "minLength": 1, "maxLength": 4096},
        }, ["token"]),
        risk=(RiskLevel.SENSITIVE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4, mcp_exposed=False,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "RATE_LIMITED", "EMAIL_VERIFICATION_INVALID", "INTERNAL_ERROR",
        ),
    ),
    _read(
        "account.consents", "读取协议记录",
        "读取当前账号已接受的协议和版本记录。",
        "account:read", "account_consents",
    ),
    ProductActionDefinition(
        id="analysis.run.remove", title="移除详细解析记录",
        description="取消当前用户的解析并释放未使用额度；保留必要的计费审计记录。",
        scopes=("analysis:run",), handler_name="analysis_run_remove",
        input_schema=_object({
            "run_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["run_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
            *_VIDEO_ANALYSIS_ERROR_CODES,
        ),
    ),
    _read(
        "models.selection.get", "读取模型选择",
        "读取当前用户选中的平台或自定义模型，不返回 API Key。",
        "models:read", "models_selection_get",
    ),
    ProductActionDefinition(
        id="models.selection.set", title="选择回答模型",
        description="选择一个已发布的平台模型或当前用户已有的自定义模型。",
        scopes=("models:write",), handler_name="models_selection_set",
        input_schema=_object({
            "kind": {"type": "string", "enum": ["platform", "custom"]},
            "offering_id": {"type": ["string", "null"], "maxLength": 64},
            "model_id": {"type": ["string", "null"], "maxLength": 64},
        }, ["kind"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    _read(
        "models.custom.list", "列出自定义模型",
        "读取当前用户脱敏后的自定义模型列表。",
        "models:read", "models_custom_list",
    ),
    ProductActionDefinition(
        id="models.custom.update", title="更新自定义模型元数据",
        description="更新已有自定义模型的名称、模型标识或启用状态；不接收 API Key 或 API Base。",
        scopes=("models:write",), handler_name="models_custom_update",
        input_schema=_object({
            "model_id": {"type": "string", "minLength": 1, "maxLength": 64},
            "name": {"type": "string", "minLength": 1, "maxLength": 80},
            "provider_name": {"type": "string", "minLength": 1, "maxLength": 80},
            "model": {"type": "string", "minLength": 1, "maxLength": 160},
            "enabled": {"type": "boolean"},
        }, ["model_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
    ),
    ProductActionDefinition(
        id="models.custom.remove", title="删除自定义模型",
        description="经一次用户确认后删除当前用户已有的自定义模型及其加密密钥。",
        scopes=("models:write",), handler_name="models_custom_remove",
        input_schema=_object({
            "model_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["model_id"]),
        risk=(RiskLevel.DESTRUCTIVE,), confirmation_required=True,
        idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
        ),
    ),
    ProductActionDefinition(
        id="models.custom.test", title="测试自定义模型",
        description="测试当前用户已有自定义模型的连接，不返回或修改 API Key。",
        scopes=("models:write",), handler_name="models_custom_test",
        input_schema=_object({
            "model_id": {"type": "string", "minLength": 1, "maxLength": 64},
        }, ["model_id"]),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        rate_limit_per_minute=4,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "UNSAFE_API_BASE", "MODEL_CONNECTION_FAILED", "RATE_LIMITED",
            "INTERNAL_ERROR",
        ),
    ),
    _read(
        "models.vision.get", "读取视觉模型",
        "读取当前用户脱敏后的视频画面识别设置。",
        "models:read", "models_vision_get",
    ),
    ProductActionDefinition(
        id="models.vision.update", title="更新视觉模型元数据",
        description="更新已有视觉模型的供应商名、模型标识或启用状态；不接收 API Key、API Base 或驱动。",
        scopes=("models:write",), handler_name="models_vision_update",
        input_schema=_object({
            "provider_name": {"type": "string", "minLength": 1, "maxLength": 80},
            "model": {"type": "string", "minLength": 1, "maxLength": 160},
            "enabled": {"type": "boolean"},
        }),
        risk=(RiskLevel.WRITE,), idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "SECURE_INPUT_REQUIRED",
            "VISION_CONFIG_FAILED", "INTERNAL_ERROR",
        ),
    ),
    ProductActionDefinition(
        id="models.vision.remove", title="删除视觉模型",
        description="经一次用户确认后删除当前用户视觉模型配置及其加密密钥。",
        scopes=("models:write",), handler_name="models_vision_remove",
        input_schema=_object(), risk=(RiskLevel.DESTRUCTIVE,),
        confirmation_required=True, idempotency=IdempotencyStrategy.REQUIRED,
        error_codes=(
            "INVALID_INPUT", "SCOPE_DENIED", "RESOURCE_NOT_FOUND",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
        ),
    ),
    ProductActionDefinition(
        id="models.vision.test", title="测试视觉模型",
        description="测试当前用户已有视觉模型连接，不返回或修改 API Key。",
        scopes=("models:write",), handler_name="models_vision_test",
        input_schema=_object(), risk=(RiskLevel.WRITE,),
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=4,
    ),
    ProductActionDefinition(
        id="library.transcript.batch", title="批量生成文稿",
        description="为用户明确选择的 1–100 条抖音资料生成完整文稿；任务持久化且不会自动重试风控失败。",
        scopes=("library:write",), handler_name="library_transcript_batch",
        input_schema=_object({
            "aweme_ids": {
                "type": "array", "minItems": 1, "maxItems": 100,
                "items": {"type": "string", "minLength": 1, "maxLength": 128},
            },
        }, ["aweme_ids"]),
        risk=(RiskLevel.WRITE,), run_type=RunType.LONG_TASK,
        idempotency=IdempotencyStrategy.REQUIRED, rate_limit_per_minute=4,
    ),
    ProductActionDefinition(
        id="account.data.export", title="导出个人数据",
        description="密码重验后将个人数据归档直接下载到用户指定文件；内容不进入 Run 或 MCP。",
        scopes=("account:manage",), handler_name=None,
        input_schema=_object(), risk=(RiskLevel.SENSITIVE,),
        available=True, secure_direct=True, mcp_exposed=False,
        error_codes=("SECURE_TRANSPORT_REQUIRED", "PASSWORD_INVALID", "EXPORT_FAILED"),
        rate_limit_per_minute=5,
    ),
    ProductActionDefinition(
        id="account.delete", title="注销账号",
        description="通过安全直连两段流程输入当前密码和确认短语，永久注销当前账号。",
        scopes=("account:manage",), handler_name=None,
        input_schema=_object(), risk=(RiskLevel.DESTRUCTIVE,),
        available=True, secure_direct=True, mcp_exposed=False,
        confirmation_required=True,
        error_codes=("SECURE_TRANSPORT_REQUIRED", "PASSWORD_INVALID", "CONFIRMATION_INVALID", "LAST_ADMIN"),
        rate_limit_per_minute=5,
    ),
    ProductActionDefinition(
        id="models.custom.create", title="创建自定义回答模型",
        description="通过 HTTPS 安全直连和无回显 stdin 创建 OpenAI 兼容回答模型；API Key 不进入 Schema、Run、MCP 或审计。",
        scopes=("models:write",), handler_name=None,
        input_schema=_object({
            "name": {"type": "string", "minLength": 1, "maxLength": 80},
            "provider_name": {"type": "string", "minLength": 1, "maxLength": 80},
            "model": {"type": "string", "minLength": 1, "maxLength": 160},
            "api_base": {"type": "string", "minLength": 1, "maxLength": 512},
            "enabled": {"type": "boolean"},
            "select": {"type": "boolean"},
        }, ["name", "provider_name", "model", "api_base"]),
        risk=(RiskLevel.SENSITIVE,), available=True,
        secure_direct=True, mcp_exposed=False, confirmation_required=True,
        error_codes=(
            "SECURE_TRANSPORT_REQUIRED", "INVALID_INPUT",
            "UNSAFE_API_BASE", "ENCRYPTION_KEY_REQUIRED",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
            "CONFIRMATION_NOT_FOUND", "CONFIRMATION_EXPIRED",
            "CONFIRMATION_MISMATCH", "CONFIRMATION_REPLAYED",
        ),
        rate_limit_per_minute=10,
    ),
    ProductActionDefinition(
        id="models.secret.update", title="修改模型密钥",
        description="通过 HTTPS 安全直连和无回显 stdin 更新已有自定义回答或视觉模型密钥。",
        scopes=("models:write",), handler_name=None,
        input_schema=_object({
            "target": {"type": "string", "enum": ["chat", "vision"]},
            "model_id": {"type": ["string", "null"], "maxLength": 64},
        }, ["target"]),
        risk=(RiskLevel.SENSITIVE,), available=True,
        secure_direct=True, mcp_exposed=False, confirmation_required=True,
        error_codes=(
            "SECURE_TRANSPORT_REQUIRED", "RESOURCE_NOT_FOUND", "INVALID_INPUT",
            "ENCRYPTION_KEY_REQUIRED",
            "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID",
            "CONFIRMATION_NOT_FOUND", "CONFIRMATION_EXPIRED",
            "CONFIRMATION_MISMATCH", "CONFIRMATION_REPLAYED",
        ),
        rate_limit_per_minute=10,
    ),
    _unavailable(
        "local.platform.login", "本机平台登录", "在受信 Windows 客户端发起扫码登录。", "local:invoke",
        local=True, input_schema=_object({
            "platform": {"type": "string", "enum": ["douyin", "bilibili", "xiaohongshu"]},
        }, ["platform"]), reason="需要已安装的 Windows 桌面客户端",
    ),
    _unavailable(
        "local.platform.collect", "本机平台采集", "在受信 Windows 客户端明确采集喜欢、收藏或作品。", "local:invoke",
        local=True, input_schema=_object({
            "platform": {"type": "string", "enum": ["douyin", "bilibili", "xiaohongshu"]},
            "mode": {"type": "string", "enum": ["like", "collect", "post"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        }, ["platform", "mode", "limit"]), reason="需要已安装的 Windows 桌面客户端",
    ),
    _unavailable(
        "local.media.open", "打开本机媒体", "使用 Windows 客户端打开本机媒体。", "local:invoke",
        local=True, input_schema=_object({
            "aweme_id": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"},
        }, ["aweme_id"]), reason="需要已安装的 Windows 桌面客户端",
    ),
    _unavailable(
        "local.update.install", "安装客户端更新", "在用户确认后安装 Windows 客户端更新。", "local:invoke",
        local=True, risk=(RiskLevel.DESTRUCTIVE,), input_schema=_object(),
        reason="需要已安装的 Windows 桌面客户端和一次确认",
    ),
)


# Full ordinary-user inventory.  Unadapted writes remain visible as disabled
# descriptors instead of silently disappearing or accidentally falling back
# to route reflection.  Each item must be deliberately promoted to a reviewed
# handler before it can execute.
_DISABLED_INVENTORY: tuple[tuple[str, str, str, str, bool], ...] = (
    ("library.sync.status", "读取平台同步状态", "读取当前设备/云端可公开的平台连接状态。", "library:read", False),
    ("library.sync.start", "同步喜欢收藏作品", "明确发起一次手动同步，不进行自动或连续风控重试。", "library:write", False),
    ("library.transcript.generate", "生成完整文稿", "为一条用户资料生成完整文稿。", "library:write", False),
    ("library.transcript.batch", "批量生成文稿", "为用户明确选择的多条资料生成文稿。", "library:write", False),
    ("library.hidden.list", "读取已隐藏资料", "读取当前用户临时移除的资料。", "library:read", False),
    ("library.hidden.restore", "恢复隐藏资料", "恢复当前用户临时移除的资料。", "library:write", False),
    ("library.visual.ask", "询问视频画面", "基于一条视频的详细画面证据提问。", "ask:run", False),
    ("ask.sources.list", "列出问答资料", "列出可用于多视频问答的资料来源。", "ask:read", False),
    ("ask.sources.search", "搜索问答资料", "按标题和文稿搜索当前用户资料。", "ask:read", False),
    ("ask.thread.create", "创建 AI 会话", "使用明确选择的资料创建知萃 AI 会话。", "ask:run", False),
    ("ask.thread.update", "修改 AI 会话", "修改当前用户会话标题。", "ask:run", False),
    ("ask.thread.remove", "删除 AI 会话", "删除当前用户的一条会话。", "ask:run", False),
    ("ask.turn.get", "读取问答运行", "读取一个持久 Agent Turn。", "ask:read", False),
    ("ask.turn.events", "读取问答事件", "续读一个持久 Agent Turn 的单调事件。", "ask:read", False),
    ("ask.turn.cancel", "取消问答", "停止一个当前用户正在运行的问答。", "ask:run", False),
    ("ask.turn.retry", "重试问答", "明确重试一个失败或取消的问答。", "ask:run", False),
    ("ask.analysis.approve", "确认问答详细解析", "确认问答内的计费详细解析报价。", "analysis:run", False),
    ("ask.analysis.text_only", "仅按文稿继续回答", "取消画面解析并按已有文稿继续原问题。", "analysis:run", False),
    ("ask.analysis.cancel", "取消本次详细解析提问", "取消问答内的详细解析审批。", "analysis:run", False),
    ("ask.analysis.reprepare", "重新生成问答解析报价", "为同一问答重新生成详细解析报价。", "analysis:run", False),
    ("knowledge.candidate.list", "读取待整理知识", "读取一条视频的知识候选。", "knowledge:read", False),
    ("knowledge.candidate.save", "保存知识候选", "将视频候选保存为知识页。", "knowledge:write", False),
    ("plan.create", "创建计划", "创建当前用户行动计划。", "plan:write", False),
    ("plan.focus.replace", "安排今日重点", "替换当天最多三项重点任务。", "plan:write", False),
    ("plan.review", "读取计划复盘", "读取当前用户周度计划复盘。", "plan:read", False),
    ("plan.task.reorder", "调整任务顺序", "调整当前用户计划任务顺序。", "plan:write", False),
    ("plan.coach.preview", "预览 AI 调整", "生成计划调整预览，不直接写入。", "plan:write", False),
    ("plan.coach.apply", "应用 AI 调整", "应用服务器签发的计划调整预览。", "plan:write", False),
    ("automation.status", "读取自动摘要状态", "读取自动摘要与邮箱验证状态。", "automation:read", False),
    ("automation.create", "创建自动摘要", "创建一个用户明确配置的自动摘要。", "automation:write", False),
    ("automation.update", "更新自动摘要", "更新当前用户自动摘要。", "automation:write", False),
    ("automation.remove", "删除自动摘要", "删除当前用户自动摘要。", "automation:write", False),
    ("automation.runs.list", "读取自动摘要运行", "读取当前用户自动摘要运行记录。", "automation:read", False),
    ("account.email.status", "读取邮箱验证状态", "读取当前账号邮箱验证状态。", "account:read", False),
    ("account.email.send", "发送邮箱验证", "向当前账号邮箱发送验证邮件。", "account:manage", False),
    ("account.email.confirm", "确认邮箱验证", "使用用户收到的验证码确认邮箱。", "account:manage", False),
    ("analysis.run.confirm", "确认详细解析", "在现有报价门槛后确认一次详细解析。", "analysis:run", False),
    ("analysis.run.get", "读取详细解析", "读取当前用户一条详细解析运行。", "analysis:read", False),
    ("analysis.run.cancel", "取消详细解析", "取消当前用户详细解析运行。", "analysis:run", False),
    ("analysis.run.remove", "删除详细解析记录", "删除当前用户一条可删除的解析记录。", "analysis:run", False),
    ("analysis.account.get", "读取解析额度", "读取当前用户详细解析额度和最近流水。", "analysis:read", False),
    ("models.selection.get", "读取模型选择", "读取当前用户选中的平台或自定义模型。", "models:read", False),
    ("models.selection.set", "选择回答模型", "选择一个已发布的平台模型。", "models:write", False),
    ("models.custom.list", "列出自定义模型", "读取脱敏后的自定义模型列表。", "models:read", False),
    ("models.custom.create", "创建自定义模型", "通过安全输入创建自定义模型。", "models:write", False),
    ("models.custom.update", "更新自定义模型", "通过安全输入更新自定义模型。", "models:write", False),
    ("models.custom.remove", "删除自定义模型", "删除当前用户自定义模型。", "models:write", False),
    ("models.custom.test", "测试自定义模型", "测试当前用户自定义模型连接。", "models:write", False),
    ("models.vision.get", "读取视觉模型", "读取脱敏后的视频画面识别设置。", "models:read", False),
    ("models.vision.update", "更新视觉模型", "通过安全输入更新视觉模型。", "models:write", False),
    ("models.vision.remove", "删除视觉模型", "清除当前用户视觉模型设置。", "models:write", False),
    ("models.vision.test", "测试视觉模型", "测试当前用户视觉模型连接。", "models:write", False),
    ("account.consents", "读取协议记录", "读取当前账号已接受的协议版本。", "account:read", False),
    ("local.status", "读取本机桥状态", "读取受信 Windows 客户端桥接状态和版本。", "local:invoke", True),
    ("local.capabilities.get", "读取本机能力", "读取受信 Windows 客户端固定白名单能力。", "local:invoke", True),
    ("local.platform.status", "读取本机平台状态", "读取受信 Windows 客户端的本机平台会话状态。", "local:invoke", True),
    ("local.platform.sync", "同步本机平台资料", "由用户或 Agent 明确发起一次本机平台同步。", "local:invoke", True),
    ("local.platform.disconnect", "断开本机平台账号", "清除当前用户在本机保存的平台会话。", "local:invoke", True),
    ("local.platform.logout", "退出本机平台", "清除当前用户在本机保存的平台会话。", "local:invoke", True),
    ("local.platform.rebind", "换绑本机平台", "在受信 Windows 客户端重新扫码换绑。", "local:invoke", True),
    ("local.platform.cancel", "取消本机平台操作", "取消当前等待扫码或采集的本机平台操作。", "local:invoke", True),
    ("local.media.settings.get", "读取本机媒体设置", "读取脱敏后的本机媒体目录设置。", "local:invoke", True),
    ("local.media.directory.choose", "选择本机媒体目录", "打开系统目录选择器并更新本机媒体目录。", "local:invoke", True),
    ("local.media.delete", "删除本机媒体", "经用户确认后删除一条本机缓存媒体。", "local:invoke", True),
    ("local.update.check", "检查客户端更新", "由受信 Windows 客户端检查签名更新。", "local:invoke", True),
    ("local.client.update.check", "检查客户端更新", "由受信 Windows 客户端检查签名更新。", "local:invoke", True),
    ("local.client.update.install", "安装客户端更新", "经用户确认后安装已校验签名的客户端更新。", "local:invoke", True)
)


_EXISTING_IDS = frozenset(definition.id for definition in _CORE_DEFINITIONS)


_LOCAL_PLATFORM_SCHEMA = _object({
    "platform": {"type": "string", "enum": ["douyin", "bilibili", "xiaohongshu"]},
}, ["platform"])

_LOCAL_COLLECT_SCHEMA = _object({
    **_LOCAL_PLATFORM_SCHEMA["properties"],
    "mode": {"type": "string", "enum": ["like", "collect", "post"]},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
}, ["platform", "mode", "limit"])

_LOCAL_MEDIA_SCHEMA = _object({
    "aweme_id": {"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"},
}, ["aweme_id"])

_LOCAL_INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    "local.status": _object(),
    "local.capabilities.get": _object(),
    "local.platform.status": _LOCAL_PLATFORM_SCHEMA,
    "local.platform.sync": _LOCAL_COLLECT_SCHEMA,
    "local.platform.disconnect": _LOCAL_PLATFORM_SCHEMA,
    "local.platform.logout": _LOCAL_PLATFORM_SCHEMA,
    "local.platform.rebind": _LOCAL_PLATFORM_SCHEMA,
    # The trusted desktop bridge cancels the single active platform operation;
    # it deliberately accepts no renderer-controlled identity or path input.
    "local.platform.cancel": _object(),
    "local.media.settings.get": _object(),
    "local.media.directory.choose": _object(),
    "local.media.delete": _LOCAL_MEDIA_SCHEMA,
    "local.update.check": _object(),
    "local.client.update.check": _object(),
    "local.client.update.install": _object(),
}


def _disabled_inventory_risk(
    action_id: str,
    scope: str,
) -> tuple[RiskLevel, ...]:
    """Keep disabled descriptors honest while their handlers are staged.

    A disabled Action is still consumed by CLI/MCP capability discovery, so
    classifying every inventory item as a write would make read-only tools
    look destructive to clients.  Local status/update checks are the two
    read-only exceptions whose shared local scope cannot express that fact.
    """
    if scope.endswith(":read") or action_id in {
        "local.status",
        "local.capabilities.get",
        "local.platform.status",
        "local.media.settings.get",
        "local.update.check",
        "local.client.update.check",
    }:
        return (RiskLevel.READ,)
    if action_id in {
        "local.platform.disconnect",
        "local.platform.logout",
        "local.platform.rebind",
        "local.media.delete",
        "local.client.update.install",
    }:
        return (RiskLevel.DESTRUCTIVE,)
    return (RiskLevel.WRITE,)


DEFINITIONS: tuple[ProductActionDefinition, ...] = _CORE_DEFINITIONS + tuple(
    _unavailable(
        action_id,
        title,
        description,
        scope,
        local=local,
        risk=_disabled_inventory_risk(action_id, scope),
        input_schema=_LOCAL_INPUT_SCHEMAS.get(action_id),
        reason=(
            "需要已安装的 Windows 桌面客户端"
            if local
            else "已纳入普通用户能力清单，等待适配器和安全门槛启用"
        ),
    )
    for action_id, title, description, scope, local in _DISABLED_INVENTORY
    if action_id not in _EXISTING_IDS
)


registry = ProductActionRegistry(DEFINITIONS)
