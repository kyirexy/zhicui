# 知萃 Agent 接口 Stable 上线手册

本文是 `open-agent-cli-interface` 的正式发布门禁。只有本页所有必需项都有可核验证据时，Web 接入中心、`@zhicui/cli@latest`、远程 MCP 与 Windows 本机能力才可称为 Stable。

## 不可放宽的边界

- 只发布 `ProductActionRegistry` 中审核过的普通用户 Action；管理员身份也不会增加 Agent 工具。
- 不发布数据库、任意 Shell、原始 Cookie/JWT/API Key、临时媒体地址或内部研究工具。
- 同步只能由用户或 Agent 明确发起；无自动同步、离线排队或风控连续重试。
- Web 只提供授权与连接管理，不提供终端；Android 不运行本机 CLI。
- 删除、注销、本地文件删除、更新安装和密钥修改保持一次真实用户确认；计费动作保持报价确认。

## 两阶段生产发布

首次上线必须先关闭态暗发布，防止建表过程直接暴露接口。启用状态不再写入
`/opt/zhicui/backend/.env`：systemd 最后加载 root 持有的
`/etc/zhicui/agent-interface.env`，并由固定 helper 原子管理。共享 `.env` 中若仍出现
`AGENT_INTERFACE_ENABLED`，发布门禁会直接拒绝。

首次安装或升级运维资产：

```bash
sudo bash /opt/zhicui-runtime/releases/<部署号>/deploy/preinstall-production-assets.sh
sudo /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify-dark
sudo /usr/local/lib/zhicui-deploy/release-evidence-store.py status
```

若 kill-switch 尚不存在或内容/权限损坏，preinstall 会 fail-closed 重建为 `false`。
生产共享 `.env` 只配置不会随 runtime 回滚的秘密和策略：

```dotenv
AGENT_TOKEN_PEPPER=<独立于 JWT_SECRET 的至少 32 字节随机秘密>
AGENT_INTERFACE_USER_ALLOWLIST=
AGENT_INTERFACE_ACTION_ALLOWLIST=
AGENT_AUTOMATION_ENABLED=true
AGENT_AUTOMATION_POLL_SECONDS=30
EMAIL_DELIVERY_ENABLED=true
SMTP_HOST=<已验证的 SMTP 主机>
SMTP_USER=<正式 SMTP 账号>
SMTP_PASSWORD=<通过服务器密码管理注入>
SMTP_FROM=<正式发件地址>
SMTP_USE_TLS=true
SMTP_USE_SSL=false
SMTP_READINESS_CACHE_SECONDS=300
CREATOR_CONNECTOR_READINESS_MAX_AGE_HOURS=24
VIDEO_ANALYSIS_ENABLED=true
```

Stable readiness 还要求：管理端已启用博主同步，抖音/B站/小红书连接状态均健康，
抖音与 B站全量作品目录连接器健康；至少发布一个可由 Agent 使用且 Provider 健康的
详细解析方案；SMTP 发件配置真实可用。任何一项关闭或仅有占位配置都会阻断晋级，
不能以“Action 已显示”代替下游能力可用。`/api/readiness` 中的
`agent_interface`、`agent_product_features` 与 `agent_automation_runtime` 必须均为
`ready`，最后一项还会确认自动摘要轮询线程已经实际启动且没有残留运行错误。

博主同步也不再只读取 `system_settings` 的健康布尔值。Stable 前须在管理端为抖音、
B站、小红书分别填写一个公开博主主页并完成真实测试；三次测试都必须仍处于
`CREATOR_CONNECTOR_READINESS_MAX_AGE_HOURS` 时间窗内。readiness 还会在当次请求中
实时验证抖音/B站全量目录 sidecar 协议；测试缺失、过期、平台关闭或实时探测失败均
返回 `not_ready`。探测只读取公开元数据，不发起同步、媒体下载或风控重试。

SMTP readiness 不是“字段非空”检查：后端会建立真实连接、执行 EHLO、用系统 CA
校验证书、选择 STARTTLS 或隐式 TLS、使用配置账号认证并执行 NOOP。它不会设置
MAIL FROM/RCPT TO/DATA，也不会发送测试邮件；返回结果只包含布尔状态和稳定错误码，
不会包含 SMTP 主机、用户名、密码或上游异常原文。该探测证明发送通道与账号当前可用，
但不能证明收件箱落地、SPF/DKIM/DMARC 或垃圾邮件评分。正式宣传前仍须向团队控制的
专用测试邮箱只发送一封验证邮件，确认收件及 SPF/DKIM/DMARC，通过后保留脱敏截图或
邮件供应商事件 ID；不得使用真实用户邮箱做发布探测。

```bash
AGENT_RELEASE_MODE=dark bash deploy/deploy.sh
```

`dark` 是默认模式。它会先把当前运行态强制设为 `false`，发布目标版本后验证
capabilities 返回 `503/INTERFACE_DISABLED`。数据库门禁不只检查表名：它会依据
`deploy/verify-agent-schema.py` 的 v1 契约核对 8 张 Agent 表的全部列与类型、nullable、
主键、关键唯一约束、索引和 `ON DELETE` 外键，并把 `agent-schema-v1:<sha256>` 写入本次
成功的 dark 发布证据。

