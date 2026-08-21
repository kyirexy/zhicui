# 多自定义模型管理

## Why

当前知萃只允许每个用户保存一套“自己的模型”配置（单行 `UserAIProviderConfig`，`mode ∈ {platform, custom}`）。用户无法同时添加多个 BYOK 模型（不同供应商、不同模型 ID），也无法在对话模型选择器中预览、切换或独立测试这些模型。该限制阻碍桌面端/网页端用户在一次工作流中灵活切换不同供应商的精调模型。

## What Changes

- 新增服务端、按用户、多行的“自定义聊天模型”存储（`user_custom_chat_models`），每行包含展示名、供应商、模型 ID、API Base、加密 API Key、启用状态与选中状态。
- 保持现有单行 `UserAIProviderConfig` 的向后兼容：`mode='platform'` 的平台“选中 offering”继续沿用现有存储语义；`mode='custom'` 的旧数据在启动迁移时被提升为第一条自定义模型。
- 新增自定义模型 CRUD、选中、连接测试接口，并对现有 `/api/user/ai-provider` 系列保留兼容语义。
- 聊天路由 `effective_config()` 在用户选中自定义模型时返回该模型的 provider/model/runtime_model/api_base/api_key；`uses_custom_provider()` 据此继续实现 BYOK 免计费。
- 设置页新增独立「模型」标签（或增强「AI 服务」区域），提供自定义模型列表的新增、编辑、删除、测试与设为当前。
- 聊天模型选择器（`AgentComposer`）新增「自定义模型」分组，展示全部已保存自定义模型并支持选中/切换；底部入口改为“配置自定义模型”并深链到设置页 `?section=models`。

## Capabilities

### New Capabilities

- `user-custom-chat-models`: 按用户多自定义模型的增删改查、启用/选中状态、连接测试，以及聊天路由对选中自定义模型的有效配置解析。

### Modified Capabilities

<!-- 无既有 spec 级需求变更；现有 provider/计费行为保持不变并向后兼容。 -->

## Impact

- **后端**: `backend/app/models/user_custom_chat_model.py`（新增 ORM）、`backend/app/services/user_ai_provider_service.py`、`backend/app/services/chat_model_catalog_service.py`、`backend/app/api/routes.py`（新增接口与请求模型）、`backend/app/main.py`（模型导入 + `_migrate_db` 旧 `custom` 行提升）。
- **前端**: `frontend/src/lib/api.ts`（类型与客户端函数）、`frontend/src/app/settings/page.tsx`、新增 `UserCustomModelsSettingsCard`、`frontend/src/components/agent/AgentComposer.tsx`、`frontend/src/components/agent/AgentModelConfigSheet.tsx`、`frontend/src/components/agent/VideoAgentWorkspace.tsx`。
- **数据**: 数据库新增 `user_custom_chat_models` 表；SQLite 开发库与 PostgreSQL 生产库均通过无 Alembic 的启动迁移。
- **兼容性**: 旧 `UserAIProviderConfig(custom)` 单行语义被提升而非删除；`selected_offering`、`effective_config`、计费门 `uses_custom_provider` 保持可工作。
