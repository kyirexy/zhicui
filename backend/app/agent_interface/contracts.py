"""Stable v1 wire contracts for locally installed Agent clients.

These models intentionally do not reuse FastAPI route request models.  The
Action protocol is a product contract: it stays versioned while browser-only
transport endpoints are free to evolve.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


API_VERSION = "v1"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


TERMINAL_STATUSES = {
    RunStatus.SUCCEEDED.value,
    RunStatus.FAILED.value,
    RunStatus.CANCELED.value,
}


class RunType(StrEnum):
    SYNC = "sync"
    STREAM = "stream"
    LONG_TASK = "long_task"


class ExecutionLocation(StrEnum):
    CLOUD = "cloud"
    LOCAL_WINDOWS = "local_windows"


class RiskLevel(StrEnum):
    READ = "read"
    WRITE = "write"
    BILLABLE = "billable"
    SENSITIVE = "sensitive"
    DESTRUCTIVE = "destructive"


class IdempotencyStrategy(StrEnum):
    NONE = "none"
    OPTIONAL = "optional"
    REQUIRED = "required"


class V1Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ActionError(V1Model):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class ActionDescriptor(V1Model):
    id: str
    version: str = "1.0.0"
    title: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    scopes: list[str]
    risk: list[RiskLevel]
    run_type: RunType
    execution_location: ExecutionLocation
    idempotency: IdempotencyStrategy
    error_codes: list[str]
    available: bool = True
    unavailable_reason: str | None = None
    # Sensitive actions remain discoverable product capabilities but can be
    # invoked only through a dedicated direct HTTPS transport.  Their secret
    # fields are intentionally absent from this public descriptor.
    secure_direct: bool = False
    mcp_exposed: bool = True


class RunRecord(V1Model):
    id: str
    action_id: str
    action_version: str
    status: RunStatus
    run_type: RunType
    execution_location: ExecutionLocation
    cancellation_requested: bool
    last_event_sequence: int
    data: Any = None
    error: ActionError | None = None
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    updated_at: str


class EventRecord(V1Model):
    id: str
    run_id: str
    sequence: int
    type: str
    status: RunStatus
    message: str = ""
    data: dict[str, Any] = Field(default_factory=dict)
    terminal: bool = False
    created_at: str


class ActionEnvelope(V1Model):
    api_version: str = API_VERSION
    action: str
    request_id: str
    run_id: str | None = None
    status: RunStatus | str
    data: Any = None
    error: ActionError | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


SCOPES: tuple[dict[str, str], ...] = (
    {"id": "account:read", "title": "读取账号", "description": "读取当前账号的公开资料与连接状态"},
    {"id": "account:manage", "title": "管理账号", "description": "导出或注销个人账号等敏感操作"},
    {"id": "library:read", "title": "读取资料库", "description": "查看当前用户的视频资料与文稿"},
    {"id": "library:write", "title": "整理资料库", "description": "导入、整理或删除当前用户的资料"},
    {"id": "creator:read", "title": "读取博主", "description": "查看已保存博主、作品与同步记录"},
    {"id": "creator:sync", "title": "同步博主", "description": "由用户或 Agent 明确发起一次博主同步"},
    {"id": "ask:read", "title": "读取对话", "description": "查看当前用户的知萃 AI 会话与运行"},
    {"id": "ask:run", "title": "运行问答", "description": "基于用户选定的视频明确发起一次问答"},
    {"id": "knowledge:read", "title": "读取知识", "description": "查看当前用户的知识页与待整理内容"},
    {"id": "knowledge:write", "title": "整理知识", "description": "创建、更新或删除当前用户的知识页"},
    {"id": "plan:read", "title": "读取计划", "description": "查看当前用户的计划与任务"},
    {"id": "plan:write", "title": "修改计划", "description": "创建或修改当前用户的计划与任务"},
    {"id": "automation:read", "title": "读取自动摘要", "description": "查看自动摘要设置与运行记录"},
    {"id": "automation:write", "title": "管理自动摘要", "description": "创建、修改或手动运行自动摘要"},
    {"id": "analysis:read", "title": "读取详细解析", "description": "查看详细解析方案与当前用户运行"},
    {"id": "analysis:run", "title": "运行详细解析", "description": "准备或确认计费的详细解析"},
    {"id": "models:read", "title": "读取模型设置", "description": "查看平台模型与脱敏后的自定义模型设置"},
    {"id": "models:write", "title": "修改模型设置", "description": "选择模型或通过安全输入更新自有配置"},
    {"id": "feedback:read", "title": "读取反馈", "description": "查看自己提交的反馈"},
    {"id": "feedback:write", "title": "提交反馈", "description": "向知萃提交产品反馈"},
    {"id": "local:invoke", "title": "调用本机能力", "description": "仅在受信 Windows 客户端内调用固定本机动作"},
)


ALL_SCOPE_IDS = frozenset(item["id"] for item in SCOPES)


def error_payload(
    code: str,
    message: str,
    *,
    retryable: bool = False,
    details: dict[str, Any] | None = None,
) -> ActionError:
    return ActionError(
        code=code,
        message=message,
        retryable=retryable,
        details=details or {},
    )
