#!/usr/bin/env bash
# Stable Agent Action/PAT/MCP production smoke. Creates short-lived full-scope
# capability and read-only behavior PATs, then always revokes both.
set -Eeuo pipefail
umask 077

BASE_URL="${SMOKE_BASE_URL:-https://luxai.cn}"
BROWSER_TOKEN_FILE="${SMOKE_BROWSER_TOKEN_FILE:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAPABILITY_MANIFEST="${SMOKE_AGENT_CAPABILITY_MANIFEST:-$SCRIPT_DIR/../backend/app/agent_interface/stable_capabilities_v1.json}"
REQUIRE_RUNTIME_SENTINELS="${SMOKE_REQUIRE_AGENT_RUNTIME_SENTINELS:-1}"
REQUIRE_ASK_SENTINEL="${SMOKE_REQUIRE_AGENT_ASK_SENTINEL:-0}"
ASK_THREAD_ID="${SMOKE_AGENT_THREAD_ID:-}"
ASK_SOURCE_ID="${SMOKE_AGENT_SOURCE_ID:-}"
ASK_TIMEOUT_SECONDS="${SMOKE_AGENT_ASK_TIMEOUT_SECONDS:-120}"

case "$BASE_URL" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*) ;;
  *) printf 'SMOKE_BASE_URL 必须为 HTTPS 或本机回环地址\n' >&2; exit 2 ;;
esac
BASE_URL="${BASE_URL%/}"
[[ -r "$BROWSER_TOKEN_FILE" && -s "$BROWSER_TOKEN_FILE" ]] || {
  printf 'SMOKE_BROWSER_TOKEN_FILE 不可读或为空\n' >&2
  exit 2
}
[[ -r "$CAPABILITY_MANIFEST" && -s "$CAPABILITY_MANIFEST" ]] || {
  printf 'Stable Action 能力清单不可读或为空\n' >&2
  exit 2
}
for command_name in curl python3 mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '缺少 Agent 冒烟依赖：%s\n' "$command_name" >&2
    exit 2
  }
done
[[ "$REQUIRE_RUNTIME_SENTINELS" == 0 || "$REQUIRE_RUNTIME_SENTINELS" == 1 ]] || {
  printf 'SMOKE_REQUIRE_AGENT_RUNTIME_SENTINELS 必须是 0 或 1\n' >&2
  exit 2
}
[[ "$REQUIRE_ASK_SENTINEL" == 0 || "$REQUIRE_ASK_SENTINEL" == 1 ]] || {
  printf 'SMOKE_REQUIRE_AGENT_ASK_SENTINEL 必须是 0 或 1\n' >&2
  exit 2
}
if [[ "$REQUIRE_ASK_SENTINEL" == 1 && "$REQUIRE_RUNTIME_SENTINELS" != 1 ]]; then
  printf '真实问答哨兵要求同时启用 SMOKE_REQUIRE_AGENT_RUNTIME_SENTINELS\n' >&2
  exit 2
