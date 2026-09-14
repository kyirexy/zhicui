# 客户端 Agent 简化接入

日期：2026-09-14。Windows Beta 1.1.8，内置 CLI 1.0.2，网页 1.1.11。

## 行为

- 设置中的 Agent 接入提供明确的 Codex / Claude Code 选择、安装按钮和可复制的接入提示词。客户端使用内置 CLI，不要求另装 Node 或依赖尚未发布的 npm 包。
- 安装、授权、云端可用和 MCP 工具发现分别检查；Skill 或配置文件存在不再显示为已连接。云端关闭时仍可安装连接，随后明确等待开放，不循环安装或授权。
- 授权在客户端显示请求方与普通业务权限，用户确认后内置进程继续领取专用凭据。复制提示词包含当前安装包真实入口，没有凭据；Agent 必须验证工具与只读调用。
- 设备授权新增 `/agent/authorize` 独立浏览器页面，要求登录并保留授权码；现有 `/settings` 的客户端访问限制不放宽。
- 启动时仅更新已接入且来源可验证的知萃配置和 Skill。旧验收包按逐文件摘要识别，未知同名配置保留；用户对 Skill 的修改备份。已运行的 MCP 进程需要在 Agent 中重新连接后使用新版。
- 授权使用独立 UUID；取消、退出、切换账号只能结束对应会话。页面按账号重新挂载，异步结果有版本校验，避免迟到响应覆盖新授权。

## 验证

- CLI 完整测试 93 项通过；追加更新状态断言后相关 24 项通过。独立联合验证配置迁移、device flow、真实 stdio 工具发现 35 项通过。
- 桌面编译、Agent 集成与发布契约通过，包含旧 UUID 取消无副作用、授权状态恢复、关闭接口分层、仅维护已接入配置。
- 前端相关 20 项与类型检查通过；生产构建成功生成 41 个页面。
- 独立浏览器授权 7 个流程通过（登录、批准、拒绝、过期、关闭状态、迟到响应、移动布局），后端真实 TestClient 设备授权 2 项通过。
- 快捷接入浏览器测试覆盖关闭接口先安装、安装后页内授权、取消再授权、旧客户端、Claude 授权恢复、移动端引导。使用合成 API 和独立浏览器，不访问真实平台账号或代替用户授权。

## 发布边界

延续现有 Windows Beta 通道，不冒充已签名 Stable。此版本更新接入与维护流程，生产 Agent 总开关仍维持 dark；真实云端调用需完成现有发布条件后另行开放。

发布前在既有部署锁内清理旧 231 runtime 的 node_modules/.next/.venv 及 232 的 node_modules，保留当前 237 和前版 236。空闲空间从约 2.97 GiB 恢复到 6.22 GiB，未处理源码、业务资料或备份。

测试与发布证据位于 `D:/6month/.codex-artifacts/agent-onboarding-20260914/` 和 `D:/6month/.codex-artifacts/agent-browser-authorization-20260914/`。发布后追加源码提交、安装包摘要和生产回读结果。

## Windows 发行

- 发行源码提交：`e501b4bfd4a207f015980d6878711be3c286e369`。
- `Zhicui-Setup-1.1.8-x64.exe` 已经由既有 Beta 脚本构建、验证并上传，大小 93,599,366 字节。
- SHA-256：`972021469f07b602150afa8ea1a20c98361409f6df99f086cfef71715f1499e9`。
- 版本化安装包、blockmap、beta.yml 与发布清单已更新；公网安装包 12 段完整回读与 blockmap、feed、manifest 校验全部通过，摘要与发行 provenance 一致。未执行安装程序。

## 生产回读

- 发布提交：`14b10aa199ffb2247b50a94e5fa56fe193c7bf3c`，GitHub / Gitee master 均已推送。
- Jenkins #238 为 SUCCESS，19 项发布门禁通过，无需回滚；实际运行目录 `/opt/zhicui-runtime/releases/jenkins-zhicui-deploy-238` 的 SHA 与发布提交一致。
- 前端、后端、抖音 sidecar 均 active；本机与公网 health=ok、readiness=ready。Agent 总开关保持 dark，公网 capabilities 为 `503 / INTERFACE_DISABLED`，尚未声称真实 Agent 调用可用。
- 公网 build `14b10aa199ff-20260914084342`，网页版本 1.1.11。`/agent/authorize` 与 `/settings?section=agent` 返回 200，所引用的生产 JS 已逐项确认包含新授权与快捷接入组件。
- 生产验证记录：`D:/6month/.codex-artifacts/agent-onboarding-20260914/production-verification.json`，`verified=true`。
- Windows 完整回读记录：`D:/6month/.codex-artifacts/douyin-sync-flow-20260914/public-beta-1.1.8-20260914T083822Z-191e1c87/verification.json`，`verified=true`。
