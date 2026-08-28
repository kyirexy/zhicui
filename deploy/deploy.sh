#!/usr/bin/env bash
# 知萃生产部署：不可变 Git worktree + 原子 runtime symlink + 失败切回上一版。
set -Eeuo pipefail
umask 027

APP_DIR="${APP_DIR:-/opt/zhicui}"
RUNTIME_ROOT="${ZHICUI_RUNTIME_ROOT:-/opt/zhicui-runtime}"
RELEASE_ROOT="$RUNTIME_ROOT/releases"
CURRENT_LINK="$RUNTIME_ROOT/current"
BACKEND_ENV="$APP_DIR/backend/.env"
DOWNLOAD_ROOT="${ZHICUI_DOWNLOAD_ROOT:-/var/lib/zhicui-downloads}"
EVIDENCE_ROOT="${DEPLOY_EVIDENCE_DIR:-/var/lib/zhicui-deployments}"
BACKUP_STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/zhicui-backups/latest.json}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/zhicui-deploy.lock}"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log() { printf "${G}[%s]${N} %s\n" "$(date +%H:%M:%S)" "$1"; }
warn() { printf "${Y}[%s] 警告:${N} %s\n" "$(date +%H:%M:%S)" "$1"; }
err() { printf "${R}[%s] 错误:${N} %s\n" "$(date +%H:%M:%S)" "$1" >&2; exit 1; }

for command_name in flock git npm node curl python3 python3.12 timeout cmp diff realpath readlink sudo; do
  command -v "$command_name" >/dev/null 2>&1 || err "服务器缺少命令：$command_name"
done
[[ "$APP_DIR" == /opt/zhicui && "$RUNTIME_ROOT" == /opt/zhicui-runtime ]] ||
  err '生产发布仅允许批准的 checkout 与 runtime 目录'
[[ -e "$APP_DIR/.git" && -f "$BACKEND_ENV" ]] ||
  err '生产 checkout 或 backend/.env 不完整'
[[ "$DOWNLOAD_ROOT" == /var/lib/zhicui-downloads && -d "$DOWNLOAD_ROOT" ]] ||
  err '持久发行目录未安装；请先执行 preinstall-production-assets.sh'
[[ -L "$CURRENT_LINK" ]] ||
  err "缺少 runtime/current；先执行 sudo bash $APP_DIR/deploy/preinstall-production-assets.sh"
[[ -d "$EVIDENCE_ROOT" && -w "$EVIDENCE_ROOT" ]] ||
  err "部署证据目录不可写；先执行 sudo bash $APP_DIR/deploy/preinstall-production-assets.sh"

if [[ ! -e "$LOCK_FILE" ]]; then
  (umask 000; : >"$LOCK_FILE") || err "无法创建部署锁：$LOCK_FILE"
fi
exec 9<"$LOCK_FILE"
if ! flock -n 9; then
  warn '已有部署正在执行，等待它完成'
  flock 9
fi

cd "$APP_DIR"
[[ "$(git symbolic-ref --short HEAD 2>/dev/null || true)" == master ]] ||
  err '生产 checkout 必须位于 master 分支'
[[ -z "$(git status --porcelain --untracked-files=no --ignore-submodules=all)" ]] ||
  err '生产 checkout 存在已跟踪改动；拒绝覆盖，先由运维审阅并恢复干净状态'

