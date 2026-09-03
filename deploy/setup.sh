#!/bin/bash
# VideoCapsule / 知萃 初次部署脚本 —— 在服务器上以 sudo 运行一次
# 装环境 + 克隆代码 + 配 systemd + 配 Nginx + 启动
set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log()  { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] 警告:${N} $1"; }
err()  { echo -e "${R}[$(date +%H:%M:%S)] 错误:${N} $1"; exit 1; }

APP_DIR=/opt/zhicui
VENV=$APP_DIR/.venv
REPO_URL=https://github.com/kyirexy/zhicui.git
PIP_BOOTSTRAP_VERSION=26.2.1

[[ $EUID -ne 0 ]] && err "请用 sudo 运行: sudo bash deploy/setup.sh"

log "=== [0/8] 创建 2G swap(防内存不足) ==="
if ! swapon --show | grep -q swap; then
  if [ -f /swapfile ]; then
    warn "/swapfile 已存在但未启用,尝试启用"
    swapon /swapfile 2>/dev/null || warn "/swapfile 启用失败,跳过 swap"
  else
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    log "swap 2G 已启用"
  fi
else
  log "swap 已存在,跳过"
fi

log "=== [1/8] 安装系统依赖 ==="
apt update -qq
apt install -y python3.12 python3.12-venv ffmpeg git nginx curl ca-certificates rsync postgresql-client openssl certbot python3-certbot-nginx
# Node.js 20+ (Next.js 16 要求 >=20.9.0；Ubuntu 24.04 自带 18 不够)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  log "安装 NodeSource Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource-setup.sh && bash /tmp/nodesource-setup.sh
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
$VENV/bin/python -m pip install --upgrade "pip==$PIP_BOOTSTRAP_VERSION" -q
$VENV/bin/python -m pip install \
  --require-hashes \
  --only-binary=:all: \
  --no-binary=qrcode-terminal \
  -r "$APP_DIR/deploy/requirements-server.lock" \
  -q
$VENV/bin/python -m pip check
log "后端依赖安装完成"

log "=== [4/8] 生成 .env 配置 ==="
if [ ! -f "$APP_DIR/backend/.env" ]; then
  cp "$APP_DIR/deploy/production.env.example" "$APP_DIR/backend/.env"
  chmod 0600 "$APP_DIR/backend/.env"
  warn ".env 已由生产模板生成；填写所有 CHANGE_ME 后发布闸门才会放行"
else
  log ".env 已存在,保留"
fi

log "=== [5/8] 构建前端 ==="
cd $APP_DIR/frontend
npm ci --silent || { warn "npm ci 失败,回退 npm install"; npm install --silent; }
npm run build

log "=== [6/8] 安装 systemd 服务 ==="
install -d -o ubuntu -g ubuntu -m 0775 /opt/zhicui-runtime /opt/zhicui-runtime/releases
install -d -o root -g root -m 0755 /etc/zhicui /usr/local/lib/zhicui-deploy
install -o root -g root -m 0755 \
  "$APP_DIR/deploy/agent-interface-kill-switch.sh" \
  /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh
install -o root -g root -m 0755 \
  "$APP_DIR/deploy/release-evidence-store.py" \
  /usr/local/lib/zhicui-deploy/release-evidence-store.py
if ! /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh verify >/dev/null 2>&1; then
  /usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh dark >/dev/null
fi
if [ ! -e /opt/zhicui-runtime/current ]; then
  ln -s "$APP_DIR" /opt/zhicui-runtime/current
fi
[ -L /opt/zhicui-runtime/current ] || err "/opt/zhicui-runtime/current 必须是符号链接"
cp $APP_DIR/deploy/videocapsule-backend.service /etc/systemd/system/
cp $APP_DIR/deploy/videocapsule-frontend.service /etc/systemd/system/
chown -R ubuntu:ubuntu $APP_DIR
chmod -R g+w $APP_DIR
systemctl daemon-reload
systemctl enable videocapsule-backend videocapsule-frontend
bash "$APP_DIR/deploy/backup/install.sh"
install -d -o root -g root -m 0700 /var/lib/zhicui-deployments
/usr/local/lib/zhicui-deploy/release-evidence-store.py status >/dev/null
install -d -o ubuntu -g ubuntu -m 0770 /var/lib/zhicui-cover-cache
install -d -o ubuntu -g ubuntu -m 0775 \
  /var/lib/zhicui-downloads/windows \
  /var/lib/zhicui-downloads/releases/windows
