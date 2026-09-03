## Context

知萃目前同时存在 FastAPI 用户路由、持久化 Agent Turn、Electron 本机账号/媒体 IPC，以及仅供视频研究编排器使用的私有工具运行时。它们没有统一的能力元数据、scope、幂等、稳定错误或机器输出约束，本地 Agent 只能依赖网页操作或直接理解内部 API。客户端还必须保证抖音会话、本机路径和媒体地址不离开设备，且同步永远由用户或 Agent 明确发起。

本变更面向用户自行安装的 Codex、Claude Code 等本地软件。后端只提供云端产品能力和授权协议，不运行云端 Agent，也不建立从服务器远程控制用户电脑的中继。

## Goals / Non-Goals

**Goals:**

- 以一个版本化 Action Registry 作为普通用户能力的唯一机器契约。
- 让 HTTP、CLI、MCP、网页接入中心和 Windows 固定 IPC 使用同一 Action 描述。
- 提供可撤销、最小 scope、可审计且不泄露秘密的 Agent 凭证。
- 为同步和长任务提供可恢复 Run、单调事件、取消、幂等和一次终态。
- 使 CLI 对人类和 Agent 都稳定：stdout 协议纯净、stderr 诊断、稳定退出码。
- 保持既有 Web/Windows/Android/REST 客户端兼容，并允许功能开关灰度。

**Non-Goals:**

- 不建设网页终端、云端 Agent、远程桌面或任意 Shell。
- 不开放管理端、数据库、原始 Cookie/JWT/API Key、临时媒体地址和内部研究工具。
- 不让 Android 运行本机 CLI 或平台采集器。
- 不引入自动同步、离线同步队列或风控后的自动连续重试。
- 首版不要求 macOS/Linux 拥有 Windows 平台私有采集能力；它们通过 npm/npx 使用云端能力。

## Decisions

### 1. Registry 是声明与处理器绑定，不是路由反射

`ProductActionRegistry` 由显式注册的不可变 `ProductActionDefinition` 组成。定义包含 `id`、`version`、中文标题/说明、输入/输出 JSON Schema、scopes、风险标签、执行位置、运行类型、幂等策略、稳定错误码和 handler。HTTP 路由不会自动枚举 FastAPI，也不会把内部函数动态变成工具。

这样可以在 CI 中审查普通用户能力边界，并确保 `/api/admin/*`、研究内部工具和资源代理永远不会因新增路由而自动暴露。替代方案“直接把 OpenAPI 转 MCP”会泄露内部传输细节和不稳定字段，因此不采用。

### 2. v1 统一 Envelope 与持久 Run

所有调用返回 `api_version/action/request_id/run/status/data/error/meta` Envelope。即时只读动作可在同一请求内成功；流式或长任务先创建 Run，再追加带单调 `sequence` 的事件。每个 Run 只允许一个终态事件，状态机只允许合法前进；SSE 支持 `Last-Event-ID` 续读，JSONL 由 CLI 从同一事件模型渲染。

Run、事件、幂等键、确认和凭证均落 PostgreSQL/SQLite 兼容表，不依赖进程内字典。现有 Agent Turn、博主同步、详细解析和批量文稿先通过适配器映射；旧 API 保留，避免一次性迁移风险。

### 3. 凭证分为登录会话、PAT 与设备授权

网页用现有 JWT 管理凭证，但 Action 调用接受专用 Bearer access token/PAT。服务端只保存带 pepper 的 SHA-256 哈希、前缀、scope、所有者、到期和吊销时间；令牌明文只在签发时返回一次。PAT 默认 90 天，浏览器设备流使用短期 user code/device code，批准后签发短期 access token 与可轮换 refresh token。

CLI 优先使用系统凭据库；不可用时使用权限受限的用户配置文件并明确诊断。配置文件不保存 Cookie、平台 profile、JWT 或 BYOK。Android 只管理已授权连接。

### 4. scope、资源归属、限流和审计在 handler 前统一执行

调用顺序固定为：解析专用凭证 → 校验 Action 启用/版本 → scope → 用户资源归属 → 共享限流 → 幂等 → 确认/计费门槛 → handler → 脱敏审计。管理员身份不会扩展 Agent 权限；Registry 本身没有 admin Action。

v1 scope 按域组织，例如 `library:read`、`library:write`、`creator:sync`、`ask:run`、`knowledge:write`、`plan:write`、`account:manage`、`local:invoke`。高风险写操作使用更窄 scope，并仍需服务端确认。

### 5. 一次普通确认由服务端签发、界面完成

