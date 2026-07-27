#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

APP_ROOT="/opt/douyin-downloader"
DEPLOY_ROOT="/opt/zhicui/deploy/douyin-sidecar"
UPSTREAM_URL="https://github.com/jiji262/douyin-downloader.git"
UPSTREAM_COMMIT="c8ddfeb997c0fd8aec6480ed056bf84d265cc954"
RELEASE_ID="${UPSTREAM_COMMIT:0:8}-$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${APP_ROOT}/releases/${RELEASE_ID}"

test -f "${DEPLOY_ROOT}/zhicui-sidecar.patch"
test -f "${DEPLOY_ROOT}/config.production.yml"
test -f "${DEPLOY_ROOT}/zhicui-douyin-sidecar.service"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  curl \
  git \
  python3-venv \
  xvfb \
  xauth

install -d -o ubuntu -g ubuntu -m 0750 \
  "${APP_ROOT}" \
  "${APP_ROOT}/releases" \
  "${APP_ROOT}/Downloaded" \
  "${APP_ROOT}/ms-playwright"
install -d -o ubuntu -g ubuntu -m 0750 "${RELEASE_DIR}"

sudo -u ubuntu git -C "${RELEASE_DIR}" init --quiet
sudo -u ubuntu git -C "${RELEASE_DIR}" remote add origin "${UPSTREAM_URL}"
sudo -u ubuntu git -C "${RELEASE_DIR}" fetch --depth 1 origin "${UPSTREAM_COMMIT}"
sudo -u ubuntu git -C "${RELEASE_DIR}" checkout --detach FETCH_HEAD
sudo -u ubuntu git -C "${RELEASE_DIR}" apply --check "${DEPLOY_ROOT}/zhicui-sidecar.patch"
sudo -u ubuntu git -C "${RELEASE_DIR}" apply "${DEPLOY_ROOT}/zhicui-sidecar.patch"

if [[ ! -x "${APP_ROOT}/.venv/bin/python" ]]; then
  sudo -u ubuntu python3 -m venv "${APP_ROOT}/.venv"
fi

sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -m pip install --upgrade pip
sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -m pip install \
  -r "${RELEASE_DIR}/requirements.txt" \
  "fastapi>=0.110,<1" \
  "uvicorn[standard]>=0.27,<1" \
  "playwright>=1.48,<2"

"${APP_ROOT}/.venv/bin/playwright" install-deps chromium
sudo -u ubuntu env PLAYWRIGHT_BROWSERS_PATH="${APP_ROOT}/ms-playwright" \
  "${APP_ROOT}/.venv/bin/playwright" install chromium

if [[ ! -f "${APP_ROOT}/config.yml" ]]; then
  install -o ubuntu -g ubuntu -m 0600 \
    "${DEPLOY_ROOT}/config.production.yml" \
    "${APP_ROOT}/config.yml"
fi

chown -R ubuntu:ubuntu \
  "${APP_ROOT}/Downloaded" \
  "${APP_ROOT}/ms-playwright" \
  "${RELEASE_DIR}"
chmod 0750 "${APP_ROOT}/Downloaded" "${APP_ROOT}/ms-playwright"
if [[ -f "${APP_ROOT}/.cookies.json" ]]; then
  chown ubuntu:ubuntu "${APP_ROOT}/.cookies.json"
  chmod 0600 "${APP_ROOT}/.cookies.json"
fi

ln -sfn "${RELEASE_DIR}" "${APP_ROOT}/current.next"
mv -Tf "${APP_ROOT}/current.next" "${APP_ROOT}/current"
install -o root -g root -m 0644 \
  "${DEPLOY_ROOT}/zhicui-douyin-sidecar.service" \
  /etc/systemd/system/zhicui-douyin-sidecar.service

systemctl daemon-reload
systemctl enable --now zhicui-douyin-sidecar.service
systemctl restart zhicui-douyin-sidecar.service

for _ in $(seq 1 30); do
  if curl --silent --fail --noproxy '*' \
    http://127.0.0.1:9000/api/v1/health >/dev/null; then
    echo "Zhicui Douyin sidecar is healthy on 127.0.0.1:9000."
    exit 0
  fi
  sleep 2
done

journalctl -u zhicui-douyin-sidecar.service -n 80 --no-pager >&2
exit 1
