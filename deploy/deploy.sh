#!/usr/bin/env bash
# 知萃生产部署：串行执行、隔离构建、短暂停服切换、失败自动回滚。
set -Eeuo pipefail
umask 022

APP_DIR="${APP_DIR:-/opt/zhicui}"
VENV="$APP_DIR/venv"
FRONTEND_DIR="$APP_DIR/frontend"
STAGING_ROOT="$APP_DIR/.deploy-staging"
BACKUP_ROOT="$APP_DIR/.deploy-backup"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/zhicui-deploy.lock}"

G='\033[0;32m'
Y='\033[1;33m'
R='\033[0;31m'
N='\033[0m'
log() { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] 警告:${N} $1"; }
err() { echo -e "${R}[$(date +%H:%M:%S)] 错误:${N} $1"; exit 1; }

command -v flock >/dev/null 2>&1 || err "服务器缺少 flock，无法保证部署串行执行"
command -v rsync >/dev/null 2>&1 || err "服务器缺少 rsync，无法创建隔离构建目录"
sudo -n -l /bin/systemctl stop videocapsule-frontend >/dev/null 2>&1 ||
  err "当前部署用户缺少停止前端服务的免密 sudo 权限，请重新运行 deploy/setup.sh"
sudo -n -l /bin/systemctl start videocapsule-frontend >/dev/null 2>&1 ||
  err "当前部署用户缺少启动前端服务的免密 sudo 权限，请重新运行 deploy/setup.sh"

# Jenkins 层会排队；此锁同时保护手工执行和其他自动化入口。
# 锁文件可能由 jenkins 或 ubuntu 首次创建，因此只读打开后再加 flock，
# 避免第二个系统用户因为文件所有权不同而无法参与同一把锁。
if [ ! -e "$LOCK_FILE" ]; then
  (umask 000; : >"$LOCK_FILE") ||
    err "无法创建部署锁文件：$LOCK_FILE"
fi
exec 9<"$LOCK_FILE"
if ! flock -n 9; then
  warn "已有部署正在执行，等待它完成..."
  flock 9
fi
log "已获得生产部署锁"

cd "$APP_DIR" || err "部署目录 $APP_DIR 不存在，请先运行 setup.sh"

DEPLOY_ID_SOURCE="${BUILD_TAG:-manual-$(date +%Y%m%d%H%M%S)-$$}"
DEPLOY_ID="$(printf '%s' "$DEPLOY_ID_SOURCE" | tr -cd 'A-Za-z0-9._-')"
[ -n "$DEPLOY_ID" ] || DEPLOY_ID="manual-$(date +%Y%m%d%H%M%S)-$$"

STAGING_DIR="$STAGING_ROOT/$DEPLOY_ID"
BACKUP_DIR="$BACKUP_ROOT/$DEPLOY_ID"
SWITCH_STARTED=0
DEPLOY_SUCCEEDED=0

