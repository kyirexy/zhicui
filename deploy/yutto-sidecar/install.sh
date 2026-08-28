#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

APP_ROOT="/opt/yutto-sidecar"
DEPLOY_ROOT="/opt/zhicui/deploy/yutto-sidecar"
UPSTREAM_URL="https://github.com/yutto-dev/yutto.git"
UPSTREAM_VERSION="2.2.0"
UPSTREAM_COMMIT="ba90a95bd89e416059ee5559b52197531d5d8998"
SOURCE_DIR="${APP_ROOT}/source/${UPSTREAM_COMMIT}"
TOKEN_FILE="${APP_ROOT}/server.token"
CATALOG_PATCH="${DEPLOY_ROOT}/zhicui-catalog-fields.patch"

test -f "${DEPLOY_ROOT}/zhicui-yutto-sidecar.service"
test -f "${DEPLOY_ROOT}/health_check.py"
test -f "${DEPLOY_ROOT}/preflight.py"
test -f "${DEPLOY_ROOT}/SOURCE-NOTICE.md"
test -f "${CATALOG_PATCH}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  ffmpeg \
  git \
  pkg-config \
  python3-venv

install -d -o ubuntu -g ubuntu -m 0750 \
  "${APP_ROOT}" \
  "${APP_ROOT}/source" \
  "${APP_ROOT}/blocked-downloads" \
  "${APP_ROOT}/tmp" \
  "${APP_ROOT}/.cargo" \
  "${APP_ROOT}/.rustup"

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  install -d -o ubuntu -g ubuntu -m 0750 "${SOURCE_DIR}"
  sudo -u ubuntu git -C "${SOURCE_DIR}" init --quiet
  sudo -u ubuntu git -C "${SOURCE_DIR}" remote add origin "${UPSTREAM_URL}"
  sudo -u ubuntu git -C "${SOURCE_DIR}" fetch --depth 1 origin "${UPSTREAM_COMMIT}"
  sudo -u ubuntu git -C "${SOURCE_DIR}" checkout --detach FETCH_HEAD
fi

if [[ "$(sudo -u ubuntu git -C "${SOURCE_DIR}" rev-parse HEAD)" != "${UPSTREAM_COMMIT}" ]]; then
  echo "Refusing to install an unreviewed yutto revision." >&2
  exit 1
fi
test -f "${SOURCE_DIR}/LICENSE"

# Keep the runtime reproducible: remove a previously applied copy of our
# reviewed projection patch, reject any other tracked source modification,
# then apply the checked-in patch again.  The patch only adds publication time
# and duration to resolve-only item snapshots; it never enables downloads.
if sudo -u ubuntu git -C "${SOURCE_DIR}" apply --reverse --check "${CATALOG_PATCH}" >/dev/null 2>&1; then
  sudo -u ubuntu git -C "${SOURCE_DIR}" apply --reverse "${CATALOG_PATCH}"
fi
if ! sudo -u ubuntu git -C "${SOURCE_DIR}" diff --quiet; then
  echo "Refusing to build a yutto source tree with unreviewed modifications." >&2
  exit 1
fi
sudo -u ubuntu git -C "${SOURCE_DIR}" apply --check "${CATALOG_PATCH}"
sudo -u ubuntu git -C "${SOURCE_DIR}" apply "${CATALOG_PATCH}"

if [[ ! -x "${APP_ROOT}/.venv/bin/python" ]]; then
  sudo -u ubuntu python3 -m venv "${APP_ROOT}/.venv"
fi
sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -m pip install --upgrade pip

# The public 2.2.0 wheel predates this reviewed revision's JSON-RPC server and
# does not contain `yutto serve`. Build the exact source instead. Rustup itself
# is pinned and checksum-verified; the workspace requires Rust >= 1.85.
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "This reviewed installer currently supports x86_64 only." >&2
  exit 1
