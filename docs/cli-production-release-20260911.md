# CLI 1.0.1 生产发布记录

日期：2026-09-11。用户已授权发布部署，并委托制定画面解析价格。

**最新价格（用户要求下调后）：每天免费 10 次；超出后 50 萃点（¥0.05）/次；BYOK 处理费 0。** 已发布新的不可变价格版本并通过真实 Provider 测试，总开关仍关闭。10 分钟、8 帧、每日平台 ¥10 预算维持。下文 200 萃点/免费 1 次为原方案历史记录，已被替代。新的 root-only 备份为 `/var/backups/zhicui/cli-pricing-before-20260911T012740Z.json`。免费与低价属于早期补贴，不把成本上界当作典型单次费用。

## B站源码复查与修复

- 生产公开资料 API `/x/web-interface/card` 实测 HTTP 200/code 0，账号身份与昵称均有效。旧 `resolve_creator` 却调用投稿列表的 yt-dlp；改为只查公开资料并严格核对 UID，头像使用白名单，不跟随重定向、不继承环境代理、不返回原始数据。
- yutto 单次元数据任务错误地返回 `items=[]/complete=true`。进一步对现有同一实现只诊断第一页，确认 nav 返回 `-101`（匿名状态），投稿 API `/x/space/wbi/arc/search` 返回 `-352`；源码将 API Failure 吞为零条，事件中没有错误。没有使用账号凭据，没有下载，没有切换 IP 或绕过验证。
- 主服务现在拒绝未验证空目录；收到风控、需登录、需验证及目录错误后，不再调用 yt-dlp 备用请求。仅本机 sidecar 未启用/不可用/版本不匹配时保留元数据兼容路径。
- yt-dlp 路径禁用配置继承及隐式重试，并设置网络超时；yutto 错误分类补齐数字风控码。公开资料可用不代表全量投稿可用，因此不把 B站目录标记为健康。
- 已运行后端全量 606 项测试，结果通过、1 项原有跳过；随后新增空目录协议测试并定向复验。发布仍使用独立 worktree，不包含主工作区其他修改。

## 发布范围与验证

基于 GitHub/Gitee/生产一致的 `286a6702e896c9ca30f5f683bba548c9e2261af9` 建立独立发布分支。仅纳入 CLI 1.0.1 修复、显式设置计划任务完成状态的后端 Action、对应契约与测试、npm 发布流程修复。保留此前博主同步和客户端版本，不夹带主工作区其他未发布功能。

- CLI：77 项通过；后端全量：599 项通过（1 项原有跳过）。
- 前端：Agent 接入 8 项、Agent v2 42 项通过；生产构建通过。
- 桌面：类型检查及 Agent 集成验证通过。
- 本地前端依赖使用与锁文件一致的共享目录；Turbopack 拒绝目录外 junction，因此本地构建用 Next 自带 `--webpack` 完成。生产仍按既有流程使用独立依赖和默认构建。
- npm 流程补齐契约测试需要的 Python/Pydantic，Node 改为满足 npm 12.0.2 引擎要求的 22.22.2；产物使用明确文件白名单审计，保持受保护环境、不可变标签、provenance 和官方仓库回读。

## 画面解析定价

依据：2026-09-11 读取的硅基流动官方目录 <https://siliconflow.cn/models>。`Qwen/Qwen3-VL-8B-Instruct` 输入为 ¥0.5/百万 token，输出为 ¥2/百万 token，上下文上限 262,144 token。脱敏来源快照位于本地 `.codex-artifacts/cli-validation-20260911/model-price-source.json`。

| 项目 | 设置 |
| --- | --- |
| 标准画面解析 | 每次 200 萃点，按现有 1,000 萃点/元计为 ¥0.20 |
| 免费额度 | 每人每天 1 次，Asia/Shanghai 日界线 |
| 用户自带模型 | 50 萃点处理费，模型费用由用户自己的服务商结算 |
| 单视频上限 | 10 分钟、8 帧、1 次模型调用、256 MiB 文件 |
| 初始平台模型预算 | 每日 ¥10，并发 1 |
| 用户每日扣点上限 | 2,000 萃点 |
| 单次批量运行扣点上限 | 1,000 萃点 |
| 自动重试 | 初始为 0，避免失败重复调用 |