fi
[[ "$ASK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  printf 'SMOKE_AGENT_ASK_TIMEOUT_SECONDS 必须是正整数\n' >&2
  exit 2
}
if [[ "$REQUIRE_ASK_SENTINEL" == 1 ]]; then
  [[ "$ASK_THREAD_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
    printf 'Stable Agent 问答哨兵缺少有效 SMOKE_AGENT_THREAD_ID\n' >&2
    exit 2
  }
  [[ "$ASK_SOURCE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
    printf 'Stable Agent 问答哨兵缺少有效 SMOKE_AGENT_SOURCE_ID\n' >&2
    exit 2
  }
fi

WORK_DIR="$(mktemp -d)"
PAT_FILE="$WORK_DIR/pat"
FULL_PAT_FILE="$WORK_DIR/full-pat"
CREDENTIAL_ID=""
FULL_CREDENTIAL_ID=""

fail() {
  printf 'Agent Stable 冒烟失败：%s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  local ids_file="$WORK_DIR/cleanup-credential-ids"
  local list_file="$WORK_DIR/cleanup-credentials-list.response"
  local browser_token
  browser_token="$(<"$BROWSER_TOKEN_FILE")"

  # Assignment parsing can fail after the server has already persisted a PAT.
  # Recover the public ids from the raw creation responses first, then augment
  # them from the authoritative credential list by the two reserved names.
  python3 - "$ids_file" "$CREDENTIAL_ID" "$FULL_CREDENTIAL_ID" \
    "$WORK_DIR/create.response" "$WORK_DIR/create-full.response" <<'PY' || status=1
import json
import os
import re
import sys

target, *values = sys.argv[1:]
ids = set()
for value in values[:2]:
    if re.fullmatch(r"[0-9a-fA-F]{32}", value or ""):
        ids.add(value.lower())
for path in values[2:]:
    if not os.path.isfile(path):
        continue
    try:
        payload = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        continue
    credential = ((payload.get("data") or {}).get("credential") or {})
    value = credential.get("id")
    if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{32}", value):
        ids.add(value.lower())
with open(target, "w", encoding="utf-8") as handle:
    for value in sorted(ids):
        handle.write(value + "\n")
PY

  local list_code
  list_code="$(curl -sS --max-time 15 -o "$list_file" -w '%{http_code}' \
    -H "Authorization: Bearer $browser_token" \
    "$BASE_URL/api/agent-interface/v1/credentials" 2>/dev/null || true)"
  if [[ "$list_code" == 200 ]]; then
    python3 - "$list_file" "$ids_file" <<'PY' || status=1
import json
import re
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
items = ((payload.get("data") or {}).get("items") or [])
reserved = {"production-stable-smoke", "production-stable-capability-smoke"}
ids = set()
try:
    ids.update(line.strip().lower() for line in open(sys.argv[2], encoding="utf-8") if line.strip())
except OSError:
    pass
for item in items:
    if (
        not isinstance(item, dict)
        or item.get("name") not in reserved
        or item.get("revoked_at")
    ):
        continue
    value = item.get("id")
    if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{32}", value):
        ids.add(value.lower())
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    for value in sorted(ids):
        handle.write(value + "\n")
PY
  else
    printf 'Agent Stable 清理失败：无法列出冒烟 PAT（HTTP %s）\n' "${list_code:-curl-error}" >&2
    status=1
  fi

  local credential_id revoke_file revoke_code
  while IFS= read -r credential_id; do
    [[ -n "$credential_id" ]] || continue
    revoke_file="$WORK_DIR/revoke-cleanup-$credential_id.response"
    revoke_code="$(curl -sS --max-time 15 -X POST -o "$revoke_file" -w '%{http_code}' \
      -H "Authorization: Bearer $browser_token" \
      "$BASE_URL/api/agent-interface/v1/credentials/$credential_id/revoke" 2>/dev/null || true)"
    if [[ "$revoke_code" != 200 ]] || ! python3 - "$revoke_file" "$credential_id" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
credential = ((payload.get("data") or {}).get("credential") or {})
if (
    payload.get("status") != "succeeded"
    or credential.get("id", "").lower() != sys.argv[2].lower()
    or not credential.get("revoked_at")
):
    raise SystemExit("revocation not confirmed")
PY
    then
      printf 'Agent Stable 清理失败：PAT %s 吊销未确认（HTTP %s）\n' \
        "$credential_id" "${revoke_code:-curl-error}" >&2
      status=1
    fi
  done <"$ids_file"

  # A final authoritative read closes the gap where a creation response was
  # malformed but the server did persist the reserved-name credential.
  list_code="$(curl -sS --max-time 15 -o "$list_file" -w '%{http_code}' \
    -H "Authorization: Bearer $browser_token" \
    "$BASE_URL/api/agent-interface/v1/credentials" 2>/dev/null || true)"
  if [[ "$list_code" != 200 ]] || ! python3 - "$list_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
items = ((payload.get("data") or {}).get("items") or [])
reserved = {"production-stable-smoke", "production-stable-capability-smoke"}
active = [item.get("id") for item in items if isinstance(item, dict) and item.get("name") in reserved and not item.get("revoked_at")]
if active:
    raise SystemExit(f"active smoke credentials remain: {active}")
PY
  then
    printf 'Agent Stable 清理失败：无法确认所有冒烟 PAT 均已吊销\n' >&2
    status=1
  fi
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

http_with_token() {
  local token_file="$1" method="$2" path="$3" body_file="$4" output_file="$5"
  local -a args=(--silent --show-error --max-time 25 -X "$method" -o "$output_file" -w '%{http_code}' -H "Authorization: Bearer $(<"$token_file")")
  if [[ -n "$body_file" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@$body_file")
  fi
  curl "${args[@]}" "$BASE_URL$path"
}

verify_full_capabilities() {
  local response_file="$1"
  python3 - "$response_file" "$CAPABILITY_MANIFEST" <<'PY'
import hashlib
import json
import sys

response = json.load(open(sys.argv[1], encoding="utf-8"))
manifest = json.load(open(sys.argv[2], encoding="utf-8"))
data = response.get("data") or {}
actions = data.get("actions")
scopes = data.get("scopes")
if response.get("status") != "succeeded" or data.get("interface_version") != manifest.get("interface_version"):
    raise SystemExit("capabilities envelope/interface version 无效")
if not isinstance(actions, list) or not isinstance(scopes, list):
    raise SystemExit("capabilities actions/scopes 不是数组")
scope_ids = [str(item.get("id") or "") for item in scopes if isinstance(item, dict)]
if len(scope_ids) != manifest.get("scope_count") or len(scope_ids) != len(set(scope_ids)):
    raise SystemExit("Stable scope 清单数量或唯一性不匹配")
if len(actions) != manifest.get("action_count"):
    raise SystemExit(f"Stable Action 数量不匹配：{len(actions)}")
cloud = [item for item in actions if item.get("execution_location") == "cloud"]
local = [item for item in actions if item.get("execution_location") == "local_windows"]
if len(cloud) != manifest.get("cloud_action_count") or len(local) != manifest.get("local_windows_action_count"):
    raise SystemExit("Stable Action 执行位置数量不匹配")
if sum(bool(item.get("available")) for item in cloud) != manifest.get("available_cloud_action_count"):
    raise SystemExit("存在未开放的 Stable 云端 Action")
if sum(not bool(item.get("available")) for item in local) != manifest.get("unavailable_local_windows_action_count"):
    raise SystemExit("本机 Action 的服务端不可用边界不匹配")
ids = [str(item.get("id") or "") for item in actions]
if len(ids) != len(set(ids)):
    raise SystemExit("Action ID 不唯一")
for action_id in ids:
    lowered = action_id.lower()
    if action_id.startswith("admin.") or "shell" in lowered or "database" in lowered or "research_tool" in lowered:
        raise SystemExit(f"Stable 清单暴露了禁止 Action：{action_id}")
canonical = json.dumps(
    sorted(actions, key=lambda item: item["id"]),
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
digest = hashlib.sha256(canonical).hexdigest()
if digest != manifest.get("descriptor_sha256"):
    raise SystemExit(f"Stable Action descriptor 指纹不匹配：{digest}")
PY
}

code="$(http_with_token "$BROWSER_TOKEN_FILE" GET /api/agent-interface/v1/capabilities '' "$WORK_DIR/browser-capabilities.response")"
[[ "$code" == 200 ]] || fail "浏览器会话读取完整 capabilities 返回 HTTP $code"
verify_full_capabilities "$WORK_DIR/browser-capabilities.response" || fail '浏览器会话的 Stable Action 清单不完整'

python3 - "$WORK_DIR/browser-capabilities.response" "$WORK_DIR/create-full.json" <<'PY' || fail '无法生成全权限冒烟 PAT 请求'
import json, os, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
scopes = [item["id"] for item in (p.get("data") or {}).get("scopes", [])]
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({"name": "production-stable-capability-smoke", "scopes": scopes, "expires_in_days": 1}, handle)
os.chmod(sys.argv[2], 0o600)
PY
code="$(http_with_token "$BROWSER_TOKEN_FILE" POST /api/agent-interface/v1/credentials/pat "$WORK_DIR/create-full.json" "$WORK_DIR/create-full.response")"
[[ "$code" == 200 ]] || fail "创建全权限能力校验 PAT 返回 HTTP $code"
FULL_CREDENTIAL_ID="$(python3 - "$WORK_DIR/create-full.response" "$FULL_PAT_FILE" <<'PY'
import json, os, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
data = p.get("data") or {}
credential = data.get("credential") or {}
token = data.get("token")
credential_id = credential.get("id")
if p.get("status") != "succeeded" or not isinstance(token, str) or not token.startswith("zhc_pat_"):
    raise SystemExit("全权限 PAT 响应无效")
if not isinstance(credential_id, str) or len(credential_id) != 32:
    raise SystemExit("全权限 credential id 无效")
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    handle.write(token)
os.chmod(sys.argv[2], 0o600)
print(credential_id)
PY
)" || fail '无法解析全权限能力校验 PAT'
code="$(http_with_token "$FULL_PAT_FILE" GET /api/agent-interface/v1/capabilities '' "$WORK_DIR/full-capabilities.response")"
[[ "$code" == 200 ]] || fail "全权限 PAT 读取 capabilities 返回 HTTP $code"
verify_full_capabilities "$WORK_DIR/full-capabilities.response" || fail '全权限 PAT 未获得完整 Stable Action 清单'
printf '{"jsonrpc":"2.0","id":"stable-full","method":"tools/list","params":{}}\n' >"$WORK_DIR/mcp-full.json"
code="$(http_with_token "$FULL_PAT_FILE" POST /mcp "$WORK_DIR/mcp-full.json" "$WORK_DIR/mcp-full.response")"
[[ "$code" == 200 ]] || fail "全权限 PAT 的 MCP tools/list 返回 HTTP $code"
python3 - "$WORK_DIR/full-capabilities.response" "$WORK_DIR/mcp-full.response" "$CAPABILITY_MANIFEST" <<'PY' || fail '远程 MCP 工具未覆盖完整 Stable 边界'
import json, sys
capabilities = json.load(open(sys.argv[1], encoding="utf-8"))
mcp = json.load(open(sys.argv[2], encoding="utf-8"))
manifest = json.load(open(sys.argv[3], encoding="utf-8"))
actions = (capabilities.get("data") or {}).get("actions") or []
expected = {
    item["id"]
    for item in actions
    if item.get("available")
    and item.get("execution_location") == "cloud"
    and item.get("mcp_exposed")
}
expected.update({"run.get", "run.events", "run.cancel"})
tools = ((mcp.get("result") or {}).get("tools"))
if not isinstance(tools, list):
    raise SystemExit("MCP tools 不是数组")
actual = {str(item.get("name") or "") for item in tools}
if len(tools) != len(actual) or actual != expected:
    raise SystemExit(
        f"MCP 工具集不匹配 missing={sorted(expected - actual)} extra={sorted(actual - expected)}"
    )
if len(actual) != manifest.get("remote_mcp_tool_count"):
    raise SystemExit(f"MCP 工具数量不匹配：{len(actual)}")
PY

if [[ "$REQUIRE_RUNTIME_SENTINELS" == 1 ]]; then
  python3 - "$WORK_DIR/full-capabilities.response" "$REQUIRE_ASK_SENTINEL" <<'PY' || fail 'Stable 运行时哨兵与 Action Schema 不匹配'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
actions = {
    item.get("id"): item
    for item in ((payload.get("data") or {}).get("actions") or [])
    if isinstance(item, dict)
}

def require_read(action_id):
    action = actions.get(action_id) or {}
    schema = action.get("input_schema") or {}
    if (
        not action.get("available")
        or action.get("execution_location") != "cloud"
        or action.get("run_type") != "sync"
        or "read" not in (action.get("risk") or [])
        or schema.get("type") != "object"
    ):
        raise SystemExit(f"{action_id} 不是可用的云端同步只读 Action")

for action_id in (
    "analysis.catalog",
    "automation.status",
    "models.list",
    "models.selection.get",
):
    require_read(action_id)

analysis_schema = actions["analysis.catalog"]["input_schema"]
trigger = (analysis_schema.get("properties") or {}).get("trigger") or {}
if "agent" not in (trigger.get("enum") or []):
    raise SystemExit("analysis.catalog 不接受 agent trigger")

if sys.argv[2] == "1":
    turn = actions.get("ask.turn.start") or {}
    turn_schema = turn.get("input_schema") or {}
    if (
        not turn.get("available")
        or turn.get("execution_location") != "cloud"
        or turn.get("run_type") != "long_task"
        or turn.get("idempotency") != "required"
        or not {"thread_id", "client_turn_id", "question"}.issubset(
            set(turn_schema.get("required") or [])
        )
    ):
        raise SystemExit("ask.turn.start 的 Stable Schema 无效")
    require_read("ask.thread.get")
PY

  printf '{"input":{"trigger":"agent"}}\n' >"$WORK_DIR/runtime-analysis.json"
  code="$(http_with_token "$FULL_PAT_FILE" POST /api/agent-interface/v1/actions/analysis.catalog/invoke "$WORK_DIR/runtime-analysis.json" "$WORK_DIR/runtime-analysis.response")"
  [[ "$code" == 200 ]] || fail "analysis.catalog 运行时哨兵返回 HTTP $code"
  python3 - "$WORK_DIR/runtime-analysis.response" <<'PY' || fail '详细解析目录未达到 Stable 运行条件'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
result = ((payload.get("data") or {}).get("result") or {})
items = result.get("items")
recommendation = result.get("recommendation") or {}
ids = {str(item.get("id") or "") for item in items or [] if isinstance(item, dict)}
if (
    payload.get("status") != "succeeded"
    or result.get("enabled") is not True
    or not isinstance(items, list)
    or not items
    or not recommendation.get("id")
    or recommendation.get("id") not in ids
    or not isinstance(result.get("account"), dict)
):
    raise SystemExit("没有可用的已发布解析方案、推荐方案或用户额度账户")
PY

  printf '{"input":{}}\n' >"$WORK_DIR/runtime-empty.json"
  code="$(http_with_token "$FULL_PAT_FILE" POST /api/agent-interface/v1/actions/automation.status/invoke "$WORK_DIR/runtime-empty.json" "$WORK_DIR/runtime-automation.response")"
  [[ "$code" == 200 ]] || fail "automation.status 运行时哨兵返回 HTTP $code"
  python3 - "$WORK_DIR/runtime-automation.response" <<'PY' || fail '自动摘要或邮件运行时未达到 Stable 条件'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
result = ((payload.get("data") or {}).get("result") or {})
runner = result.get("runner") or {}
email = result.get("email") or {}
poll = runner.get("poll_seconds")
if (
    payload.get("status") != "succeeded"
    or runner.get("enabled") is not True
    or runner.get("running") is not True
    or not isinstance(poll, int)
    or not 5 <= poll <= 300
    or email.get("configured") is not True
    or email.get("provider") != "smtp"
    or result.get("recipient_policy") != "account_email_only"
):
    raise SystemExit("自动摘要轮询器、SMTP 或收件策略不可用")
PY

  code="$(http_with_token "$FULL_PAT_FILE" POST /api/agent-interface/v1/actions/models.list/invoke "$WORK_DIR/runtime-empty.json" "$WORK_DIR/runtime-models.response")"
  [[ "$code" == 200 ]] || fail "models.list 运行时哨兵返回 HTTP $code"
  code="$(http_with_token "$FULL_PAT_FILE" POST /api/agent-interface/v1/actions/models.selection.get/invoke "$WORK_DIR/runtime-empty.json" "$WORK_DIR/runtime-model-selection.response")"
  [[ "$code" == 200 ]] || fail "models.selection.get 运行时哨兵返回 HTTP $code"
  python3 - "$WORK_DIR/runtime-models.response" "$WORK_DIR/runtime-model-selection.response" <<'PY' || fail '回答模型目录或选择未达到 Stable 条件'
import json
import sys

catalog = json.load(open(sys.argv[1], encoding="utf-8"))
selection = json.load(open(sys.argv[2], encoding="utf-8"))
result = ((catalog.get("data") or {}).get("result") or {})
items = result.get("items")
ids = {str(item.get("id") or "") for item in items or [] if isinstance(item, dict)}
selected = result.get("selected_offering_id")
selected_result = ((selection.get("data") or {}).get("result") or {})
serialized = json.dumps(selected_result, ensure_ascii=False).lower()
if (
    catalog.get("status") != "succeeded"
    or selection.get("status") != "succeeded"
    or not isinstance(items, list)
    or not items
    or not isinstance(selected, str)
    or selected not in ids
    or not isinstance(result.get("account"), dict)
    or '"api_key":' in serialized
):
    raise SystemExit("模型目录为空、当前模型不可用或输出包含密钥字段")
PY

  if [[ "$REQUIRE_ASK_SENTINEL" == 1 ]]; then
    ASK_SENTINEL_TOKEN="ZHICUI-SMOKE-94731"
    CLIENT_TURN_ID="agent-stable-smoke-$(date -u +%Y%m%d%H%M%S)-$$"
    python3 - "$WORK_DIR/runtime-ask.json" "$ASK_THREAD_ID" "$CLIENT_TURN_ID" <<'PY'
import json
import sys

path, thread_id, client_turn_id = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "input": {
            "thread_id": thread_id,
            "client_turn_id": client_turn_id,
            "question": "固定视频文稿中，琥珀火车的唯一校验编号是什么？请直接回答并引用原文。",
            "research_mode": "fast",
            "output_style": "answer",
            "web_scope": "video_only",
        }
    }, handle, ensure_ascii=False)
PY
    ASK_IDEMPOTENCY_KEY="agent-stable-ask-$CLIENT_TURN_ID"
    code="$(curl -sS --max-time 25 -X POST -o "$WORK_DIR/runtime-ask.response" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $(<"$FULL_PAT_FILE")" \
      -H "Idempotency-Key: $ASK_IDEMPOTENCY_KEY" \
      --data-binary "@$WORK_DIR/runtime-ask.json" \
      "$BASE_URL/api/agent-interface/v1/actions/ask.turn.start/invoke")"
    [[ "$code" == 200 ]] || fail "ask.turn.start 真实问答哨兵返回 HTTP $code"
    readarray -t ask_ids < <(python3 - "$WORK_DIR/runtime-ask.response" "$ASK_THREAD_ID" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
result = ((payload.get("data") or {}).get("result") or {})
turn = result.get("turn") or {}
run_id = payload.get("run_id")
if (
    payload.get("status") not in {"queued", "running", "waiting_for_user", "succeeded"}
    or not isinstance(run_id, str)
    or not run_id
    or turn.get("thread_id") != sys.argv[2]
    or not isinstance(turn.get("id"), str)
    or not turn.get("id")
):
    raise SystemExit("ask.turn.start 未返回绑定到固定会话的持久 Run/Turn")
print(run_id)
print(turn["id"])
PY
    ) || fail 'ask.turn.start 输出契约无效'
    ASK_RUN_ID="${ask_ids[0]:-}"
    ASK_TURN_ID="${ask_ids[1]:-}"
    [[ -n "$ASK_RUN_ID" && -n "$ASK_TURN_ID" ]] || fail 'ask.turn.start 缺少 Run 或 Turn ID'

    ask_deadline=$(( $(date +%s) + ASK_TIMEOUT_SECONDS ))
    while true; do
      code="$(http_with_token "$FULL_PAT_FILE" GET "/api/agent-interface/v1/runs/$ASK_RUN_ID" '' "$WORK_DIR/runtime-ask-run.response")"
      [[ "$code" == 200 ]] || fail "读取真实问答 Run 返回 HTTP $code"
      ask_status="$(python3 - "$WORK_DIR/runtime-ask-run.response" "$ASK_RUN_ID" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
run = ((payload.get("data") or {}).get("run") or {})
if payload.get("run_id") != sys.argv[2] or run.get("id") != sys.argv[2]:
    raise SystemExit("Run ID 不匹配")
print(run.get("status") or "")
PY
      )" || fail '真实问答 Run 输出契约无效'
      case "$ask_status" in
        succeeded) break ;;
        failed|canceled|waiting_for_user) fail "真实问答 Run 进入非成功状态：$ask_status" ;;
        queued|running) ;;
        *) fail "真实问答 Run 返回未知状态：$ask_status" ;;
      esac
      (( $(date +%s) < ask_deadline )) || fail "真实问答 Run 未在 ${ASK_TIMEOUT_SECONDS} 秒内完成"
      sleep 1
    done

    printf '{"input":{"thread_id":"%s"}}\n' "$ASK_THREAD_ID" >"$WORK_DIR/runtime-thread-get.json"
    code="$(http_with_token "$FULL_PAT_FILE" POST /api/agent-interface/v1/actions/ask.thread.get/invoke "$WORK_DIR/runtime-thread-get.json" "$WORK_DIR/runtime-thread-get.response")"
    [[ "$code" == 200 ]] || fail "ask.thread.get 真实问答核验返回 HTTP $code"
    code="$(http_with_token "$FULL_PAT_FILE" GET "/api/agent-interface/v1/runs/$ASK_RUN_ID/events?after=0" '' "$WORK_DIR/runtime-ask-events.response")"
    [[ "$code" == 200 ]] || fail "读取真实问答事件返回 HTTP $code"
    python3 - "$WORK_DIR/runtime-thread-get.response" "$WORK_DIR/runtime-ask-events.response" \
      "$ASK_THREAD_ID" "$ASK_TURN_ID" "$ASK_SOURCE_ID" "$ASK_SENTINEL_TOKEN" <<'PY' || fail '真实 Agent 问答未返回可核验的流式答案与引用'
