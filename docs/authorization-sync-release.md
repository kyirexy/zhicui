# 自动恢复授权与同步发布记录

版本：Web 1.1.16、官网 CLI 1.0.18、Windows beta 1.1.19，均已发布。Windows 本机实际安装版本为 1.1.19.0，官网 CLI 实际安装版本为 1.0.18。端到端 200 条验收待旧客户端完成一次原账号登录，未标记全量验收完成。

## 实现

- Web HttpOnly 刷新 Cookie，桌面主进程系统加密会话，访问令牌 1 小时；使用后滚动续期 30 天、绝对 365 天。CLI 设备授权滚动续期，PAT 原到期时间保留。刷新回包丢失使用固定请求标识和加密收据恢复。
- 网络故障保留登录；确认失效才要求恢复。退出、账号切换、权限撤销停止旧身份任务；旧有效 JWT 自动迁移，已过期且没有刷新凭据的旧安装仍需确认一次。
- CLI 同步按需后台启动客户端、最多等 30 秒，空闲 5 分钟退出后台实例；状态查询不启动应用。开发版桥接与正式安装隔离。
- `zhicui sync --platform douyin --mode like --limit 200` 与 `sync resume <run_id>`；最多每来源 500 条，每批最多 100 条。固定任务、采集和批次标识，磁盘检查点、中断续跑、已有作品去重。平台游标失效时重新读取并明确说明。
- `library.activity.list` 分页返回未转写作品与实际互动数据；首页共享读取、保存、新增、复用、失败及等待状态。跨天续跑不倒填新发现日期。

## 本地验证

- 后端授权、真实 HTTP Cookie、迁移、刷新回包丢失、撤销、Agent、200 条分批与每日回顾：89 项通过。
- 最终 CLI 完整官网 CI：144 项，128 通过、16 项按平台跳过、0 失败；本机 Windows 144 项全部通过。包含刷新字段、退出码、本机 Schema 兼容与撤销后取消采集。安装验收修正独立硬编码版本号；1.0.15 的桌面内置布局检查被 CI 阻止，未发布。
- 桌面会话、200 条桥接并发幂等／重启／账号隔离、平台分页与覆盖范围、Agent 安装、更新与发布契约通过。
- 前端会话与同步观察器测试通过，TypeScript 与 Next.js 生产构建通过。
- CLI 1.0.17 Windows 全量 143 项通过，新增首次调用读取真实 Unicode 注册表与失效安装记录回退测试。
- CLI 1.0.18 增加只读状态命令的主进程诊断测试，覆盖恢复中、未登录、离线，不触发采集或自动启动。
- 真实 Electron 43.2.0 / Windows 系统加密验收：在隔离测试目录使用真实 DPAPI，跨三个进程完成保存、重启恢复相同刷新请求、断网后恢复、离线退出后不复活；只模拟 HTTP，不接触用户登录凭据。
- 以上 200 条为受控夹具验证；实际平台采集仍需旧客户端完成一次原账号登录，不能当作真实采集验收通过。

## 已完成的线上与本机验收（2026-10-07）

