## Why

知萃现有能力分散在网页路由、桌面 IPC 与若干内部 Agent 工具中，本地 Codex、Claude Code 等 Agent 无法通过稳定、可发现且可审计的产品协议调用它们。现在需要建立一个以普通用户权限为边界的统一 Action 层，并提供 CLI、MCP 与可撤销授权，使自动化接入不依赖网页模拟操作，也不暴露管理端、任意 Shell 或用户秘密。

## What Changes

- 新增版本化 `ProductActionRegistry`，统一声明普通用户 Action 的 Schema、scope、风险、执行位置、幂等与稳定错误码，并让 HTTP、CLI、MCP、网页和桌面端共享同一份能力描述。
- 新增 `/api/agent-interface/v1` 能力发现、Action 调用、持久化 Run、事件流与取消协议；长任务统一为 `queued/running/waiting_for_user/succeeded/failed/canceled`。
- 新增可撤销、分 scope 的 PAT 与浏览器设备授权，服务端只保存令牌哈希，并按用户、凭证和 Action 做资源归属、限流、幂等与脱敏审计。
- 新增 TypeScript/Node 22 的 `@zhicui/cli`，支持机器可读 JSON/JSONL、稳定退出码、stdin 输入、远程 MCP，以及面向 Codex/Claude Code 的安装、诊断、状态与卸载流程。
- Windows 安装包集成 CLI 与本地 MCP 入口；本机能力只通过固定 Action 和受限桌面适配器开放，不提供任意 Shell，不暴露 Cookie、JWT、API Key 或临时媒体地址。
- 网页设置新增“Agent 接入”中心，用于创建/吊销 PAT、设备授权、查看权限与调用记录、复制 CLI/MCP 配置；网页不提供终端，Android 只提供授权与连接管理。
- 同步保持完全手动；扫码、验证码、目录选择通过 `waiting_for_user` 协作；敏感写操作使用服务端短期 `confirmation_id` 完成一次普通确认。
- 建立普通用户路由覆盖清单与 CI 校验，确保新增路由被归类为 Action、内部传输或资源流，管理端永不进入 Agent 能力表。

## Capabilities

### New Capabilities

- `agent-action-interface`: Action Registry、版本化调用协议、持久化 Run、事件流、取消、幂等、确认与稳定错误模型。
- `agent-credentials`: 浏览器设备授权、分 scope PAT、令牌轮换/吊销、凭据哈希、限流与脱敏审计。
- `agent-cli-mcp`: 跨平台 CLI、远程/本地 MCP、机器可读输出及 Codex/Claude Code 安装诊断工作流。
- `agent-access-center`: 网页与桌面端 Agent 接入中心、权限管理、安装指引、本机能力诊断和移动端只读管理体验。

### Modified Capabilities

- `durable-video-research-agent`: 现有 Agent Turn 与详细解析长任务需要适配统一 Run 状态、事件和取消语义，但内部研究工具继续保持私有。
- `desktop-douyin-private-sync`: 本机平台登录与采集增加共享桌面核心、用户隔离和跨进程互斥，并作为受限本机 Action 暴露。
- `multi-platform-video-library-import`: 链接导入、喜欢/收藏/作品同步和批量文稿能力增加显式 Action 映射，同时继续禁止自动同步与连续风控重试。

## Impact

- 后端：新增 Action、凭证、Run、事件、确认和审计模型/服务/路由，并对现有普通用户服务增加适配器；数据库启动迁移新增相关表。
- CLI：新增独立 Node 22 workspace、HTTP 客户端、MCP stdio/HTTP 适配、凭据存储与 Agent 配置安装器。
- 前端：设置页新增 Agent 接入中心和 API 客户端；桌面增加固定 IPC 诊断/安装动作，Android 隐藏本机 CLI 操作。
- 发布：Windows 构建打包 CLI，npm 先发布 Beta；后端能力通过开关逐步启用，旧 Web、Windows、Android 与 REST API 保持兼容。
- 安全：不开放 `/api/admin/*`、数据库、任意 Shell、原始平台会话、JWT/API Key、内部研究工具或临时媒体 URL。
