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
AGENT_RELEASE_MODE="${AGENT_RELEASE_MODE:-dark}"
AGENT_KILL_SWITCH_FILE="/etc/zhicui/agent-interface.env"
AGENT_KILL_SWITCH_HELPER="/usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh"
RELEASE_EVIDENCE_HELPER="/usr/local/lib/zhicui-deploy/release-evidence-store.py"
PIP_BOOTSTRAP_VERSION="26.2.1"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log() { printf "${G}[%s]${N} %s\n" "$(date +%H:%M:%S)" "$1"; }
warn() { printf "${Y}[%s] 警告:${N} %s\n" "$(date +%H:%M:%S)" "$1"; }
err() { printf "${R}[%s] 错误:${N} %s\n" "$(date +%H:%M:%S)" "$1" >&2; exit 1; }

for command_name in flock git npm node curl python3 python3.12 timeout cmp diff realpath readlink sha256sum sudo; do
  command -v "$command_name" >/dev/null 2>&1 || err "服务器缺少命令：$command_name"
done
case "$AGENT_RELEASE_MODE" in
  dark|stable) ;;
  *) err 'AGENT_RELEASE_MODE 只能是 dark 或 stable' ;;
esac
if [[ "$AGENT_RELEASE_MODE" == stable && "${SMOKE_REQUIRE_AGENT_INTERFACE:-1}" != 1 ]]; then
  err 'Stable 发布不得跳过 Agent Action/PAT/MCP 冒烟'
fi
[[ "$APP_DIR" == /opt/zhicui && "$RUNTIME_ROOT" == /opt/zhicui-runtime ]] ||
  err '生产发布仅允许批准的 checkout 与 runtime 目录'
[[ -x "$AGENT_KILL_SWITCH_HELPER" && -x "$RELEASE_EVIDENCE_HELPER" && -f "$AGENT_KILL_SWITCH_FILE" ]] ||
  err 'Agent 独立 kill-switch 或 release evidence helper 未安装；请先执行 preinstall-production-assets.sh'
[[ -e "$APP_DIR/.git" && -f "$BACKEND_ENV" ]] ||
  err '生产 checkout 或 backend/.env 不完整'
[[ "$DOWNLOAD_ROOT" == /var/lib/zhicui-downloads && -d "$DOWNLOAD_ROOT" ]] ||
  err '持久发行目录未安装；请先执行 preinstall-production-assets.sh'
[[ -L "$CURRENT_LINK" ]] ||
  err "缺少 runtime/current；先执行 sudo bash $APP_DIR/deploy/preinstall-production-assets.sh"
[[ "$EVIDENCE_ROOT" == /var/lib/zhicui-deployments ]] ||
  err '生产部署证据目录不允许覆盖'
sudo -n "$RELEASE_EVIDENCE_HELPER" status >/dev/null ||
  err "root-owned 证据仓未就绪；先执行 sudo bash $APP_DIR/deploy/preinstall-production-assets.sh"

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
GATES_FILE="$(mktemp)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
PREVIOUS_RUNTIME="$(realpath "$CURRENT_LINK")"
PREVIOUS_RUNTIME_COMMIT=""
TARGET_COMMIT=""
PREVIOUS_AGENT_SCHEMA_FINGERPRINT=""
TARGET_AGENT_SCHEMA_FINGERPRINT=""
AGENT_SCHEMA_DARK_EVIDENCE=""
AGENT_SCHEMA_DARK_EVIDENCE_SHA256=""
AGENT_SCHEMA_REHEARSAL_EVIDENCE=""
AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256=""
BUILD_ID=""
BACKUP_ARTIFACT=""
BACKUP_SHA256=""
BACKUP_SIZE_BYTES=""
BACKUP_METADATA_SHA256=""
BACKUP_STATUS_EVIDENCE_SHA256=""
SMOKE_EVIDENCE_TEMP=""
SMOKE_EVIDENCE_NAME=""
SMOKE_EVIDENCE_SHA256=""
WORKTREE_CREATED=0
SWITCH_STARTED=0
DEPLOY_SUCCEEDED=0
EVIDENCE_WRITTEN=0
PRESERVE_RELEASE=0
ROLLBACK_RESULT="not_required"
SMOKE_FIXTURE_PROVISIONED=0

