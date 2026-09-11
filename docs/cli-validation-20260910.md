# CLI 1.0.1 安装与健壮性验收记录

后续更新：主项目的并发修复、最新安装包及 77 项 CLI / 23 项真实后端复验结果见 [2026-09-11 续验记录](cli-validation-20260911.md)。下文保留上一轮历史结果。

日期：2026-09-10。验收环境：Windows、Node.js 22.19.0，CLI 要求 Node.js 22.12.0 或以上。

本次已实际打包、全局安装知萃 CLI，并针对发现的问题修改为 **1.0.1**。最终全局安装包连接真实 FastAPI 的 23 项验收全部通过。此记录不代表 npm 已公开发布或生产 Agent 接口已开放。

## 当前发布状态

| 项目 | 本次结果 |
| --- | --- |
| CLI 目标版本 | `@zhicui/cli` 1.0.1 |
| 本机安装 | 已全局安装最终 1.0.1 包，`zhicui --version` 回读一致 |
| CLI 自动测试 | 56 项全部通过，TypeScript 编译通过 |
| 后端相关回归 | 47 项全部通过，命令见下文 |
| 真实 FastAPI 验收 | 源码入口与最终全局安装入口分别 23 项通过，使用临时 SQLite 和真实 HTTP 服务 |
| 生产设备授权 | 正式环境 `auth login` 返回 `INTERFACE_DISABLED` |
| 官方 npm 仓库 | `@zhicui/cli` 查询返回 HTTP 404，尚未公开发布 |
| 本次生产操作 | 没有开启生产 Agent 开关，没有发布 npm 包，没有更改生产数据 |

当前可安装本地生成的 `.tgz` 进行验收；在生产接口开放和 npm 正式发布之前，不能把 README 中的 `npx @zhicui/cli` 描述为已对外可用的安装方式。

## 已修复的问题

1. **命令输入与 Action Schema 不一致。** 按字段 Schema 处理输入，保留长视频 ID 和字符串原文，支持 JSON 数组、对象；补充参数错误、幂等键及确认要求的提示。
2. **业务记录 ID 被误用为 Agent Run ID。** 区分顶层 Agent `run_id` 与博主同步等业务记录 ID，修复终态等待、取消及等待用户时的退出结果。
3. **常用视频工作流入口不完整。** 补齐保存博主、多视频会话、从视频生成计划，以及明确设置任务完成状态的命令别名和说明。
4. **任务完成操作缺少目标状态语义。** 完成或取消完成使用显式布尔目标，重复操作不反向切换、不重复改写完成时间，并验证用户隔离。
5. **Windows 凭据更新存在空档。** 旧实现先删除已有凭据，再移动临时文件，导致并发读取短暂丢失登录态并可能触发迁移竞争。改为原子替换，临时文件使用 UUID，Windows 短暂文件占用时有界重试，失败仍保留旧凭据。
6. **损坏凭据可能泄露错误原文。** JSON 解析失败现在返回固定的 `CREDENTIAL_CORRUPTED`，不会把凭据内容片段带到终端。
7. **桌面桥描述及跳转检查不足。** 拒绝非法有效期、非预期地址组成和 HTTP 跳转；正常回环调用及账号绑定保持可用。
8. **Agent 接入忽略超时和 Claude 自定义目录。** Codex、Claude 子进程遵循 `--timeout`；Claude 的配置检查、备份与恢复遵循原生 `CLAUDE_CONFIG_DIR`。
9. **发行版本信息不一致。** 命令行、API 与 MCP 使用统一版本信息，本次目标版本为 1.0.1。
10. **只读凭据错误被误报为远端故障。** 对确实存在、但当前授权不包含的 Action 返回 `SCOPE_DENIED` 与退出码 4，不尝试执行写操作。

## Windows 凭据与桌面桥验证

使用临时 `ZHICUI_CONFIG_HOME` 和明确的假凭据验证了真实 Windows DPAPI 的保存、读取和删除，包含中文字段往返。检查磁盘产物为加密内容，未出现假令牌原文。没有读取或覆盖用户已有凭据。

新增并执行了以下回归：

- 连续 50 次凭据替换期间并发读取，登录态不出现缺失，文件竞争不导致更新失败。
- 损坏的凭据文件返回稳定错误，终端不包含凭据片段。
- 桌面桥非法、过期有效期被拒绝；307 响应不会访问跳转目的地。
- 正常桌面桥请求只进入预期回环服务，并携带当前账号绑定的桥令牌。

负责此范围的 20 项回归测试全部通过，含 Agent 配置管理测试。此处是 Windows 真机验证，不构成 macOS Keychain 真机验收。

## Codex 与 Claude Code 真实接入

实测版本：**Codex CLI 0.153.4**、**Claude Code 2.1.266**。

每个子进程的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 均指向独立临时目录；最终一轮没有使用知萃内部的配置路径 override，验证的是客户端原生目录语义。没有修改父进程配置环境。

两个客户端均完成：

1. `agent status` 检测到真实可执行程序。
2. `agent setup` 创建 MCP 配置及知萃 Skill。
3. 重复 `agent setup` 返回 `changed: false`。
4. `agent doctor` 的客户端接入检查通过。
5. `agent uninstall` 移除本次管理的条目，并恢复配置。

两份临时配置均恢复到客户端初始化后的原始内容。Claude 首次启动自身会写入迁移及启动元数据，因此比较基线在首次 `status` 初始化后采集。用户原有配置只读取字节计算 SHA256，实测前后摘要一致，没有输出配置内容。

这一组验证检查真实客户端配置接入；真实 MCP 工具发现与调用另由下述 FastAPI 验收覆盖。

## 真实后端工作流验证

