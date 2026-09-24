# Agent 接入生产验收（2026-09-24）

## 已发布的产品行为

- 主侧边栏新增独立「Agent 接入」，旧设置入口跳转至 `/agent-access`；网页登录后也有独立入口。
- PAT 的创建、权限、有效期与连接管理在独立页面直接展示。完整令牌仅创建时显示，关闭后清除；默认只授予 `library:read`。
- 服务端开放明确的 `core` 范围：38 个 Action、10 个 scope，支持已保存资料、已有文稿问答、知识与计划。不开放平台同步、链接导入、下载、提取、画面解析、自动摘要、邮件或本机桥接。
- 设备授权先发现服务端支持的权限，避免请求未开放范围。Windows DPAPI 管道固定 UTF-8，修复凭据读取失败。
- CLI 1.0.3 增加官方 Windows Codex 安装目录识别，解决 Codex 桌面已安装却未进入普通注册 PATH 的情况；保留显式配置与 PATH 优先级。

## 不可变版本与生产证据

| 组件 | 已发布版本 / 来源 |
| --- | --- |
| Web / API | `39127c7d81c340cf746d65b6056d543f479db76c` |
| 生产 runtime | `manual-agent-core-39127c7-20260924T0358` |
| Windows | `1.1.16` Beta，来源 `18e28ecbbb9e6c8dc80e0e8af75b8906f5dfbefd` |
| 本机全局 CLI | `1.0.3`，同 Windows 来源提交 |
| Core 清单 SHA-256 | `d6e7645960c83ad196f7209fe140ba0d2b279d8fb48ce2e4e434031b8fc8f0fe` |
| Windows 安装包 SHA-256 | `91453b79c51a067e5505cc800cfc37784f9e36af1b431192f90f3ff548f369e0` |

Windows 按既有 Beta 策略发行（未签名，不冒充 Stable）；安装包共 93,671,257 字节。
后续 Codex 识别修复仅涉及 CLI / 桌面，通过持久 Windows 发行源独立发布，没有重建未改动的后端。
官网和客户端从持久 `windows/beta.json` 读取新版本，下载服务也优先使用该清单。

服务器 root-owned 证据位于 `/var/lib/zhicui-deployments`：

- dark：`jenkins-zhicui-deploy-305.json`，SHA-256 `974daf9ce39b1dcd66c7c6bc2590d54504182430e58a0b7d65f60745469049c3`。
- 同备份双启动：`agent-schema-rehearsal-20260924T035531Z-39127c7d81c3.json`，SHA-256 `f7d6a90f3732999cb0bc2fc0d587719c82fdc9e9e094db6f024dc1440fa44236`。
- core：`manual-agent-core-39127c7-20260924T0358.json`，SHA-256 `a2ccf4c1e3c72baccf5bce2cb85da9b63e66b09cecdb65443c941a0b00097989`。

完整 core → dark → 同备份恢复演练 → smoke 证据链已由原 root helper 复验。数据库结构指纹不变，隔离演练未启动 worker，隔离库与明文临时目录均已清理。健康检查和 readiness 均通过。备份继续采用原有明确配置的 `local_only`，不宣称已完成异地备份。

## 实际验收

- 后端全量：848 项，1 项按环境跳过，其余通过；前端生产构建通过。
- CLI 全量：100/100；真实普通 Windows 注册 PATH 下成功发现官方 `codex-cli 0.153.4`。
- 桌面 Agent 接入、更新策略及发行契约检查通过。
- 正式发布冒烟使用专用普通账号与固定文稿，验证真实 AI SSE 增量、最终答案和来源引用，以及 Action / PAT / MCP 和未开放范围的拒绝。
- 正式网页无 mock 验收：真实表单登录、独立入口、1440×1000 首屏 PAT、最小权限创建、真实复制、关闭、鉴权、UI 吊销和原 PAT 立即 401；无浏览器运行错误。
- Windows 全局 CLI 1.0.3 连接正式域名，10/10 通过：PAT stdin / DPAPI、仅一次显示、列表调用、只读权限边界、stdio MCP 发现和调用、撤销与重复撤销、设备授权、真实 refresh 轮转。测试只读授权下发现 8 个 MCP 工具。
- 安装包、manifest、feed、blockmap 均从公网完整回读并核对 SHA-256；未跟随下载重定向。

本地脱敏证据：

- `.artifacts/agent-cli/production-core-global-1.0.3.json`
- `.artifacts/windows/beta-1.1.16-public-readback.json`
- `output/agent-access-validation/production-ui/2026-09-24T04-17-53-613Z/report.json`

所有本次测试 PAT / device 凭据和临时 CLI profile 已回收；剪贴板只在仍为测试令牌时清空。
专用测试账号的临时密码租约已通过 CAS 恢复原哈希，未发现并发改密，明文已删除。
没有替用户授权个人账号，也没有改写用户已有 Codex / Claude 配置。

## 后续运维

当前生产开放的是 core。完整 Stable 的平台同步与其他依赖门禁保持不变，不能把 core 验收当作完整 Stable 验收。
Jenkins 现有 freestyle job 的普通推送仍执行 dark；下一次后端发布需按同提交完成 dark、恢复演练与 core 晋级。
本次后端提交已推至 Gitee；仅桌面 / CLI 的后续独立发行提交已推至 GitHub，未触发第二次后端 dark。
操作说明见 `deploy/AGENT-INTERFACE-CORE.md` 与 `docs/agent-cli-connection-smoke.md`。