is_guarded_child() {
  local root="$1"
  local target="$2"
  case "$target" in
    "$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

remove_guarded_dir() {
  local root="$1"
  local target="$2"
  if [ -e "$target" ] || [ -L "$target" ]; then
    is_guarded_child "$root" "$target" ||
      err "拒绝清理不安全路径：$target"
    rm -rf -- "$target"
  fi
}

rollback_frontend() {
  warn "新版本未能正常上线，正在恢复上一版前端..."
  set +e
  sudo systemctl stop videocapsule-frontend

  if [ -d "$BACKUP_DIR/.next" ]; then
    rm -rf -- "$FRONTEND_DIR/.next"
    mv -- "$BACKUP_DIR/.next" "$FRONTEND_DIR/.next"
  fi
  if [ -d "$BACKUP_DIR/node_modules" ]; then
    rm -rf -- "$FRONTEND_DIR/node_modules"
    mv -- "$BACKUP_DIR/node_modules" "$FRONTEND_DIR/node_modules"
  fi

  sudo systemctl start videocapsule-frontend
  warn "已执行上一版前端恢复；本次部署仍以失败退出"
  set -e
}

on_exit() {
  local status=$?
  trap - EXIT

  if [ "$status" -ne 0 ] &&
    [ "$SWITCH_STARTED" -eq 1 ] &&
    [ "$DEPLOY_SUCCEEDED" -eq 0 ]; then
    rollback_frontend
  fi

  remove_guarded_dir "$STAGING_ROOT" "$STAGING_DIR"
  if [ "$DEPLOY_SUCCEEDED" -eq 1 ] ||
    { [ ! -d "$BACKUP_DIR/.next" ] && [ ! -d "$BACKUP_DIR/node_modules" ]; }; then
    remove_guarded_dir "$BACKUP_ROOT" "$BACKUP_DIR"
  fi

  exit "$status"
}
trap on_exit EXIT

log "拉取最新代码..."
git pull --ff-only origin master
git submodule sync --recursive
git submodule update --init --recursive

log "更新后端依赖..."
"$VENV/bin/pip" install -r "$APP_DIR/deploy/requirements-server.txt" -q

log "准备隔离前端构建目录..."
mkdir -p "$STAGING_ROOT" "$BACKUP_ROOT"
remove_guarded_dir "$STAGING_ROOT" "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
rsync -a \
  --exclude='.next/' \
  --exclude='node_modules/' \
  --exclude='out/' \
  --exclude='android/.gradle/' \
  --exclude='android/app/build/' \
  "$FRONTEND_DIR/" "$STAGING_DIR/"

log "在隔离目录安装前端依赖..."
cd "$STAGING_DIR"
npm ci --silent || {
  warn "npm ci 失败，尝试 npm install"
  npm install --silent
}

log "在隔离目录构建前端..."
npm run build

if [ -d "$FRONTEND_DIR/.next/static" ]; then
  log "保留上一版哈希静态资源，兼容部署期间已打开的页面..."
  rsync -a --ignore-existing \
    "$FRONTEND_DIR/.next/static/" \
    "$STAGING_DIR/.next/static/"
  find "$STAGING_DIR/.next/static" -type f -mtime +14 -delete
fi

log "验证暂存构建产物..."
[ -s "$STAGING_DIR/.next/BUILD_ID" ] ||
  err "暂存构建缺少 .next/BUILD_ID"
[ -f "$STAGING_DIR/node_modules/next/package.json" ] ||
  err "暂存构建缺少 Next.js 依赖"
[ -f "$STAGING_DIR/node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js" ] ||
  err "暂存构建的 Next.js 依赖不完整"
[ -d "$FRONTEND_DIR/.next" ] ||
  err "当前线上前端缺少 .next，无法安全回滚"
[ -d "$FRONTEND_DIR/node_modules" ] ||
  err "当前线上前端缺少 node_modules，无法安全回滚"

remove_guarded_dir "$BACKUP_ROOT" "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
SWITCH_STARTED=1

log "暂存构建有效，短暂停止前端并切换完整产物..."
sudo systemctl stop videocapsule-frontend
mv -- "$FRONTEND_DIR/.next" "$BACKUP_DIR/.next"
mv -- "$FRONTEND_DIR/node_modules" "$BACKUP_DIR/node_modules"
mv -- "$STAGING_DIR/.next" "$FRONTEND_DIR/.next"
mv -- "$STAGING_DIR/node_modules" "$FRONTEND_DIR/node_modules"

log "重启后端并启动新前端..."
sudo systemctl restart videocapsule-backend
sudo systemctl start videocapsule-frontend

log "检查后端 API 与前端设置页（最长 60 秒）..."
BACKEND_READY=0
FRONTEND_READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 \
    http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    BACKEND_READY=1
  else
    BACKEND_READY=0
  fi

  if curl -fsS --max-time 5 \
    http://127.0.0.1:3000/settings >/dev/null 2>&1; then
    FRONTEND_READY=1
  else
    FRONTEND_READY=0
  fi

  if [ "$BACKEND_READY" -eq 1 ] && [ "$FRONTEND_READY" -eq 1 ]; then
    DEPLOY_SUCCEEDED=1
    log "✅ 前后端均已就绪，CI/CD 部署成功"
    exit 0
  fi
  sleep 2
done

sudo systemctl --no-pager --full status videocapsule-backend || true
sudo systemctl --no-pager --full status videocapsule-frontend || true
err "健康检查失败：backend=$BACKEND_READY frontend=$FRONTEND_READY"