import json
import sys

thread_payload = json.load(open(sys.argv[1], encoding="utf-8"))
events_payload = json.load(open(sys.argv[2], encoding="utf-8"))
thread_id, turn_id, source_id, sentinel = sys.argv[3:]
thread = ((thread_payload.get("data") or {}).get("result") or {})
messages = thread.get("messages") or []
assistants = [
    item for item in messages
    if isinstance(item, dict)
    and item.get("role") == "assistant"
    and item.get("turn_id") == turn_id
]
if thread_payload.get("status") != "succeeded" or thread.get("id") != thread_id or len(assistants) != 1:
    raise SystemExit("固定会话没有唯一的本次 assistant 消息")
assistant = assistants[0]
if sentinel not in str(assistant.get("content") or ""):
    raise SystemExit("最终答案没有哨兵事实")
evidence = (assistant.get("result") or {}).get("evidence")
if not isinstance(evidence, list):
    raise SystemExit("最终答案缺少 evidence")
matched = [
    item for item in evidence
    if isinstance(item, dict)
    and str(item.get("note_id") or item.get("source_id") or "") == source_id
]
if not matched or not any(sentinel in str(item.get("quote") or "") for item in matched):
    raise SystemExit("最终答案没有回指固定资料中的哨兵原文")
items = ((events_payload.get("data") or {}).get("items") or [])
sequences = [item.get("sequence") for item in items if isinstance(item, dict)]
if (
    events_payload.get("status") != "succeeded"
    or not sequences
    or sequences != sorted(sequences)
    or len(sequences) != len(set(sequences))
    or sum(bool(item.get("terminal")) for item in items) != 1
    or not any(
        item.get("type") == "external.turn.answer.delta"
        and str((item.get("data") or {}).get("delta") or "").strip()
        for item in items if isinstance(item, dict)
    )
):
    raise SystemExit("Action Run 缺少有序增量事件或唯一终态")
