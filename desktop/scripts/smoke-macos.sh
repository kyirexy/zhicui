#!/bin/bash
set -euo pipefail

package_root="${1:?需要构建目录}"
app_path=$(find "$package_root" -maxdepth 3 -name '*.app' -type d -print -quit)
test -n "$app_path"
executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app_path/Contents/Info.plist")
mkdir -p "$package_root/smoke"
app_pid=''
cleanup() {
  if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

# 云端仅验证无账号启动与重新打开；登录、系统权限和分发仍需真机验收。
for attempt in 1 2; do
  ZHICUI_DESKTOP_SMOKE=1 "$app_path/Contents/MacOS/$executable" >"$package_root/smoke/launch-$attempt.log" 2>&1 &
  app_pid=$!
  ready=0
  for tick in $(seq 1 90); do
    kill -0 "$app_pid"
    if grep -Fq '[desktop-smoke] 页面加载完成' "$package_root/smoke/launch-$attempt.log"; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    printf '%s\n' 'App 在 90 秒内未完成页面加载。' >&2
    exit 1
  fi
  sleep 5
  if [ "$attempt" = 1 ]; then
    /usr/sbin/screencapture -x "$package_root/smoke/launch.png"
  fi
  kill "$app_pid"
  wait "$app_pid" || true
  app_pid=''
  if grep -Eq 'TypeError:|ReferenceError:|Error occurred in handler|渲染进程退出' "$package_root/smoke/launch-$attempt.log"; then
    printf '%s\n' '启动日志存在应用运行错误，请检查构建产物日志。' >&2
    exit 1
  fi
done
printf '%s\n' 'Mac 安装包已完成两次启动与退出检查。'
