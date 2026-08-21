# 实施任务：多自定义模型管理

## 1. 后端数据模型

- [x] 1.1 新增 `backend/app/models/user_custom_chat_model.py`：`UserCustomChatModel` ORM（含列、索引、`updated_at` onupdate）
- [x] 1.2 在 `backend/app/main.py` 顶部导入新模型使 `Base.metadata.create_all` 注册它

## 2. 后端迁移

- [x] 2.1 在 `_migrate_db()` 增加 `user_custom_chat_models` 列补丁与索引（含旧表 `user_ai_provider_configs` 列检查）
- [x] 2.2 实现幂等提升：把旧 `UserAIProviderConfig(mode='custom' && enabled && 字段完整)` 提升为第一条自定义模型并设为当前

## 3. 后端服务层

- [x] 3.1 在 `user_ai_provider_service.py` 增加 `list_custom_models` / `get_custom_model` / `create_custom_model` / `update_custom_model` / `delete_custom_model` / `select_custom_model`
- [x] 3.2 增强 `serialize()` 返回 `custom_models` 与当前选中状态，并保留旧字段兼容
- [x] 3.3 改写 `effective_config()` 与 `uses_custom_provider()`，优先按 `is_selected && enabled` 自定义模型解析
- [x] 3.4 保留旧 `save()` 的 `custom` 语义为“创建/更新并选中自定义模型”语法糖

## 4. 后端 API

- [x] 4.1 在 `routes.py` 新增自定义模型 Pydantic 请求模型
- [x] 4.2 实现 `GET/POST /api/user/custom-chat-models`、`PUT/DELETE /api/user/custom-chat-models/{id}`、`PUT .../select`、`POST .../test`
- [x] 4.3 在 `_agent_failure_metadata` 不泄露 API Key 的前提下接入新路由解析

## 5. 旧接口兼容与测试

- [x] 5.1 让 `GET/PUT/DELETE /api/user/ai-provider` 与 `POST /api/user/ai-provider/test` 在新模型下保持旧语义
- [x] 5.2 更新 `backend/tests/test_personal_knowledge_and_provider.py` 覆盖多模型 CRUD、选中、路由解析与旧配置提升（若存在测试运行环境则执行）

## 6. 前端 API 客户端

- [x] 6.1 在 `frontend/src/lib/api.ts` 新增 `UserCustomChatModel` 类型与 `list/create/update/delete/select/test` 客户端函数
- [x] 6.2 扩展 `UserAIProviderConfig` 类型增加 `custom_models` 与选中字段

## 7. 设置页「模型」标签

- [x] 7.1 在 `settings/page.tsx` 增加 `models` 段与图标、文案、搜索关键词，并从移动端隐藏表移除
- [x] 7.2 新增 `UserCustomModelsSettingsCard.tsx`：平台模型选择 + 自定义模型列表 + CRUD + 测试 + 设为当前
- [x] 7.3 保留现有 `UserAIProviderSettingsCard` 作为旧入口，并在「模型」段渲染新卡片

## 8. 对话模型选择器

- [x] 8.1 在 `AgentComposer.tsx` 增加「自定义模型」分组，渲染自定义模型选项与选中/切换
- [x] 8.2 底部“配置自定义模型”链接深链 `router.push('/settings?section=models')`
- [x] 8.3 保持 `AgentModelConfigSheet` 兼容：提交时走单模型语法糖创建并选中

## 9. 工作区接线

- [x] 9.1 在 `VideoAgentWorkspace.tsx` 加载 `custom_models` 状态并传给 `AgentComposer`
- [x] 9.2 `handleComposerModelChange` 兼容 `custom:<id>` ID 与平台 offering ID 的路由
- [x] 9.3 `applyCustomModelConfig` 适配新创建/选中语义，确保测试与保存后刷新列表

## 10. 验证与收尾

- [x] 10.1 后端 `python -c "from app.main import create_app"` 及（可选）跑相关单测确保无导入/迁移回归
- [x] 10.2 前端 `npm run build`（或 dev 回路）确认类型与编译通过，手工走查设置页与选择器交互
- [ ] 10.3 全流程人工验收：新增→选中→测试→切换→删除回退，以及旧自定义配置升级路径
