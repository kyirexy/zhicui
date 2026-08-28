#!/usr/bin/env bash
# 将加密备份恢复到随机隔离数据库，验证关键表后立即清理。
set -Eeuo pipefail
umask 077

BACKUP_DIR="${ZHICUI_BACKUP_DIR:-/var/backups/zhicui}"
STATE_DIR="${ZHICUI_BACKUP_STATE_DIR:-/var/lib/zhicui-backups}"
KEY_FILE="${ZHICUI_BACKUP_KEY_FILE:-/etc/zhicui/backup.key}"
PRODUCTION_DATABASE="${PGDATABASE:-zhicui}"
STATUS_FILE="$STATE_DIR/last-restore-verify.json"
READINESS_FILE="${BACKUP_STATUS_FILE:-$STATE_DIR/latest.json}"
LOCK_FILE="$STATE_DIR/restore-verify.lock"
OFFSITE_STATUS_FILE="$STATE_DIR/last-offsite.json"
OFFSITE_SCRIPT="${ZHICUI_OFFSITE_SCRIPT:-/usr/local/lib/zhicui-backup/postgres-offsite-replicate.sh}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESTORE_DATABASE=""
TEMP_DUMP=""
BACKUP_FILE=""

log() { printf '[zhicui-restore-verify] %s\n' "$*"; }
fail() { printf '[zhicui-restore-verify] ERROR: %s\n' "$*" >&2; exit 1; }

write_status() {
  local outcome="$1"
  local detail="$2"
  local artifact="${3:-}"
  local counts="${4:-{}}"
  python3 - "$STATUS_FILE" "$outcome" "$detail" "$artifact" "$counts" "$STARTED_AT" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, outcome, detail, artifact, counts, started_at = sys.argv[1:]
try:
    parsed_counts = json.loads(counts)
except json.JSONDecodeError:
    parsed_counts = {}
payload = {
    "schema_version": 1,
    "operation": "postgres_restore_verify",
    "status": outcome,
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "artifact": artifact or None,
    "verified_counts": parsed_counts,
    "detail": detail[:240],
}
temporary = f"{path}.tmp-{os.getpid()}"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o640)
os.replace(temporary, path)
PY
}

write_readiness_ok() {
  local artifact="$1"
  local checksum="$2"
  local counts="$3"
  local backup_completed_at="$4"
  python3 - "$READINESS_FILE" "$artifact" "$checksum" "$counts" "$backup_completed_at" "$OFFSITE_STATUS_FILE" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, artifact, checksum, counts, backup_completed_at, offsite_status_path = sys.argv[1:]
restore_verified_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
try:
    offsite = json.load(open(offsite_status_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"异地副本状态不可读：{exc}")
if not (
    offsite.get("status") == "success"
    and offsite.get("remote_verified") is True
    and offsite.get("artifact") == artifact
    and str(offsite.get("sha256", "")).lower() == checksum.lower()
    and offsite.get("recovery_material_sha256")
    and offsite.get("remote_verified_at")
):
    raise SystemExit("异地副本状态与本次备份不匹配")
payload = {
    "schema_version": 1,
    "status": "ok",
    "completed_at": backup_completed_at,
    "backup_completed_at": backup_completed_at,
    "restore_verified_at": restore_verified_at,
    "artifact": artifact,
    "sha256": checksum,
    "checksum_verified": True,
    "restore_verified": True,
    "verified_counts": json.loads(counts),
    "offsite_required": True,
    "offsite_verified": True,
    "offsite_verified_at": offsite["remote_verified_at"],
    "offsite_provider": offsite.get("provider"),
    "recovery_material_verified": True,
}
temporary = f"{path}.tmp-{os.getpid()}"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o640)
os.replace(temporary, path)
PY
}

cleanup() {
  local status=$?
  set +e
  [[ -z "$TEMP_DUMP" || ! -e "$TEMP_DUMP" ]] || rm -f -- "$TEMP_DUMP"
  if [[ -n "$RESTORE_DATABASE" && "$RESTORE_DATABASE" == zhicui_restore_verify_* ]]; then
    psql --dbname=postgres --set=ON_ERROR_STOP=1 --quiet \
      --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$RESTORE_DATABASE' AND pid <> pg_backend_pid();" >/dev/null 2>&1
    dropdb --if-exists "$RESTORE_DATABASE" >/dev/null 2>&1
  fi
  if [[ "$status" -ne 0 ]]; then
    write_status "failed" "隔离恢复验证未完成；生产数据库未被修改" "${BACKUP_FILE##*/}" || true
  fi
  exit "$status"
}
trap cleanup EXIT

