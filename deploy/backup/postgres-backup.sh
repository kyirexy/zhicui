#!/usr/bin/env bash
# 知萃 PostgreSQL 一致性备份：custom dump -> 加密 -> 校验和 -> 原子发布。
set -Eeuo pipefail
umask 077

BACKUP_DIR="${ZHICUI_BACKUP_DIR:-/var/backups/zhicui}"
STATE_DIR="${ZHICUI_BACKUP_STATE_DIR:-/var/lib/zhicui-backups}"
KEY_FILE="${ZHICUI_BACKUP_KEY_FILE:-/etc/zhicui/backup.key}"
RETENTION_DAYS="${ZHICUI_BACKUP_RETENTION_DAYS:-14}"
DATABASE_NAME="${PGDATABASE:-zhicui}"
LOCK_FILE="$STATE_DIR/backup.lock"
STATUS_FILE="$STATE_DIR/last-backup.json"
READINESS_FILE="${BACKUP_STATUS_FILE:-$STATE_DIR/latest.json}"
OFFSITE_REQUIRED="${ZHICUI_OFFSITE_REQUIRED:-true}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_NAME="zhicui-$STAMP.dump.enc"
FINAL_PATH="$BACKUP_DIR/$FINAL_NAME"
TEMP_DUMP=""
TEMP_ENCRYPTED=""

log() { printf '[zhicui-backup] %s\n' "$*"; }
fail() { printf '[zhicui-backup] ERROR: %s\n' "$*" >&2; exit 1; }

assert_safe_directory() {
  local value="$1"
  [[ "$value" == /* ]] || fail "目录必须是绝对路径：$value"
  [[ "$value" != "/" && "$value" != "/var" && "$value" != "/var/backups" ]] ||
    fail "拒绝使用过宽目录：$value"
}

write_status() {
  local outcome="$1"
  local detail="$2"
  local artifact="${3:-}"
  local checksum="${4:-}"
  local size="${5:-0}"
  python3 - "$STATUS_FILE" "$outcome" "$detail" "$artifact" "$checksum" "$size" "$STARTED_AT" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, outcome, detail, artifact, checksum, size, started_at = sys.argv[1:]
payload = {
    "schema_version": 1,
    "operation": "postgres_backup",
    "status": outcome,
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "artifact": artifact or None,
    "sha256": checksum or None,
    "size_bytes": int(size or 0),
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

write_readiness_pending() {
  python3 - "$READINESS_FILE" "$FINAL_NAME" "$CHECKSUM" "$SIZE_BYTES" "$BACKUP_COMPLETED_AT" "$OFFSITE_REQUIRED" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, artifact, checksum, size, backup_completed_at, offsite_required = sys.argv[1:]
payload = {
    "schema_version": 1,
    "status": "pending_restore",
    # completed_at 保留兼容，但永远表示备份生成时间，不得被恢复验证时间覆盖。
    "completed_at": backup_completed_at,
    "backup_completed_at": backup_completed_at,
    "restore_verified_at": None,
    "artifact": artifact,
    "sha256": checksum,
    "size_bytes": int(size),
    "checksum_verified": True,
    "restore_verified": False,
    "offsite_required": offsite_required.lower() in {"1", "true", "yes", "on"},
    "backup_mode": "offsite" if offsite_required.lower() in {"1", "true", "yes", "on"} else "local_only",
    "offsite_verified": False,
    "offsite_verified_at": None,
    "offsite_provider": None,
    "recovery_material_verified": False,
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
  [[ -z "$TEMP_DUMP" || ! -e "$TEMP_DUMP" ]] || rm -f -- "$TEMP_DUMP"
  [[ -z "$TEMP_ENCRYPTED" || ! -e "$TEMP_ENCRYPTED" ]] || rm -f -- "$TEMP_ENCRYPTED"
  if [[ "$status" -ne 0 ]]; then
    write_status "failed" "备份未完成；请查看 systemd 日志" || true
  fi
  exit "$status"
}
trap cleanup EXIT

for command_name in pg_dump pg_restore openssl sha256sum flock python3 stat find; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS >= 1 )) ||
  fail "ZHICUI_BACKUP_RETENTION_DAYS 必须是不小于 1 的整数"
[[ "$DATABASE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "数据库名称格式不安全"
[[ -r "$KEY_FILE" ]] || fail "备份加密密钥不可读：$KEY_FILE"

assert_safe_directory "$BACKUP_DIR"
assert_safe_directory "$STATE_DIR"
mkdir -p -- "$BACKUP_DIR" "$STATE_DIR"
chmod 700 "$BACKUP_DIR"
chmod 2750 "$STATE_DIR"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "已有备份任务正在运行"

TEMP_DUMP="$(mktemp "$STATE_DIR/.zhicui-$STAMP.XXXXXX.dump")"
TEMP_ENCRYPTED="$(mktemp "$BACKUP_DIR/.zhicui-$STAMP.XXXXXX.enc")"
chmod 600 "$TEMP_DUMP" "$TEMP_ENCRYPTED"

log "正在创建 PostgreSQL custom dump"
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --dbname="$DATABASE_NAME" \
  --file="$TEMP_DUMP"
[[ -s "$TEMP_DUMP" ]] || fail "pg_dump 产物为空"
pg_restore --list "$TEMP_DUMP" >/dev/null

log "正在加密备份"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$TEMP_DUMP" \
  -out "$TEMP_ENCRYPTED" \
  -pass "file:$KEY_FILE"
[[ -s "$TEMP_ENCRYPTED" ]] || fail "加密产物为空"

mv -- "$TEMP_ENCRYPTED" "$FINAL_PATH"
TEMP_ENCRYPTED=""
chmod 600 "$FINAL_PATH"
CHECKSUM="$(sha256sum "$FINAL_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$FINAL_NAME" >"$FINAL_PATH.sha256"
chmod 600 "$FINAL_PATH.sha256"
SIZE_BYTES="$(stat -c '%s' "$FINAL_PATH")"
BACKUP_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$FINAL_PATH.json" "$FINAL_NAME" "$CHECKSUM" "$SIZE_BYTES" "$STARTED_AT" "$BACKUP_COMPLETED_AT" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, artifact, checksum, size, started_at, completed_at = sys.argv[1:]
payload = {
    "schema_version": 1,
    "artifact": artifact,
    "encryption": "AES-256-CBC/PBKDF2-SHA256/200000",
    "sha256": checksum,
    "size_bytes": int(size),
    "started_at": started_at,
    "completed_at": completed_at,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(path, 0o600)
PY

write_status "success" "加密备份与校验和已生成" "$FINAL_NAME" "$CHECKSUM" "$SIZE_BYTES"
write_readiness_pending

# 删除只限于已验证的专用目录和固定前缀，不跟随子目录或符号链接。
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'zhicui-*.dump.enc' -o -name 'zhicui-*.dump.enc.sha256' -o -name 'zhicui-*.dump.enc.json' \) \
  -mtime "+$RETENTION_DAYS" -delete

log "完成：$FINAL_NAME ($SIZE_BYTES bytes)"
