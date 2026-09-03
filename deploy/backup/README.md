# PostgreSQL 备份与恢复演练

生产默认每天生成 PostgreSQL custom dump，使用独立密钥通过
AES-256-CBC + PBKDF2（200,000 次）加密，再生成 SHA-256 校验和。归档、元数据和
密钥保持 `0600/0640` 且只允许备份服务读取；脱敏状态 JSON 通过
`zhicui-readiness` 只读组以 `0640` 提供给后端，目录为 setgid `2750`。默认保留 14 天。

每日恢复任务会在备份后验证加密归档哈希，解密到受限临时文件，再恢复到名称以
`zhicui_restore_verify_` 开头的随机隔离数据库。它检查 `users`、`notes`、
`plans` 表和只读计数后删除隔离库，任何路径都不会覆盖 `zhicui` 生产库。
严格异地模式随后把**已经加密**的数据库归档、SHA-256、非敏感元数据和单独加密的恢复材料
复制到异地故障域，并从远端重新读取归档和恢复材料计算 SHA-256。只有本地隔离恢复、
远端存在性、远端内容校验全部通过，`/api/readiness` 才会就绪。

默认启用 `ZHICUI_OFFSITE_REQUIRED=true`。早期阶段可由产品所有者显式接受单机故障域
风险：备份环境设 `ZHICUI_OFFSITE_REQUIRED=false`，后端同时设置
`BACKUP_OFFSITE_REQUIRED=false` 和 `EARLY_STAGE_LOCAL_BACKUP_ACCEPTED=true`。此模式仍会
完成加密、SHA-256 与隔离恢复，状态显示 `backup_mode=local_only`，且
`offsite_verified=false`；服务器整机损坏时本机备份也可能丢失。接入真实第二故障域后
应立即恢复三个开关的严格配置。

异地模式支持两种外部目标：

- `rclone`：推荐用于 S3-compatible/object storage；凭据放在
  `/etc/zhicui/rclone.conf`，不得写入仓库或日志。
- `ssh`：使用专用受限账号、私钥和固定 `known_hosts`，目标目录不得与应用服务器同机。

还必须提供 `ZHICUI_OFFSITE_RECOVERY_MATERIAL`。它应是把 `backup.key` 和恢复说明
用离线公钥封装后的 `age`、ASCII-armored PGP 或 OpenSSL salted 密文；脚本会拒绝
明文 `backup.key`、符号链接和无法识别的封装。密文恢复材料可以异地保存，解密私钥/
口令仍应由另一位负责人或另一套密钥系统保管。

安装：

```bash
sudo bash /opt/zhicui/deploy/backup/install.sh
sudo systemctl start zhicui-postgres-backup.service
sudo systemctl start zhicui-postgres-restore-verify.service
sudo systemctl list-timers 'zhicui-postgres-*'
```

状态证据：

- `/var/lib/zhicui-backups/latest.json`（readiness 消费的原子安全状态）
- `/var/lib/zhicui-backups/last-backup.json`
- `/var/lib/zhicui-backups/last-restore-verify.json`
- `/var/lib/zhicui-backups/last-offsite.json`
- `journalctl -u zhicui-postgres-backup.service`
- `journalctl -u zhicui-postgres-restore-verify.service`

`latest.json` 的 `backup_completed_at`/兼容字段 `completed_at` 表示归档生成时间，
`restore_verified_at` 独立表示隔离恢复时间；readiness 的新鲜度只依据备份生成时间。
`offsite_verified_at` 表示本次归档已从另一故障域回读校验。密钥只存在于
`/etc/zhicui/backup.key`，属主为 `root:postgres`，readiness 组无权读取，不得复制到
仓库或 CI 日志。删除密钥且无法解开异地恢复材料会让已有备份永久不可恢复。

生产发布不会只抄录 `latest.json` 中的哈希。root-owned release evidence helper 会在
每次部署中重新读取加密归档与元数据，计算实际 SHA-256 和大小，并把
`latest.json` 的实际 SHA-256 一并封入部署证据；证据 JSON 与 detached sidecar 均为
`root:root 0600`。后续 dark → rehearsal → Stable 晋级会再次读取归档并重算，归档、
元数据或任一前序证据被替换都会 fail-closed。备份轮换因此不得删除仍被当前 Stable
晋级/审计引用的归档；清理前应先核对 `/var/lib/zhicui-deployments` 中的引用。