PY
  fi
fi
code="$(http_with_token "$BROWSER_TOKEN_FILE" POST "/api/agent-interface/v1/credentials/$FULL_CREDENTIAL_ID/revoke" '' "$WORK_DIR/revoke-full.response")"
[[ "$code" == 200 ]] || fail "吊销全权限能力校验 PAT 返回 HTTP $code"
FULL_CREDENTIAL_ID=""

printf '{"name":"production-stable-smoke","scopes":["account:read"],"expires_in_days":1}\n' >"$WORK_DIR/create.json"
code="$(http_with_token "$BROWSER_TOKEN_FILE" POST /api/agent-interface/v1/credentials/pat "$WORK_DIR/create.json" "$WORK_DIR/create.response")"
[[ "$code" == 200 ]] || fail "创建只读 PAT 返回 HTTP $code"
CREDENTIAL_ID="$(python3 - "$WORK_DIR/create.response" "$PAT_FILE" <<'PY'
import json, os, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
data = p.get("data") or {}
credential = data.get("credential") or {}
token = data.get("token")
credential_id = credential.get("id")
if p.get("status") != "succeeded" or not isinstance(token, str) or not token.startswith("zhc_pat_"):
    raise SystemExit("PAT 响应无效")
if not isinstance(credential_id, str) or len(credential_id) != 32:
    raise SystemExit("credential id 无效")
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    handle.write(token)
os.chmod(sys.argv[2], 0o600)
print(credential_id)
PY
)" || fail '无法解析只读 PAT'

