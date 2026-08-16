#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/zhicui}"
SOURCE_DIR="$APP_DIR/integrations/XHS-Downloader"
PATCH_FILE="$APP_DIR/deploy/xhs-downloader/zhicui-creator.patch"
PINNED_COMMIT="4f0f7a406551ef1e97f2bea1207b3be1703173b3"

cd "$APP_DIR"
git submodule update --init --recursive integrations/XHS-Downloader

cd "$SOURCE_DIR"
CURRENT_COMMIT="$(git rev-parse HEAD)"
if [ "$CURRENT_COMMIT" != "$PINNED_COMMIT" ]; then
  echo "XHS-Downloader 版本与已审查补丁不一致：$CURRENT_COMMIT" >&2
  exit 1
fi

if git apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "知萃博主同步扩展已存在"
else
  git apply --check "$PATCH_FILE"
  git apply "$PATCH_FILE"
fi

python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e .

sudo cp "$APP_DIR/deploy/xhs-downloader/xhs-downloader.service" \
  /etc/systemd/system/xhs-downloader.service
sudo systemctl daemon-reload
sudo systemctl enable --now xhs-downloader
sudo systemctl restart xhs-downloader

curl --noproxy '*' --fail --silent --show-error \
  http://127.0.0.1:5556/ >/dev/null
echo "XHS-Downloader sidecar 已安装并通过 loopback 健康检查"