case "$PREVIOUS_RUNTIME" in
  "$APP_DIR"|"$RELEASE_ROOT"/*) ;;
  *) err "runtime/current 指向未批准路径：$PREVIOUS_RUNTIME" ;;
esac
[[ -x "$PREVIOUS_RUNTIME/.venv/bin/python" ]] ||
  err "当前 runtime 缺少独立 .venv：$PREVIOUS_RUNTIME"
# current 可能来自受控的 ubuntu 运维 worktree，而流水线以 jenkins 运行。
# 路径已在上方 realpath 并限制到批准目录，因此仅对本次命令信任这个精确路径，
# 避免依赖持久的 safe.directory 或使用不安全的通配符。
PREVIOUS_RUNTIME_COMMIT="$(git -c safe.directory="$PREVIOUS_RUNTIME" -C "$PREVIOUS_RUNTIME" rev-parse HEAD 2>/dev/null || true)"
[[ "$PREVIOUS_RUNTIME_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  err "当前 runtime 无法追溯到完整 Git 提交：$PREVIOUS_RUNTIME"

record_gate() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "${3:-}" | tr '\t\r\n' '   ' | cut -c1-240)" >>"$GATES_FILE"
}

json_value() {
  local payload="$1" field="$2"
  python3 -c 'import json,sys; value=json.loads(sys.argv[1]); print(value[sys.argv[2]])' \
    "$payload" "$field"
}

asset_matches() {
  local source_file="$1" installed_file="$2"
  if [[ "$installed_file" == /etc/sudoers.d/jenkins-videocapsule ]]; then
    local source_sha installed_sha
    source_sha="$(sha256sum "$source_file" | awk '{print $1}')"
    installed_sha="$(sudo -n /usr/bin/sha256sum "$installed_file" | awk '{print $1}')" || return 1
    [[ "$source_sha" == "$installed_sha" ]]
    return
  fi
  cmp -s "$source_file" "$installed_file"
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

prune_reproducible_release_artifacts() {
  local current_runtime previous_runtime candidate resolved failed=0
  current_runtime="$(realpath "$CURRENT_LINK")" || return 1
  previous_runtime="$(realpath "$PREVIOUS_RUNTIME")" || return 1
  case "$current_runtime" in "$RELEASE_ROOT"/*) ;; *) return 1 ;; esac
  case "$previous_runtime" in "$APP_DIR"|"$RELEASE_ROOT"/*) ;; *) return 1 ;; esac

  while IFS= read -r -d '' candidate; do
    resolved="$(realpath "$candidate")" || { failed=1; continue; }
    case "$resolved" in "$RELEASE_ROOT"/manual-*) ;; *) failed=1; continue ;; esac
    if [[ "$resolved" == "$current_runtime" || "$resolved" == "$previous_runtime" ]]; then
      continue
    fi
    if ! git -C "$APP_DIR" worktree remove --force "$resolved"; then
      # A directory left by an older deployment may no longer be registered as
      # a worktree. It is still safe to remove after the approved-root check.
      rm -rf -- "$resolved" || failed=1
    fi
  done < <(find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'manual-*' -print0)

  git -C "$APP_DIR" worktree prune --expire now || failed=1
  npm cache clean --force >/dev/null 2>&1 || failed=1
  return "$failed"
}

atomic_runtime_switch() {
  local target="$1" temporary="$RUNTIME_ROOT/.current-$DEPLOY_ID-$$"
  case "$target" in "$APP_DIR"|"$RELEASE_ROOT"/*) ;; *) return 1 ;; esac
  rm -f -- "$temporary"
  ln -s "$target" "$temporary"
  mv -Tf -- "$temporary" "$CURRENT_LINK"
  [[ "$(realpath "$CURRENT_LINK")" == "$(realpath "$target")" ]]
}

set_agent_kill_switch() {
  local mode="$1"
  sudo -n "$AGENT_KILL_SWITCH_HELPER" "$mode" >/dev/null
  sudo -n "$AGENT_KILL_SWITCH_HELPER" "verify-$mode" >/dev/null
}

wait_backend_health() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 5 http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

probe_agent_interface() {
  local expected="$1" body status result
  body="$(mktemp)"
  status="$(
    curl -sS --max-time 8 -o "$body" -w '%{http_code}' \
      http://127.0.0.1:8000/api/agent-interface/v1/capabilities
  )" || { rm -f -- "$body"; return 1; }
  if python3 - "$expected" "$status" "$body" <<'PY'
import json, sys

expected, status, path = sys.argv[1:]
try:
    payload = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError):
    payload = {}
error = payload.get("error") if isinstance(payload, dict) else None
error_code = error.get("code") if isinstance(error, dict) else None
data = payload.get("data") if isinstance(payload, dict) else None
if expected == "enabled":
    ok = status == "200" and isinstance(data, dict) and data.get("feature_enabled") is True
elif expected == "disabled":
    ok = status == "503" and error_code == "INTERFACE_DISABLED"
elif expected == "absent-or-disabled":
    ok = status == "404" or (status == "503" and error_code == "INTERFACE_DISABLED")
else:
    ok = False
raise SystemExit(0 if ok else 1)
PY
  then
    result=0
  else
    result=1
  fi
  rm -f -- "$body"
  return "$result"
}

verify_agent_schema() {
  local runtime="$1"
  "$runtime/.venv/bin/python" "$runtime/deploy/verify-agent-schema.py" \
    --env-file "$BACKEND_ENV" \
    --require-postgresql \
    --output fingerprint
}

verify_agent_schema_dark_baseline() {
  local expected_commit="$1" expected_fingerprint="$2"
  printf '{"expected_commit":"%s","expected_fingerprint":"%s"}\n' \
    "$expected_commit" "$expected_fingerprint" |
    sudo -n "$RELEASE_EVIDENCE_HELPER" verify-dark
}

verify_agent_schema_rehearsal() {
  local expected_commit="$1" expected_fingerprint="$2"
  local dark_name="$3" dark_sha256="$4"
  printf '{"expected_commit":"%s","expected_fingerprint":"%s","dark_evidence_name":"%s","dark_evidence_sha256":"%s"}\n' \
    "$expected_commit" "$expected_fingerprint" "$dark_name" "$dark_sha256" |
    sudo -n "$RELEASE_EVIDENCE_HELPER" verify-rehearsal
}

force_agent_fail_closed() {
  local failed=0
  set +e
  set_agent_kill_switch dark || failed=1
  sudo systemctl restart videocapsule-backend || failed=1
  wait_backend_health || failed=1
  probe_agent_interface absent-or-disabled || failed=1
  set -e
  [[ "$failed" -eq 0 ]]
}

rollback_runtime() {
  warn '发布闸门失败，原子切回上一版 runtime'
  ROLLBACK_RESULT="attempted"
  local failed=0 resolved=''
  set +e
  set_agent_kill_switch dark || failed=1
  sudo systemctl stop videocapsule-frontend || failed=1
  atomic_runtime_switch "$PREVIOUS_RUNTIME" || failed=1
  resolved="$(realpath "$CURRENT_LINK" 2>/dev/null)" || failed=1
  [[ "$resolved" == "$PREVIOUS_RUNTIME" ]] || failed=1
  sudo systemctl restart videocapsule-backend || failed=1
  sudo systemctl start videocapsule-frontend || failed=1
  if [[ "$failed" -eq 0 ]] &&
     wait_backend_health &&
     curl -fsS --max-time 8 http://127.0.0.1:3000/ >/dev/null 2>&1 &&
     probe_agent_interface absent-or-disabled; then
    ROLLBACK_RESULT="succeeded"
    record_gate agent_kill_switch_rollback pass 'Agent 接口已原子恢复为 false 并完成运行态复验'
    record_gate rollback pass "$PREVIOUS_RUNTIME"
  else
    ROLLBACK_RESULT="failed"
    record_gate agent_kill_switch_rollback fail 'Agent kill-switch 无法恢复关闭，需立即人工介入'
    record_gate rollback fail '回滚后健康检查失败，需人工介入'
  fi
  set -e
}

persist_smoke_evidence() {
  local result
  [[ -z "$SMOKE_EVIDENCE_NAME" ]] || return 0
  [[ -n "$SMOKE_EVIDENCE_TEMP" && -s "$SMOKE_EVIDENCE_TEMP" ]] || return 1
  result="$(sudo -n "$RELEASE_EVIDENCE_HELPER" store-smoke <"$SMOKE_EVIDENCE_TEMP")" || return 1
  SMOKE_EVIDENCE_NAME="$(json_value "$result" name)" || return 1
  SMOKE_EVIDENCE_SHA256="$(json_value "$result" sha256)" || return 1
  [[ "$SMOKE_EVIDENCE_NAME" == "$DEPLOY_ID-smoke.json" &&
     "$SMOKE_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 1
  rm -f -- "$SMOKE_EVIDENCE_TEMP"
  SMOKE_EVIDENCE_TEMP=""
}

write_evidence() {
  local exit_status="$1" result
  result="$({
    python3 - "$GATES_FILE" "$DEPLOY_ID" "$STARTED_AT" "$exit_status" \
      "$PREVIOUS_COMMIT" "$TARGET_COMMIT" "$BUILD_ID" "$ROLLBACK_RESULT" \
      "$AGENT_RELEASE_MODE" "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT" \
      "$TARGET_AGENT_SCHEMA_FINGERPRINT" "$BACKUP_ARTIFACT" "$BACKUP_SHA256" \
      "$BACKUP_SIZE_BYTES" "$BACKUP_METADATA_SHA256" "$BACKUP_STATUS_EVIDENCE_SHA256" \
      "$SMOKE_EVIDENCE_NAME" "$SMOKE_EVIDENCE_SHA256" \
      "$AGENT_SCHEMA_DARK_EVIDENCE" "$AGENT_SCHEMA_DARK_EVIDENCE_SHA256" \
      "$AGENT_SCHEMA_REHEARSAL_EVIDENCE" "$AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256" <<'PY'
import json, os, sys
from datetime import datetime, timezone
(source, deploy_id, started_at, exit_status, previous_commit, target_commit,
 build_id, rollback, agent_release_mode, previous_agent_schema_fingerprint,
 target_agent_schema_fingerprint, backup_artifact, backup_sha256,
 backup_size_bytes, backup_metadata_sha256, backup_status_evidence_sha256,
 smoke_evidence_name, smoke_evidence_sha256, dark_evidence_name,
 dark_evidence_sha256, rehearsal_evidence_name,
 rehearsal_evidence_sha256) = sys.argv[1:]
checks = []
if os.path.exists(source):
    for line in open(source, encoding="utf-8"):
        name, status, detail = line.rstrip("\n").split("\t", 2)
        checks.append({"name": name, "status": status, "detail": detail or None})
payload = {
    "schema_version": 2,
    "operation": "production_deployment",
    "deployment_id": deploy_id,
    "status": "succeeded" if int(exit_status) == 0 else "failed",
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "actor": os.environ.get("BUILD_USER_ID") or os.environ.get("USER") or "unknown",
    "job": os.environ.get("JOB_NAME") or "manual",
    "previous_commit": previous_commit,
    "target_commit": target_commit or None,
    "frontend_build_id": build_id or None,
    "backup": ({
        "artifact": backup_artifact,
        "sha256": backup_sha256,
        "size_bytes": int(backup_size_bytes),
        "metadata_sha256": backup_metadata_sha256,
        "status_evidence_sha256": backup_status_evidence_sha256,
    } if all((backup_artifact, backup_sha256, backup_size_bytes,
              backup_metadata_sha256, backup_status_evidence_sha256)) else None),
    "rollback": rollback,
    "agent_release_mode": agent_release_mode,
    "previous_agent_schema_fingerprint": previous_agent_schema_fingerprint or None,
    "target_agent_schema_fingerprint": target_agent_schema_fingerprint or None,
    "smoke_evidence": ({"name": smoke_evidence_name, "sha256": smoke_evidence_sha256}
                       if smoke_evidence_name and smoke_evidence_sha256 else None),
    "dark_evidence": ({"name": dark_evidence_name, "sha256": dark_evidence_sha256}
                      if dark_evidence_name and dark_evidence_sha256 else None),
    "rehearsal_evidence": ({"name": rehearsal_evidence_name, "sha256": rehearsal_evidence_sha256}
                           if rehearsal_evidence_name and rehearsal_evidence_sha256 else None),
    "gates": checks,
}
json.dump(payload, sys.stdout, ensure_ascii=False)
PY
  } | sudo -n "$RELEASE_EVIDENCE_HELPER" store-deployment)" || return 1
  [[ "$(json_value "$result" name)" == "$DEPLOY_ID.json" ]] || return 1
  [[ "$(json_value "$result" sha256)" =~ ^[0-9a-f]{64}$ ]] || return 1
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
  if [[ -n "$SMOKE_EVIDENCE_TEMP" && -s "$SMOKE_EVIDENCE_TEMP" ]]; then
    if ! persist_smoke_evidence; then
      status=1
      record_gate smoke_evidence_store fail '公网冒烟证据无法写入 root-owned 哈希仓'
    fi
  fi
  if [[ "$status" -ne 0 && "$DEPLOY_SUCCEEDED" -eq 0 ]]; then
    if [[ "$SWITCH_STARTED" -eq 1 ]]; then
      rollback_runtime
    elif force_agent_fail_closed; then
      record_gate agent_kill_switch_rollback pass '发布切换前失败；当前 runtime 已强制恢复 false'
    else
      ROLLBACK_RESULT="failed"
      PRESERVE_RELEASE=1
      record_gate agent_kill_switch_rollback fail '发布切换前失败且无法确认 Agent 接口已关闭'
    fi
  fi
  if [[ "$ROLLBACK_RESULT" == failed ]]; then
    PRESERVE_RELEASE=1
  fi
  if [[ "$EVIDENCE_WRITTEN" -eq 0 ]] && ! write_evidence "$status"; then
    warn '部署证据无法写入 root-owned 哈希仓；本次发布不得作为 Stable 证据'
    status=1
  fi
  if [[ "$status" -ne 0 && "$WORKTREE_CREATED" -eq 1 && "$PRESERVE_RELEASE" -eq 0 ]]; then
    case "$RELEASE_DIR" in "$RELEASE_ROOT"/*) git -C "$APP_DIR" worktree remove --force "$RELEASE_DIR" || true ;; esac
  fi
  rm -f -- "$GATES_FILE"
  [[ -z "$SMOKE_EVIDENCE_TEMP" ]] || rm -f -- "$SMOKE_EVIDENCE_TEMP"
  exit "$status"
}
trap on_exit EXIT

log '验证生产环境为 fail-closed 配置'
python3 - "$BACKEND_ENV" "$AGENT_RELEASE_MODE" <<'PY' || err '生产环境配置不满足发布要求'
import base64
import re
import sys
from pathlib import Path
path = Path(sys.argv[1])
release_mode = sys.argv[2]
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
offsite_value = values.get("BACKUP_OFFSITE_REQUIRED", "").lower()
if offsite_value not in {"true", "false"}:
    errors.append("BACKUP_OFFSITE_REQUIRED 必须明确为 true 或 false")
elif offsite_value == "false" and values.get("EARLY_STAGE_LOCAL_BACKUP_ACCEPTED", "").lower() != "true":
    errors.append("本机备份模式必须显式设置 EARLY_STAGE_LOCAL_BACKUP_ACCEPTED=true")
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
if values.get("PUBLIC_APP_URL", "").rstrip("/") != "https://luxai.cn":
    errors.append("PUBLIC_APP_URL 必须为 https://luxai.cn")
if "AGENT_INTERFACE_ENABLED" in values:
    errors.append("AGENT_INTERFACE_ENABLED 禁止写入共享 backend/.env；必须使用独立 kill-switch")
if release_mode == "stable":
    if values.get("AGENT_AUTOMATION_ENABLED", "").lower() != "true":
        errors.append("Stable 发布要求 AGENT_AUTOMATION_ENABLED=true")
    try:
        automation_poll_seconds = int(values.get("AGENT_AUTOMATION_POLL_SECONDS", ""))
    except ValueError:
        automation_poll_seconds = 0
    if not 5 <= automation_poll_seconds <= 300:
        errors.append("AGENT_AUTOMATION_POLL_SECONDS 必须明确设置为 5 到 300 秒")
    if values.get("EMAIL_DELIVERY_ENABLED", "").lower() != "true":
        errors.append("Stable 全量能力要求 EMAIL_DELIVERY_ENABLED=true")
    smtp_host = values.get("SMTP_HOST", "")
    smtp_user = values.get("SMTP_USER", "")
    smtp_password = values.get("SMTP_PASSWORD", "")
    smtp_from = values.get("SMTP_FROM", "")
    if not smtp_host or smtp_host.startswith("CHANGE_ME"):
        errors.append("Stable 全量能力要求真实 SMTP_HOST")
    if not smtp_user or smtp_user.startswith("CHANGE_ME"):
        errors.append("Stable 全量能力要求真实 SMTP_USER")
    if not smtp_password or smtp_password.startswith("CHANGE_ME"):
        errors.append("Stable 全量能力要求真实 SMTP_PASSWORD")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", smtp_from) or "CHANGE_ME" in smtp_from:
        errors.append("Stable 全量能力要求有效 SMTP_FROM")
    try:
        smtp_port = int(values.get("SMTP_PORT", ""))
    except ValueError:
        smtp_port = 0
    if not 1 <= smtp_port <= 65535:
        errors.append("Stable 全量能力要求有效 SMTP_PORT")
    smtp_tls = values.get("SMTP_USE_TLS", "").lower() == "true"
    smtp_ssl = values.get("SMTP_USE_SSL", "").lower() == "true"
    if smtp_tls == smtp_ssl:
        errors.append("Stable SMTP 必须且只能启用 STARTTLS 或隐式 TLS 之一")
    try:
        creator_probe_hours = int(values.get("CREATOR_CONNECTOR_READINESS_MAX_AGE_HOURS", ""))
    except ValueError:
        creator_probe_hours = 0
    if not 1 <= creator_probe_hours <= 168:
        errors.append("CREATOR_CONNECTOR_READINESS_MAX_AGE_HOURS 必须明确设置为 1 到 168 小时")
    if values.get("VIDEO_ANALYSIS_ENABLED", "").lower() != "true":
        errors.append("Stable 全量能力要求 VIDEO_ANALYSIS_ENABLED=true")
    if values.get("AGENT_INTERFACE_USER_ALLOWLIST", "").strip():
        errors.append("Stable 全量发布不得保留 AGENT_INTERFACE_USER_ALLOWLIST 灰度限制")
    if values.get("AGENT_INTERFACE_ACTION_ALLOWLIST", "").strip():
        errors.append("Stable 全量发布不得保留 AGENT_INTERFACE_ACTION_ALLOWLIST 灰度限制")
agent_pepper = values.get("AGENT_TOKEN_PEPPER", "")
agent_pepper_bytes = agent_pepper.encode("utf-8")
if (
    not agent_pepper
    or agent_pepper.startswith("CHANGE_ME")
    or len(agent_pepper_bytes) < 32
    or len(set(agent_pepper_bytes)) < 16
):
    errors.append("AGENT_TOKEN_PEPPER 必须是至少 32 字节的独立随机秘密")
elif agent_pepper == jwt_secret:
    errors.append("AGENT_TOKEN_PEPPER 不得复用 JWT_SECRET")
if errors: raise SystemExit("；".join(errors))
PY
record_gate production_env pass "CORS、限流、监控、备份模式、Agent Automation 与独立秘密配置通过"

for helper_action in dark stable verify-dark verify-stable; do
  sudo -n -l "$AGENT_KILL_SWITCH_HELPER" "$helper_action" >/dev/null 2>&1 ||
    err "缺少 Agent kill-switch $helper_action 权限；请先执行 preinstall-production-assets.sh"
done
for evidence_action in status verify-backup store-smoke store-deployment verify-dark verify-rehearsal; do
  sudo -n -l "$RELEASE_EVIDENCE_HELPER" "$evidence_action" >/dev/null 2>&1 ||
    err "缺少 release evidence $evidence_action 权限；请先执行 preinstall-production-assets.sh"
done
if [[ "$AGENT_RELEASE_MODE" == dark ]]; then
  log '将当前运行态 Agent 接口强制置为 dark'
  set_agent_kill_switch dark || err '无法原子写入 Agent dark kill-switch'
  sudo systemctl restart videocapsule-backend
  wait_backend_health ||
    err 'Agent dark 预备阶段后端健康检查失败'
  probe_agent_interface absent-or-disabled ||
    err 'Agent dark 预备阶段接口未保持关闭'
  record_gate agent_kill_switch_preflight pass '独立 kill-switch=false；当前 runtime 不暴露 Agent 接口'
else
  sudo -n "$AGENT_KILL_SWITCH_HELPER" verify-dark >/dev/null ||
    err 'Stable 必须从已完成的 dark=false 运行态进入'
  probe_agent_interface disabled ||
    err 'Stable 前置检查要求已暗发布的 Agent 接口返回 INTERFACE_DISABLED'
  record_gate agent_kill_switch_preflight pass 'Stable 从已验证的 dark=false 与关闭态接口进入'
fi

if [[ "$AGENT_RELEASE_MODE" == stable ]]; then
  PREVIOUS_AGENT_SCHEMA_FINGERPRINT="$(verify_agent_schema "$PREVIOUS_RUNTIME")" ||
    err 'Agent Stable 数据库结构前置条件未满足'
  DARK_EVIDENCE_RESULT="$(verify_agent_schema_dark_baseline \
    "$PREVIOUS_RUNTIME_COMMIT" "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT")" ||
    err 'Agent Stable 缺少同提交、同 PostgreSQL 结构的 dark 验收基线'
  AGENT_SCHEMA_DARK_EVIDENCE="$(json_value "$DARK_EVIDENCE_RESULT" name)"
  AGENT_SCHEMA_DARK_EVIDENCE_SHA256="$(json_value "$DARK_EVIDENCE_RESULT" sha256)"
  [[ "$AGENT_SCHEMA_DARK_EVIDENCE" =~ ^[A-Za-z0-9._-]+\.json$ &&
     "$AGENT_SCHEMA_DARK_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    err 'Agent Stable dark 证据 helper 返回无效身份'
  record_gate agent_schema_preflight pass \
    "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT（8 张表结构通过；dark 证据 $AGENT_SCHEMA_DARK_EVIDENCE@$AGENT_SCHEMA_DARK_EVIDENCE_SHA256）"
else
  record_gate agent_schema_preflight pass 'dark 模式保持接口关闭，发布后建立版本化 PostgreSQL 结构基线'
fi

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
python3 - "$BACKUP_STATUS_FILE" "$BACKEND_ENV" <<'PY' ||
  err '备份状态文件无效，保持当前版本'
import json, sys
from datetime import datetime, timezone
p = json.load(open(sys.argv[1], encoding="utf-8"))
values = {}
for raw in open(sys.argv[2], encoding="utf-8"):
    line = raw.strip()
    if line and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
offsite_required = values.get("BACKUP_OFFSITE_REQUIRED", "").lower() == "true"
local_accepted = values.get("EARLY_STAGE_LOCAL_BACKUP_ACCEPTED", "").lower() == "true"
backup_completed_text = str(p.get("backup_completed_at", ""))
restore_verified_text = str(p.get("restore_verified_at", ""))
completed = datetime.fromisoformat(backup_completed_text.replace("Z", "+00:00"))
restored = datetime.fromisoformat(restore_verified_text.replace("Z", "+00:00"))
if completed.tzinfo is None: completed = completed.replace(tzinfo=timezone.utc)
if restored.tzinfo is None: restored = restored.replace(tzinfo=timezone.utc)
age = (datetime.now(timezone.utc) - completed.astimezone(timezone.utc)).total_seconds()
common_ok = (
    p.get("completed_at") == backup_completed_text and restored >= completed
    and p.get("status") == "ok" and p.get("checksum_verified") is True
    and p.get("restore_verified") is True and 0 <= age <= 3600
    and p.get("offsite_required") is offsite_required
)
if offsite_required:
    mode_ok = (
        p.get("backup_mode") == "offsite"
        and p.get("offsite_verified") is True
        and p.get("recovery_material_verified") is True
        and bool(p.get("offsite_verified_at"))
    )
else:
    mode_ok = (
        local_accepted and p.get("backup_mode") == "local_only"
        and p.get("offsite_verified") is False
        and p.get("recovery_material_verified") is False
        and not p.get("offsite_verified_at")
    )
if not (common_ok and mode_ok):
    raise SystemExit("备份状态与生产配置模式不一致，或最近一小时恢复证据不完整")
PY
BACKUP_EVIDENCE_RESULT="$(sudo -n "$RELEASE_EVIDENCE_HELPER" verify-backup)" ||
  err '备份真实归档、元数据或 SHA-256 校验失败，保持当前版本'
BACKUP_ARTIFACT="$(json_value "$BACKUP_EVIDENCE_RESULT" artifact)"
BACKUP_SHA256="$(json_value "$BACKUP_EVIDENCE_RESULT" sha256)"
BACKUP_SIZE_BYTES="$(json_value "$BACKUP_EVIDENCE_RESULT" size_bytes)"
BACKUP_METADATA_SHA256="$(json_value "$BACKUP_EVIDENCE_RESULT" metadata_sha256)"
BACKUP_STATUS_EVIDENCE_SHA256="$(json_value "$BACKUP_EVIDENCE_RESULT" status_evidence_sha256)"
[[ -n "$BACKUP_ARTIFACT" && "$BACKUP_SHA256" =~ ^[0-9a-f]{64}$ &&
   "$BACKUP_METADATA_SHA256" =~ ^[0-9a-f]{64}$ &&
   "$BACKUP_STATUS_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ &&
   "$BACKUP_SIZE_BYTES" =~ ^[1-9][0-9]*$ ]] ||
  err '备份 helper 返回的真实证据身份无效'
record_gate predeploy_backup pass \
  "$BACKUP_ARTIFACT@$BACKUP_SHA256（真实归档、元数据、隔离恢复及模式一致性已验证）"

log '获取目标提交并创建不可变 worktree'
git fetch --prune origin master
TARGET_COMMIT="$(git rev-parse origin/master)"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || err '无法解析 origin/master'
if [[ "$AGENT_RELEASE_MODE" == stable ]]; then
  [[ "$PREVIOUS_RUNTIME_COMMIT" == "$TARGET_COMMIT" ]] ||
    err 'Stable 只允许晋级当前已完成 dark 验收的同一 Git 提交；请先对目标提交执行 dark'
  REHEARSAL_EVIDENCE_RESULT="$(verify_agent_schema_rehearsal \
    "$TARGET_COMMIT" "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT" \
    "$AGENT_SCHEMA_DARK_EVIDENCE" "$AGENT_SCHEMA_DARK_EVIDENCE_SHA256")" ||
    err 'Stable 缺少同提交、同备份、同结构指纹的恢复快照双启动演练证据'
  AGENT_SCHEMA_REHEARSAL_EVIDENCE="$(json_value "$REHEARSAL_EVIDENCE_RESULT" name)"
  AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256="$(json_value "$REHEARSAL_EVIDENCE_RESULT" sha256)"
  [[ "$AGENT_SCHEMA_REHEARSAL_EVIDENCE" =~ ^agent-schema-rehearsal-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.json$ &&
     "$AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    err 'Stable rehearsal 证据 helper 返回无效身份'
  record_gate agent_same_commit_promotion pass "$TARGET_COMMIT 已以 dark 运行并进入 Stable 晋级"
  record_gate agent_schema_rehearsal pass \
    "$AGENT_SCHEMA_REHEARSAL_EVIDENCE@$AGENT_SCHEMA_REHEARSAL_EVIDENCE_SHA256（绑定 dark SHA 与真实备份后双启动）"
else
  record_gate agent_same_commit_promotion pass "$TARGET_COMMIT 正在建立关闭态暗发布基线"
fi
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
  "$RELEASE_DIR/deploy/agent-interface-kill-switch.sh:$AGENT_KILL_SWITCH_HELPER" \
  "$RELEASE_DIR/deploy/release-evidence-store.py:$RELEASE_EVIDENCE_HELPER" \
  "$RELEASE_DIR/deploy/backup/postgres-backup.sh:/usr/local/lib/zhicui-backup/postgres-backup.sh" \
  "$RELEASE_DIR/deploy/backup/postgres-restore-verify.sh:/usr/local/lib/zhicui-backup/postgres-restore-verify.sh" \
  "$RELEASE_DIR/deploy/backup/postgres-offsite-replicate.sh:/usr/local/lib/zhicui-backup/postgres-offsite-replicate.sh" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-backup.service:/etc/systemd/system/zhicui-postgres-backup.service" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-backup.timer:/etc/systemd/system/zhicui-postgres-backup.timer" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-restore-verify.service:/etc/systemd/system/zhicui-postgres-restore-verify.service" \
  "$RELEASE_DIR/deploy/backup/zhicui-postgres-restore-verify.timer:/etc/systemd/system/zhicui-postgres-restore-verify.timer" \
  "$RELEASE_DIR/deploy/jenkins-videocapsule.sudoers:/etc/sudoers.d/jenkins-videocapsule"; do
  source_file="${pair%%:*}"; installed_file="${pair#*:}"
  if ! asset_matches "$source_file" "$installed_file"; then
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
REQUIREMENTS_LOCK="$RELEASE_DIR/deploy/requirements-server.lock"
[[ -s "$REQUIREMENTS_LOCK" ]] || err '生产 Python 依赖锁文件缺失或为空'
"$RELEASE_DIR/.venv/bin/python" -m pip install --upgrade "pip==$PIP_BOOTSTRAP_VERSION" -q
"$RELEASE_DIR/.venv/bin/python" -m pip install \
  --require-hashes \
  --only-binary=:all: \
  --no-binary=qrcode-terminal \
  -r "$REQUIREMENTS_LOCK" \
  -q
"$RELEASE_DIR/.venv/bin/python" -m pip check
DOUYIN_MCP_ROOT="${DOUYIN_MCP_SERVER_ROOT:-$APP_DIR/douyin-mcp-server}"
[[ -f "$DOUYIN_MCP_ROOT/douyin-video/scripts/douyin_downloader.py" ]] ||
  err '生产环境缺少 douyin-mcp-server 运行依赖'
(
  cd "$RELEASE_DIR/backend"
  DOUYIN_MCP_SERVER_ROOT="$DOUYIN_MCP_ROOT" \
    "$RELEASE_DIR/.venv/bin/python" -c \
      'from app.services.video_extractor import DouyinProcessor; assert DouyinProcessor is not None'
  DOUYIN_MCP_SERVER_ROOT="$DOUYIN_MCP_ROOT" \
    "$RELEASE_DIR/.venv/bin/python" \
      "$RELEASE_DIR/deploy/verify-server-runtime.py"
)
record_gate backend_import pass '锁定依赖、JWT、应用路由与核心视频解析运行时可用'

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
# Nginx only reads versioned public download manifests through the current
# release symlink.  Keep application source private while granting traversal
# and read access exclusively to the public asset tree.
chmod o+x "$RELEASE_DIR" "$RELEASE_DIR/frontend"
chmod -R o+rX "$RELEASE_DIR/frontend/public"
BUILD_ID="$(<"$RELEASE_DIR/frontend/.next/BUILD_ID")"
record_gate frontend_build pass "$BUILD_ID"

log '原子切换 runtime 并启动目标版本'
SWITCH_STARTED=1
sudo systemctl stop videocapsule-frontend
atomic_runtime_switch "$RELEASE_DIR"
[[ "$(realpath "$CURRENT_LINK")" == "$(realpath "$RELEASE_DIR")" ]] || err 'runtime 身份校验失败'
set_agent_kill_switch "$AGENT_RELEASE_MODE" || err '无法原子切换目标 Agent kill-switch'
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

TARGET_AGENT_SCHEMA_FINGERPRINT="$(verify_agent_schema "$RELEASE_DIR")" ||
  err '目标 runtime 的 Agent PostgreSQL 结构校验失败'
if [[ "$AGENT_RELEASE_MODE" == stable ]]; then
  [[ "$TARGET_AGENT_SCHEMA_FINGERPRINT" == "$PREVIOUS_AGENT_SCHEMA_FINGERPRINT" ]] ||
    err 'Stable 启动改变了 dark 已验收的 Agent PostgreSQL 结构；拒绝开放接口'
fi
record_gate agent_schema_target pass \
  "$TARGET_AGENT_SCHEMA_FINGERPRINT（8 张表的列、非空、主键、唯一约束、索引和外键通过）"
if [[ "$AGENT_RELEASE_MODE" == stable ]]; then
  sudo -n "$AGENT_KILL_SWITCH_HELPER" verify-stable >/dev/null ||
    err 'Stable 目标运行态 kill-switch 并非 true'
  probe_agent_interface enabled ||
    err 'Stable 目标运行态未公开有效 capabilities'
  record_gate agent_kill_switch_target pass '独立 kill-switch=true；目标 capabilities 已启用'
else
  sudo -n "$AGENT_KILL_SWITCH_HELPER" verify-dark >/dev/null ||
    err 'dark 目标运行态 kill-switch 并非 false'
  probe_agent_interface disabled ||
    err 'dark 目标运行态没有返回 INTERFACE_DISABLED'
  record_gate agent_kill_switch_target pass '独立 kill-switch=false；目标接口保持关闭'
fi

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

SMOKE_EVIDENCE_TEMP="$(mktemp)"
SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://luxai.cn}" \
SMOKE_EVIDENCE_FILE="$SMOKE_EVIDENCE_TEMP" \
SMOKE_DEPLOYMENT_ID="$DEPLOY_ID" \
SMOKE_TARGET_COMMIT="$TARGET_COMMIT" \
SMOKE_REQUIRE_AUTHENTICATED="${SMOKE_REQUIRE_AUTHENTICATED:-1}" \
SMOKE_REQUIRE_AGENT_SSE="${SMOKE_REQUIRE_AGENT_SSE:-1}" \
SMOKE_REQUIRE_AGENT_INTERFACE="$([[ "$AGENT_RELEASE_MODE" == stable ]] && printf 1 || printf 0)" \
SMOKE_LOGIN_EMAIL="${SMOKE_LOGIN_EMAIL:-}" \
SMOKE_PASSWORD_FILE="${SMOKE_PASSWORD_FILE:-}" \
SMOKE_SOURCE_ID="$SMOKE_SOURCE_ID" \
  bash "$RELEASE_DIR/scripts/smoke-production.sh"
persist_smoke_evidence || err '公网冒烟通过，但证据无法写入 root-owned 哈希仓'
record_gate production_smoke pass "$SMOKE_EVIDENCE_NAME@$SMOKE_EVIDENCE_SHA256"

cleanup_smoke_fixture || err '冒烟通过，但隔离资料或残留会话清理失败'
SMOKE_FIXTURE_PROVISIONED=0
record_gate smoke_fixture_cleanup pass '隔离资料与残留会话已清理'

sudo -n "$AGENT_KILL_SWITCH_HELPER" "verify-$AGENT_RELEASE_MODE" >/dev/null ||
  err '完成发布前 Agent kill-switch 状态发生漂移'
if [[ "$AGENT_RELEASE_MODE" == stable ]]; then
  probe_agent_interface enabled || err '完成发布前 Stable Agent 接口状态发生漂移'
else
  probe_agent_interface disabled || err '完成发布前 dark Agent 接口状态发生漂移'
fi
record_gate agent_kill_switch_final pass "Agent $AGENT_RELEASE_MODE 最终状态与运行态一致"

# 所有闸门通过后才推进长期 checkout；失败时 checkout 始终保留上一版且保持干净。
cd "$APP_DIR"
git merge --ff-only "$TARGET_COMMIT"
record_gate deployment pass "$TARGET_COMMIT"
write_evidence 0 || err '成功部署证据无法写入 root-owned 哈希仓；拒绝完成发布'
EVIDENCE_WRITTEN=1
DEPLOY_SUCCEEDED=1
if prune_reproducible_release_artifacts; then
  record_gate release_retention pass '仅保留当前与上一版 runtime，并清理 npm 可再生成缓存'
else
  warn '发布已成功，但旧 runtime 或 npm 缓存未能完全清理'
  record_gate release_retention warning '发布成功；可再生成缓存需要后续人工清理'
fi
log '✅ 原子 runtime、备份、readiness、发行与真实用户旅程全部通过'
