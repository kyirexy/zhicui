# 生产发布闸门

`deploy/deploy.sh` 不再以“进程存活”代替可发布。它依次要求：生产环境安全配置、
PostgreSQL 加密备份、SHA-256、隔离库恢复、异地故障域回读校验、Nginx 配置一致、beta/stable 清单一致、
`/api/readiness`、法律页、权限边界、桌面登录票据、真实 AI SSE 完整增量与客户端下载哈希。
任一必需检查失败都会恢复上一版应用产物，并在
`/var/lib/zhicui-deployments/` 写入不含秘密的 JSON 证据。

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
   同时依据 `deploy/backup/backup.env.example` 配置 `/etc/zhicui/backup.env`：生产必须
   使用真实 rclone/S3-compatible 或 SSH 异地目标，以及已经离线加密的恢复材料。
   外部凭据或恢复材料缺失时 preinstall、readiness 和 deploy 均按设计失败，禁止临时关闭门禁。
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
pwsh scripts/release-desktop.ps1 -Commit $commit -Version 1.0.10 -Channel Beta
```

Windows 首次构建会在 Git checkout 之外保存按“提交/渠道/版本”隔离的产物及
`provenance.json`。审核后发布同一字节产物时使用 `-SkipBuild -Publish`；脚本会重新
创建 detached worktree，并核对发行脚本、依赖锁、安装包、blockmap 和 feed 的哈希。
缓存缺失或任一来源字段不符时会拒绝发布。

```powershell
pwsh scripts/release-desktop.ps1 -Commit $commit -Version 1.0.10 `
  -Channel Beta -SkipBuild -Publish
```

生产冒烟不是“接口返回 200”检查。它会创建仅选择临时资料的 `selected` 会话，询问固定
哨兵事实，并同时要求 SSE 出现非空 `delta`、唯一 `done`、回答包含哨兵值，以及至少一条
`evidence` 的 `note_id` 回指该临时资料。任一条件失败都会触发发布回滚；清理逻辑在成功、
失败和重复执行时均为幂等，不会删除或修改普通用户资料。
