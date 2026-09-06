#!/usr/bin/env bash
# 可重复安装案例媒体运维资产；不读取或改写应用 .env，不删除任何媒体。
set -Eeuo pipefail
umask 077
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo '请使用 sudo 安装案例媒体资产' >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
case "$(realpath "$SCRIPT_DIR/..")" in
  /opt/zhicui|/opt/zhicui-runtime/releases/*) ;;
  *) echo '安装来源必须是批准的生产 checkout 或 release' >&2; exit 1 ;;
esac
for command_name in ffmpeg ffprobe openssl python3 pg_dump pg_restore runuser psql; do
  command -v "$command_name" >/dev/null || { echo "缺少案例媒体依赖：$command_name" >&2; exit 1; }
done
for directory in /var/lib/zhicui-case-media /var/backups/zhicui-case-media; do
  [[ ! -L "$directory" ]] || { echo "拒绝符号链接目录：$directory" >&2; exit 1; }
done
install -d -o ubuntu -g ubuntu -m 0700 /var/lib/zhicui-case-media
if [[ ! -e /var/lib/zhicui-case-media/.upload.lock ]]; then
  install -o ubuntu -g ubuntu -m 0600 /dev/null /var/lib/zhicui-case-media/.upload.lock
fi
[[ ! -L /var/lib/zhicui-case-media/.upload.lock && -f /var/lib/zhicui-case-media/.upload.lock ]] || {
  echo '案例媒体锁必须是普通文件' >&2; exit 1;
}
chown ubuntu:ubuntu /var/lib/zhicui-case-media/.upload.lock
chmod 0600 /var/lib/zhicui-case-media/.upload.lock
install -d -o root -g root -m 0700 /var/backups/zhicui-case-media
install -d -o root -g root -m 0755 /usr/local/lib/zhicui-deploy
install -o root -g root -m 0755 "$SCRIPT_DIR/case-media-maintenance.py" /usr/local/lib/zhicui-deploy/case-media-maintenance.py
install -o root -g root -m 0644 "$SCRIPT_DIR/zhicui-case-media-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SCRIPT_DIR/zhicui-case-media-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zhicui-case-media-backup.timer
systemctl start zhicui-case-media-backup.service
/usr/local/lib/zhicui-deploy/case-media-maintenance.py verify
echo '案例媒体持久目录、每日加密备份及逐文件完整性校验已安装。'
