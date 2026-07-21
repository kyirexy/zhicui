## Context

计划使用 `plans` 表保存基础元数据，并同时以 `tasks` 平铺数组和 `days_json` 分日数组保存任务。前端详情以 `days` 渲染，统计和部分服务逻辑以 `tasks` 为准，因此每次任务变更都必须同步两份结构。现有接口已经要求 JWT，但计划 service 调用没有传 `current_user.id`，导致用户隔离没有落实。任务类型已经预留 `scheduled_at` 和 `reminder_at`，但 UI 与编辑 API 尚未形成闭环。

本次跨越 FastAPI 路由、SQLAlchemy service、共享 TypeScript 类型、API client 和 Next.js 客户端页面。约束是不新增数据库表或第三方依赖，兼容 SQLite/PostgreSQL、旧 JSON 数据和 Capacitor 静态导出。

## Goals / Non-Goals

**Goals:**

- 所有计划读取与写入都按当前用户隔离，外部用户访问统一表现为不存在。
- 用户可以修正 AI 计划：修改标题、完成/重开计划，以及编辑任务标题、所属天、日期和优先级。
- 每次任务变更同步 flat tasks 与 days，并兼容只有其中一份结构的旧计划。
- 提供跨计划的今日、逾期、待完成执行概览。
- 在桌面与移动端提供明确的编辑、保存、错误和空状态。

**Non-Goals:**

- 不实现系统级推送通知、日历同步或后台定时任务。
- 不引入拖拽排序、多人协作或任务评论。
- 不迁移 JSON 任务到独立数据库表。
- 不重写 AI 计划生成 prompt 或计划动态字段系统。

## Decisions

1. **用户隔离在 route 和 service 双层落实。**
   - 所有用户计划路由显式传入 `current_user.id`。
   - `get/list/stats/update/delete/overview` service 接受 `user_id` 并在查询层过滤。
   - 对他人计划的详情或修改返回与不存在相同的 404，避免资源枚举。
   - 仅在路由校验但 service 不过滤的方案无法防止后续调用遗漏，因此放弃。

2. **继续使用现有 JSON，不做数据库迁移。**
   - 任务增加可选 `day`、`scheduled_at`、`reminder_at` 和 `priority` 字段。
   - `priority` 仅允许 `low | medium | high`，旧任务读取时按 `medium` 展示。
   - service 使用统一任务读取/同步帮助函数：flat tasks 缺失时从 days 去重恢复，days 缺失时仍允许平铺任务编辑。
   - 移动任务时从原日删除并插入目标日；目标日不存在则创建并按 day 排序。

3. **保留 toggle 端点，新增明确的编辑端点。**
   - 现有 `PATCH /api/plans/{id}/tasks/{task_id}` 保持“切换完成”语义，避免破坏客户端。
   - 新增 `PUT /api/plans/{id}/tasks/{task_id}` 更新任务详情。
   - 新增 `PATCH /api/plans/{id}` 更新标题或状态。
   - 新增 `GET /api/plans/overview`，并放在动态 `{plan_id}` 路由之前。

4. **计划状态既可手动控制，也与任务完成度保持最低限度一致。**
   - 用户可显式标记 `active` 或 `done`。
   - 勾选后若所有任务完成，状态自动变为 `done`；从完成计划重新打开任务时恢复为 `active`。
   - 不新增 paused 状态，因为没有暂停起始日计算所需的数据模型。

5. **执行概览在服务层聚合。**
   - 后端遍历当前用户的非完成计划，按北京时间比较 ISO 日期。
   - 已过日期归入 overdue；当天日期或计划当前日任务归入 today；其余未完成任务归入 upcoming。
   - 同一任务只进入一个最高优先级分组，返回摘要计数和有限的焦点任务列表。
   - 由于任务仍存于 JSON，数据库无法直接高效查询日期；本次接受按用户计划遍历的成本，并限制返回列表长度。

6. **编辑采用一个可复用任务面板，而不是为每行堆叠内联表单。**
   - 新建/编辑共享标题、所属天、日期和优先级字段。
   - 桌面和移动端复用现有 BottomSheet，避免两套状态逻辑。
   - 计划详情提供标题编辑与状态控制；计划列表顶部展示执行概览与焦点任务。

## Risks / Trade-offs

- **[旧计划 flat/day 结构不一致]** → 统一恢复与同步函数按任务 ID 去重，并用定向 service 测试覆盖。
- **[JSON 聚合随计划数量增长]** → overview 只读取当前用户、跳过完成计划并限制焦点任务条数；未来数据量扩大时再迁移独立 task 表。
- **[自动完成覆盖用户状态]** → 仅在 toggle 后全部任务完成时自动 done，重新打开时恢复 active；手动状态仍可修改。
- **[日期时区偏差]** → 后端按 `Asia/Shanghai` 比较日期，前端使用本地 `YYYY-MM-DD` 输入。
- **[现有 UI 修改面较大]** → 复用已有组件、颜色变量和 BottomSheet，保持接口旧调用可用并逐步替换。

## Migration Plan

1. 增加 service 用户过滤、任务同步帮助函数、编辑/状态/overview 能力。
2. 增加请求模型和新路由，修复所有现有计划路由的 `user_id` 传递。
3. 扩展 TypeScript 类型与 API client。
4. 增加执行概览、任务编辑面板、标题和状态控制。
5. 运行 Python 定向回归、TypeScript、Next 构建、OpenSpec 严格校验并重启开发服务。

回滚时移除新增路由与前端入口即可；新增 JSON 字段为可选值，旧代码会忽略，不需要数据库回滚。

## Open Questions

无。提醒时间字段继续保留兼容，但本轮不宣称提供系统通知。
