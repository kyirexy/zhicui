#!/usr/bin/env bash
# 将已加密 PostgreSQL 归档复制到独立故障域，并从远端重新读取后校验。
set -Eeuo pipefail
umask 077

BACKUP_DIR="${ZHICUI_BACKUP_DIR:-/var/backups/zhicui}"
STATE_DIR="${ZHICUI_BACKUP_STATE_DIR:-/var/lib/zhicui-backups}"
KEY_FILE="${ZHICUI_BACKUP_KEY_FILE:-/etc/zhicui/backup.key}"
OFFSITE_REQUIRED="${ZHICUI_OFFSITE_REQUIRED:-true}"
OFFSITE_MODE="${ZHICUI_OFFSITE_MODE:-}"
RECOVERY_MATERIAL="${ZHICUI_OFFSITE_RECOVERY_MATERIAL:-}"
RCLONE_REMOTE="${ZHICUI_OFFSITE_RCLONE_REMOTE:-}"
RCLONE_CONFIG="${ZHICUI_OFFSITE_RCLONE_CONFIG:-/etc/zhicui/rclone.conf}"
SSH_TARGET="${ZHICUI_OFFSITE_SSH_TARGET:-}"
SSH_DIRECTORY="${ZHICUI_OFFSITE_SSH_DIRECTORY:-}"
SSH_KEY_FILE="${ZHICUI_OFFSITE_SSH_KEY_FILE:-/etc/zhicui/offsite_ed25519}"
SSH_KNOWN_HOSTS_FILE="${ZHICUI_OFFSITE_SSH_KNOWN_HOSTS_FILE:-/etc/zhicui/offsite_known_hosts}"
STATUS_FILE="$STATE_DIR/last-offsite.json"
LOCK_FILE="$STATE_DIR/offsite.lock"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BACKUP_FILE=""
PUBLIC_MANIFEST=""
REMOTE_PROVIDER=""

log() { printf '[zhicui-offsite] %s\n' "$*"; }
fail() { printf '[zhicui-offsite] ERROR: %s\n' "$*" >&2; exit 1; }

