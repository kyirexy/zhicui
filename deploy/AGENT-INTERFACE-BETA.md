# 知萃 Agent 接口 Beta 发布手册

> 历史灰度资料：当前正式发布入口是 [`AGENT-INTERFACE-STABLE.md`](./AGENT-INTERFACE-STABLE.md)。
> 本文仅用于核对旧 Beta 凭证、清单和回滚语义，不得作为新的上线步骤或验收证据。

本文只描述 `open-agent-cli-interface` 的分阶段发布。它不会替代现有 Web、Windows、Android 或 REST API，也不会在服务器运行 Agent 或远程控制用户电脑。

## 发布边界

- 远程接口只允许 `ProductActionRegistry` 中显式注册的普通用户 Action。
- `/api/admin/*`、数据库、任意 Shell、内部视频研究工具、Cookie、JWT、API Key、本机路径和临时媒体地址不得进入 capabilities、MCP 或审计载荷。
- 同步只能由用户或 Agent 明确调用；不得建立自动同步、离线队列或风控后的连续重试。
- Windows 本机能力只通过签名客户端中的固定动作开放。Web 与 Android 不能调用本机 CLI/采集器。
- Windows 客户端运行时只在 `127.0.0.1` 随机端口启动本机桥，短期随机凭证写入当前系统用户的 LocalAppData；凭证每 20 分钟轮换，并在登录账号切换或退出时立即撤销。桥接描述文件只保存不可逆的用户哈希，不含 Cookie、JWT、API Key、profile 路径或媒体临时地址。
- 本机扫码/验证码通过官方浏览器窗口完成；删除缓存、断开平台会话和安装更新由 Electron 原生确认框确认一次，Agent 不能在请求参数中伪造批准。
- 密码、注销确认短语与 API Key 只允许通过安全直连接口和 CLI 无回显 stdin 输入；这些 Action 不进入通用 Run，也不发布为 MCP 工具。

## 生产配置

在服务端环境中显式设置：

```dotenv
AGENT_INTERFACE_ENABLED=false
AGENT_INTERFACE_USER_ALLOWLIST=<内部测试用户的不可变 user_id，逗号分隔>
AGENT_INTERFACE_ACTION_ALLOWLIST=account.me,library.list,library.get
AGENT_TOKEN_PEPPER=<独立随机值，不提交仓库>
```

初次部署保持接口关闭，以便先创建表并验证旧客户端。`AGENT_TOKEN_PEPPER` 应通过密码管理器/Jenkins secret 注入；不得复用公开配置或写入日志。
Beta 开启时必须先配置用户与 Action 白名单；空白名单表示全量开放，只适合全部验收完成后的 Stable。管理员身份不会绕过白名单。

## 分阶段顺序

1. **协议暗发布**：发布后端 Registry、凭证和 Run 表；`AGENT_INTERFACE_ENABLED=false`。验证健康检查、旧登录、资料库、问答、计划、同步与管理端不受影响。
2. **接入中心 Beta**：开启接口，用 `AGENT_INTERFACE_USER_ALLOWLIST` 只放行内部测试账号，并用 `AGENT_INTERFACE_ACTION_ALLOWLIST` 只开放最小只读 Action；验证 PAT 创建后只显示一次、scope、吊销、最近调用和跨用户隔离。
3. **CLI / MCP Beta**：发布 npm Beta 与 Windows Beta 包。真实测试 `npx @zhicui/cli`、远程 MCP、本地 stdio MCP、Codex 和 Claude Code 的 setup/status/doctor/uninstall。
4. **写能力灰度**：逐域开启资料导入、手动同步、问答、知识、计划和反馈。删除、注销、更新安装、密钥修改必须通过一次服务端确认；详细解析继续走报价确认。
5. **Stable**：路由分类、Schema、scope、凭证生命周期、幂等、确认防重放、秘密脱敏、CLI 输出纯净度、Run 续读/取消及 Web/Windows/Android 回归全部通过后转稳定通道。

