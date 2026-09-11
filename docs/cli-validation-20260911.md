# CLI 1.0.1 凭据并发修复与安装复验

日期：2026-09-11（Asia/Shanghai）。本次接续 9 月 10 日的 CLI 验收，将独立工作树中未合入的凭据修复恢复到 `D:/6month`，补齐并发认证修复并重新全局安装。本记录中的安装包和校验值取代前一轮产物；没有提交、推送或发布 npm，也没有修改生产开关或生产数据。

## 本次修复

1. **Windows 持续读取阻塞凭据替换。** 写入取得门控后暂停新读取，已有读取完成后原子替换；文件占用有界重试，失败保留旧凭据。DPAPI 和明确启用的文件存储都使用此机制，暂时超时不会触发明文降级。
2. **慢刷新锁被按时间误回收。** 锁目录和包含 PID、UUID 的所有权标记一起原子出现，只在确认进程退出时回收。活跃持有者即使目录时间很旧也不会被抢锁。
3. **释放中崩溃遗留空锁。** 新版使用 `v2.lock` 协议，其空目录不表示活跃所有者，可安全回收；旧协议的空目录可能仍在刷新，只等待、不按时间删除。
4. **同一显式凭据文件有多个刷新锁。** 文件存储按规范化完整路径生成协调标识；不同 profile 共享同一文件时，共用刷新和读改写锁。
5. **迟到 401 导致重复刷新。** 普通请求和事件流使用发请求时的凭据快照，同一登录会话已经完成刷新时复用结果；排队期间令牌再度过期时使用最新刷新令牌。
6. **慢刷新覆盖退出或新登录。** 凭据保存、删除、旧格式迁移和条件替换共用独立的修改锁；仅当登录种类、创建时间、访问令牌、刷新令牌仍匹配观察值时保存刷新结果。401 重试使用原会话的刷新快照，避免切换成另一个账号执行旧操作。
7. **失败 PAT 校验覆盖其他命令的登录态。** 校验失败只回滚本次写入的临时凭据，保留并发退出或新登录的结果。

实现集中于 `cli/src/credentials.ts`、`cli/src/api-client.ts`、`cli/src/main.ts`，并更新 CLI README 和 CHANGELOG。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `cd D:/6month/cli; npm test` | TypeScript 编译通过，77/77 项通过，无跳过 |
| Windows DPAPI | 假凭据加密保存、中文读取、删除通过 |
| 持续读取压力 | 4 个独立读取进程期间，100 次原子更新全部完成，无凭据缺失 |
| 刷新锁压力 | 4 个不同 profile 的进程共享同一显式凭据文件，80 次临界区操作无重叠，计数完整 |
| 崩溃恢复 | 空 v2 锁、强制终止持锁子进程后的锁均可恢复，凭据保留 |
| 认证竞态回归 | 13 项通过，覆盖迟到 401、非轮换刷新、旧令牌、退出/新登录、PAT 失败回滚与重试快照 |
| 后端现有回归 | 47/47 项通过，内存 SQLite 和假授权配置 |
| 已安装包真实后端复验 | 23/23 项通过，真实 FastAPI HTTP、临时 SQLite、实际全局安装入口 |
| 已安装编译文件一致性 | 安装后的 30 个 dist 文件逐个 SHA256 比较，与通过测试的编译结果一致 |
| 包内容检查 | 35 个文件，仅编译文件、Skill、README、CHANGELOG、RELEASE 与包元数据 |
| 本机命令版本 | `zhicui --version` 回读 1.0.1 |

23 项真实后端验收覆盖未登录、PAT 登录、资料与博主查询、长视频 ID 文稿复用、异步批处理、事件续读、多视频会话及幂等重放、计划创建和任务完成/重开/编辑、MCP 工具发现及读取、只读权限拒绝写入、用户资料隔离。报告标记 `real_fastapi: true`、`mock_http: false`、`production_mutations: false`，保留 3 条既有测试资料，只新增预期的 1 个会话与 1 个计划；外部连接及 ASR/LLM 调用均为 0。

本轮没有重复执行真实 Codex/Claude 配置安装与卸载；其既有测试包含在 77 项 CLI 测试内，9 月 10 日的真实客户端配置验收记录仍单独保留。真实 MCP 工具发现与读取已使用本轮安装包复验。

## 安装产物

- 包：`D:/6month/.codex-artifacts/cli-validation-20260911/zhicui-cli-1.0.1.tgz`
- 大小：50,857 字节；展开后 194,833 字节。
- SHA256：`f6bbe001644c1f9a00ef17ca53be181a351d28486fdcb9c10a3ffbb1a99b7440`
- 全局命令：`D:/dev/node/zhicui.ps1`
- 全局 Node 入口：`D:/dev/node/node_modules/@zhicui/cli/dist/index.js`
- 真实后端报告：`D:/6month/.codex-artifacts/cli-validation-20260911/real-backend-installed-report.json`

使用本地包重新安装：

```powershell
npm install --global --ignore-scripts D:/6month/.codex-artifacts/cli-validation-20260911/zhicui-cli-1.0.1.tgz
zhicui --version
```

真实后端复现命令（脚本自行创建隔离数据库、测试授权及本机 HTTP 服务，不需要提供真实密钥）：

```powershell
$env:PYTHONUTF8='1'
& D:/6month/backend/.venv/Scripts/python.exe D:/6month/.codex-artifacts/cli-validation-20260910/real_backend_cli_smoke.py --repo D:/6month --cli-entry D:/dev/node/node_modules/@zhicui/cli/dist/index.js --report D:/6month/.codex-artifacts/cli-validation-20260911/real-backend-installed-report.json
```

后端回归模块：`tests.test_plan_task_completion`、`tests.test_agent_interface_v1`、`tests.test_agent_interface_routes`、`tests.test_agent_plan_creation`，使用现有 `unittest`，未引入测试框架。

## 发布与兼容边界

9 月 10 日查询的 npm 包尚未公开、生产设备授权返回 `INTERFACE_DISABLED`；本轮没有重新探测这两项，也没有代为发布或开启生产接口。本轮验收结论是主项目修复、全局安装和独立后端流程通过，不代表正式账号云端登录已开放。

升级时应先结束旧版 CLI/MCP 进程。新版在取得 v2 锁前后检查已有旧锁；旧版并不识别 v2 协议，因此不保证旧、新版本混跑时的互斥。遇到旧锁超时，只能在确认旧版进程全部结束后检查残留空目录。Windows 本机验证不替代 macOS Keychain、Linux Secret Service 真机测试；本轮没有做 PostgreSQL 压测或外部平台抓取、收费模型调用。
