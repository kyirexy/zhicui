## Why

当前普通用户可以接触实时模型目录和路由细节，选择范围过大，也缺少与平台成本一致的聊天萃点结算。产品需要把供应商、密钥、模型发布和价格控制收回管理端，同时让桌面端用户只在管理员发布的模型与自己的自定义模型之间做明确选择。

## What Changes

- **BREAKING**：移除普通用户的“智能选择”和自动模型路由入口，不再把 `auto`、`auto/*` 或完整网关目录作为用户可选项。
- 新增由 Web 管理端维护的聊天模型目录，管理员可以新增、编辑、启停、排序模型，并配置免费额度、萃点价格、能力与用户可见性。
- 桌面端用户只能选择管理员已发布且自己有权限使用的模型；模型选择器明确显示免费或萃点价格。
- 保留“使用自己的模型”，但作为设置中的次级入口；用户 API Key 继续由后端加密保存，BYOK 不扣平台模型萃点。
- 将现有萃点账户与只追加账本扩展到聊天调用，支持免费额度、预留、结算、释放和失败退款。
- Web 浏览器只调用知萃的管理员 API，不直接接触 Provider 密钥或第三方管理接口。

## Capabilities

### New Capabilities

- `managed-chat-model-catalog`: 管理员维护平台聊天模型、发布状态、用户权限、免费额度与萃点价格。
- `chat-credit-billing`: 平台聊天调用的免费额度、报价、萃点预留、实际结算、释放与退款。
- `restricted-user-model-selection`: 桌面端用户只能选择已发布模型或自己的自定义模型，且不存在智能选择。

### Modified Capabilities

<!-- 无现有主规格需要修改。 -->

## Impact

- 后端新增聊天模型目录与用户模型选择数据模型、管理员与用户 API，并复用现有萃点账户/账本。
- Agent 有效模型解析从实时完整目录改为管理员发布目录，保留自定义 Provider 路径。
- Web 管理端新增“聊天模型”管理页面；桌面端 Agent 与设置页调整模型选择交互。
- 影响 `backend/app/models`、`backend/app/services`、`backend/app/api`、`frontend/src/components/admin`、`frontend/src/components/agent`、`frontend/src/lib/api.ts` 与相关类型。