## 必做冒烟

```text
GET  /api/agent-interface/v1/capabilities
POST /api/agent-interface/v1/actions/account.me/invoke
POST /api/agent-interface/v1/actions/<long-action>/invoke
GET  /api/agent-interface/v1/runs/<run_id>
GET  /api/agent-interface/v1/runs/<run_id>/events
POST /api/agent-interface/v1/runs/<run_id>/cancel
POST /mcp  initialize / tools/list / tools/call
```

同时验证：

- 普通 PAT 请求 `/api/admin/*` 被拒绝；管理员创建的 PAT 也不能发现管理 Action。
- 另一个用户的资源和 Run 统一返回不泄露归属的信息。
- 重复幂等键复用原 Run；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。
- SSE/JSONL 断线续读顺序单调，只产生一次终态事件。
- 日志、数据库和最近调用中搜索不到 `zcp_` 完整令牌、Authorization、Cookie、API Key、本机路径或临时媒体 URL。
- Codex/Claude 重复 setup 不生成重复配置；uninstall 只移除知萃拥有的条目。
- 从干净 checkout 执行 Windows 打包，确认打包脚本先安装并构建 `cli/`，unpacked 资源中存在 `cli/index.js` 与 `cli/skills/zhicui/SKILL.md`，不依赖被 gitignore 的本地 `cli/dist/`。
- 启动 Windows 客户端后执行 `zhicui agent doctor --json`，确认本机桥仅绑定 loopback；并验证同一用户+平台的界面同步与 Agent 同步只有一个获得锁。

## 回滚

1. 通过独立 kill-switch 关闭接口并复验，不修改共享 `backend/.env`：
   `sudo /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh dark && sudo systemctl restart videocapsule-backend`；capabilities 必须返回 `503/INTERFACE_DISABLED`。
2. 吊销 Beta PAT 与设备连接；不删除用户原有资料、会话、知识或计划。
3. npm 标记 Beta 版本为 deprecated，并将 Windows Beta manifest 回退到上一可用版本。
4. 保留新增表和审计记录，便于排障；旧客户端继续使用既有 REST API。

## 稳定版发布凭据

npm token、Windows 代码签名证书、服务器 SSH 密钥与 Jenkins 凭据均由发布环境注入。仓库只保存构建与验证脚本，不保存任何发布秘密。

## 2026-09-03 本地 Beta 验收记录

- Registry：共 120 个普通用户 Action；102 个云端 Action 可执行，18 个 Windows 本机 Action 只在桌面桥在线时开放。
- 后端：Agent 专项 140 项、全量 378 项测试通过（另有 1 项按环境跳过）；精确路由清单、安全直连、持久批任务、计划与详细解析确认、模型安全和平台导入相关回归均通过。
- CLI：35 项测试通过；`npm pack --dry-run` 生成 33 个文件，协议输出与秘密 stdin 约束通过。
- Web：TypeScript、6 项接入中心测试、40 项 Agent 流式与移动端一致性测试，以及包含 38 个页面的 Next.js 生产构建通过。
- Windows：类型检查、固定 IPC/账号隔离/更新策略/发布契约验证通过；解包产物中的 CLI 与当前构建 SHA-256 一致，且包含通用 Skill。
- OpenSpec：`openspec validate open-agent-cli-interface --strict` 通过。

以下属于发布环境阻塞，不在开发机伪造完成状态：

- npm Beta 仍需发布环境提供 npm token，并执行真实安装、升级和卸载冒烟。
- 当前本地 Windows 解包产物未签名；转 Stable 前必须由发布环境注入代码签名证书并验证签名链。
- Codex 与 Claude Code 已通过隔离配置夹具测试；转 Stable 前仍需针对届时真实发布版本各做一次干净安装冒烟，不能硬编码调研材料中的易变配置字段。
- 功能旗标继续默认关闭；生产灰度、npm 发布和 Windows 安装包发布尚未执行。
