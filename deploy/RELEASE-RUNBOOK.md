# 生产发布闸门

`deploy/deploy.sh` 不再以“进程存活”代替可发布。它依次要求：生产环境安全配置、
PostgreSQL 加密备份、SHA-256、隔离库恢复、配置所要求的灾备模式校验、Nginx 配置一致、beta/stable 清单一致、
`/api/readiness`、法律页、权限边界、桌面登录票据、真实 AI SSE 完整增量与客户端下载哈希。
任一必需检查失败都会恢复上一版应用产物，并通过固定 root helper 在
`/var/lib/zhicui-deployments/` 写入不含秘密的 JSON 证据。该目录必须为
`root:root 0700`，JSON 与 detached `.sha256` 必须为 `root:root 0600`；部署账号
不能直接读取或改写。成功证据绑定真实 runtime Git SHA、加密备份/元数据字节哈希、
公网 smoke 哈希及前序 dark/rehearsal 哈希，Stable 会逐层重新计算而不是信任字段文本。
Agent 公开状态不写入共享 `backend/.env`；systemd 最后加载
`/etc/zhicui/agent-interface.env`。该 root-owned 文件只允许固定 helper 原子切换，
Stable 失败路径会先恢复 `false` 再切回旧 runtime。

应用版本运行在 `/opt/zhicui-runtime/releases/<部署号>` 的只读式 Git worktree 中，
`runtime/current` 只在所有本地构建检查通过后原子切换。失败只需切回旧 symlink，
不会把旧文件 rsync 回长期 Git checkout，因此 checkout 始终可再次 fast-forward。
每个 runtime 同时携带自己的 `.venv`，代码与 Python 依赖会作为一个身份切换。
Windows 二进制、Electron feed 和 Windows 渠道清单不跟随 Git 切版，统一持久化在
`/var/lib/zhicui-downloads/`；Nginx 只读提供它，应用回滚不会删除或覆盖已发布安装包。

## 一次性服务器配置

1. 以 root 运行 `bash /opt/zhicui/deploy/setup.sh`，安装 systemd timer、Nginx 配置和 sudoers。
   首次尚无证书时先设置 `CERTBOT_EMAIL=运维邮箱`；脚本申请证书后才启用强制 HTTPS/HSTS。
2. 依据 `deploy/production.env.example` 填写 `/opt/zhicui/backend/.env`；不得使用通配 CORS。
   不得在该共享文件中添加 `AGENT_INTERFACE_ENABLED`；Agent Pepper、Automation 和
   allowlist 策略仍在这里配置，启用状态由独立 kill-switch 管理。
   同时依据 `deploy/backup/backup.env.example` 配置 `/etc/zhicui/backup.env`。默认必须
   使用真实 rclone/S3-compatible 或 SSH 异地目标，以及已经离线加密的恢复材料。
   早期阶段若产品所有者明确接受单机风险，可用双重开关进入 `local_only`；它只跳过远端
   复制和回读，仍强制加密备份、校验和与隔离恢复。不得把本机模式标记为异地验证成功。
3. 创建一个**非管理员、仅用于冒烟**的普通账号，用户名必须固定为
   `zhicui_production_smoke`。不要给它放入真实用户资料；部署脚本会临时预置一条带唯一
   哨兵事实的隔离视频文稿，验证回答和引用后立即删除资料与会话。
4. 将密码写入 Jenkins Credentials Binding 生成的临时文件，向部署任务注入：
   `SMOKE_LOGIN_EMAIL` 和 `SMOKE_PASSWORD_FILE`。不要把密码直接写进 Jenkinsfile、仓库或日志。
5. stable 客户端发行还需在 CI secret 中提供 Windows Authenticode 证书和 Android release keystore；
   缺少时 stable 脚本按设计失败，现有 stable 清单保持 `unavailable`。

以后仅升级 Nginx、systemd、备份 timer 或 sudoers 时，不必重跑完整初始化：

```bash
sudo bash /opt/zhicui-runtime/releases/<部署号>/deploy/preinstall-production-assets.sh
```

若 deploy 检出目标提交包含新的运维资产，它会保留该目标 worktree，并在错误信息中
给出同一条脚本的精确路径；执行后直接重跑发布即可。

Agent 首次正式上线必须对同一个完整 Git SHA 执行两次发布。Jenkins 的
`AGENT_RELEASE_MODE` 是受控 choice 参数，Gitee push 使用 `dark`；dark 构建及证据通过且
期间没有新 push 后，再从 “Build with Parameters” 选择 `stable`。Pipeline 从 Jenkins
Credentials `zhicui-production-smoke-email`（Secret text）和
`zhicui-production-smoke-password-file`（Secret file）注入冒烟凭据，并显式向
`deploy.sh` 传递模式和凭据；禁止依赖脚本默认值或把密码写入 Jenkinsfile。

