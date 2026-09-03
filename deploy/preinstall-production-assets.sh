#!/usr/bin/env bash
# 一次性/升级安装生产运维资产；不修改 backend/.env，不拉代码，不构建应用。
set -Eeuo pipefail
umask 027

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo '请使用 sudo 运行此脚本' >&2; exit 1; }
APP_DIR="${APP_DIR:-/opt/zhicui}"
RUNTIME_ROOT="${ZHICUI_RUNTIME_ROOT:-/opt/zhicui-runtime}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(realpath "$SCRIPT_DIR/..")"
[[ "$APP_DIR" == /opt/zhicui && "$RUNTIME_ROOT" == /opt/zhicui-runtime ]] || {
  echo '生产安装仅允许 /opt/zhicui 与 /opt/zhicui-runtime' >&2
  exit 1
}
case "$SOURCE_ROOT" in
  "$APP_DIR"|"$RUNTIME_ROOT/releases"/*) ;;
  *) echo "拒绝从未批准的 release 路径安装：$SOURCE_ROOT" >&2; exit 1 ;;
esac
for required in \
  deploy/backup/install.sh deploy/videocapsule-backend.service \
  deploy/videocapsule-frontend.service deploy/nginx-security-headers.conf \
  deploy/nginx-windows-updates.conf deploy/nginx-videocapsule.conf \
  deploy/agent-interface-kill-switch.sh deploy/jenkins-videocapsule.sudoers \
  deploy/release-evidence-store.py; do
  [[ -f "$SOURCE_ROOT/$required" ]] || { echo "发行缺少运维资产：$required" >&2; exit 1; }
done
[[ -s /etc/letsencrypt/live/luxai.cn/fullchain.pem && -s /etc/letsencrypt/live/luxai.cn/privkey.pem ]] || {
  echo 'TLS 证书不存在；首次安装请设置 CERTBOT_EMAIL 并运行 deploy/setup.sh' >&2
  exit 1
}

install -d -o ubuntu -g ubuntu -m 0775 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"
if [[ ! -e "$APP_DIR/.venv" && -x "$APP_DIR/venv/bin/python" ]]; then
  ln -s "$APP_DIR/venv" "$APP_DIR/.venv"
fi
[[ -x "$APP_DIR/.venv/bin/python" ]] || {
  echo '初始 checkout 缺少可用 .venv；请先创建 /opt/zhicui/.venv' >&2
  exit 1
}
if [[ ! -e "$RUNTIME_ROOT/current" ]]; then
  ln -s "$APP_DIR" "$RUNTIME_ROOT/current"
fi
[[ -L "$RUNTIME_ROOT/current" ]] || { echo 'runtime/current 必须是符号链接' >&2; exit 1; }
current_target="$(realpath "$RUNTIME_ROOT/current")"
case "$current_target" in
  "$APP_DIR"|"$RUNTIME_ROOT/releases"/*) ;;
  *) echo "runtime/current 指向未批准路径：$current_target" >&2; exit 1 ;;
esac

bash "$SOURCE_ROOT/deploy/backup/install.sh"
install -d -o root -g root -m 0700 /var/lib/zhicui-deployments
install -d -o ubuntu -g ubuntu -m 0770 /var/lib/zhicui-cover-cache
install -d -o root -g root -m 0755 /etc/zhicui /usr/local/lib/zhicui-deploy
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/deploy/agent-interface-kill-switch.sh" \
  /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/deploy/release-evidence-store.py" \
  /usr/local/lib/zhicui-deploy/release-evidence-store.py
# 首次安装和任何损坏状态都默认关闭；合法的既有 Stable 状态在运维资产
# 升级时保持不变，真正的模式切换只允许 deploy.sh 通过受限 helper 完成。
if ! /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify >/dev/null 2>&1; then
  /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh dark >/dev/null
fi
AGENT_KILL_SWITCH_STATE="$(
  /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify
)"
/usr/local/lib/zhicui-deploy/release-evidence-store.py status >/dev/null

# Electron 更新源独立于 Git/runtime 生命周期。迁移只补缺，不覆盖已发布版本。
install -d -o ubuntu -g ubuntu -m 0775 \
  /var/lib/zhicui-downloads/windows \
  /var/lib/zhicui-downloads/releases/windows
if [[ -d "$APP_DIR/frontend/public/download/windows" ]]; then
  rsync -a --ignore-existing "$APP_DIR/frontend/public/download/windows/" /var/lib/zhicui-downloads/windows/
fi
if [[ -d "$APP_DIR/frontend/public/download/releases/windows" ]]; then
  rsync -a --ignore-existing "$APP_DIR/frontend/public/download/releases/windows/" /var/lib/zhicui-downloads/releases/windows/
fi
rsync -a --ignore-existing "$SOURCE_ROOT/frontend/public/download/releases/windows/" /var/lib/zhicui-downloads/releases/windows/
if [[ -s /var/lib/zhicui-downloads/windows/latest.yml && ! -e /var/lib/zhicui-downloads/windows/beta.yml ]]; then
  cp -p /var/lib/zhicui-downloads/windows/latest.yml /var/lib/zhicui-downloads/windows/beta.yml
fi
chown -R ubuntu:ubuntu /var/lib/zhicui-downloads

install -m 0644 "$SOURCE_ROOT/deploy/videocapsule-backend.service" /etc/systemd/system/
install -m 0644 "$SOURCE_ROOT/deploy/videocapsule-frontend.service" /etc/systemd/system/
install -d -m 0755 /etc/nginx/snippets
install -m 0644 "$SOURCE_ROOT/deploy/nginx-security-headers.conf" /etc/nginx/snippets/zhicui-security-headers.conf
install -m 0644 "$SOURCE_ROOT/deploy/nginx-windows-updates.conf" /etc/nginx/snippets/zhicui-windows-updates.conf
install -m 0644 "$SOURCE_ROOT/deploy/nginx-videocapsule.conf" /etc/nginx/sites-available/nginx-videocapsule.conf
ln -sfn /etc/nginx/sites-available/nginx-videocapsule.conf /etc/nginx/sites-enabled/nginx-videocapsule.conf
rm -f /etc/nginx/sites-enabled/default

if id jenkins >/dev/null 2>&1; then
  usermod -aG ubuntu jenkins
fi
install -o root -g ubuntu -m 0440 \
  "$SOURCE_ROOT/deploy/jenkins-videocapsule.sudoers" /etc/sudoers.d/jenkins-videocapsule
visudo -cf /etc/sudoers.d/jenkins-videocapsule

systemctl daemon-reload
nginx -t
systemctl reload nginx
systemctl enable videocapsule-backend videocapsule-frontend
systemctl restart videocapsule-backend videocapsule-frontend

# 资产升级完成前必须产生后端可读取的最新安全备份状态。
systemctl start zhicui-postgres-backup.service
systemctl start zhicui-postgres-restore-verify.service
python3 - /var/lib/zhicui-backups/latest.json "$APP_DIR/backend/.env" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
values = {}
for raw in open(sys.argv[2], encoding="utf-8"):
    line = raw.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
offsite_text = values.get("BACKUP_OFFSITE_REQUIRED", "").lower()
if offsite_text not in {"true", "false"}:
    raise SystemExit("BACKUP_OFFSITE_REQUIRED 必须明确为 true 或 false")
offsite_required = offsite_text == "true"
local_accepted = values.get("EARLY_STAGE_LOCAL_BACKUP_ACCEPTED", "").lower() == "true"
common_ok = (
    p.get("status") == "ok"
    and p.get("checksum_verified") is True
    and p.get("restore_verified") is True
    and p.get("offsite_required") is offsite_required
)
if offsite_required:
    mode_ok = (
        p.get("backup_mode") == "offsite"
        and p.get("offsite_verified") is True
        and p.get("recovery_material_verified") is True
        and bool(p.get("offsite_verified_at"))
    )
else:
    mode_ok = (
        local_accepted and p.get("backup_mode") == "local_only"
        and p.get("offsite_verified") is False
        and p.get("recovery_material_verified") is False
        and not p.get("offsite_verified_at")
    )
if not (common_ok and mode_ok):
    raise SystemExit("本地备份恢复状态与生产配置模式不一致")
PY

echo "生产运维资产安装完成；加密备份、隔离恢复与配置模式已验证；$AGENT_KILL_SWITCH_STATE。"
echo '下一次 deploy.sh 将继续通过独立 kill-switch 执行 dark/stable 原子切换。'
