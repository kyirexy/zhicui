#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo '请使用 sudo 安装备份服务' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$ROOT/deploy/backup"

command -v pg_dump >/dev/null 2>&1 || { echo '缺少 PostgreSQL client（pg_dump）' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo '缺少 openssl' >&2; exit 1; }
id postgres >/dev/null 2>&1 || { echo '缺少 postgres 系统用户' >&2; exit 1; }
id ubuntu >/dev/null 2>&1 || { echo '缺少后端运行用户 ubuntu' >&2; exit 1; }
id jenkins >/dev/null 2>&1 || { echo '缺少 Jenkins 部署用户' >&2; exit 1; }

getent group zhicui-readiness >/dev/null 2>&1 || groupadd --system zhicui-readiness
usermod -aG zhicui-readiness postgres
usermod -aG zhicui-readiness ubuntu
# Jenkins 只加入 readiness 组，用于读取脱敏的备份状态；归档本体仍保持
# postgres:postgres 0600，不向部署进程暴露数据库备份或加密密钥。
usermod -aG zhicui-readiness jenkins

install -d -m 0755 /usr/local/lib/zhicui-backup
install -m 0755 "$SOURCE/postgres-backup.sh" /usr/local/lib/zhicui-backup/postgres-backup.sh
install -m 0755 "$SOURCE/postgres-restore-verify.sh" /usr/local/lib/zhicui-backup/postgres-restore-verify.sh
install -m 0755 "$SOURCE/postgres-offsite-replicate.sh" /usr/local/lib/zhicui-backup/postgres-offsite-replicate.sh
# 保存完整、只读的安装来源快照，deploy 可对 backup/* 做逐文件漂移检查。
install -d -m 0755 /usr/local/share/zhicui-deploy/backup
find /usr/local/share/zhicui-deploy/backup -mindepth 1 -maxdepth 1 -type f -delete
for source_file in "$SOURCE"/*; do
  [[ -f "$source_file" ]] || continue
  install -m 0644 "$source_file" "/usr/local/share/zhicui-deploy/backup/$(basename "$source_file")"
done
install -d -o postgres -g postgres -m 0700 /var/backups/zhicui
# 归档本体仍为 postgres:postgres 0600；此目录只暴露脱敏 readiness JSON。
install -d -o postgres -g zhicui-readiness -m 2750 /var/lib/zhicui-backups
install -d -o root -g postgres -m 0750 /etc/zhicui

if [[ ! -f /etc/zhicui/backup.key ]]; then
  openssl rand -base64 48 >/etc/zhicui/backup.key
fi
chown root:postgres /etc/zhicui/backup.key
chmod 0640 /etc/zhicui/backup.key

if [[ ! -f /etc/zhicui/backup.env ]]; then
  install -o root -g postgres -m 0640 "$SOURCE/backup.env.example" /etc/zhicui/backup.env
fi

install -m 0644 "$SOURCE/zhicui-postgres-backup.service" /etc/systemd/system/
install -m 0644 "$SOURCE/zhicui-postgres-backup.timer" /etc/systemd/system/
install -m 0644 "$SOURCE/zhicui-postgres-restore-verify.service" /etc/systemd/system/
install -m 0644 "$SOURCE/zhicui-postgres-restore-verify.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zhicui-postgres-backup.timer zhicui-postgres-restore-verify.timer

echo '备份与隔离恢复验证 timer 已安装。首次上线前请执行：'
echo '  sudo systemctl start zhicui-postgres-backup.service'
echo '  sudo systemctl start zhicui-postgres-restore-verify.service'
echo '生产默认要求异地副本；请先在 /etc/zhicui/backup.env 配置 rclone 或 SSH 目标及加密恢复材料。'