成本按官方 token 单价计算，配置使用完整模型上下文上限和 4,096 输出 token 的保守上界：`ceil(262144/1000) × ¥0.0005 + ceil(4096/1000) × ¥0.002 = ¥0.1415`。这不是典型单次成本预测，也不含服务器、带宽和支付成本；实际使用仍按已有成本计量和预算门禁处理。

生产已完成真实合成图片识别测试，并发布“标准画面解析”的价格版本；运行开关暂时保持关闭，待完整依赖门禁通过后再向用户启用。原配置已备份为 root-only `/var/backups/zhicui/cli-pricing-before-20260911T011310Z.json`，变更已写管理审计。

## 开放前条件

预检确认 Agent 独立凭据配置、SMTP TLS/认证、抖音目录与近期主页测试通过。B站 yutto 2.2.0 本机鉴权协议健康，但生产公开主页测试返回 `bilibili_risk_control`；未改写健康标记，也没有连续重试。完整 Stable 仍须等待该真实依赖验证通过。

已清理明确旧版本 214、215、216、218、219 的 `.venv`、`frontend/node_modules`、`frontend/.next`，保留源码、用户数据、备份、当前 221 和上一版 220。清理在部署锁内验证进程和真实路径后执行，可用空间由约 3.0 GB 增至 14.1 GB。

后续严格执行同一提交的 dark、加密快照隔离恢复双启动、Stable 与真实普通用户冒烟；只有生产门禁通过后才推送 CLI 发布标签并发布 npm latest。本文件创建时尚未宣布 Stable 或 npm 发布成功。

## 实际发布进展（09:24 更新）

- 已提交并同步 GitHub/Gitee master：`197c7bef3a833d7ae10faa3cd6c96e4d620565f7`。主工作区其他未发布修改没有纳入。
- Jenkins `#222` 暗发布成功，运行路径 `/opt/zhicui-runtime/releases/jenkins-zhicui-deploy-222`。生产真实 SHA 与上述提交一致，公网 `/api/health` 正常，独立 kill-switch 回读 `dark`。暗发布执行了现有网站、固定资料和普通账号冒烟；它不等于 Agent Stable 冒烟。
- 暗发布证据：`/var/lib/zhicui-deployments/jenkins-zhicui-deploy-222.json`，由受控证据仓保存。
- 对该暗发布绑定的同一加密快照完成隔离恢复及两次 schema 启动；未启动 worker。演练证据：`agent-schema-rehearsal-20260911T012209Z-197c7bef3a83.json`，SHA-256 `43ea182f95133d16c4e64c2dcb89479744f9636a35653f41116acc9fcf8f9dc2`。临时数据库、明文 dump 和连接串文件全部清理。
- 最终已安装 CLI 对真实 Codex `0.153.4`、独立安装的官方 Claude Code `2.1.267` 完成 status、setup、重复 setup、doctor、uninstall，共 10 个阶段通过；两份隔离配置恢复，原有用户配置哈希不变。此检查不宣称正式账号已登录。报告：`.codex-artifacts/cli-validation-20260911/real-agent-validation.json`。
- 最终全局安装包再次连接准确发布 worktree 的独立真实 FastAPI 后端，23/23 项通过，包含计划完成与重开、权限隔离、异步流程、幂等和 MCP 工具读取；没有生产数据写入或外部模型调用。报告：`.codex-artifacts/cli-validation-20260911/real-backend-release-installed-report.json`。
- 本机原有 Claude Code 全局入口为 500 字节安装占位文件，Windows 无法执行；本次使用独立目录的官方客户端完成验收，没有覆盖原有全局安装。
- 发布预检再次确认 SMTP TLS/认证/NOOP、独立 Agent 凭据与抖音目录正常；B站近期主页验证缺失且目录未启用。先前真实主页探测返回 `bilibili_risk_control`，没有连续抓取或改写健康状态。画面解析价格版本和 Provider 测试已就绪，功能总开关仍关闭，所以尚不满足完整产品就绪条件。
- npm 官方仓库于 `2026-09-11T01:23Z` 回读 `E404`，尚无公开包；未创建 `cli-v1.0.1` 标签。待 B站服务端连接验证通过后，再启用解析功能、对同一提交晋级 Stable、完成 Agent 真实冒烟并发布 npm。

运行本次演练时，初次检查遇到 Jenkins 所有权下的 Git safe.directory 及旧格式历史证据缺少 sidecar；两次均在创建临时库前退出。后续仅给确切 runtime 添加命令级只读 Git 信任，并先筛选目标提交再严格校验其证据，成功完成演练；未放宽生产证据门禁。
