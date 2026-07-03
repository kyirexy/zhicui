#!/bin/bash
# VideoCapsule CI/CD 部署脚本 —— Jenkins 触发后调用
# 拉最新代码 → 更新依赖 → 构建前端 → 重启服务 → 健康检查
set -e

APP_DIR=/opt/zhicui
VENV=$APP_DIR/venv

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log() { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] 警告:${N} $1"; }
err() { echo -e "${R}[$(date +%H:%M:%S)] 错误:${N} $1"; exit 1; }

cd $APP_DIR || err "部署目录 $APP_DIR 不存在,请先跑 setup.sh"

log "拉取最新代码..."
git pull origin master

log "更新后端依赖..."
$VENV/bin/pip install -r $APP_DIR/deploy/requirements-server.txt -q

log "构建前端..."
cd $APP_DIR/frontend
npm ci --silent || { warn "npm ci 失败,回退 npm install"; npm install --silent; }
npm run build

log "重启服务..."
sudo systemctl restart videocapsule-backend
sudo systemctl restart videocapsule-frontend

log "健康检查(等待后端就绪,最多 60s)..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    log "✅ CI/CD 部署成功"
    exit 0
  fi
  sleep 2
done
err "后端健康检查失败(60s 内未就绪,看 journalctl -u videocapsule-backend 排查)"
