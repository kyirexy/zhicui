## Why

当前主导航把首页标记为“今日行动”，同时又把 `/plans` 视为同一个导航项，导致首页、每日执行和计划管理三个概念混在一起。计划模块已经具备独立工作区能力，应当拥有单独入口，而首页只负责汇总当前状态和快速进入各工作区。

## What Changes

- 将根路由 `/` 的主导航名称从“今日行动”统一改为“首页”。
- 新增独立“计划”主导航 Tab，指向 `/plans`，拥有独立选中状态和未完成任务角标。
- 计划中心默认打开“全部计划”，并保留“今日安排”和“本周复盘”作为内部视图。
- 将计划页顶部从首页式问候改成紧凑的“计划中心”工具栏，突出创建计划和管理目标。
- 同步桌面侧栏、桌面上下文栏、网页导航和移动底部导航的名称、图标、预取与激活规则。

## Capabilities

### New Capabilities

- `home-and-plan-navigation`: 定义首页与独立计划中心在各客户端导航中的入口、激活状态和角标归属。

### Modified Capabilities

- `clear-action-plan-workspace`: 将计划中心默认视图从“今日”调整为“全部计划”，并明确内部视图层级。

## Impact

- 前端导航：`productNavigation.ts`、`DesktopAppFrame.tsx`、`BottomTabBar.tsx`、`AppHeader.tsx`。
- 计划工作区：`app/plans/page.tsx` 与 `PlanWorkspace.module.css`。
- 不改变后端计划 API、数据模型或现有计划详情路由。