printf '{"input":{}}\n' >"$WORK_DIR/invoke.json"
code="$(curl -sS --max-time 25 -X POST -o "$WORK_DIR/invoke.response" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(<"$PAT_FILE")" \
  -H "Idempotency-Key: stable-smoke-$(date -u +%Y%m%d%H%M%S)-$$" \
  --data-binary "@$WORK_DIR/invoke.json" \
  "$BASE_URL/api/agent-interface/v1/actions/account.me/invoke")"
[[ "$code" == 200 ]] || fail "account.me 返回 HTTP $code"
RUN_ID="$(python3 - "$WORK_DIR/invoke.response" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
result = (p.get("data") or {}).get("result") or {}
run_id = p.get("run_id")
if p.get("status") != "succeeded" or not isinstance(run_id, str) or not run_id:
    raise SystemExit("account.me 未成功")
if "is_admin" in result:
    raise SystemExit("普通 Action 泄露了管理员字段")
print(run_id)
PY
)" || fail 'account.me 输出契约不符合预期'

code="$(http_with_token "$PAT_FILE" GET "/api/agent-interface/v1/runs/$RUN_ID" '' "$WORK_DIR/run.response")"
[[ "$code" == 200 ]] || fail "读取 Run 返回 HTTP $code"
python3 - "$WORK_DIR/run.response" "$RUN_ID" <<'PY' || fail 'Run 状态不正确'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
run = (p.get("data") or {}).get("run") or {}
if run.get("id") != sys.argv[2] or run.get("status") != "succeeded":
    raise SystemExit("Run 不是 succeeded")
