#!/usr/bin/env bash
# root 持有的 Agent 接口总开关。它与 backend/.env 完全独立，避免应用
# 回滚时继承一次尚未完成的公开接口配置修改。
set -Eeuo pipefail
umask 077

STATE_DIR="/etc/zhicui"
STATE_FILE="$STATE_DIR/agent-interface.env"

fail() {
  printf '[zhicui-agent-kill-switch] ERROR: %s\n' "$1" >&2
  exit 1
}

verify_file() {
  local expected="${1:-}" line_count assignment profile_line profile='full' mode owner
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail '状态目录不存在或不是受控目录'
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail '状态文件不存在或不是普通文件'
  owner="$(stat -c '%u:%g' "$STATE_FILE")"
  mode="$(stat -c '%a' "$STATE_FILE")"
  [[ "$owner" == '0:0' ]] || fail '状态文件必须归 root 所有'
  [[ "$mode" == '600' ]] || fail '状态文件权限必须为 0600'
  line_count="$(grep -Ev '^[[:space:]]*(#|$)' "$STATE_FILE" | wc -l | tr -d '[:space:]')"
  [[ "$line_count" == 1 || "$line_count" == 2 ]] || fail '状态文件只能包含启用状态与明确的能力范围'
  assignment="$(grep '^AGENT_INTERFACE_ENABLED=' "$STATE_FILE")"
  profile_line="$(grep '^AGENT_INTERFACE_PROFILE=' "$STATE_FILE" || true)"
  if [[ "$line_count" == 2 ]]; then
    case "$profile_line" in
      AGENT_INTERFACE_PROFILE=full) profile='full' ;;
      AGENT_INTERFACE_PROFILE=core) profile='core' ;;
      *) fail '状态文件的能力范围无效' ;;
    esac
  fi
  case "$assignment" in
    AGENT_INTERFACE_ENABLED=false) [[ "$profile" == full ]] || fail '关闭态不接受能力范围覆盖'; current='dark' ;;
    AGENT_INTERFACE_ENABLED=true) [[ "$profile" == core ]] && current='core' || current='stable' ;;
    *) fail '状态文件包含未知或无效配置' ;;
  esac
  if [[ -n "$expected" && "$current" != "$expected" ]]; then
    fail "当前模式不是 $expected"
  fi
  printf 'agent_interface=%s\n' "$current"
}

write_mode() {
  local requested="$1" enabled temporary profile='full'
  case "$requested" in
    dark) enabled='false' ;;
    stable) enabled='true' ;;
    core) enabled='true'; profile='core' ;;
    *) fail '写入模式只能是 dark、core 或 stable' ;;
  esac
  install -d -o root -g root -m 0755 "$STATE_DIR"
  [[ ! -L "$STATE_DIR" ]] || fail '拒绝写入符号链接目录'
  if [[ -e "$STATE_FILE" && ( -L "$STATE_FILE" || ! -f "$STATE_FILE" ) ]]; then
    fail '拒绝覆盖非普通状态文件'
  fi
  temporary="$(mktemp "$STATE_DIR/.agent-interface.env.XXXXXX")"
  trap 'rm -f -- "$temporary"' RETURN
  printf '# Managed by deploy/agent-interface-kill-switch.sh; do not edit.\nAGENT_INTERFACE_ENABLED=%s\nAGENT_INTERFACE_PROFILE=%s\n' \
    "$enabled" "$profile" >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -fT -- "$temporary" "$STATE_FILE"
  trap - RETURN
  verify_file "$requested"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail '必须以 root 身份运行'
case "${1:-}" in
  dark|stable|core) write_mode "$1" ;;
  verify) verify_file ;;
  verify-dark) verify_file dark ;;
  verify-stable) verify_file stable ;;
  verify-core) verify_file core ;;
  *) fail '用法：agent-interface-kill-switch.sh dark|stable|core|verify|verify-dark|verify-stable|verify-core' ;;
esac
