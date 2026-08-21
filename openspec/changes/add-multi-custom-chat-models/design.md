# 设计：多自定义模型管理

## Context

知萃的聊天模型选择目前收敛在单条 `UserAIProviderConfig` 行上：`mode='platform'` 时该行的 `model` 字段保存平台目录中用户选中的 offering ID；`mode='custom'` 时该行保存一条 BYOK OpenAI 兼容配置。聊天路由 `user_ai_provider_service.effective_config()`、BYOK 免计费门 `uses_custom_provider()`、平台目录选择 `chat_model_catalog_service.selected_offering/effective_config` 都依赖这一单行语义。

目标是在不破坏现有语义的前提下，演进为“多条自定义模型 + 一条当前选中”，存储必须服务端、按用户、可跨 Web/桌面/Android 保持一致。

## Goals / Non-Goals

**Goals:**

- 新增按用户多行自定义模型表，完整 CRUD、启用/停用、设为当前、连接测试。
- `effective_config()` 与 `uses_custom_provider()` 以“当前选中的自定义模型”为准。
- 旧 `UserAIProviderConfig(custom)` 数据无损提升为第一条自定义模型。
- 设置页新增「模型」标签页承载列表式 CRUD；对话选择器新增「自定义模型」分组。

**Non-Goals:**

- 不引入 Alembic；沿用 `main._migrate_db()` 的无 Alembic 启动迁移。
- 不改动 `ChatModelOffering`/`ChatModelFreeUsage` 平台目录与计费模型。
- 不改动视觉问答（vision）的供应商选择逻辑（继续引用聊天 `effective_config`）。
- 不实现自定义模型的额度/竞价/路由策略；BYOK 仍为免平台计费。

## Decisions

### D1: 新增独立表 `user_custom_chat_models`（而非扩展旧单行表）

- 表列：`id`(uuid, PK)、`user_id`(FK users, cascade, index)、`name`(显示名)、`provider_name`、`model`、`api_base`、`encrypted_api_key`(Text, `ENC:` 前缀加密)、`enabled`(bool)、`is_selected`(bool)、`created_at`、`updated_at`。
- 每用户最多一条 `is_selected=true`，由服务层在事务内维护（清除旧选中再用唯一索引 `uq_user_custom_model_selected` 保证）。
- 备选方案：在旧表加 `display_name`/`is_selected` 并把单行改成“当前自定义配置”集合。被否决——旧表 `UniqueConstraint(user_id)` 无法承载多模型，改约束会放大迁移风险与旧接口语义破损。

### D2: 当前选中状态的统一表达

- 自定义模型表中 `is_selected` 表示“当前生效的自定义模型”。
- 平台 offering 选择继续存放在旧 `UserAIProviderConfig.model`（`mode='platform'`）。
- 派生逻辑：`uses_custom_provider()` = 存在 `is_selected=true` 且 `enabled=true` 的自定义模型。
- `serialize()` 新增 `custom_models`（列表）与当前选中标记，兼容旧字段 `mode/enabled/model/api_base/api_key_set/api_key_masked/selected_offering_*`。

### D3: 路由解析顺序

`effective_config(db, user_id)` 按优先级：

1. 无用户 → 平台全局 `settings_service.get_llm_config(db)`（保持现状）。
2. 找到 `is_selected=true && enabled=true` 的自定义模型 → 返回其 `provider='custom'`, `model`, `runtime_model`（无 `/` 则前缀 `openai/`）, `api_base`, `api_key`（解密）。
3. 否则 → 平台路径（旧 `mode='platform'` 时用该行 `model`，否则 `chat_model_catalog_service.effective_config`）。

### D4: 兼容旧自定义行提升

`_migrate_db()` 幂等步骤：

- `user_custom_chat_models` 表不存在时由 `Base.metadata.create_all` 创建。
- 列缺失时用 `ALTER TABLE` 补列（沿用现有列补丁模式），并为 `user_id, is_selected` 建索引。
- 对每条旧 `UserAIProviderConfig` 行且 `mode='custom' && enabled && model && api_base && encrypted_api_key`：若用户尚无自定义模型，插入一条 `name=provider_name`, `is_selected=true` 的自定义模型；不删除旧行。
- 旧 `mode='platform'` 行完全跳过。

### D5: API 表面

新增（均挂载 `get_current_user`）：

- `GET /api/user/custom-chat-models` → `{items:[...], selected_id, active_selection}`。
- `POST /api/user/custom-chat-models` → 创建（缺省 `enabled=true`）。
- `PUT /api/user/custom-chat-models/{model_id}` → 更新（`api_key` 留空则保留旧密钥）。
- `DELETE /api/user/custom-chat-models/{model_id}` → 删除；若是选中项，回退 `is_selected` 到平台。
- `PUT /api/user/custom-chat-models/{model_id}/select` → 设为当前。
- `POST /api/user/custom-chat-models/{model_id}/test` → 测试该模型（不改选中状态）。

保留旧 `/api/user/ai-provider`（PUT/DELETE/GET/TEST）语义：PUT `custom` 变为“创建/更新并选中自定义模型”的语法糖，以继续服务旧客户端与新 `AgentModelConfigSheet`。

### D6: 前端信息架构

- 设置页 `SettingsSectionId` 增加 `models`；`SETTINGS_SECTIONS` 插入「模型」项（icon `Cpu`/`Robot`，描述“管理平台与自定义模型”）。
- `UserAIProviderSettingsCard` 保留在「AI 服务」下（视觉问答 + 旧入口兼容），另建 `UserCustomModelsSettingsCard` 挂「模型」标签页，包含平台模型选择 + 自定义模型列表 CRUD + 测试。
- `AgentComposer` 的 `MODEL_GROUPS` 第三组「自定义模型」，选项由 `customModels` 列表生成，`id='custom:<uuid>'`，选中项显示勾选；“配置自定义模型”链接深链 `router.push('/settings?section=models')`。

## Risks / Trade-offs

- [旧表与新表双写漂移] → 所有读路径统一走新增服务函数，旧表仅保留 `mode/platform` 选择语义；`_migrate_db` 幂等提升后不删除旧行。
- [每用户最多一个选中项被并发写破坏] → 服务层用 `db.flush()` + 唯一索引；SQLite 开发单写限制下风险低，PostgreSQL 用 partial unique index 兜底。
- [连接测试暴露密文明文到日志] → 测试只走 litellm，`error_log_service` 元数据只记录 provider/model，不记录 api_key。
- [旧客户端误读新 `serialize()`] → 新字段为增量追加，旧字段名保持不变；`mode` 在存在选中自定义模型时返回 `'custom'`，保持旧选择器兼容。

## Migration Plan

1. 部署包含 `Base.metadata.create_all` + `_migrate_db` 新步骤的后端；启动即建表并提升旧自定义行。
2. 部署前端设置页与选择器改造；新入口与旧入口并存。
3. 观察旧 `/api/user/ai-provider` 调用量归零后再决定是否清理旧表（不在本次范围）。
4. 回滚：回退代码版本即可；`user_custom_chat_models` 表不删除，旧配置保持不变，功能回到单模型语义。

## Open Questions

- 是否需要自定义模型“供应商图标”枚举与 UI 图标匹配：本次先采用通用 `Cloud`/`Cpu` 图标 + `provider_name` 文本，后续可按名称二次映射。