for command_name in pg_restore psql createdb dropdb openssl sha256sum flock python3 mktemp stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done
[[ -r "$KEY_FILE" ]] || fail "备份加密密钥不可读：$KEY_FILE"
[[ "$PRODUCTION_DATABASE" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "生产数据库名称格式不安全"
mkdir -p -- "$STATE_DIR"
chmod 2750 "$STATE_DIR"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "已有恢复验证任务正在运行"

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zhicui-*.dump.enc' -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {$1=""; sub(/^ /, ""); print}')"
fi
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || fail "没有可验证的加密备份"
BACKUP_FILE="$(realpath "$BACKUP_FILE")"
case "$BACKUP_FILE" in
  "$(realpath "$BACKUP_DIR")"/zhicui-*.dump.enc) ;;
  *) fail "备份文件不在受控目录或名称不合法" ;;
esac
[[ -f "$BACKUP_FILE.sha256" ]] || fail "缺少校验和文件"

log "正在验证归档 SHA-256"
(cd "$(dirname "$BACKUP_FILE")" && sha256sum --check "$(basename "$BACKUP_FILE").sha256")
VERIFIED_CHECKSUM="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
BACKUP_SIZE="$(stat -c '%s' "$BACKUP_FILE")"
BACKUP_COMPLETED_AT="$(python3 - "$BACKUP_FILE.json" "${BACKUP_FILE##*/}" "$VERIFIED_CHECKSUM" "$BACKUP_SIZE" <<'PY'
import json, sys
from datetime import datetime
path, artifact, checksum, size = sys.argv[1:]
try:
    payload = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"备份元数据不可读：{exc}")
if payload.get("artifact") != artifact:
    raise SystemExit("备份元数据 artifact 不匹配")
if str(payload.get("sha256", "")).lower() != checksum.lower():
    raise SystemExit("备份元数据 SHA-256 不匹配")
if int(payload.get("size_bytes", -1)) != int(size):
    raise SystemExit("备份元数据 size_bytes 不匹配")
completed = str(payload.get("completed_at", ""))
datetime.fromisoformat(completed.replace("Z", "+00:00"))
print(completed)
PY
)" || fail "备份元数据验证失败"

TEMP_DUMP="$(mktemp "$STATE_DIR/.restore-verify.XXXXXX.dump")"
chmod 600 "$TEMP_DUMP"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$BACKUP_FILE" \
  -out "$TEMP_DUMP" \
  -pass "file:$KEY_FILE"
[[ -s "$TEMP_DUMP" ]] || fail "解密后的 dump 为空"
pg_restore --list "$TEMP_DUMP" >/dev/null

RESTORE_DATABASE="zhicui_restore_verify_$(date -u +%Y%m%d%H%M%S)_$$"
[[ "$RESTORE_DATABASE" != "$PRODUCTION_DATABASE" ]] || fail "隔离库名称不得等于生产库"
log "正在恢复到隔离数据库 $RESTORE_DATABASE"
createdb --template=template0 "$RESTORE_DATABASE"
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --dbname="$RESTORE_DATABASE" \
  "$TEMP_DUMP"

declare -A COUNTS
for table_name in users notes plans; do
  present="$(psql --dbname="$RESTORE_DATABASE" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="SELECT to_regclass('public.$table_name') IS NOT NULL;")"
  [[ "$present" == "t" ]] || fail "隔离恢复缺少关键表：$table_name"
  COUNTS[$table_name]="$(psql --dbname="$RESTORE_DATABASE" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="SELECT count(*) FROM \"$table_name\";")"
done

COUNTS_JSON="$(printf '{\"users\":%s,\"notes\":%s,\"plans\":%s}' \
  "${COUNTS[users]}" "${COUNTS[notes]}" "${COUNTS[plans]}")"
[[ -x "$OFFSITE_SCRIPT" ]] || fail "异地副本脚本不可执行：$OFFSITE_SCRIPT"
log "正在复制并从异地故障域回读校验"
"$OFFSITE_SCRIPT" "$BACKUP_FILE"
write_status "success" "隔离恢复、关键表计数与异地副本验证通过" "${BACKUP_FILE##*/}" "$COUNTS_JSON"
write_readiness_ok "${BACKUP_FILE##*/}" "$VERIFIED_CHECKSUM" "$COUNTS_JSON" "$BACKUP_COMPLETED_AT"
log "本地恢复与异地副本验证通过：$COUNTS_JSON"