真实 FastAPI 服务、临时 SQLite 与 CLI 子进程之间的 23 项验收已通过，报告标记 `mock_http: false`、`production_mutations: false`。覆盖范围包括：

- 未登录访问、PAT 登录、只读凭据拒绝写入、其他用户资料不可访问。
- 视频资料列表及详情、长视频 ID 的已就绪文稿复用。
- 异步批处理、真实 Run 事件续读、多视频会话创建及幂等重放。
- 计划创建、设置完成/未完成、重复完成保留时间、任务编辑。
- 真实 CLI MCP 工具发现与资料读取。

验收数据中已有的 3 条文稿全部保留，仅创建预期的 1 个会话与 1 个计划。此组测试不连接外部平台，不调用收费 ASR 或 LLM；它验证真实服务端业务逻辑及 CLI 协议，不替代外部平台抓取和模型质量测试。

## 已确认的功能边界

- 抖音通过**博主同步**或**桌面本机同步**进入资料库；`library import` 当前不支持抖音单链接导入，文档已明确说明。
- 同步全部博主目录仅保存目录，不会自动转写全部作品；近期 20/50/100 条或所选作品的文稿需要显式提交。
- 多视频问答需要先准备文稿，再使用 `ask sources` 返回的资料 ID 创建会话。
- 昨天资料范围依赖已完成的手动同步记录，不等同于平台真实点赞或收藏时间。
- 本机动作需要知萃桌面端运行并与 CLI 使用同一账号；本机 Run 不应交给云端 Run 接口轮询。
- 生产设备授权开关和官方 npm 发布尚未完成，本次没有代为开启或发布。

## 验收产物与复现

本次工作树：`D:/6month-worktrees/cli-validation-20260910`。

| 产物 | 位置 |
| --- | --- |
| CLI 1.0.1 安装包 | `D:/6month/.codex-artifacts/cli-validation-20260910/zhicui-cli-1.0.1.tgz` |
| 真实客户端接入脚本 | `D:/6month/.codex-artifacts/cli-validation-20260910/real-agent-validation.mjs` |
| 真实客户端接入报告 | `D:/6month/.codex-artifacts/cli-validation-20260910/real-agent-validation.json` |
| 真实 FastAPI 验收脚本 | `D:/6month/.codex-artifacts/cli-validation-20260910/real_backend_cli_smoke.py` |
| 源码入口 FastAPI 报告 | `D:/6month/.codex-artifacts/cli-validation-20260910/real-backend-source-report.json` |
| 最终全局安装入口报告 | `D:/6month/.codex-artifacts/cli-validation-20260910/real-backend-installed-report.json` |

CLI 完整回归与打包安装命令：

```powershell
Set-Location D:/6month-worktrees/cli-validation-20260910/cli
npm ci
npm test
npm pack --pack-destination D:/6month/.codex-artifacts/cli-validation-20260910
npm install --global --ignore-scripts D:/6month/.codex-artifacts/cli-validation-20260910/zhicui-cli-1.0.1.tgz
zhicui --version
zhicui creator --help --json
zhicui ask --help --json
zhicui plan --help --json
```

Windows 凭据、桌面桥及 Agent 管理回归；测试只使用临时目录：

```powershell
Set-Location D:/6month-worktrees/cli-validation-20260910/cli
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test test/credentials.test.mjs test/local-adapter.test.mjs test/agent-manager.test.mjs
node D:/6month/.codex-artifacts/cli-validation-20260910/real-agent-validation.mjs
```

真实 FastAPI 隔离验收，脚本自行创建临时数据库和测试授权，不需要在命令中提供密钥：

```powershell
& D:/6month/backend/.venv/Scripts/python.exe D:/6month/.codex-artifacts/cli-validation-20260910/real_backend_cli_smoke.py --repo D:/6month-worktrees/cli-validation-20260910 --cli-entry D:/6month-worktrees/cli-validation-20260910/cli/dist/index.js --report D:/6month/.codex-artifacts/cli-validation-20260910/real-backend-source-report.json
```

最终安装包验收应把上述 `--cli-entry` 替换为 `npm root --global` 返回目录下的 `@zhicui/cli/dist/index.js`，另存报告，不覆盖源码入口报告。

后端 47 项回归使用现有 unittest：

```powershell
Set-Location D:/6month-worktrees/cli-validation-20260910/backend
$env:JWT_SECRET='cli-contract-local-only-123456789'
$env:AGENT_TOKEN_PEPPER='cli-contract-local-pepper-123456789'
$env:PYTHONUTF8='1'
$env:LITELLM_LOCAL_MODEL_COST_MAP='True'
$env:DOUYIN_MCP_SERVER_ROOT='D:/6month/douyin-mcp-server'
& D:/6month/backend/.venv/Scripts/python.exe -m unittest tests.test_plan_task_completion tests.test_agent_interface_v1 tests.test_agent_interface_routes tests.test_agent_plan_creation -q
```

## 最终安装产物

- 实际命令入口：`D:/dev/node/zhicui.ps1`。
- 实际 Node 入口：`D:/dev/node/node_modules/@zhicui/cli/dist/index.js`。
- 安装版本：1.0.1；已安装入口的 23 项真实后端复验全部通过。
- 包大小：48,417 字节；35 个文件，内容仅包括编译后的 CLI、Skill、说明文档和包元数据。
- SHA256：`7ed978d55e6af164378302f1b4dc26471991c540d80bb3767db66cede4980b77`。

本次未在 macOS/Linux 真机运行凭据存储，也未做 PostgreSQL 并发写入压测；Windows 凭据、已安装命令与真实 FastAPI/SQLite 流程均已实测。生产开关和 npm 状态仍以上表为准。
