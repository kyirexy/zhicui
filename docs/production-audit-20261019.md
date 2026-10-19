# 知萃线上巡检记录（2026-10-19）

检查日期：2026-10-19，北京时间下午。目标：https://luxai.cn 。只读巡检，未修改生产数据、部署代码、重启服务或触发付费生成。

## 结论与证据边界

站点与核心服务当前可用。发现持续发生的封面加载失败、近期媒体流失败，以及线上代码中可复现的会话撤销和计划数据缺陷；前端还存在换账号后解析状态未清理的风险。

- **线上实际观测**：HTTP 检查、生产服务状态、生产日志聚合。
- **线上代码存在，隔离复现**：将关键函数与生产代码比对后，用内存数据库或真实前端组件的注入状态复现。没有在真实账号上制造丢数据或修改密码。
- **代码确认，交互待验**：换账号残留已定位状态生命周期问题，尚未用两个线上账号操作验证。

浏览器自动化工具连接失败，因此未完成登录后的实际点击、移动端布局、完整平台提取、真实邮件投递与视频生成验收。该工具故障不算知萃产品故障。没有现成专用冒烟账号凭据，未尝试伪造会话或绕过鉴权。

## 当前运行情况

- 后端、前端 systemd 服务均 active；`/api/health` 为 HTTP 200、`status=ok`。
- Web `1.1.18`，build `efe1ed7df23f-20261013083311`；生产发布 `manual-auth-recovery-core-efe1ed7`。
- 11 个页面返回 200：首页、下载、登录、每日研究、平台限制、Agent 接入、隐私、条款、社区、Harness、支持页。HTTP 200 仅代表资源可达，不代表交互验收完成。
- 从主要页面提取的 40 个静态资源全部可达；两次连接重置在各重试一次后返回 200，没有复现稳定资源缺失。
- Windows Beta `1.1.21`、Android Beta `1.3.7 (29)` 的清单和安装包可访问，Content-Length 与清单相符。未重新下载全包核对 SHA-256。
- 未登录访问用户、笔记、计划、管理员、提取流、每日研究状态接口均返回 401。
- 最近七日后端约 17.5 万条日志中未发现 Python 异常栈。该结果不能证明业务功能无缺陷。

## 优先处理的问题

### 1. P1：管理员重置密码不能收回已有登录权限

**证据：线上函数一致，隔离复现通过。**

重置仅更新密码哈希，没有撤销用户已有会话。真实重置函数执行后，旧密码确实无效，但旧 access token 与 refresh token 仍有效，可以继续访问与续期。如果重置目的是处理账号泄露，当前行为不能收回访问权。

- 定位：`backend/app/api/routes.py:5174`；`backend/app/services/auth_session_service.py:32`、`:83`。
- 结果：`old_password_still_valid=false`，`old_access_still_valid=true`，`old_refresh_still_valid=true`。
- 修复方向：密码重置与该用户会话撤销原子提交，覆盖 access/refresh 与兼容旧令牌的撤销策略；增加重置后旧凭据失效的回归验证。
- 未观察到账号被入侵，未在生产执行密码重置。

### 2. P1：同一客户端换账号后，单条解析原文可能残留

**证据：本地与生产状态管理代码确认；双账号线上交互待验。**

`ExtractionProvider` 全局保留 `cardData/transcript/previewVideo`，没有订阅用户身份变化；退出登录只清认证状态，Provider 不随用户重建，未完成 SSE 也不会因登出被取消。`/extract` 继续使用这些共享状态。触发路径为 A 解析内容后退出，在同一个仍运行的客户端登录 B，再进入单条解析。

- 定位：`frontend/src/lib/hooks/ExtractionContext.tsx:99`、`:110`；`frontend/src/app/Providers.tsx:20`；`frontend/src/lib/hooks/AuthContext.tsx:501`。
- 影响：可能显示上一账号的预览、原文或迟到的解析结果；这不是数据库跨用户查询越权。
- 修复方向：以用户 ID 隔离解析状态，退出/换号时取消请求并清理内存与相关缓存，同时拒绝旧账号请求的迟到回包。

### 3. P2：快速勾选不同任务，可能漏记其中一次完成

**证据：线上函数一致，隔离交错请求复现通过。**

同一计划两个请求先读到相同任务 JSON，再分别勾选 A、B；两次都返回成功，后一次整份 JSON 写回覆盖前一次结果。前端只禁用当前任务，允许不同任务同时提交。

- 定位：`backend/app/services/plan_service.py:822`；`frontend/src/components/plans/PlanTaskBoard.tsx:206`。
- 结果：两个响应均 `done=true`，最终落库 `A=false / B=true`。
- 对照：CLI 的 `set_task_completion` 已使用 `with_for_update()`，Web 的 `toggle_task` 路径遗漏。
- 修复方向：统一任务更新事务与锁定策略，结合幂等的目标完成状态提交，避免整份 JSON 的并发覆盖。
- 未对生产计划进行并发写入试验。