发布证据仓固定为 `/var/lib/zhicui-deployments`，必须是 `root:root 0700`；每份 JSON
及其同名 `.sha256` sidecar 均由固定 helper 规范化、原子写入为 `root:root 0600`。
Jenkins 只能调用 sudoers 中列出的固定 `status/verify-backup/store-smoke/
store-deployment/verify-dark/verify-rehearsal` 动作，不能读取、列举、覆盖或删除证据。
成功证据会绑定当前 `runtime/current` 的真实 Git SHA、加密备份和元数据的实际
SHA-256/大小、备份恢复状态哈希以及公网 smoke 证据哈希；Stable 会重新读取真实文件，
并逐层重验 dark → rehearsal → Stable 的名称、SHA-256、提交、结构指纹与时间顺序。
升级到该证据格式后，旧的可写/无 sidecar 证据不会被接受，必须重新执行一次 dark。
暗发布完成后不修改共享 `.env`，并且在 `master` 没有进入新提交时，对**同一完整
Git SHA** 显式执行 Stable：

```bash
AGENT_RELEASE_MODE=stable bash deploy/deploy.sh
```

Stable 只允许从已验证的 `dark=false` 运行态进入。脚本在目标 runtime symlink 已切换、
但新后端尚未启动时才原子写入 `true`；随后验证 capabilities、PAT/MCP 冒烟和最终状态。
脚本还会比较当前 dark runtime 与 `origin/master` 的完整 SHA；两者不同就拒绝晋级，必须
先对新提交重新运行 dark。这样 Jenkins 排队期间即使收到新 push，也不会把未经暗发布的
代码误当作 Stable。Stable 还会从 `/var/lib/zhicui-deployments/*.json` 找到该 SHA 的成功
dark 证据，并要求晋级前、目标启动后和 dark 证据中的版本化结构指纹完全一致。
任一门禁失败都会先写回并复验 `false`，再切回旧 runtime，因此旧版本不会继承一次
失败发布留下的开放状态。部署脚本也会拒绝跳过 Stable Agent 冒烟或首次在未建表状态
直接全量开放。

`AGENT_TOKEN_PEPPER` 只能通过服务器密码管理或 Jenkins Secret 注入，不能提交、输出到
日志或复用 `JWT_SECRET`。现有 `AGENT_AUTOMATION_ENABLED=true` 与 5–300 秒轮询范围门禁
在 Stable 模式继续强制执行。

## 恢复快照双启动演练

每个准备晋级 Stable 的提交，都必须在 dark 成功后、Stable 之前完成一次恢复快照演练。
这一步故意不在生产库上执行：从该次 dark 发布证据 `backup.artifact` 指向的真实加密归档恢复到一个名称以
`zhicui_agent_rehearsal_` 开头的隔离 PostgreSQL 数据库，用 dark runtime 的独立 `.venv`
连续执行两次与真实启动相同的 `create_all + _migrate_db` schema 阶段。后台 worker 不会
启动。连接串只放在 0600 临时文件中，不能出现在命令历史或发布证据。

```bash
# 先按已审核的备份解密/pg_restore 流程，把 dark 证据记录的同一归档恢复到隔离库。
REHEARSAL_DB="zhicui_agent_rehearsal_$(date -u +%Y%m%d%H%M%S)"
# createdb/pg_restore 由备份运维账号执行；严禁使用生产库 zhicui。
install -m 0600 /dev/null /tmp/zhicui-agent-rehearsal-url
# 用受控编辑器写入 postgresql://.../$REHEARSAL_DB；不要把密码放进命令参数或历史。
${EDITOR:-vi} /tmp/zhicui-agent-rehearsal-url

sudo python3 /opt/zhicui-runtime/current/deploy/rehearse-agent-schema-upgrade.py \
  --runtime /opt/zhicui-runtime/current \
  --database-url-file /tmp/zhicui-agent-rehearsal-url \
  --snapshot-file '/var/backups/zhicui/<dark 证据中的 backup.artifact 原值>' \
  --dark-evidence-file '/var/lib/zhicui-deployments/<该次 dark 部署号>.json' \
  --evidence-directory /var/lib/zhicui-deployments

rm -f /tmp/zhicui-agent-rehearsal-url
dropdb "$REHEARSAL_DB"
```

脚本会重算 snapshot 与元数据 SHA-256，并重验 dark JSON 的 detached SHA-256。它生成
`agent-schema-rehearsal-<UTC>-<commit12>.json` 及同名 sidecar，不覆盖历史演练。
演练证据必须为 `status=succeeded`、`schema_startup_passes=2`、`workers_started=false`，
并包含基础表计数、完整目标 Git SHA、同一真实备份及 dark 证据名称和 SHA-256。
Stable 部署会自动选择并交叉验证匹配的不可变证据；缺失、被篡改、来自另一提交/备份、早于 dark 完成时间、
用户数为 0，或指纹不同都会 fail-closed。隔离库和 URL 临时文件必须在演练后清理。