对应的命令语义如下（人工发布也必须显式传递模式）：

```bash
AGENT_RELEASE_MODE=dark bash deploy/deploy.sh
sudo /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify-dark
AGENT_RELEASE_MODE=stable bash deploy/deploy.sh
sudo /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify-stable
```

Stable 会拒绝从 true、路由不存在或 Agent 表不完整的状态直接进入。失败证据若没有
`agent_kill_switch_rollback=pass`，必须按事故处理，不得只依据 runtime symlink 判定回滚成功。
它还会拒绝 `origin/master` 与当前 dark runtime 的完整 SHA 不一致；此时必须先对新提交
重新运行 dark，不能把旧 dark 的验收结果沿用到新代码。8 张公开 Agent 表还要通过
`deploy/verify-agent-schema.py` 的版本化结构契约；列/类型、nullable、主键、唯一约束、
索引或 `ON DELETE` 外键任一漂移都会失败。dark 成功证据记录完整结构指纹，Stable 要求
当前库、目标启动后和该 dark 证据为同一指纹。

dark 完成后还要把该次证据记录的同一 `backup_artifact` 恢复到
`zhicui_agent_rehearsal_*` 隔离库，执行：

```bash
sudo python3 /opt/zhicui-runtime/current/deploy/rehearse-agent-schema-upgrade.py \
  --runtime /opt/zhicui-runtime/current \
  --database-url-file /path/to/0600-isolated-database-url \
  --snapshot-file '/var/backups/zhicui/<dark evidence backup.artifact>' \
  --dark-evidence-file '/var/lib/zhicui-deployments/<dark deployment id>.json' \
  --evidence-directory /var/lib/zhicui-deployments
```

脚本要求隔离库名使用受控前缀、基础 `users/notes/plans` 表存在且至少有一个用户，连续
两次运行 schema 启动阶段后再校验结构指纹；不会启动 worker。脚本重算真实 snapshot、
元数据和 dark sidecar 哈希，生成不覆盖历史的时间戳证据。Stable 会自动要求证据
目标提交、真实备份、dark 前序 SHA、两次启动、完成时间和指纹均一致。演练完成后必须删除
隔离库和 0600 URL 文件；详细安全步骤见 `AGENT-INTERFACE-STABLE.md`。

人工演练可显式跳过付费 AI 调用：

```bash
SMOKE_REQUIRE_AUTHENTICATED=0 SMOKE_REQUIRE_AGENT_SSE=0 \
  bash scripts/smoke-production.sh
```

生产部署不得使用上述跳过开关。

## 客户端可复现发行

Android 与 Windows 发行都必须显式指定已经提交的完整 40 位 Git SHA。脚本会从该
提交创建临时 detached worktree，并改由提交中的发行脚本安装锁定依赖和构建；当前
checkout 的修改、未追踪文件和既有 `node_modules` 不会参与产物生成。

```bash
RELEASE_COMMIT="$(git rev-parse HEAD)" RELEASE_CHANNEL=beta PUBLISH=0 \
  bash scripts/build-apk.sh
```

```powershell
$commit = git rev-parse HEAD
pwsh scripts/release-desktop.ps1 -Commit $commit -Version 1.1.0 -Channel Stable
```

Windows 首次构建会在 Git checkout 之外保存按“提交/渠道/版本”隔离的产物及
`provenance.json`。审核后发布同一字节产物时使用 `-SkipBuild -Publish`；脚本会重新
创建 detached worktree，并核对发行脚本、依赖锁、安装包、blockmap 和 feed 的哈希。
缓存缺失或任一来源字段不符时会拒绝发布。

Stable 上传不能只以 SSH 命令成功作为完成。脚本会禁用 HTTP 重定向，从公网
`https://luxai.cn` 回读 Stable manifest、版本化 installer 与 blockmap，并复验 manifest
原始字节 SHA-256、`channel/version/source_commit/release_status`、文件大小与 SHA-256，
还会再次验证公网 installer 的 Authenticode 发布者。回读失败时脚本直接失败且不会输出
“发布完成”；这项检查不替代全新 Windows 设备上的安装、更新和回滚验收。

```powershell
pwsh scripts/release-desktop.ps1 -Commit $commit -Version 1.1.0 `
  -Channel Stable -SkipBuild -Publish
```

生产冒烟不是“接口返回 200”检查。它会创建仅选择临时资料的 `selected` 会话，询问固定
哨兵事实，并同时要求 SSE 出现非空 `delta`、唯一 `done`、回答包含哨兵值，以及至少一条
`evidence` 的 `note_id` 回指该临时资料。任一条件失败都会触发发布回滚；清理逻辑在成功、
失败和重复执行时均为幂等，不会删除或修改普通用户资料。