### 4. P2：AI 修订计划会破坏完成历史

**证据：线上函数一致，隔离复现通过。**

任务合并只保留 `done`，没有保留 `completed_at`。同 ID、同标题的普通修订即可让已完成任务失去时间，周复盘少算；新任务如果复用旧 ID，即使标题不同，也可能被误标为已完成。

- 定位：`backend/app/services/plan_service.py:368`；入口 `backend/app/api/routes.py:4283`（资料计划 Agent）。
- 结果：周复盘 `completed_tasks: 1 → 0`，`partial_history: false → true`；复用 ID 的不同新任务变成 `done=true`。
- 修复方向：可靠识别同一任务并完整继承完成元数据；不同任务不得仅凭模型复用的 ID 继承完成状态。
- 未触发线上模型或修改用户计划。

### 5. P2：封面持续失败，视频媒体流近期有失败

**证据：生产日志实际发生。**

- 滚动七日有 **281 次抖音封面 503**，检查当日已有 **22 次**。代码在所有源读取失败后返回 SVG 占位，用户看到的是占位图，原封面并未加载成功。
- 七日 **9 次媒体 502**（Web 代理 8 次、Agent 1 次），最新为 **10 月 17 日 18:05，北京时间**。
- 应用错误表有 12 条同类“视频临时流读取失败，请重新获取播放地址”记录；与上述 HTTP 次数并非一一对应，不能相加为用户故障数。
- 定位：`backend/app/api/routes.py` 中 `_proxy_douyin_image` 的重试与 SVG 回退（`:329`、`:349`、`:441`），以及视频流代理路径。
- 当前日志未保留足够的上游异常链，不能确定是 Cookie、链接失效、限流或超时。应补充脱敏原因、上游状态和重试结果，再定向修复；不要仅根据 503 推断服务器整体不可用。

## 创作工坊：启用前需修复

生产 Hypit 开关当前关闭（未设置启用值，默认 False，数据库也无启用项）。以下缺陷已在部署代码中存在，但不能据此声称已有用户的生成任务失败：

1. **草稿无法进入渲染**：`StudioWorkspace.tsx:291` 要求 `pricing` 非空才显示确认按钮；新草稿 `pricing={}`，服务端却要在调用确认接口之后才写价格（`video_creation_routes.py:207`）。真实组件渲染结果：脚本可见、确认按钮不存在。
2. **成品播放/下载缺少认证头**：`StudioWorkspace.tsx:315`、`:319` 将受保护地址直接交给 `<video>` 和 `<a>`；服务端视频路由强制 Bearer，未发现 Cookie/query 或桌面头注入补偿。未认证只读请求实际返回 401。静态客户端还应处理 API 基址。
3. **首次创建失败无提示**：错误提示放在 `activeJob` 存在的区域中（`StudioWorkspace.tsx:218`），创建失败时没有任务，错误信息不可见。真实组件注入“创作工坊暂未开启”后未显示该提示。

## 未作为产品故障的问题

- 发布阶段的 9 次 Agent capabilities 503 位于 10 月 13 日切换窗口，不能当作当前持续故障。
- 前端 30 次 `NoFallbackError` 邻近非法 Server Reference ID `x/r2s`，更像扫描请求；没有证据证明正常用户路径触发。
- 公网私有工作区跳转下载/客户端门禁属于当前产品设计，不按旧 AGENTS 描述判为回归。

## 复查材料

产物目录：`.artifacts/production-audit-20261019/`。

- `http-summary.json`：页面、资源、安装包与未登录鉴权检查。
- `ops-summary.json`：脱敏生产服务与日志统计。
- `backend-repro.py` / `backend-repro-results.json`：内存数据库、假用户、阻断网络的复现脚本与结果。
- `backend-function-fingerprints.json` / `backend-production-function-comparison.json`：8 个关键后端函数的 AST SHA-256 对比，8/8 与生产一致。
- `frontend-studio-render-audit.cjs` / `frontend-studio-render-results.json`：真实组件的受控状态渲染，不发网络请求、不调用生成服务。

复查命令（仓库根目录）：

```powershell
backend/.venv/Scripts/python.exe .artifacts/production-audit-20261019/backend-repro.py
node .artifacts/production-audit-20261019/frontend-studio-render-audit.cjs
```

本次新增巡检文档和复现材料，未改动业务代码。建议首先修复会话撤销与换账号状态隔离，其次修复计划记录，再针对媒体错误补足原因并处理。