DEPLOY_ID_SOURCE="${BUILD_TAG:-manual-$(date +%Y%m%d%H%M%S)-$$}"
DEPLOY_ID="$(printf '%s' "$DEPLOY_ID_SOURCE" | tr -cd 'A-Za-z0-9._-')"
[[ -n "$DEPLOY_ID" ]] || DEPLOY_ID="manual-$(date +%Y%m%d%H%M%S)-$$"
RELEASE_DIR="$RELEASE_ROOT/$DEPLOY_ID"
EVIDENCE_FILE="$EVIDENCE_ROOT/$DEPLOY_ID.json"
SMOKE_EVIDENCE_FILE="$EVIDENCE_ROOT/$DEPLOY_ID-smoke.json"
GATES_FILE="$(mktemp)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
PREVIOUS_RUNTIME="$(realpath "$CURRENT_LINK")"
TARGET_COMMIT=""
BUILD_ID=""
BACKUP_ARTIFACT=""
WORKTREE_CREATED=0
SWITCH_STARTED=0
DEPLOY_SUCCEEDED=0
PRESERVE_RELEASE=0
ROLLBACK_RESULT="not_required"
SMOKE_FIXTURE_PROVISIONED=0

case "$PREVIOUS_RUNTIME" in
  "$APP_DIR"|"$RELEASE_ROOT"/*) ;;
  *) err "runtime/current 指向未批准路径：$PREVIOUS_RUNTIME" ;;
esac
[[ -x "$PREVIOUS_RUNTIME/.venv/bin/python" ]] ||
  err "当前 runtime 缺少独立 .venv：$PREVIOUS_RUNTIME"

record_gate() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "${3:-}" | tr '\t\r\n' '   ' | cut -c1-240)" >>"$GATES_FILE"
}

cleanup_smoke_fixture() {
  [[ "$SMOKE_FIXTURE_PROVISIONED" -eq 1 ]] || return 0
  [[ -n "${SMOKE_LOGIN_EMAIL:-}" && -x "$RELEASE_DIR/.venv/bin/python" ]] || return 1
  (
    cd "$APP_DIR/backend"
    "$RELEASE_DIR/.venv/bin/python" \
      "$RELEASE_DIR/scripts/manage_production_smoke_fixture.py" cleanup \
      --email "$SMOKE_LOGIN_EMAIL" >/dev/null
  )
}

atomic_runtime_switch() {
  local target="$1" temporary="$RUNTIME_ROOT/.current-$DEPLOY_ID-$$"
  case "$target" in "$APP_DIR"|"$RELEASE_ROOT"/*) ;; *) return 1 ;; esac
  rm -f -- "$temporary"
  ln -s "$target" "$temporary"
  mv -Tf -- "$temporary" "$CURRENT_LINK"
  [[ "$(realpath "$CURRENT_LINK")" == "$(realpath "$target")" ]]
}

rollback_runtime() {
  warn '发布闸门失败，原子切回上一版 runtime'
  ROLLBACK_RESULT="attempted"
  local failed=0 resolved=''
  set +e
  sudo systemctl stop videocapsule-frontend || failed=1
  atomic_runtime_switch "$PREVIOUS_RUNTIME" || failed=1
  resolved="$(realpath "$CURRENT_LINK" 2>/dev/null)" || failed=1
  [[ "$resolved" == "$PREVIOUS_RUNTIME" ]] || failed=1
  sudo systemctl restart videocapsule-backend || failed=1
  sudo systemctl start videocapsule-frontend || failed=1
  if [[ "$failed" -eq 0 ]] &&
     curl -fsS --max-time 8 http://127.0.0.1:8000/api/health >/dev/null 2>&1 &&
     curl -fsS --max-time 8 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    ROLLBACK_RESULT="succeeded"
    record_gate rollback pass "$PREVIOUS_RUNTIME"
  else
    ROLLBACK_RESULT="failed"
    record_gate rollback fail '回滚后健康检查失败，需人工介入'
  fi
  set -e
}

write_evidence() {
  local exit_status="$1"
  python3 - "$GATES_FILE" "$EVIDENCE_FILE" "$DEPLOY_ID" "$STARTED_AT" "$exit_status" \
    "$PREVIOUS_COMMIT" "$TARGET_COMMIT" "$BUILD_ID" "$BACKUP_ARTIFACT" "$ROLLBACK_RESULT" <<'PY' || true
import json, os, sys
from datetime import datetime, timezone
(source, target, deploy_id, started_at, exit_status, previous_commit,
 target_commit, build_id, backup_artifact, rollback) = sys.argv[1:]
checks = []
if os.path.exists(source):
    for line in open(source, encoding="utf-8"):
        name, status, detail = line.rstrip("\n").split("\t", 2)
        checks.append({"name": name, "status": status, "detail": detail or None})
payload = {
    "schema_version": 1,
    "deployment_id": deploy_id,
    "status": "succeeded" if int(exit_status) == 0 else "failed",
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "actor": os.environ.get("BUILD_USER_ID") or os.environ.get("USER") or "unknown",
    "job": os.environ.get("JOB_NAME") or "manual",
    "previous_commit": previous_commit,
    "target_commit": target_commit or None,
    "frontend_build_id": build_id or None,
    "backup_artifact": backup_artifact or None,
    "rollback": rollback,
    "gates": checks,
}
temporary = f"{target}.tmp-{os.getpid()}"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o640)
os.replace(temporary, target)
PY
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$SMOKE_FIXTURE_PROVISIONED" -eq 1 ]]; then
    if cleanup_smoke_fixture; then
      SMOKE_FIXTURE_PROVISIONED=0
      record_gate smoke_fixture_cleanup pass '隔离资料与残留会话已清理'
    else
      status=1
      record_gate smoke_fixture_cleanup fail '隔离资料清理失败，需人工介入'
    fi
  fi
  if [[ "$status" -ne 0 && "$SWITCH_STARTED" -eq 1 && "$DEPLOY_SUCCEEDED" -eq 0 ]]; then
    rollback_runtime
  fi
  if [[ "$ROLLBACK_RESULT" == failed ]]; then
    PRESERVE_RELEASE=1
  fi
  write_evidence "$status"
  if [[ "$status" -ne 0 && "$WORKTREE_CREATED" -eq 1 && "$PRESERVE_RELEASE" -eq 0 ]]; then
    case "$RELEASE_DIR" in "$RELEASE_ROOT"/*) git -C "$APP_DIR" worktree remove --force "$RELEASE_DIR" || true ;; esac
  fi
  rm -f -- "$GATES_FILE"
  exit "$status"
}
trap on_exit EXIT

log '验证生产环境为 fail-closed 配置'
python3 - "$BACKEND_ENV" <<'PY' || err '生产环境配置不满足发布要求'
import sys
import base64
from pathlib import Path
path = Path(sys.argv[1])
values = {}
for raw in path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
errors = []
allowed = {item.strip() for item in values.get("ALLOWED_ORIGINS", "").split(",") if item.strip()}
expected = {"https://luxai.cn", "https://www.luxai.cn", "https://localhost"}
if allowed != expected: errors.append("ALLOWED_ORIGINS 不符合生产允许列表")
for flag in ("RATE_LIMIT_ENABLED", "OPS_MONITOR_ENABLED"):
    if values.get(flag, "").lower() != "true": errors.append(f"{flag} 必须为 true")
if values.get("BACKUP_STATUS_FILE") != "/var/lib/zhicui-backups/latest.json": errors.append("BACKUP_STATUS_FILE 不安全")
if values.get("BACKUP_MAX_AGE_HOURS") != "36": errors.append("BACKUP_MAX_AGE_HOURS 必须为 36")
if values.get("BACKUP_OFFSITE_REQUIRED", "").lower() != "true": errors.append("BACKUP_OFFSITE_REQUIRED 必须为 true")
database_url = values.get("DATABASE_URL", "")
if not database_url.startswith("postgresql") or "CHANGE_ME" in database_url: errors.append("DATABASE_URL 不是有效生产 PostgreSQL")
jwt_secret = values.get("JWT_SECRET", "")
if not jwt_secret or jwt_secret.startswith("CHANGE_ME"):
    errors.append("JWT_SECRET 未配置真实秘密")
else:
    try:
        if len(jwt_secret) % 2 == 0 and all(ch in "0123456789abcdefABCDEF" for ch in jwt_secret):
            jwt_bytes = bytes.fromhex(jwt_secret)
        else:
            padded = jwt_secret + "=" * (-len(jwt_secret) % 4)
            jwt_bytes = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception:
        jwt_bytes = jwt_secret.encode("utf-8")
    if len(jwt_bytes) < 32 or len(set(jwt_bytes)) < 16:
        errors.append("JWT_SECRET 必须至少包含 32 个随机字节")
encryption_key = values.get("ENCRYPTION_KEY", "")
try:
    decoded_key = base64.urlsafe_b64decode(encryption_key.encode("ascii"))
except Exception:
    decoded_key = b""
if encryption_key.startswith("CHANGE_ME") or len(decoded_key) != 32:
    errors.append("ENCRYPTION_KEY 必须是 Fernet 32-byte URL-safe base64 密钥")
for flag in ("DEV_AUTH_BYPASS", "NEXT_PUBLIC_DEV_AUTH_AUTO"):
    if values.get(flag, "false").lower() in {"1", "true", "yes", "on"}: errors.append(f"{flag} 不得开启")
if errors: raise SystemExit("；".join(errors))
PY
record_gate production_env pass 'CORS、限流、监控、本地备份、异地灾备与秘密配置通过'

[[ -n "${SMOKE_LOGIN_EMAIL:-}" && -n "${SMOKE_PASSWORD_FILE:-}" ]] ||
  err '生产部署必须注入 SMOKE_LOGIN_EMAIL 与 SMOKE_PASSWORD_FILE'
[[ -r "$SMOKE_PASSWORD_FILE" && -s "$SMOKE_PASSWORD_FILE" ]] ||
  err 'SMOKE_PASSWORD_FILE 不可读或为空'

for unit in zhicui-postgres-backup.service zhicui-postgres-restore-verify.service; do
  sudo -n -l /bin/systemctl start "$unit" >/dev/null 2>&1 ||
    err "缺少 $unit 权限；运行 sudo bash $APP_DIR/deploy/preinstall-production-assets.sh"
done

log '部署前执行加密备份与隔离恢复验证'
sudo systemctl start zhicui-postgres-backup.service || err 'PostgreSQL 加密备份失败，保持当前版本'
sudo systemctl start zhicui-postgres-restore-verify.service || err '隔离恢复验证失败，保持当前版本'
BACKUP_ARTIFACT="$(python3 - "$BACKUP_STATUS_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
p = json.load(open(sys.argv[1], encoding="utf-8"))
backup_completed_text = str(p.get("backup_completed_at", ""))
restore_verified_text = str(p.get("restore_verified_at", ""))
completed = datetime.fromisoformat(backup_completed_text.replace("Z", "+00:00"))
restored = datetime.fromisoformat(restore_verified_text.replace("Z", "+00:00"))
if completed.tzinfo is None: completed = completed.replace(tzinfo=timezone.utc)
if restored.tzinfo is None: restored = restored.replace(tzinfo=timezone.utc)
age = (datetime.now(timezone.utc) - completed.astimezone(timezone.utc)).total_seconds()
if (p.get("completed_at") != backup_completed_text or restored < completed or
    p.get("status") != "ok" or p.get("checksum_verified") is not True or
    p.get("restore_verified") is not True or p.get("offsite_required") is not True or
    p.get("offsite_verified") is not True or p.get("recovery_material_verified") is not True or
    not p.get("offsite_verified_at") or not (0 <= age <= 3600)):
    raise SystemExit("备份状态不是最近一小时内完成的本地恢复和异地校验")
print(str(p.get("artifact") or ""))
PY
)" || err '备份状态文件无效，保持当前版本'
[[ -n "$BACKUP_ARTIFACT" ]] || err '备份状态缺少归档标识'
record_gate predeploy_backup pass "$BACKUP_ARTIFACT（含异地回读校验）"

log '获取目标提交并创建不可变 worktree'
git fetch --prune origin master
TARGET_COMMIT="$(git rev-parse origin/master)"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || err '无法解析 origin/master'
[[ ! -e "$RELEASE_DIR" ]] || err "发行目录已存在：$RELEASE_DIR"
git worktree add --detach "$RELEASE_DIR" "$TARGET_COMMIT"
WORKTREE_CREATED=1
if ! timeout 120s git -C "$RELEASE_DIR" -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 submodule update --init --recursive; then
  warn '可选集成子模块未能在 120 秒内更新；主应用继续，sidecar 保持已安装版本'
fi

for pair in \
  "$RELEASE_DIR/deploy/nginx-security-headers.conf:/etc/nginx/snippets/zhicui-security-headers.conf" \
  "$RELEASE_DIR/deploy/nginx-windows-updates.conf:/etc/nginx/snippets/zhicui-windows-updates.conf" \
  "$RELEASE_DIR/deploy/nginx-videocapsule.conf:/etc/nginx/sites-available/nginx-videocapsule.conf" \
  "$RELEASE_DIR/deploy/videocapsule-backend.service:/etc/systemd/system/videocapsule-backend.service" \
  "$RELEASE_DIR/deploy/videocapsule-frontend.service:/etc/systemd/system/videocapsule-frontend.service" \
  "$RELEASE_DIR/deploy/backup/postgres-backup.sh:/usr/local/lib/zhicui-backup/postgres-backup.sh" \
  "$RELEASE_DIR/deploy/backup/postgres-restore-verify.sh:/usr/local/lib/zhicui-backup/postgres-restore-verify.sh" \
  "$RELEASE_DIR/deploy/backup/postgres-offsite-replicate.sh:/usr/local/lib/zhicui-backup/postgres-offsite-replicate.sh" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-backup.service:/etc/systemd/system/zhicui-postgres-backup.service" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-backup.timer:/etc/systemd/system/zhicui-postgres-backup.timer" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-restore-verify.service:/etc/systemd/system/zhicui-postgres-restore-verify.service" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-restore-verify.timer:/etc/systemd/system/zhicui-postgres-restore-verify.timer" \
  "$RELEASE_DIR/deploy/jenkins-videocapsule.sudoers:/etc/sudoers.d/jenkins-videocapsule"; do
  source_file="${pair%%:*}"; installed_file="${pair#*:}"
  if [[ ! -f "$installed_file" ]] || ! cmp -s "$source_file" "$installed_file"; then
    PRESERVE_RELEASE=1
    err "生产运维资产需要升级；执行 sudo bash $RELEASE_DIR/deploy/preinstall-production-assets.sh 后重试"
  fi
done
if [[ ! -d /usr/local/share/zhicui-deploy/backup ]] ||
   ! diff -qr "$RELEASE_DIR/deploy/backup" /usr/local/share/zhicui-deploy/backup >/dev/null; then
  PRESERVE_RELEASE=1
  err "完整 backup/* 安装快照存在漂移；执行 sudo bash $RELEASE_DIR/deploy/preinstall-production-assets.sh 后重试"
fi
sudo -n /usr/sbin/nginx -t
record_gate production_assets pass 'systemd、Nginx、SSE 与下载规则一致'

ZHICUI_DOWNLOAD_ROOT="$DOWNLOAD_ROOT" node "$RELEASE_DIR/scripts/verify-release-manifests.mjs"
record_gate release_manifests pass 'beta/stable 清单与 Android beta 产物一致'

log '为目标 release 创建独立 Python 环境'
python3.12 -m venv "$RELEASE_DIR/.venv"
"$RELEASE_DIR/.venv/bin/pip" install --upgrade pip -q
"$RELEASE_DIR/.venv/bin/pip" install -r "$RELEASE_DIR/deploy/requirements-server.txt" -q
"$RELEASE_DIR/.venv/bin/pip" check

for env_name in .env.local .env.production.local; do
  if [[ -f "$APP_DIR/frontend/$env_name" ]]; then
    install -m 0600 "$APP_DIR/frontend/$env_name" "$RELEASE_DIR/frontend/$env_name"
  fi
done
log '在目标 worktree 构建前端'
cd "$RELEASE_DIR/frontend"
npm ci --silent
npm run build
[[ -s "$RELEASE_DIR/frontend/.next/BUILD_ID" ]] || err '目标构建缺少 BUILD_ID'
[[ -f "$RELEASE_DIR/frontend/node_modules/next/package.json" ]] || err '目标构建缺少 Next.js'
BUILD_ID="$(<"$RELEASE_DIR/frontend/.next/BUILD_ID")"
record_gate frontend_build pass "$BUILD_ID"

log '原子切换 runtime 并启动目标版本'
SWITCH_STARTED=1
sudo systemctl stop videocapsule-frontend
atomic_runtime_switch "$RELEASE_DIR"
[[ "$(realpath "$CURRENT_LINK")" == "$(realpath "$RELEASE_DIR")" ]] || err 'runtime 身份校验失败'
sudo systemctl restart videocapsule-backend
sudo systemctl start videocapsule-frontend

READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8000/api/health >/dev/null 2>&1 &&
     curl -fsS --max-time 5 http://127.0.0.1:8000/api/readiness >/dev/null 2>&1 &&
     curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done
[[ "$READY" -eq 1 ]] || err '目标版本在 60 秒内未通过 liveness/readiness'
record_gate readiness pass '目标 runtime 本机探测通过'

log '为专用普通账号预置隔离的固定冒烟视频资料'
SMOKE_FIXTURE_PROVISIONED=1
SMOKE_SOURCE_ID="$(
  cd "$APP_DIR/backend"
  "$RELEASE_DIR/.venv/bin/python" \
    "$RELEASE_DIR/scripts/manage_production_smoke_fixture.py" ensure \
    --email "$SMOKE_LOGIN_EMAIL"
)" || err '无法预置隔离冒烟资料'
[[ "$SMOKE_SOURCE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || err '冒烟资料返回了无效 source id'
record_gate smoke_fixture pass '专用账号固定资料已预置（不记录账号或资料标识）'

SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://luxai.cn}" \
SMOKE_EVIDENCE_FILE="$SMOKE_EVIDENCE_FILE" \
SMOKE_REQUIRE_AUTHENTICATED="${SMOKE_REQUIRE_AUTHENTICATED:-1}" \
SMOKE_REQUIRE_AGENT_SSE="${SMOKE_REQUIRE_AGENT_SSE:-1}" \
SMOKE_LOGIN_EMAIL="${SMOKE_LOGIN_EMAIL:-}" \
SMOKE_PASSWORD_FILE="${SMOKE_PASSWORD_FILE:-}" \
SMOKE_SOURCE_ID="$SMOKE_SOURCE_ID" \
  bash "$RELEASE_DIR/scripts/smoke-production.sh"
record_gate production_smoke pass "$SMOKE_EVIDENCE_FILE"

cleanup_smoke_fixture || err '冒烟通过，但隔离资料或残留会话清理失败'
SMOKE_FIXTURE_PROVISIONED=0
record_gate smoke_fixture_cleanup pass '隔离资料与残留会话已清理'

# 所有闸门通过后才推进长期 checkout；失败时 checkout 始终保留上一版且保持干净。
cd "$APP_DIR"
git merge --ff-only "$TARGET_COMMIT"
DEPLOY_SUCCEEDED=1
record_gate deployment pass "$TARGET_COMMIT"
log '✅ 原子 runtime、备份、readiness、发行与真实用户旅程全部通过'
