# Agent 基础接入发布

基础接入（`core`）独立开放指定公开链接导入、单条文稿提取、鉴权视频下载、资料问答、知识与计划。
博主入口仅开放 B站公开主页解析、前 20 条作品目录导入及只读任务观察，不自动提取文稿。
它不代表 [完整 Stable](./AGENT-INTERFACE-STABLE.md) 已验收。手动平台清单同步仅通过同账号桌面桥的
固定 login/status/sync/cancel 动作执行，必须另有 `local:invoke` 授权；服务端仅登记公开元数据并读取每日台账。
不开放云端账号列表同步、全量博主同步、付费画面解析或邮件自动化。平台缺少登录、桌面未启动或验证失败不会
被改写为健康；readiness 明示本机同步依赖客户端，不把云端健康当作用户平台已连接。

## 权限与可用性

- `AGENT_INTERFACE_PROFILE` 只能来自 root 持有的 `/etc/zhicui/agent-interface.env`。
  `dark` 写入 `false/full`，`core` 写入 `true/core`，`stable` 写入 `true/full`。
  旧单项状态文件只按 full 兼容读取；未知范围拒绝使用。
- core 的 Action 与 scope 是固定白名单；后端同时约束发现、直接调用、MCP 和授权。
  设备授权和 PAT 不允许预先授予未开放范围。默认设备授权只选当前公开的只读权限。
- core 的问答只读取已保存文稿，固定 `video_only`，不调用网络研究、画面解析或同步。
- `creator.resolve` 仅接受 `bilibili`。`creator.catalog.import` 必须同时持有既有的
  `library:write` 与 `creator:read`，仅接受 `platform/profile_ref/limit`，`limit` 固定为 20。
  它使用独立 `catalog_recent` 任务，不接受 `catalog_all`、`auto_transcribe`、全量或任意批量参数；
  任务与已保存作品仍按用户隔离，已有更多作品不会因为本次前 20 条刷新被删除或隐藏。
- `creator.runs.list`、`creator.sync.get`、`creator.sync.items.list` 只观察当前用户的任务。
  `platform.binding.status` 只读取当前用户的 B站绑定状态，不返回 Cookie 或令牌，也不发起绑定。
  `creator.create/sync.start/sync.retry/sync.cancel/remove` 与平台绑定写操作继续不开放。
  本次没有增加 scope，也不改变旧密钥的权限或期限。
- `core_capabilities_v1.json` 是独立版本化清单。完整 Stable 清单与依赖检查保持独立。
  生产证据必须同时绑定发布范围、目标 Git 提交中的清单原始字节 SHA-256 和冒烟结果。

## 发布顺序

仍使用 [生产发布闸门](./RELEASE-RUNBOOK.md)：

1. 同一目标提交先执行 `AGENT_RELEASE_MODE=dark`，创建加密备份并验证 PostgreSQL 结构。
2. 从该 dark 证据绑定的同一归档恢复到隔离库，运行已有双启动演练并清理临时库。
   本次含博主任务 operation 约束迁移，必须确认 `catalog_recent` 约束在两次启动后均有效。
3. 显式执行 `AGENT_RELEASE_MODE=core`。保持身份隔离、独立 Pepper、备份恢复、
   同 SHA 晋级、schema 指纹、真实资料 SSE 与引用、PAT/MCP 和吊销测试。
4. 确认能力清单精确匹配、未开放动作与 scope 被拒绝，之后才能记录 core 发布成功。

博主生产冒烟固定使用 `zhicui_production_smoke` 非管理员账号：核对有界 schema 与 MCP 发现、
随机 source/run 的资源归属拒绝、无效主页拒绝，以及独立 `library:read` PAT 无法导入目录。
只读凭证的 scope、固定期限必须保持不变，临时凭证由内层和外层清理双重吊销核验。
探针不请求真实博主主页、不下载或转写媒体；真实成功、取消、恢复与跨用户隔离由隔离测试覆盖。
正式用户的主页导入在发布后显式执行，并如实报告平台绑定或风控状态；目录获取失败不能计作已导入。

失败仍将总开关写回 dark，再回滚 runtime。不得设置跳过认证、问答或 Agent 冒烟的变量。
`stable` 继续要求平台真实主页测试、完整目录、视觉方案与邮件/自动摘要运行器全部就绪。

Jenkins 的发布参数包括 dark/core/stable；普通推送仍使用 dark。
仓库 Jenkinsfile 与实际任务必须同步，不能让旧 freestyle Shell 永久硬编码 dark。
Windows 内置 CLI 与独立 CLI 必须包含 UTF-8 DPAPI 修复及公开权限发现，才可完整使用新接入流程。