fi
RUSTUP_INIT="${APP_ROOT}/rustup-init-1.28.2-x86_64"
if [[ ! -x "${RUSTUP_INIT}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 \
    https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init \
    --output "${RUSTUP_INIT}.next"
  echo "20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  ${RUSTUP_INIT}.next" \
    | sha256sum --check --strict
  install -o ubuntu -g ubuntu -m 0755 "${RUSTUP_INIT}.next" "${RUSTUP_INIT}"
fi
sudo -u ubuntu env \
  CARGO_HOME="${APP_ROOT}/.cargo" \
  RUSTUP_HOME="${APP_ROOT}/.rustup" \
  "${RUSTUP_INIT}" -y --no-modify-path --profile minimal --default-toolchain 1.85.0
sudo -u ubuntu env \
  CARGO_HOME="${APP_ROOT}/.cargo" \
  RUSTUP_HOME="${APP_ROOT}/.rustup" \
  PATH="${APP_ROOT}/.cargo/bin:${PATH}" \
  CARGO_NET_GIT_FETCH_WITH_CLI=true \
  "${APP_ROOT}/.venv/bin/python" -m pip install "${SOURCE_DIR}"
sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -m pip check
sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -c \
  'import yutto, websockets; assert websockets.__version__.split(".", 1)[0] == "17"'
sudo -u ubuntu "${APP_ROOT}/.venv/bin/yutto" serve -h >/dev/null

if [[ "$(sudo -u ubuntu "${APP_ROOT}/.venv/bin/yutto" --version)" != "yutto ${UPSTREAM_VERSION}" ]]; then
  echo "Installed yutto version does not match ${UPSTREAM_VERSION}." >&2
  exit 1
fi

if [[ ! -e "${TOKEN_FILE}" ]]; then
  install -o ubuntu -g ubuntu -m 0600 /dev/null "${TOKEN_FILE}"
  sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" -c \
    'import secrets,sys; open(sys.argv[1], "w", encoding="utf-8").write(secrets.token_urlsafe(48))' \
    "${TOKEN_FILE}"
fi
if [[ -L "${TOKEN_FILE}" || ! -f "${TOKEN_FILE}" ]]; then
  echo "Refusing unsafe yutto token file." >&2
  exit 1
fi
chown ubuntu:ubuntu "${TOKEN_FILE}"
chmod 0600 "${TOKEN_FILE}"

install -o root -g root -m 0644 \
  "${DEPLOY_ROOT}/zhicui-yutto-sidecar.service" \
  /etc/systemd/system/zhicui-yutto-sidecar.service
install -o root -g root -m 0644 \
  "${SOURCE_DIR}/LICENSE" \
  "${APP_ROOT}/LICENSE.yutto-GPL-3.0"
install -o root -g root -m 0644 \
  "${DEPLOY_ROOT}/SOURCE-NOTICE.md" \
  "${APP_ROOT}/SOURCE-NOTICE.md"
install -o root -g root -m 0644 \
  "${CATALOG_PATCH}" \
  "${APP_ROOT}/zhicui-catalog-fields.patch"
install -o root -g root -m 0755 \
  "${DEPLOY_ROOT}/health_check.py" \
  "${APP_ROOT}/health_check.py"
install -o ubuntu -g ubuntu -m 0755 \
  "${DEPLOY_ROOT}/preflight.py" \
  "${APP_ROOT}/preflight.py"

sudo -u ubuntu "${APP_ROOT}/.venv/bin/python" "${APP_ROOT}/preflight.py"

systemctl daemon-reload

# The feature and sidecar are deliberately off after deployment.  Production
# must pass the authenticated health check before an administrator opts in.
if [[ "${YUTTO_ENABLE_ON_INSTALL:-0}" == "1" ]]; then
  systemctl enable --now zhicui-yutto-sidecar.service
  "${APP_ROOT}/.venv/bin/python" "${APP_ROOT}/health_check.py"
else
  systemctl disable --now zhicui-yutto-sidecar.service >/dev/null 2>&1 || true
  echo "yutto ${UPSTREAM_VERSION} installed but left disabled (release gate)."
fi