- 后端/Web 提交 `07b6aa5d36578a7bf7917021ed5668751de73851`，运行目录 `/opt/zhicui-runtime/releases/manual-authsync-core-07b6aa5`；Jenkins 317 暗发布、同备份隔离恢复与两次启动、core 冒烟全部通过。
- 使用专用生产验收账号验证：访问有效期 3600 秒；HttpOnly/Secure Cookie；4 个并发刷新共用收据；刷新响应丢失后恢复；退出和旧会话撤销；本机会话迁移；外站请求拒绝。测试后恢复验收账号，删除临时明文凭据。
- 用户现有 CLI 设备授权在访问令牌过期后自动续期成功，未再次进行设备授权；可读取新能力列表。
- 首次 CLI 自动启动发现 `reg.exe` 中文路径输出编码问题；已改用 Unicode 注册表读取，同时兼容全机安装和路径变更。最终 Windows 1.1.19 覆盖安装退出码 0，原账号资料保留。
- 最终包实测：普通 `local status` 用时 739ms，客户端进程数保持 0；`sync resume` 用时 3773ms，自动启动实际安装并进入明确的 `DESKTOP_AUTH_REQUIRED`，原任务 ID 和检查点保留，未误报完成。本机连接报告版本 1.1.19、每来源上限 500。
- 新 `library.activity.list` 已使用现有 CLI 授权在线调用，返回当前账号抖音喜欢台账总数 703、分页标记和未转写作品。这是历史台账读取，不是本次新采集 200 条。
- Codex 已有受管接入与 Skill 均为最新；Claude Code 尚未配置，保留原状态，不擅自新增接入。
- 本次真实任务：`sync-e02ddd3c-1667-4c07-abc8-ae8aa560dcae`，抖音喜欢，请求 200 条，当前已读取 0 / 已保存 0。原因：升级前已经停在登录页，没有有效旧刷新凭据。待用户登录原账号后使用原任务续跑；不绕过账号验证，也不把夹具数据写入用户资料。
- 详细脱敏记录位于 `.artifacts/auth-sync-production-auth-check.jsonl`、`.artifacts/auth-sync-cli-1.0.18.log`、`.artifacts/auth-sync-native-storage-smoke.log`、`.artifacts/auth-sync-final-launch-evidence.json`、`.artifacts/auth-sync-final-resume.jsonl`（本机验收产物，不随源码提交）。

## 最终发行凭证

| 组件 | 版本 / 来源 | SHA-256 |
| --- | --- | --- |
| 官网 CLI | 1.0.18 / `5ee5ebc9e14acca16cec1399b69941446b5cbdf5` | `407fa3c7504eb4bc4835c943a39a2a6c0c8eb0216852a1155c1c32fcc17eb4d7` |
| Windows beta | 1.1.19 / `5ee5ebc9e14acca16cec1399b69941446b5cbdf5` | `367c50e75e3e3b11a3f4ae79da06d5b643605bfe45d33ee3a72c7defbf603ca4` |

- CLI GitHub 构建 `37576608412`，来源证明核验通过；官网入口 https://luxai.cn/download/cli/ ，短安装地址 https://luxai.cn/cli.tgz 。
- Windows 清单 https://luxai.cn/download/releases/windows/beta.json ，发行包 https://luxai.cn/download/windows/Zhicui-Setup-1.1.19-x64.exe 。沿用现有 beta 渠道；未变更 stable 签名要求。
- 后端/Web 运行提交保持 `07b6aa5d36578a7bf7917021ed5668751de73851`；后续提交仅为 CLI 发行和本机诊断修正，与已发布后端兼容。

## 发布与回滚

按现有 dark → 同备份隔离恢复及双启动 → core 闸门发布；官网 CLI 使用 GitHub 构建来源核验，Windows 使用已提交源码与 beta 发布脚本。新数据库表保留，旧版本可忽略；保留加密迁移备份、上一版 runtime 与安装包。发布状态未核验前不标记完成。

- 生产发布记录：`/var/lib/zhicui-deployments/manual-authsync-core-07b6aa5.json`；隔离恢复证据：`agent-schema-rehearsal-20261007T050604Z-07b6aa5d3657.json`；加密迁移备份位置由发布记录保存。
- 上一版生产 runtime：`/opt/zhicui-runtime/releases/manual-audio-core-cfcda48`。
- 本机原安装与资料备份：`D:/6month-backups/auth-sync-install-20261007-130721`。1.1.16/1.1.17 旧 app.asar 与历史官网安装包保留。
- 待实测：原账号登录后的真实 200 条分页与去重、CLI 中断恢复、首页与 CLI 数量一致、平台验证码/限流场景和已授权后台实例空闲退出。相应逻辑已通过受控测试，不能替代真实平台验收。

工作区原有视频解析和发布基础设施改动不随本次提交，保留原内容。
