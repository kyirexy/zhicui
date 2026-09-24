# Agent 基础接入发布

基础接入（`core`）独立开放指定公开链接导入、单条文稿提取、鉴权视频下载、资料问答、知识与计划。
它不代表 [完整 Stable](./AGENT-INTERFACE-STABLE.md) 已验收，不开放平台账号批量同步、
本机桥、付费画面解析或邮件自动化。平台账号缺少登录或主页测试失败不会
被改写为健康；相应动作不进入基础接入的公开能力清单，也不能通过直接请求调用。

## 权限与可用性

- `AGENT_INTERFACE_PROFILE` 只能来自 root 持有的 `/etc/zhicui/agent-interface.env`。
  `dark` 写入 `false/full`，`core` 写入 `true/core`，`stable` 写入 `true/full`。
  旧单项状态文件只按 full 兼容读取；未知范围拒绝使用。
- core 的 Action 与 scope 是固定白名单；后端同时约束发现、直接调用、MCP 和授权。
  设备授权和 PAT 不允许预先授予未开放范围。默认设备授权只选当前公开的只读权限。
- core 的问答只读取已保存文稿，固定 `video_only`，不调用网络研究、画面解析或同步。
- `core_capabilities_v1.json` 是独立版本化清单。完整 Stable 清单与依赖检查保持独立。
  生产证据必须同时绑定发布范围、目标 Git 提交中的清单原始字节 SHA-256 和冒烟结果。

## 发布顺序

仍使用 [生产发布闸门](./RELEASE-RUNBOOK.md)：

1. 同一目标提交先执行 `AGENT_RELEASE_MODE=dark`，创建加密备份并验证 PostgreSQL 结构。
2. 从该 dark 证据绑定的同一归档恢复到隔离库，运行已有双启动演练并清理临时库。
3. 显式执行 `AGENT_RELEASE_MODE=core`。保持身份隔离、独立 Pepper、备份恢复、
   同 SHA 晋级、schema 指纹、真实资料 SSE 与引用、PAT/MCP 和吊销测试。
4. 确认能力清单精确匹配、未开放动作与 scope 被拒绝，之后才能记录 core 发布成功。

失败仍将总开关写回 dark，再回滚 runtime。不得设置跳过认证、问答或 Agent 冒烟的变量。
`stable` 继续要求平台真实主页测试、完整目录、视觉方案与邮件/自动摘要运行器全部就绪。

Jenkins 的发布参数包括 dark/core/stable；普通推送仍使用 dark。
仓库 Jenkinsfile 与实际任务必须同步，不能让旧 freestyle Shell 永久硬编码 dark。
Windows 内置 CLI 与独立 CLI 必须包含 UTF-8 DPAPI 修复及公开权限发现，才可完整使用新接入流程。
