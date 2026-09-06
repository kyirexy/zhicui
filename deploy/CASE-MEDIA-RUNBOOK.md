# 官网真实案例媒体运维

案例内容通过管理端 `/admin/showcase-cases` 更新。已发布案例由匿名 API 返回；
MP4/GIF 和首帧经 FastAPI 的案例权限检查后返回，不配置 Nginx 静态目录别名。
生产服务通过 systemd 固定使用 `/var/lib/zhicui-case-media`，所有者为 `ubuntu:ubuntu`，
目录 `0700`。切换或回滚 immutable runtime 不会移动、覆盖或删除媒体。

## 安装与发布

新运维资产首次上线时，原发布流程会在资产漂移闸门保留目标 worktree 并停止。
确认该目录对应本次完整 Git SHA 后执行既有安装入口，再重跑 Jenkins：

```bash
sudo bash /opt/zhicui-runtime/releases/<实际部署号>/deploy/preinstall-production-assets.sh
```

该入口会调用 `install-case-media.sh`，建立目录与 `.upload.lock`，安装固定参数的
root helper 和每日备份 timer，执行初次完整性校验；同时安装 Nginx、systemd、
sudoers 等既有资产。它会按既有流程重新启动服务、执行原数据库备份和隔离恢复。
如只需补装媒体备份资产，可以单独运行 `deploy/install-case-media.sh`；后端环境和
Nginx 上传规则仍必须由完整安装入口更新，不能跳过生产资产一致性闸门。

Nginx 仅为 `/api/admin/showcase-cases` 路径放宽到 `105M`，容纳 `100 MiB` MP4 加
multipart 头；其他路径保留 `50M`。后端继续独立校验 MP4 `100 MiB`、GIF `20 MiB`、
实际格式和解码能力。环境固定总媒体额度 `1024 MiB`、最低剩余空间 `512 MiB`。
发布在生成媒体快照之后要求至少 `2560 MiB` 可用空间（构建约 `2 GiB` 加余量）。
预检缺失依赖或空间不足只会停止发布，不会自动删除业务文件或 Jenkins 历史版本。

```bash
sudo /usr/local/lib/zhicui-deploy/case-media-maintenance.py preflight
sudo systemctl start zhicui-case-media-backup.service
sudo /usr/local/lib/zhicui-deploy/case-media-maintenance.py verify
systemctl status zhicui-case-media-backup.timer
sudo journalctl -u zhicui-case-media-backup.service --no-pager -n 30
```

## 媒体与案例表的一致备份

备份与所有案例写操作共用 `/var/lib/zhicui-case-media/.upload.lock`。备份持锁期间，
上传、替换、删除和文字更新返回可重试的冲突提示；匿名浏览正常。持锁期间先
`pg_dump --format=custom --table=public.showcase_cases`，再将该表快照与媒体打进同一个
加密归档。因此替换媒体可正常删除旧文件，无需长期累积已失效媒体。

归档为 `/var/backups/zhicui-case-media/case-media-<UTC时间>-<清单哈希>.tar.gz.enc`，
目录和文件分别为 `root:root 0700/0600`。使用原有 `/etc/zhicui/backup.key` 和
AES-256-CBC/PBKDF2-SHA256/200000 加密。完成后解密流式读取每个条目，复验大小和
SHA-256；数据库 custom dump 另经 `pg_restore --list` 检查。`latest.json` 记录密文
SHA-256、条目清单和 `archive_verified=true`。

这里的 `archive_verified` 表示解密、逐文件哈希和 dump 结构清单检查，**不表示案例表
已实际导入隔离数据库演练**。原有全库 PostgreSQL 备份、加密与实际隔离恢复闸门原样
保留。首次预安装时旧版本尚无案例表，快照记录 `case_table_included=false`；新版本
启动后再执行一次媒体备份，使案例表进入快照。

每日服务器时间 `04:30`（加最多 5 分钟随机延迟）以及每次发布前自动备份，保留最新
两份加密归档；只清理本 helper 生成的旧快照。媒体最多 `1 GiB`，两份快照约额外
`2 GiB`，生成新快照还需临时空间。空间不足会失败并保留已完成快照；请关注 timer
失败状态和磁盘监控。这些新增快照当前为 `local_only`，不宣称已做异地复制；如配置
异地灾备，应将这些加密归档、`latest.json` 和离线恢复密钥同步纳入原有灾备方案。

恢复应先在私有临时目录验证密文 SHA-256，再使用既有密钥解密，核对 `latest.json`
中的每个条目哈希。tar 条目仅应为 `media/<UUID>.<mp4|gif|jpg>` 和
`database/showcase_cases.dump`。在隔离数据库用 `pg_restore` 演练后，维护窗口停止
案例写入，将案例表和该快照的媒体作为一对恢复；不得只覆盖媒体或在生产直接执行
未经验证的全量 tar 解包。完成后恢复媒体 `ubuntu:ubuntu` 和目录 `0700`，重新确认
草稿、已发布和下架案例权限，再启动服务。恢复上线属于独立运维操作，不由安装脚本执行。

## 2026-09-06 上线前只读盘点

盘点时 `/` 为 `40G`，可用 `3.1G`，使用率 `92%`。当前 runtime 为
`jenkins-zhicui-deploy-185`；Jenkins `179` 至 `185` 每份约 `2.2G`。另有两份约 `2.1G`
的旧 manual runtime 与两份约 `65M` 的 preinstall worktree。生产 `ffmpeg` 和
`ffprobe` 都已存在于 `/usr/bin`。本次适配未删除任何线上文件。

清理候选为当前和上一成功版之外、已验证可再生的旧 Jenkins worktree。先从
root-owned 发布证据确认前版，再检查 exact worktree 对应 Git SHA 和是否存在未提交
业务文件；不能仅凭目录编号删除。优先审核 `179`—`183`，保留 `185` 与 `184`，
实际决定以最新证据和 `runtime/current` 为准。使用 `ubuntu` 或原 worktree 所有者
执行 Git，严禁 root 在 `/opt/zhicui` 运行 Git。

```bash
readlink -f /opt/zhicui-runtime/current
df -h /opt/zhicui-runtime /var/lib/zhicui-case-media
git -C /opt/zhicui worktree list --porcelain
du -sh /opt/zhicui-runtime/releases/*
```

现有部署脚本的自动清理仅覆盖 `manual-*` 和 npm 可再生缓存，并不自动删除 Jenkins
历史 runtime；本次没有扩大它的删除范围。