删除资料、账号注销、本地文件删除、更新安装和密钥修改返回 `CONFIRMATION_REQUIRED` 与短期、单用途 `confirmation_id`。确认记录绑定用户、凭证、Action 和规范化参数摘要；网页或受信桌面界面完成一次批准，Agent 不能自签或复用。账号注销继续要求密码和确认短语；详细解析继续使用现有报价确认。

### 6. 本机能力通过 desktop-core 与受限桥接执行

平台登录、采集、本地媒体和更新安装被描述为 `execution_location=local_windows`。CLI 本地 MCP 发现受信任桌面能力并只调用固定动作。第一阶段复用 Electron 主进程，通过命名本机 IPC/loopback 握手暴露受限接口；纯校验、会话路径推导、锁键和结果规范化下沉到不依赖 Electron 的 `desktop-core`。所有平台会话按知萃用户隔离，并以用户+平台加跨进程锁。

远程 MCP 仅注册 `execution_location=cloud` Action。本地 MCP 合并云端与本机能力，但不提供 shell/filesystem 通配工具。扫码、验证码和目录选择将 Run 置为 `waiting_for_user`，完成后继续。

### 7. CLI 使用 Node 22 ESM 与零隐式输出

CLI 作为独立 `@zhicui/cli` 包，入口为 `zhicui`。命令只调用 capability/action/run 协议；`--json` 输出一个 Envelope，`--jsonl` 每行一个事件，stdout 不输出日志/进度色彩，诊断进入 stderr。退出码固定映射：0 成功、2 用法/Schema、3 认证、4 权限、5 确认/等待用户、6 限流、7 远端失败、8 超时/取消、9 本机能力不可用。

MCP stdio 使用同一 Registry 元数据生成工具 Schema。`agent setup` 先检测实际 Codex/Claude Code 安装版本和配置格式，备份后通过临时文件+原子替换更新；重复安装幂等，卸载只移除知萃拥有的区块。

### 8. 网页提供接入中心而非终端

设置页新增“Agent 接入”，展示安装命令、远程 MCP URL、PAT/设备连接、scope、最后使用、调用审计和吊销。Windows 再显示“连接 Codex”“连接 Claude Code”及诊断按钮；这些按钮只调用固定 desktop bridge。Web/macOS/Linux 隐藏本机按钮，Android 只显示连接管理。

## Risks / Trade-offs

- [Action 覆盖面很大，容易把内部 API 当产品能力] → 使用显式清单、CI 路由分类和默认关闭；未分类普通用户路由不允许合并。
- [长任务迁移可能破坏旧客户端] → 先用适配器双轨映射，旧路由继续返回原响应；Run 协议通过开关逐动作启用。
- [PAT 泄露可造成用户数据访问] → 最小 scope、90 天默认过期、只存哈希、系统凭据库、即时吊销、限流和最近调用可见。
- [本机 IPC 被恶意网页调用] → 桌面握手绑定当前登录用户、随机会话密钥、固定动作白名单、来源校验、输入 Schema 和跨进程锁。
- [CLI 配置格式随 Codex/Claude 版本变化] → 运行时探测实际版本，保留备份并原子写入；诊断不硬编码调研示例字段。
- [远程 MCP 与 CLI 的输出漂移] → 两者从 capabilities 和 JSON Schema 生成工具/命令，不复制手写协议类型。
- [SQLite 开发环境共享限流能力有限] → 以数据库事务实现正确性；生产 PostgreSQL 使用行级唯一约束与原子更新。

## Migration Plan

1. 上线新增表、Registry 和关闭状态的 Agent v1 路由；为少量只读 Action 建立冒烟测试。
2. 上线凭证与网页接入中心，默认只允许 `capabilities` 和用户本人只读能力。
3. 发布 npm Beta 与 Windows Beta CLI；真实验证 Codex/Claude MCP 工具发现、安装和卸载。
4. 逐域启用普通用户读写 Action，并将长任务适配到持久 Run；保留旧 API。
5. 路由分类、跨用户、scope、幂等、确认、秘密脱敏和全客户端回归全部通过后转 Stable。

回滚时关闭 Agent 接口功能开关并吊销 Beta 凭证；新增表和旧 API 可保留，不需要回退用户数据。CLI 能识别 `INTERFACE_DISABLED` 并给出可操作提示。

## Open Questions

- npm 正式发布组织与签名证书在转 Stable 前由发布负责人配置；本实现保留 Beta 发布脚本但不在源码中保存凭据。
- Windows 本机桥的最终传输可在 Beta 冒烟后从命名 loopback 升级为 named pipe；协议与 Action Schema 不变。
- 首批全量开放 Action 将由路由覆盖清单和风险审查决定，未完成确认/计费适配的写 Action 保持 `available=false`。
