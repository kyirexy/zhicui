#!/usr/bin/env bash
# 原子切换 Nginx 前端端口。只有已经通过本机 readiness 的颜色才允许由调用方切换。
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo 'frontend-route.sh 必须以 root 运行' >&2; exit 1; }
color="${1:-}"
case "$color" in
  blue) port=3001 ;;
  green) port=3002 ;;
  *) echo '颜色只能是 blue 或 green' >&2; exit 64 ;;
esac

PORT_FILE="/etc/nginx/snippets/zhicui-frontend-port.conf"
STATE_FILE="/etc/zhicui/frontend-color"
install -d -m 0755 /etc/zhicui /etc/nginx/snippets

old_port_file="$(mktemp /etc/nginx/snippets/.zhicui-frontend-port.old.XXXXXX)"
new_port_file="$(mktemp /etc/nginx/snippets/.zhicui-frontend-port.new.XXXXXX)"
old_state_file="$(mktemp /etc/zhicui/.frontend-color.old.XXXXXX)"
new_state_file="$(mktemp /etc/zhicui/.frontend-color.new.XXXXXX)"
cleanup() {
  rm -f -- "$old_port_file" "$new_port_file" "$old_state_file" "$new_state_file"
}
trap cleanup EXIT

if [[ -f "$PORT_FILE" ]]; then cp -p -- "$PORT_FILE" "$old_port_file"; else : >"$old_port_file"; fi
if [[ -f "$STATE_FILE" ]]; then cp -p -- "$STATE_FILE" "$old_state_file"; else printf 'blue\n' >"$old_state_file"; fi
printf 'set $zhicui_frontend_port %s;\n' "$port" >"$new_port_file"
printf '%s\n' "$color" >"$new_state_file"
install -m 0644 "$new_port_file" "$PORT_FILE"
install -m 0644 "$new_state_file" "$STATE_FILE"

if ! /usr/sbin/nginx -t >/dev/null; then
  install -m 0644 "$old_port_file" "$PORT_FILE"
  install -m 0644 "$old_state_file" "$STATE_FILE"
  echo 'Nginx 配置检查失败，前端流量保持原颜色' >&2
  exit 1
fi
if ! /bin/systemctl reload nginx; then
  install -m 0644 "$old_port_file" "$PORT_FILE"
  install -m 0644 "$old_state_file" "$STATE_FILE"
  echo 'Nginx reload 失败，前端流量保持原颜色' >&2
  exit 1
fi