PY

code="$(http_with_token "$PAT_FILE" GET "/api/agent-interface/v1/runs/$RUN_ID/events?after=0" '' "$WORK_DIR/events.response")"
[[ "$code" == 200 ]] || fail "读取事件返回 HTTP $code"
python3 - "$WORK_DIR/events.response" <<'PY' || fail '事件序列或终态不正确'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
items = (p.get("data") or {}).get("items")
if not isinstance(items, list) or not items:
    raise SystemExit("事件为空")
sequences = [item.get("sequence") for item in items]
if sequences != sorted(sequences) or len(sequences) != len(set(sequences)):
    raise SystemExit("事件序列不严格单调")
if sum(bool(item.get("terminal")) for item in items) != 1:
    raise SystemExit("终态事件数量不是 1")
PY

printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' >"$WORK_DIR/mcp-init.json"
code="$(curl -sS --max-time 25 -X POST -o "$WORK_DIR/mcp-init.response" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary "@$WORK_DIR/mcp-init.json" "$BASE_URL/mcp")"
[[ "$code" == 200 ]] || fail "MCP initialize 返回 HTTP $code"
python3 - "$WORK_DIR/mcp-init.response" <<'PY' || fail 'MCP initialize 契约无效'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
if ((p.get("result") or {}).get("serverInfo") or {}).get("name") != "zhicui":
    raise SystemExit("serverInfo 无效")