## Jenkins 受控晋级

Jenkins 任务必须通过 `AGENT_RELEASE_MODE` choice 参数显式记录 `dark` 或 `stable`，不能
依赖 `deploy.sh` 的默认值。Gitee push 使用安全默认 `dark`；对应构建及证据全部通过后，
运维在没有新 push 的前提下用 “Build with Parameters” 对同一任务选择 `stable`。若期间
`origin/master` 改变，Stable 会因 SHA 不一致 fail-closed，先对新提交重新执行 dark。

在 Jenkins Credentials 中创建以下两项（值不写入 Jenkinsfile）：

- `zhicui-production-smoke-email`：Secret text，值为专用普通冒烟账号邮箱；
- `zhicui-production-smoke-password-file`：Secret file，只包含该账号密码且末尾可带换行。

Pipeline 通过 Credentials Binding 注入 `SMOKE_LOGIN_EMAIL` 与 `SMOKE_PASSWORD_FILE`，
并显式传递 `SMOKE_REQUIRE_AGENT_INTERFACE`（dark 为 0，stable 为 1）。缺少、不可读或
空密码文件都会在进入发布前失败；日志不得打印上述变量的值或密码文件内容。

## 必须自动通过

```bash
cd backend && python -m unittest discover -s tests -p 'test_*.py'
cd cli && npm ci && npm test && npm pack --dry-run
cd frontend && npm run test:agent-access && npm run test:agent-v2 && npm run build
cd desktop && npm run typecheck && npm run verify:agent-integration
openspec validate open-agent-cli-interface --strict
```

生产部署必须运行 `scripts/smoke-production.sh`。其中 `scripts/smoke-agent-interface.sh`
先用 1 天有效的全 scope PAT，将 120 个审核 Action 的完整 descriptor 指纹、102 个云端
Action、18 个仅 Windows 本机 Action及 100 个远程 MCP 工具与版本化 Stable 清单严格
对账；随后通过实际 Action 调用核验详细解析目录、自动摘要轮询器、SMTP 配置与回答
模型目录，并在隔离固定资料上完成一次真实 `ask.turn.start`，检查回答增量、唯一终态、
哨兵事实和资料引用。最后再用只读 PAT 验证 `account.me`、Run、最小 MCP 工具集、
管理端拒绝和吊销后失效。两个临时凭证会从原始创建响应和服务端凭证列表双重找回、
去重并逐个确认 `revoked_at`；清理无法确认时整项冒烟失败。不得删减这项冒烟后仍称为
Stable。

## 外部分发门禁

1. npm：`@zhicui/cli@1.0.0` 以 provenance 发布到 `latest`，在无仓库源码的干净目录完成 `npx`、Codex、Claude Code、重复 setup、doctor、调用、uninstall 与配置恢复冒烟。
2. Windows：Stable 安装包和内置 CLI 均来自目标提交；安装包通过 Authenticode、可信时间戳和发布者校验。上传后发行脚本必须从 `https://luxai.cn` 公网重新读取 manifest、版本化安装包和 blockmap，禁止重定向，并再次核对 manifest 字节哈希、渠道、版本、完整提交、文件大小/SHA-256 和公网安装包签名；任一不符都不得报告发布成功。全新安装、桌面快捷方式、登录、本机桥、后台更新、用户确认安装和回滚仍需真实 Windows 设备验收，公网回读不能替代这些外部证据。
3. Android：只有 Release keystore 签名、升级安装和生产 API 回归通过时，Stable manifest 才可标记 `available`；否则保持 `unavailable`，不能拿 debug APK 代替。
4. GitHub、Gitee、服务器 release 的提交必须可追溯到同一审核提交；生产证据记录 commit、构建 ID、Agent 发布模式、dark/rehearsal 证据文件名、前后结构指纹、清单哈希和所有门禁结果，不记录凭据。

## 发布与回滚

顺序为关闭态暗发布 → Web/后端 Stable → npm Stable → Windows Stable → Android Stable（可独立保持 unavailable）。任一步失败都保持上一可用清单；`deploy.sh` 的失败路径会自动恢复 kill-switch。人工紧急关闭只使用固定 helper：

```bash
sudo /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh dark
sudo systemctl restart videocapsule-backend
curl -i http://127.0.0.1:8000/api/agent-interface/v1/capabilities
# 必须为 503，且错误码为 INTERFACE_DISABLED
```

随后吊销受影响凭据。禁止通过修改共享 `.env` 回滚开关；新增表和用户数据不回滚，旧 Web、Windows、Android 与 REST API 继续工作。部署证据必须包含 `agent_schema_preflight`、`agent_schema_rehearsal`、`agent_schema_target`、`agent_kill_switch_preflight`、`agent_kill_switch_target`、`agent_kill_switch_final`；失败证据必须包含通过的 `agent_kill_switch_rollback`，否则不得称为已安全回滚。

上线完成的定义不是“构建成功”，而是生产 URL、真实普通用户、真实 npm 包和签名安装包的全链路证据均通过。