rsync -a --ignore-existing "$APP_DIR/frontend/public/download/releases/windows/" \
  /var/lib/zhicui-downloads/releases/windows/
chown -R ubuntu:ubuntu /var/lib/zhicui-downloads

log "=== [7/8] 配置 Nginx 反向代理 ==="
install -d -m 0755 /etc/nginx/snippets
install -m 0644 "$APP_DIR/deploy/nginx-security-headers.conf" /etc/nginx/snippets/zhicui-security-headers.conf
install -m 0644 "$APP_DIR/deploy/nginx-windows-updates.conf" /etc/nginx/snippets/zhicui-windows-updates.conf
if [ ! -s /etc/letsencrypt/live/luxai.cn/fullchain.pem ] || [ ! -s /etc/letsencrypt/live/luxai.cn/privkey.pem ]; then
  [ -n "${CERTBOT_EMAIL:-}" ] || err "首次部署缺少 TLS 证书；请设置 CERTBOT_EMAIL 后重跑 setup.sh"
  cp "$APP_DIR/deploy/nginx-bootstrap.conf" /etc/nginx/sites-available/nginx-videocapsule.conf
  ln -sf /etc/nginx/sites-available/nginx-videocapsule.conf /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "$CERTBOT_EMAIL" -d luxai.cn -d www.luxai.cn
fi
cp $APP_DIR/deploy/nginx-videocapsule.conf /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/nginx-videocapsule.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx

log "=== [8/8] 配置 Jenkins 部署权限 ==="
if id jenkins >/dev/null 2>&1; then
  usermod -aG ubuntu jenkins
  systemctl restart jenkins 2>/dev/null || true
  log "jenkins 权限已配置(加入 ubuntu 组 + sudo 免密启停服务)"
else
  warn "jenkins 用户不存在,装完 Jenkins 后重跑此脚本以配置权限"
fi
install -o root -g ubuntu -m 0440 \
  "$APP_DIR/deploy/jenkins-videocapsule.sudoers" /etc/sudoers.d/jenkins-videocapsule
visudo -cf /etc/sudoers.d/jenkins-videocapsule

log "=== 启动应用服务 ==="
systemctl restart videocapsule-backend
sleep 3
systemctl restart videocapsule-frontend

log "=== 初始化备份恢复安全状态 ==="
if systemctl start zhicui-postgres-backup.service && systemctl start zhicui-postgres-restore-verify.service; then
  log "首次加密备份、隔离恢复与异地回读验证通过"
else
  err "首次灾备门禁失败；配置真实异地目标和加密恢复材料后重跑，当前版本不可发布"
fi

log "=== ✅ 部署完成 ==="
echo ""
echo "  后端健康检查: curl http://127.0.0.1:8000/api/health"
echo "  前端:        http://127.0.0.1:3000"
echo "  对外访问:    http://$(curl -s --max-time 3 ifconfig.me || echo '服务器IP')"
echo ""
warn "剩余步骤:"
echo "  1. 编辑后端配置: sudo nano $APP_DIR/backend/.env  填入 API_KEY / LLM_API_KEY / JWT_SECRET"
echo "     然后重启: sudo systemctl restart videocapsule-backend"
echo "  2. 编辑灾备配置: sudo nano /etc/zhicui/backup.env  填入真实异地目标和加密恢复材料"
echo "  3. 腾讯云控制台 → 防火墙 → 放行 TCP 80 端口"
echo "  4. 配置 Jenkins CI/CD(访问 http://服务器IP:8080)"
echo "  5. Agent 接口由 /etc/zhicui/agent-interface.env 独立控制；首次安装保持 dark"
