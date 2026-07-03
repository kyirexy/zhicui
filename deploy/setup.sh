#!/bin/bash
# VideoCapsule / 知萃 初次部署脚本 —— 在服务器上以 sudo 运行一次
# 装环境 + 克隆代码 + 配 systemd + 配 Nginx + 启动
set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log()  { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] 警告:${N} $1"; }
err()  { echo -e "${R}[$(date +%H:%M:%S)] 错误:${N} $1"; exit 1; }

APP_DIR=/opt/zhicui
VENV=$APP_DIR/venv
REPO_URL=https://github.com/kyirexy/zhicui.git

[[ $EUID -ne 0 ]] && err "请用 sudo 运行: sudo bash deploy/setup.sh"

log "=== [0/8] 创建 2G swap(防内存不足) ==="
if ! swapon --show | grep -q swap; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "swap 2G 已启用"
else
  log "swap 已存在,跳过"
fi

log "=== [1/8] 安装系统依赖 ==="
apt update -qq
apt install -y python3.12 python3.12-venv ffmpeg git nginx curl ca-certificates
# Node.js 20+ (Next.js 16 要求 >=20.9.0；Ubuntu 24.04 自带 18 不够)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  log "安装 NodeSource Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
log "Python $(python3 --version 2>&1) | Node $(node -v) | npm $(npm -v)"

log "=== 配置 pip / npm 国内镜像 ==="
mkdir -p /root/.config/pip
printf '[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\n' > /root/.config/pip/pip.conf
npm config set registry https://registry.npmmirror.com

log "=== [2/8] 检查代码 ==="
mkdir -p $APP_DIR && cd $APP_DIR
if [ -d "$APP_DIR/backend" ]; then
  log "代码已就位(本地打包上传),跳过 clone"
elif [ -d "$APP_DIR/.git" ]; then
  git pull
else
  git clone $REPO_URL $APP_DIR
fi
if [ ! -d "$APP_DIR/douyin-mcp-server" ]; then
  log "尝试克隆 douyin-mcp-server 依赖..."
  git clone https://github.com/yzfly/douyin-mcp-server.git $APP_DIR/douyin-mcp-server || warn "douyin-mcp-server clone 失败,若已打包上传可忽略"
fi
git config core.sharedRepository group 2>/dev/null || true

log "=== [3/8] 创建 Python venv + 装后端依赖 ==="
python3.12 -m venv $VENV
$VENV/bin/pip install --upgrade pip -q
$VENV/bin/pip install -r $APP_DIR/deploy/requirements-server.txt -q
log "后端依赖安装完成"

log "=== [4/8] 生成 .env 配置 ==="
if [ ! -f "$APP_DIR/backend/.env" ]; then
  cp $APP_DIR/.env.example $APP_DIR/backend/.env
  warn ".env 已生成,稍后必须编辑填入 API key"
else
  log ".env 已存在,保留"
fi

log "=== [5/8] 构建前端 ==="
cd $APP_DIR/frontend
npm ci --silent 2>/dev/null || npm install --silent
npm run build

log "=== [6/8] 安装 systemd 服务 ==="
cp $APP_DIR/deploy/videocapsule-backend.service /etc/systemd/system/
cp $APP_DIR/deploy/videocapsule-frontend.service /etc/systemd/system/
chown -R ubuntu:ubuntu $APP_DIR
chmod -R g+w $APP_DIR
systemctl daemon-reload
systemctl enable videocapsule-backend videocapsule-frontend

log "=== [7/8] 配置 Nginx 反向代理 ==="
cp $APP_DIR/deploy/nginx-videocapsule.conf /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/nginx-videocapsule.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx

log "=== [8/8] 配置 Jenkins 部署权限 ==="
if id jenkins >/dev/null 2>&1; then
  usermod -aG ubuntu jenkins
  echo "jenkins ALL=(ALL) NOPASSWD: /bin/systemctl restart videocapsule-backend, /bin/systemctl restart videocapsule-frontend, /bin/systemctl status videocapsule*" > /etc/sudoers.d/jenkins-videocapsule
  chmod 440 /etc/sudoers.d/jenkins-videocapsule
  systemctl restart jenkins 2>/dev/null || true
  log "jenkins 权限已配置(加入 ubuntu 组 + sudo 免密重启服务)"
else
  warn "jenkins 用户不存在,装完 Jenkins 后重跑此脚本以配置权限"
fi

log "=== 启动应用服务 ==="
systemctl restart videocapsule-backend
sleep 3
systemctl restart videocapsule-frontend

log "=== ✅ 部署完成 ==="
echo ""
echo "  后端健康检查: curl http://127.0.0.1:8000/api/health"
echo "  前端:        http://127.0.0.1:3000"
echo "  对外访问:    http://$(curl -s --max-time 3 ifconfig.me || echo '服务器IP')"
echo ""
warn "剩余步骤:"
echo "  1. 编辑后端配置: sudo nano $APP_DIR/backend/.env  填入 API_KEY / LLM_API_KEY / JWT_SECRET"
echo "     然后重启: sudo systemctl restart videocapsule-backend"
echo "  2. 腾讯云控制台 → 防火墙 → 放行 TCP 80 端口"
echo "  3. 配置 Jenkins CI/CD(访问 http://服务器IP:8080)"
