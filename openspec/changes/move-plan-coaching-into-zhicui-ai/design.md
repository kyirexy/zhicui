## Context

当前计划工作区中的 `PlanCoachPanel` 直接调用 `/api/plans/{id}/coach/preview`，而知萃 AI 使用持久 Agent Thread/Turn、用户选择模型和聊天计费。两条链路最终都能调用 `generate_or_revise_plan` 和 `plan_service.build_coaching_preview`，但当前没有共享交互或确认状态。

现有 Agent Thread 只能冻结 Note 来源。本变更需要让 Thread 可以显式绑定一个用户拥有的 Plan，但不应将计划伪装成视频来源，也不应将计划变更交给无界的通用工具调用。

## Goals / Non-Goals

**Goals:**

- 用一个知萃 AI 会话承载计划调整、模型选择、计费、流式状态和历史恢复。
- 保持计划预览与应用两阶段，只有用户显式确认才修改计划。
- 复用现有计划规范化、完成任务保护、乐观版本检查和用户隔离逻辑。
- 计划页保持专注执行，只提供进入 AI 的上下文入口。

**Non-Goals:**

- 不让 Agent 访问任意数据库、Shell 或无界网络。
- 不在本版同时修改多个计划。
- 不删除现有计划预览/应用域服务；它们继续作为唯一写入路径。
- 不将普通任务打卡、拖拽排序等确定性操作改成 AI 操作。

## Decisions

### Thread 使用显式领域上下文

`AgentThread` 增加可选 `context_type` 和 `context_id`。视频会话保持 `context_type=video`；计划会话使用 `context_type=plan` 和所属 Plan ID。创建和每次读取都重新验证 Plan 所有权。

备选方案是仅使用 URL `plan_id` 或把 Plan 序列化进用户问题。这两种做法都无法在刷新后可靠恢复，也容易让旧快照覆盖新计划，因此不采用。

### 计划 Turn 走专用有界执行器

持久 worker 根据 Thread 上下文分流。计划 Turn 只能读取当前 Plan，调用现有 `generate_or_revise_plan` 产生目标，再由 `build_coaching_preview` 生成结构化 diff。此执行仍处在用户请求上下文中，因此使用知萃 AI 当前选择模型，并复用 Turn 的免费次数/萃点预留与结算。

备选方案是让通用研究 Agent 自由调用计划工具。对于单一、高影响的写操作，专用执行器更容易审计、测试和限界，因此首版不开放通用循环。

### 预览是持久的 Assistant Message Result

预览保存为 `AgentMessage.result_json` 中的 `plan_change_preview`，包含 Plan ID、`base_updated_at`、有界 operations、diff 和展示摘要。不保存模型原始输出或提示词。这让刷新、断线和历史会话可恢复待确认卡片。

### 应用通过 Agent 专用确认端点

客户端只传 Message ID，服务端从已持久预览读取 Plan ID、基线版本和 operations，验证用户、Thread 和 Plan 所有权后调用 `apply_coaching_preview`。成功后将消息标记为 `applied`，重复确认幂等返回当前计划。

### 计划页使用深链接而不是复制控件

“让知萃 AI 帮我调整”导航到 `/harness?plan_id=<id>&new=1`。知萃 AI 创建 Plan Thread 并展示当前计划标题、进度和简短提示。计划页继续提供手工编辑，不嵌入另一个对话器。

## Risks / Trade-offs

- [旧数据库缺少 Thread 上下文列] → 使用项目现有的跨方言可加性启动迁移，旧会话默认为 video。
- [预览后计划已被人工编辑] → 复用 `base_updated_at` 冲突检查，要求用户重新生成而不自动覆盖。
- [模型返回无效结构] → 继续使用现有规范化和验证；Turn 失败时释放预留额度且不产生预览。
- [Plan 会话没有视频来源] → UI 根据 `context_type` 显示“当前计划”，不显示“0 条视频”或资料选择器。

## Migration Plan

1. 部署可加性 Agent Thread 上下文列和后端分流，保持旧视频 Thread 兼容。
2. 部署前端计划入口、Plan Thread 空状态和预览卡。
3. 对一个测试计划完成创建会话、生成预览、确认应用、冲突和刷新恢复冒烟。
4. 回滚前端入口即可停止新 Plan Thread；可加性列和已存消息无需删除。

## Open Questions

- 首版一个 Plan Thread 只绑定一个计划；跨计划统筹后续作为独立能力设计。
