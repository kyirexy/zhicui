# Agent 接入的真实 CLI 验证

`scripts/smoke-agent-cli.mjs` 从当前机器启动真实 CLI 子进程，验证正式接口和本机凭据库。它只接受用户名为 `zhicui_production_smoke` 的普通账号；不会使用管理员或真实用户，也不会修改默认 CLI profile。

覆盖：

- PAT 创建、仅创建时返回完整令牌、无回显 stdin 导入、系统加密凭据库保存。
- CLI `auth status --verify`、账号/资料/博主列表调用；只读凭据拒绝写操作。
- 本地 stdio MCP 的初始化、工具发现、真实资料列表调用及权限边界。
- PAT 撤销、重复撤销、撤销后调用被拒绝。
- CLI 设备授权 JSONL → 浏览器接口预览权限 → 专用测试账号确认 → CLI 轮询完成。
- 独立测试 profile 的过期元数据触发真实刷新，验证 refresh token 轮换。
- 最后撤销本次 PAT 和设备凭据，删除本次独立 profile；日志和报告不包含凭据、个人资料或授权码。

不创建/安装 Agent 配置、不触发平台同步、不调用付费模型、不下载用户资料。它验证接入与能力调用链路；真实视频下载/提取属于另一个工作流。

## 本地验证

先构建 CLI，再用真实临时 FastAPI/SQLite 分别跑 Core、Full 两档完整流程。临时账号、资料和数据库只在临时目录存在，结束后清理；不读取原有数据库。Core 还执行生产共用的已存资料/模型读取、排除动作直调/MCP 拒绝和排除 scope 签发拒绝。

```powershell
npm --prefix cli run build
.\backend\.venv\Scripts\python.exe scripts/test-agent-cli-local.py
```

需要 Node 22.12+、后端现有 Python 依赖及系统凭据库。Windows 使用 DPAPI；不会回退到明文凭据文件。无图形凭据库的 Linux 服务器应改从开发者 Windows/Mac 机器运行，不能为了测试开启明文凭据。

## 本机连接正式环境

先按现有生产流程准备专用普通测试账号，开启 Agent 接口。脚本默认固定正式域名 `https://luxai.cn`；开发调试只额外允许回环地址。

```powershell
$env:SMOKE_LOGIN_EMAIL = '专用冒烟账号邮箱'
$env:SMOKE_AGENT_PROFILE = 'core'
$env:SMOKE_PASSWORD_FILE = '仅当前用户可读取的密码文件绝对路径'
$env:SMOKE_REPORT_FILE = 'D:\6month\deploy\artifacts\agent-cli-smoke.json'
node scripts/smoke-agent-cli.mjs
```

也可以传 `--password-stdin`，把受保护密码源的输出通过进程管道直接交给脚本。不要把密码/Token 放在命令参数、聊天、普通项目文件或终端日志。`SMOKE_REPORT_FILE` 的父目录需预先存在。

可设置 `SMOKE_CLI_ENTRY` 指向验收后的 CLI `dist/index.js`，默认使用仓库的 `cli/dist/index.js`。CLI 同目录必须有 `credentials.js`，因为验证需要读取本次测试自己的系统凭据，以检查刷新和清理。正式个人 profile 完全不参与此操作。

脚本失败会返回非零退出码；只输出检查项、CLI 版本、工具数量、清理结果以及经过约束的错误码。`cleanup: false` 表示凭据撤销/本机清理未能确认，需要排查专用测试账号，不能把它当作通过。

## Core / Full 发布证据

`SMOKE_AGENT_PROFILE` 必须与公开 capabilities 的 `release_profile` 一致，默认是 `full`。Core 是明确的 38 个 Action / 10 个 scope：使用已保存资料和已有文稿进行问答、知识整理和计划，读取已存博主与模型信息。Core 不开放新同步/转写、详细视频分析、自动摘要、邮件、本机动作、模型密钥修改；这些动作的 descriptor、直接调用和 MCP 调用都必须拒绝。

`scripts/smoke-agent-interface.sh` 在 Core 使用独立 `core_capabilities_v1.json`，按精确 scope/action IDs 和 descriptor SHA-256 对账，保留 PAT 全生命周期、MCP 和管理端边界。Core 必須开启两个哨兵，实际调用现有资料/知识/计划/模型读取，验证排除动作和权限；并执行 `ask.turn.start`、真实 `text/event-stream` 增量、唯一终态、最终固定哨兵答案与原文引用。Full 保留原有解析目录、自动摘要/邮件运行器、模型目录及真实问答的全部检查。

生产脚本接收以下部署参数：

```bash
SMOKE_AGENT_PROFILE=core
SMOKE_AGENT_CAPABILITY_MANIFEST=/固定目标runtime/backend/app/agent_interface/core_capabilities_v1.json
SMOKE_REQUIRE_AUTHENTICATED=1
SMOKE_REQUIRE_AGENT_SSE=1
SMOKE_REQUIRE_AGENT_INTERFACE=1
```

接口烟测另外要求 `SMOKE_REQUIRE_AGENT_RUNTIME_SENTINELS=1`、`SMOKE_REQUIRE_AGENT_ASK_SENTINEL=1`、固定冒烟 `SMOKE_AGENT_SOURCE_ID` / `SMOKE_AGENT_THREAD_ID` 和受保护的 `SMOKE_BROWSER_TOKEN_FILE`。`smoke-production.sh` 会传递这些值。Core 不能关闭其中任一必需检查以制造通过结果。

生产 evidence 和本机 CLI report 都记录 `agent_release_profile`、`agent_capability_manifest_sha256`，后者计算指定 manifest 的实际文件字节。发布证据仓应将两字段与目标版本和验收清单绑定。Core readiness 要求接口和产品依赖 `ready`、自动摘要运行器明确 `not_required`；档位通过 capabilities 精确核验。Full 仍要求三个检查全部 `ready`。

可执行 `python scripts/generate-agent-core-manifest.py` 根据明确 `CORE_ACTION_IDS` 重新生成 Core 清单；该命令不修改 Full Stable 清单。变更 manifest 后必须重新跑相应验收，不能只更新哈希。

桌面可在任何登录状态执行 `zhicui capabilities --public --json --non-interactive` 读取 `release_profile`、`scopes`、`limitations`，不会读取或发送已保存凭据。默认 `auth login` 求原有只读默认 scope 与当前公开 scope 的交集；显式 `--scopes` 保持原样，未开放权限由服务端拒绝。

## 版本说明

1.0.1 已有 PAT 和设备授权，但 1.0.2 增加了桌面接入需要的设备授权 JSONL 事件、完整诊断和配置迁移。1.0.2 还固定了 DPAPI 管道 UTF-8，解决真实 PAT 前缀省略号在某些 Windows 代码页下导致 `CREDENTIAL_CORRUPTED` 的问题。

只更新网页不会替换已经安装的 CLI。完成验证后，通过已有可信发行包更新客户端连接组件；不要使用未验证的远程安装脚本或覆盖未知自定义 MCP 配置。