PY

printf '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' >"$WORK_DIR/mcp-list.json"
code="$(http_with_token "$PAT_FILE" POST /mcp "$WORK_DIR/mcp-list.json" "$WORK_DIR/mcp-list.response")"
[[ "$code" == 200 ]] || fail "MCP tools/list 返回 HTTP $code"
python3 - "$WORK_DIR/mcp-list.response" <<'PY' || fail 'MCP 工具暴露边界不正确'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
tools = ((p.get("result") or {}).get("tools"))
if not isinstance(tools, list):
    raise SystemExit("tools 不是数组")
names = {str(item.get("name") or "") for item in tools}
required = {"account.me", "run.get", "run.events"}
allowed = required | {"account.email.status", "account.consents"}
if not required.issubset(names) or not names.issubset(allowed):
    raise SystemExit(f"只读 PAT 工具集异常：{sorted(names)}")
if "run.cancel" in names or any(name.startswith(("admin.", "local.")) or "shell" in name.lower() for name in names):
    raise SystemExit("只读 PAT 发现取消、管理、本机或 Shell 工具")
PY

printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"account.me","arguments":{}}}\n' >"$WORK_DIR/mcp-call.json"
code="$(http_with_token "$PAT_FILE" POST /mcp "$WORK_DIR/mcp-call.json" "$WORK_DIR/mcp-call.response")"
[[ "$code" == 200 ]] || fail "MCP tools/call 返回 HTTP $code"
python3 - "$WORK_DIR/mcp-call.response" <<'PY' || fail 'MCP account.me 调用失败'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
result = p.get("result") or {}
structured = result.get("structuredContent") or {}
account = (structured.get("data") or {}).get("result") or {}
if result.get("isError") is not False or "is_admin" in account:
    raise SystemExit("MCP 调用错误或泄露管理员字段")
PY

code="$(http_with_token "$PAT_FILE" GET /api/admin/readiness '' "$WORK_DIR/admin.response")"
[[ "$code" == 401 || "$code" == 403 ]] || fail "PAT 访问管理端得到 HTTP $code"

code="$(http_with_token "$BROWSER_TOKEN_FILE" POST "/api/agent-interface/v1/credentials/$CREDENTIAL_ID/revoke" '' "$WORK_DIR/revoke.response")"
[[ "$code" == 200 ]] || fail "吊销 PAT 返回 HTTP $code"
CREDENTIAL_ID=""
code="$(http_with_token "$PAT_FILE" POST /api/agent-interface/v1/actions/account.me/invoke "$WORK_DIR/invoke.json" "$WORK_DIR/revoked.response")"
[[ "$code" == 401 ]] || fail "已吊销 PAT 仍可调用（HTTP $code）"
python3 - "$WORK_DIR/revoked.response" <<'PY' || fail '吊销后的稳定错误码无效'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
error = p.get("error") or {}
if error.get("code") not in {"CREDENTIAL_REVOKED", "INVALID_CREDENTIAL"}:
    raise SystemExit("吊销错误码无效")
PY

printf 'Agent Action/PAT/MCP Stable smoke passed\n'
