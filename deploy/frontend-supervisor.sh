#!/usr/bin/env bash
# 启动当前被 Nginx 选中的前端颜色；蓝绿服务本身由 systemd 管理。
set -Eeuo pipefail

STATE_FILE="/etc/zhicui/frontend-color"

read_color() {
  local color=""
  if [[ -s "$STATE_FILE" ]]; then
    color="$(tr -d '[:space:]' <"$STATE_FILE")"
  fi
  case "$color" in
    blue|green) printf '%s' "$color" ;;
    *) printf '%s' blue ;;
  esac
}

case "${1:-}" in
  start)
    color="$(read_color)"
    exec /bin/systemctl start "videocapsule-frontend-${color}.service"
    ;;
  stop)
    /bin/systemctl stop videocapsule-frontend-blue.service videocapsule-frontend-green.service || true
    ;;
  status)
    color="$(read_color)"
    /bin/systemctl is-active "videocapsule-frontend-${color}.service"
    ;;
  *)
    echo '用法：frontend-supervisor.sh start|stop|status' >&2
    exit 64
    ;;
esac