is_true() {
  case "${1,,}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

is_private_mode() {
  local mode="$1" group_digit other_digit
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode="${mode: -3}"
  group_digit="${mode:1:1}"
  other_digit="${mode:2:1}"
  (( (10#$group_digit & 2) == 0 && 10#$other_digit == 0 ))
}

assert_private_file() {
  local path="$1" label="$2" mode
  [[ -r "$path" && -f "$path" && ! -L "$path" ]] || fail "$label 不可读、不是普通文件或是符号链接"
  mode="$(stat -c '%a' "$path")"
  is_private_mode "$mode" ||
    fail "$label 权限过宽；必须禁止 group 写入及 other 全部访问"
}

write_status() {
  local outcome="$1" detail="$2" artifact="${3:-}" checksum="${4:-}" provider="${5:-}"
  local recovery_checksum="${6:-}" verified_at="${7:-}"
  python3 - "$STATUS_FILE" "$outcome" "$detail" "$artifact" "$checksum" "$provider" \
    "$recovery_checksum" "$verified_at" "$STARTED_AT" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

(path, outcome, detail, artifact, checksum, provider, recovery_checksum,
 verified_at, started_at) = sys.argv[1:]
payload = {
    "schema_version": 1,
    "operation": "postgres_offsite_replication",
    "status": outcome,
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "artifact": artifact or None,
    "sha256": checksum or None,
    "provider": provider or None,
    "recovery_material_sha256": recovery_checksum or None,
    "remote_verified_at": verified_at or None,
    "remote_verified": outcome == "success",
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

run_contract_self_test() {
  local test_dir private_file
  for command_name in python3 stat mktemp; do
    command -v "$command_name" >/dev/null 2>&1 || fail "契约测试缺少命令：$command_name"
  done
  test_dir="$(mktemp -d)"
  private_file="$test_dir/private-material.enc"
  STATUS_FILE="$test_dir/status.json"
  printf 'Salted__contract-test-material' >"$private_file"
  chmod 0600 "$private_file"
  assert_private_file "$private_file" "契约测试私密文件"
  is_private_mode 0600 || fail "权限检查错误拒绝 0600"
  for unsafe_mode in 0620 0630 0660 0644; do
    if is_private_mode "$unsafe_mode"; then
      rm -rf -- "$test_dir"
      fail "权限检查错误接受 $unsafe_mode"
    fi
  done
  write_status "success" "contract test" "artifact.dump.enc" \
    "0123456789abcdef" "contract" "fedcba9876543210" "$STARTED_AT"
  python3 - "$STATUS_FILE" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
if payload.get("status") != "success" or payload.get("remote_verified") is not True:
    raise SystemExit("status contract mismatch")
PY
  rm -rf -- "$test_dir"
  log "contract self-test passed"
}

if [[ "${1:-}" == "--contract-test" ]]; then
  run_contract_self_test
  exit 0
fi

cleanup() {
  local status=$?
  [[ -z "$PUBLIC_MANIFEST" || ! -e "$PUBLIC_MANIFEST" ]] || rm -f -- "$PUBLIC_MANIFEST"
  if [[ "$status" -ne 0 ]]; then
    write_status "failed" "异地副本上传或远端校验未完成" "${BACKUP_FILE##*/}" "" "$REMOTE_PROVIDER" || true
  fi
  exit "$status"
}
trap cleanup EXIT

for command_name in python3 sha256sum flock realpath stat mktemp find sort awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"
done
is_true "$OFFSITE_REQUIRED" || fail "生产异地副本门禁不得关闭（ZHICUI_OFFSITE_REQUIRED=true）"

mkdir -p -- "$STATE_DIR"
chmod 2750 "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "已有异地复制任务正在运行"

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zhicui-*.dump.enc' -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {$1=""; sub(/^ /, ""); print}')"
fi
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || fail "没有可复制的本地加密备份"
BACKUP_FILE="$(realpath "$BACKUP_FILE")"
case "$BACKUP_FILE" in "$(realpath "$BACKUP_DIR")"/zhicui-*.dump.enc) ;; *) fail "备份不在受控目录" ;; esac
[[ -f "$BACKUP_FILE.sha256" && -f "$BACKUP_FILE.json" ]] || fail "备份缺少校验和或元数据"
(cd "$(dirname "$BACKUP_FILE")" && sha256sum --check "$(basename "$BACKUP_FILE").sha256") >/dev/null
LOCAL_SHA256="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"

# 恢复材料必须已经由离线公钥或独立口令加密。明文 backup.key 永不上传。
[[ -n "$RECOVERY_MATERIAL" && "$RECOVERY_MATERIAL" == /* ]] || fail "未配置绝对路径 ZHICUI_OFFSITE_RECOVERY_MATERIAL"
assert_private_file "$RECOVERY_MATERIAL" "异地恢复材料"
RECOVERY_MATERIAL="$(realpath "$RECOVERY_MATERIAL")"
[[ "$RECOVERY_MATERIAL" != "$(realpath "$KEY_FILE")" ]] || fail "禁止上传明文备份密钥"
RECOVERY_SIZE="$(stat -c '%s' "$RECOVERY_MATERIAL")"
(( RECOVERY_SIZE > 16 && RECOVERY_SIZE <= 16777216 )) || fail "恢复材料大小异常"
python3 - "$RECOVERY_MATERIAL" <<'PY' || fail "恢复材料不是支持的加密封装（age/ASCII PGP/OpenSSL salted）"
import sys
from pathlib import Path

head = Path(sys.argv[1]).read_bytes()[:128]
if not (
    head.startswith(b"age-encryption.org/v1")
    or head.startswith(b"-----BEGIN PGP MESSAGE-----")
    or head.startswith(b"Salted__")
):
    raise SystemExit(1)
PY
RECOVERY_SHA256="$(sha256sum "$RECOVERY_MATERIAL" | awk '{print $1}')"
RECOVERY_REMOTE_NAME="zhicui-recovery-material-$RECOVERY_SHA256.enc"
ARTIFACT="${BACKUP_FILE##*/}"
PUBLIC_MANIFEST="$(mktemp "$STATE_DIR/.offsite-manifest.XXXXXX.json")"
python3 - "$PUBLIC_MANIFEST" "$ARTIFACT" "$LOCAL_SHA256" "$RECOVERY_REMOTE_NAME" "$RECOVERY_SHA256" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, artifact, checksum, recovery_name, recovery_checksum = sys.argv[1:]
payload = {
    "schema_version": 1,
    "artifact": artifact,
    "sha256": checksum,
    "encryption": "AES-256-CBC/PBKDF2-SHA256/200000",
    "checksum_file": f"{artifact}.sha256",
    "metadata_file": f"{artifact}.json",
    "recovery_material": recovery_name,
    "recovery_material_sha256": recovery_checksum,
    "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "note": "Recovery material is an encrypted envelope; no plaintext secret is stored here.",
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(path, 0o600)
PY
METADATA_SHA256="$(sha256sum "$BACKUP_FILE.json" | awk '{print $1}')"
MANIFEST_SHA256="$(sha256sum "$PUBLIC_MANIFEST" | awk '{print $1}')"

verify_hash() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label 远端 SHA-256 不匹配"
}

case "$OFFSITE_MODE" in
  rclone)
    REMOTE_PROVIDER="rclone"
    command -v rclone >/dev/null 2>&1 || fail "已选择 rclone，但服务器未安装 rclone"
    assert_private_file "$RCLONE_CONFIG" "rclone 配置"
    [[ "$RCLONE_REMOTE" =~ ^[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$ && "$RCLONE_REMOTE" != *..* ]] ||
      fail "ZHICUI_OFFSITE_RCLONE_REMOTE 格式不安全"
    remote_base="${RCLONE_REMOTE%/}"
    rclone copyto --config "$RCLONE_CONFIG" "$BACKUP_FILE" "$remote_base/$ARTIFACT"
    rclone copyto --config "$RCLONE_CONFIG" "$BACKUP_FILE.sha256" "$remote_base/$ARTIFACT.sha256"
    rclone copyto --config "$RCLONE_CONFIG" "$BACKUP_FILE.json" "$remote_base/$ARTIFACT.json"
    rclone copyto --config "$RCLONE_CONFIG" "$RECOVERY_MATERIAL" "$remote_base/$RECOVERY_REMOTE_NAME"
    rclone copyto --config "$RCLONE_CONFIG" "$PUBLIC_MANIFEST" "$remote_base/$ARTIFACT.offsite.json"
    verify_hash "$(rclone cat --config "$RCLONE_CONFIG" "$remote_base/$ARTIFACT" | sha256sum | awk '{print $1}')" "$LOCAL_SHA256" "数据库归档"
    verify_hash "$(rclone cat --config "$RCLONE_CONFIG" "$remote_base/$RECOVERY_REMOTE_NAME" | sha256sum | awk '{print $1}')" "$RECOVERY_SHA256" "恢复材料"
    verify_hash "$(rclone cat --config "$RCLONE_CONFIG" "$remote_base/$ARTIFACT.json" | sha256sum | awk '{print $1}')" "$METADATA_SHA256" "备份元数据"
    verify_hash "$(rclone cat --config "$RCLONE_CONFIG" "$remote_base/$ARTIFACT.offsite.json" | sha256sum | awk '{print $1}')" "$MANIFEST_SHA256" "恢复清单"
    remote_checksum_line="$(rclone cat --config "$RCLONE_CONFIG" "$remote_base/$ARTIFACT.sha256")"
    [[ "$remote_checksum_line" == "$LOCAL_SHA256  $ARTIFACT" ]] ||
      fail "远端校验和文件内容不匹配"
    ;;
  ssh)
    REMOTE_PROVIDER="ssh"
    for command_name in ssh scp; do command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令：$command_name"; done
    [[ "$SSH_TARGET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]] || fail "ZHICUI_OFFSITE_SSH_TARGET 格式不安全"
    [[ "$SSH_DIRECTORY" =~ ^/[A-Za-z0-9._/-]+$ && "$SSH_DIRECTORY" != *..* && "$SSH_DIRECTORY" != "/" ]] ||
      fail "ZHICUI_OFFSITE_SSH_DIRECTORY 格式不安全"
    assert_private_file "$SSH_KEY_FILE" "异地 SSH 私钥"
    [[ -r "$SSH_KNOWN_HOSTS_FILE" && ! -L "$SSH_KNOWN_HOSTS_FILE" ]] || fail "异地 known_hosts 不可读或是符号链接"
    ssh_options=(-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS_FILE" -i "$SSH_KEY_FILE")
    ssh "${ssh_options[@]}" -- "$SSH_TARGET" "install -d -m 0700 -- $SSH_DIRECTORY"
    for local_path in "$BACKUP_FILE" "$BACKUP_FILE.sha256" "$BACKUP_FILE.json"; do
      scp "${ssh_options[@]}" -- "$local_path" "$SSH_TARGET:$SSH_DIRECTORY/${local_path##*/}"
    done
    scp "${ssh_options[@]}" -- "$RECOVERY_MATERIAL" "$SSH_TARGET:$SSH_DIRECTORY/$RECOVERY_REMOTE_NAME"
    scp "${ssh_options[@]}" -- "$PUBLIC_MANIFEST" "$SSH_TARGET:$SSH_DIRECTORY/$ARTIFACT.offsite.json"
    verify_hash "$(ssh "${ssh_options[@]}" -- "$SSH_TARGET" "sha256sum -- $SSH_DIRECTORY/$ARTIFACT" | awk '{print $1}')" "$LOCAL_SHA256" "数据库归档"
    verify_hash "$(ssh "${ssh_options[@]}" -- "$SSH_TARGET" "sha256sum -- $SSH_DIRECTORY/$RECOVERY_REMOTE_NAME" | awk '{print $1}')" "$RECOVERY_SHA256" "恢复材料"
    verify_hash "$(ssh "${ssh_options[@]}" -- "$SSH_TARGET" "sha256sum -- $SSH_DIRECTORY/$ARTIFACT.json" | awk '{print $1}')" "$METADATA_SHA256" "备份元数据"
    verify_hash "$(ssh "${ssh_options[@]}" -- "$SSH_TARGET" "sha256sum -- $SSH_DIRECTORY/$ARTIFACT.offsite.json" | awk '{print $1}')" "$MANIFEST_SHA256" "恢复清单"
    ssh "${ssh_options[@]}" -- "$SSH_TARGET" "cd $SSH_DIRECTORY && sha256sum --check -- $ARTIFACT.sha256" >/dev/null
    ;;
  *) fail "ZHICUI_OFFSITE_MODE 必须明确配置为 rclone 或 ssh" ;;
esac

VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status "success" "异地加密归档、校验和、元数据与加密恢复材料均已远端回读校验" \
  "$ARTIFACT" "$LOCAL_SHA256" "$REMOTE_PROVIDER" "$RECOVERY_SHA256" "$VERIFIED_AT"
log "异地副本验证通过：$ARTIFACT ($REMOTE_PROVIDER)"
