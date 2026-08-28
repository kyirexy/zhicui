#!/usr/bin/env bash
# 知萃生产关键旅程冒烟。默认要求专用普通用户凭据并验证真实 AI SSE 首包。
set -Eeuo pipefail
umask 077

BASE_URL="${SMOKE_BASE_URL:-https://luxai.cn}"
REQUIRE_AUTH="${SMOKE_REQUIRE_AUTHENTICATED:-1}"
REQUIRE_SSE="${SMOKE_REQUIRE_AGENT_SSE:-1}"
SSE_TIMEOUT_SECONDS="${SMOKE_SSE_TIMEOUT_SECONDS:-120}"
LOGIN_EMAIL="${SMOKE_LOGIN_EMAIL:-}"
PASSWORD_FILE="${SMOKE_PASSWORD_FILE:-}"
EVIDENCE_FILE="${SMOKE_EVIDENCE_FILE:-}"
SOURCE_ID="${SMOKE_SOURCE_ID:-}"
SENTINEL_TOKEN="ZHICUI-SMOKE-94731"

case "$BASE_URL" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*) ;;
  *) printf 'SMOKE_BASE_URL 必须为 HTTPS 或本机回环地址\n' >&2; exit 2 ;;
esac
BASE_URL="${BASE_URL%/}"

for command_name in curl python3 sha256sum mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf '缺少冒烟依赖：%s\n' "$command_name" >&2
    exit 2
  }
done
[[ "$SSE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  printf 'SMOKE_SSE_TIMEOUT_SECONDS 必须是正整数\n' >&2
  exit 2
}

WORK_DIR="$(mktemp -d)"
RESULTS_FILE="$WORK_DIR/results.tsv"
TOKEN_FILE="$WORK_DIR/token"
THREAD_ID=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

clean_text() { printf '%s' "$1" | tr '\t\r\n' '   ' | cut -c1-240; }
record() {
  local name="$1" status="$2" detail="${3:-}"
  printf '%s\t%s\t%s\n' "$(clean_text "$name")" "$status" "$(clean_text "$detail")" >>"$RESULTS_FILE"
  printf '[%s] %s%s\n' "$status" "$name" "${detail:+ — $detail}"
}
pass() { record "$1" pass "${2:-}"; }
skip() { record "$1" skip "${2:-}"; }
fatal() { record "$1" fail "$2"; exit 1; }

# shellcheck disable=SC2329  # invoked by write_evidence through the EXIT trap
delete_smoke_thread() {
  [[ -z "$THREAD_ID" || ! -s "$TOKEN_FILE" ]] && return 0
  curl -fsS --max-time 8 -X DELETE \
    -H "Authorization: Bearer $(<"$TOKEN_FILE")" \
    "$BASE_URL/api/agent/threads/$THREAD_ID" >/dev/null 2>&1 || true
}

# shellcheck disable=SC2329  # registered as the EXIT trap below
write_evidence() {
  local exit_status=$?
  trap - EXIT
  delete_smoke_thread
  if [[ -n "$EVIDENCE_FILE" ]]; then
    install -d -m 0700 "$(dirname "$EVIDENCE_FILE")"
    python3 - "$RESULTS_FILE" "$EVIDENCE_FILE" "$BASE_URL" "$STARTED_AT" "$exit_status" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

source, target, base_url, started_at, exit_status = sys.argv[1:]
checks = []
if os.path.exists(source):
    with open(source, encoding="utf-8") as handle:
        for line in handle:
            name, status, detail = line.rstrip("\n").split("\t", 2)
            checks.append({"name": name, "status": status, "detail": detail or None})
payload = {
    "schema_version": 1,
    "operation": "production_smoke",
    "base_url": base_url,
    "started_at": started_at,
    "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "status": "passed" if int(exit_status) == 0 else "failed",
    "checks": checks,
}
temporary = f"{target}.tmp-{os.getpid()}"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, target)
PY
  fi
  rm -rf -- "$WORK_DIR"
  exit "$exit_status"
}
trap write_evidence EXIT

request() {
  local method="$1" path="$2" body_file="$3" output="$4" headers="$5"
  local args=(--silent --show-error --max-time 20 -X "$method" -D "$headers" -o "$output" -w '%{http_code}')
  [[ -z "$body_file" ]] || args+=(-H 'Content-Type: application/json' --data-binary "@$body_file")
  curl "${args[@]}" "$BASE_URL$path"
}

assert_json() {
  local file="$1" expression="$2" label="$3"
  python3 - "$file" "$expression" "$label" <<'PY'
import json
import sys

path, expression, label = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    payload = json.load(handle)
safe = {"p": payload, "isinstance": isinstance, "str": str, "bool": bool}
if not bool(eval(expression, {"__builtins__": {}}, safe)):
    raise SystemExit(f"{label}: 响应结构不符合预期")
PY
}

BODY="$WORK_DIR/body"; HEADERS="$WORK_DIR/headers"

code="$(request GET /api/health '' "$BODY" "$HEADERS")"
[[ "$code" == 200 ]] || fatal 'liveness' "HTTP $code"
assert_json "$BODY" 'p.get("success") is True' 'liveness' || fatal 'liveness' 'JSON 响应无效'
pass 'liveness' '/api/health 通过'

code="$(request GET /api/readiness '' "$BODY" "$HEADERS")"
[[ "$code" == 200 ]] || fatal 'readiness' "HTTP $code（关键依赖未就绪）"
assert_json "$BODY" 'p.get("success") is True and p.get("data", {}).get("status") == "ready" and "creator_connectors" in p.get("data", {}).get("checks", {}) and "backup" in p.get("data", {}).get("checks", {})' 'readiness' || fatal 'readiness' '依赖或连接器摘要不完整'
pass 'readiness' '数据库、AI、队列、连接器和备份闸门通过'

for path in /legal/terms /legal/privacy /support /platform-limits /library; do
  code="$(request GET "$path" '' "$BODY" "$HEADERS")"
  [[ "$code" == 200 ]] || fatal "页面 $path" "HTTP $code"
  pass "页面 $path"
done

code="$(request GET /api/auth/me '' "$BODY" "$HEADERS")"
[[ "$code" == 401 ]] || fatal '未登录权限边界' "/api/auth/me 返回 HTTP $code"
code="$(request GET /api/admin/readiness '' "$BODY" "$HEADERS")"
[[ "$code" == 401 || "$code" == 403 ]] || fatal '管理端权限边界' "返回 HTTP $code"
pass '未登录与管理端权限边界'

printf '{"email":"smoke-invalid-user@example.invalid","password":"invalid-smoke-password"}\n' >"$WORK_DIR/invalid-login.json"
code="$(request POST /api/auth/login "$WORK_DIR/invalid-login.json" "$BODY" "$HEADERS")"
[[ "$code" == 200 || "$code" == 401 ]] || fatal '错误凭据登录' "HTTP $code"
assert_json "$BODY" 'p.get("success") is False and not p.get("data") and isinstance(p.get("error"), str) and bool(p.get("error")) and "token" not in p' '错误凭据登录' || fatal '错误凭据登录' '失败响应意外泄露会话'
pass '错误凭据登录' '未签发令牌'

HANDOFF_SESSION="$(python3 - <<'PY'
import base64, os
print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))
PY
)"
printf '{"session_id":"%s"}\n' "$HANDOFF_SESSION" >"$WORK_DIR/handoff.json"
code="$(request POST /api/auth/desktop-handoff/request "$WORK_DIR/handoff.json" "$BODY" "$HEADERS")"
[[ "$code" == 200 ]] || fatal '桌面登录票据' "request HTTP $code"
assert_json "$BODY" 'p.get("success") is True and p.get("data", {}).get("status") == "pending"' '桌面登录票据' || fatal '桌面登录票据' '未进入 pending'
code="$(request GET "/api/auth/desktop-handoff/status/$HANDOFF_SESSION" '' "$BODY" "$HEADERS")"
[[ "$code" == 200 ]] || fatal '桌面登录票据' "status HTTP $code"
assert_json "$BODY" 'p.get("success") is True and p.get("data", {}).get("status") == "pending"' '桌面登录票据' || fatal '桌面登录票据' '轮询状态异常'
code="$(request GET "/login?desktop=1&session=$HANDOFF_SESSION" '' "$BODY" "$HEADERS")"
[[ "$code" == 200 ]] || fatal '桌面登录回跳页' "HTTP $code"
pass '桌面登录票据与回跳页'

curl -sS --max-time 15 -D "$HEADERS" -o /dev/null -H 'Origin: https://evil.invalid' "$BASE_URL/api/health"
if grep -Eiq '^access-control-allow-origin:[[:space:]]*https://evil\.invalid' "$HEADERS"; then
  fatal 'CORS 拒绝未知来源' '服务器回显了恶意 Origin'
fi
curl -sS --max-time 15 -D "$HEADERS" -o /dev/null -H 'Origin: https://luxai.cn' "$BASE_URL/api/health"
grep -Eiq '^access-control-allow-origin:[[:space:]]*https://luxai\.cn' "$HEADERS" || fatal 'CORS 允许官网' '缺少精确 ACAO'
pass 'CORS 精确来源'

curl -sS --max-time 15 -I "$BASE_URL/" >"$HEADERS"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$HEADERS" || fatal '安全响应头' '缺少 nosniff'
grep -Eiq '^x-frame-options:[[:space:]]*DENY' "$HEADERS" || fatal '安全响应头' '缺少 DENY'
grep -Eiq '^content-security-policy:' "$HEADERS" || fatal '安全响应头' '缺少 CSP'
if [[ "$BASE_URL" == https://* ]]; then
  grep -Eiq '^strict-transport-security:' "$HEADERS" || fatal '安全响应头' 'HTTPS 缺少 HSTS'
fi
pass 'Nginx/Next 安全响应头'

verify_download_manifest() {
  local platform="$1" channel="$2"
  local manifest="$WORK_DIR/$platform-$channel.json"
  local manifest_headers="$WORK_DIR/$platform-$channel.headers"
  local status
  status="$(request GET "/download/releases/$platform/$channel.json" '' "$manifest" "$manifest_headers")"
  [[ "$status" == 200 ]] || fatal "$platform $channel 清单" "HTTP $status"
  assert_json "$manifest" "p.get('schema_version') == 2 and p.get('platform') == '$platform' and p.get('channel') == '$channel' and p.get('availability') in ('available', 'unavailable')" "$platform $channel 清单" || fatal "$platform $channel 清单" '结构无效'
  local availability
  availability="$(python3 - "$manifest" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["availability"])
PY
)"
  if [[ "$availability" != available ]]; then
    pass "$platform $channel 清单" '当前明确标记 unavailable'
    return
  fi
  readarray -t artifact < <(python3 - "$manifest" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
print(p["download_url"])
print(p["size_bytes"])
print(p["sha256"].lower())
PY
  )
  local url="${artifact[0]}" expected_size="${artifact[1]}" expected_hash="${artifact[2]}"
  case "$url" in
    "$BASE_URL"/download/*|https://luxai.cn/download/*) ;;
    *) fatal "$platform $channel 下载" '清单 URL 不属于受信官网下载目录' ;;
  esac
  local binary="$WORK_DIR/$platform-$channel.bin"
  curl -fsS --max-time 300 --retry 2 --retry-all-errors -o "$binary" "$url" || fatal "$platform $channel 下载" '下载失败'
  local actual_size actual_hash
  actual_size="$(wc -c <"$binary" | tr -d '[:space:]')"
  actual_hash="$(sha256sum "$binary" | awk '{print tolower($1)}')"
  [[ "$actual_size" == "$expected_size" ]] || fatal "$platform $channel 下载" '文件大小与清单不一致'
  [[ "$actual_hash" == "$expected_hash" ]] || fatal "$platform $channel 下载" 'SHA-256 与清单不一致'
  pass "$platform $channel 清单与下载哈希" "$actual_size bytes"
}

for platform in android windows; do
  verify_download_manifest "$platform" beta
  verify_download_manifest "$platform" stable
done

if [[ -z "$LOGIN_EMAIL" || -z "$PASSWORD_FILE" ]]; then
  if [[ "$REQUIRE_AUTH" == 1 || "$REQUIRE_SSE" == 1 ]]; then
    fatal '登录与 AI SSE' '需配置 SMOKE_LOGIN_EMAIL 与仅部署用户可读的 SMOKE_PASSWORD_FILE'
  fi
  skip '登录与 AI SSE' '显式设置为非必需'
else
  [[ -r "$PASSWORD_FILE" ]] || fatal '专用冒烟账号' '密码文件不可读'
  PASSWORD="$(<"$PASSWORD_FILE")"
  [[ -n "$PASSWORD" ]] || fatal '专用冒烟账号' '密码文件为空'
  python3 - "$WORK_DIR/login.json" "$LOGIN_EMAIL" "$PASSWORD" <<'PY'
import json, os, sys
path, email, password = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"email": email, "password": password}, handle)
os.chmod(path, 0o600)
PY
  unset PASSWORD
  code="$(request POST /api/auth/login "$WORK_DIR/login.json" "$BODY" "$HEADERS")"
  [[ "$code" == 200 ]] || fatal '专用冒烟账号登录' "HTTP $code"
  python3 - "$BODY" "$TOKEN_FILE" <<'PY'
import json, os, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
data = p.get("data") or {}
token = data.get("token")
user = data.get("user") or {}
if p.get("success") is not True or not isinstance(token, str) or not token or user.get("is_admin") is not False:
    raise SystemExit("冒烟账号必须是有效的普通用户")
if user.get("username") != "zhicui_production_smoke":
    raise SystemExit("拒绝使用真实用户账号执行冒烟")
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    handle.write(token)
os.chmod(sys.argv[2], 0o600)
PY
  TOKEN="$(<"$TOKEN_FILE")"
  code="$(curl -sS --max-time 20 -o "$BODY" -D "$HEADERS" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/auth/me")"
  [[ "$code" == 200 ]] || fatal '已登录会话' "HTTP $code"
  code="$(curl -sS --max-time 20 -o "$BODY" -D "$HEADERS" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/admin/readiness")"
  [[ "$code" == 403 ]] || fatal '普通用户管理端边界' "预期 403，得到 $code"
  pass '专用普通用户登录与管理端边界'

  if [[ "$REQUIRE_SSE" == 1 ]]; then
    [[ "$SOURCE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fatal '隔离冒烟资料' '缺少有效 SMOKE_SOURCE_ID；生产部署必须先预置固定资料'
    python3 - "$WORK_DIR/thread.json" "$SOURCE_ID" <<'PY'
import json, sys
path, source_id = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "title": "[production-smoke] fixed-source-citation-gate",
        "source_scope": "selected",
        "source_ids": [source_id],
    }, handle, ensure_ascii=False)
PY
    code="$(curl -sS --max-time 20 -X POST -o "$BODY" -D "$HEADERS" -w '%{http_code}' -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" --data-binary "@$WORK_DIR/thread.json" "$BASE_URL/api/agent/threads")"
    [[ "$code" == 200 ]] || fatal 'AI SSE 建立测试会话' "HTTP $code"
    THREAD_ID="$(python3 - "$BODY" "$SOURCE_ID" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
data = p.get("data") or {}
expected = sys.argv[2]
if (
    p.get("success") is not True
    or data.get("scope_type") != "selected"
    or data.get("source_ids") != [expected]
    or data.get("source_selected_count") != 1
):
    raise SystemExit("会话没有冻结在唯一冒烟资料上")
print(data.get("id") or "")
PY
)"
    [[ "$THREAD_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fatal 'AI SSE 建立测试会话' '未返回 thread id'
    CLIENT_TURN_ID="smoke-$(date -u +%Y%m%d%H%M%S)-$$"
    python3 - "$WORK_DIR/stream.json" "$CLIENT_TURN_ID" <<'PY'
import json, sys
path, client_turn_id = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "content": "固定视频文稿中，琥珀火车的唯一校验编号是什么？请直接回答并引用原文。",
        "client_turn_id": client_turn_id,
        "research_mode": "fast",
        "output_style": "answer",
        "web_scope": "video_only",
    }, handle, ensure_ascii=False)
PY
    set +e
    sse_code="$(curl -sS -N --max-time "$SSE_TIMEOUT_SECONDS" -X POST -o "$WORK_DIR/stream.body" -D "$WORK_DIR/stream.headers" -w '%{http_code}' -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -H "Authorization: Bearer $TOKEN" --data-binary "@$WORK_DIR/stream.json" "$BASE_URL/api/agent/threads/$THREAD_ID/messages/stream")"
    curl_status=$?
    set -e
    [[ "$sse_code" == 200 ]] || fatal 'AI SSE 首包' "HTTP $sse_code"
    [[ "$curl_status" == 0 ]] || fatal 'AI SSE 完整回答' "curl $curl_status（未在 ${SSE_TIMEOUT_SECONDS} 秒内完成）"
    grep -Eiq '^content-type:[[:space:]]*text/event-stream' "$WORK_DIR/stream.headers" || fatal 'AI SSE 完整回答' '响应不是 text/event-stream'
    python3 - "$WORK_DIR/stream.body" "$SOURCE_ID" "$SENTINEL_TOKEN" <<'PY' || fatal 'AI SSE 可核验回答' '回答必须包含唯一哨兵事实，并提供回指固定资料的引用'
import json, sys
path, expected_source_id, sentinel = sys.argv[1:]
deltas = []
done_events = []
for raw in open(path, encoding="utf-8"):
    if not raw.startswith("data:"):
        continue
    try:
        event = json.loads(raw[5:].strip())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"SSE data 不是 JSON：{exc}")
    event_type = event.get("type")
    if event_type == "error":
        raise SystemExit(f"SSE error：{event.get('message') or event}")
    if event_type == "delta" and isinstance(event.get("delta"), str) and event["delta"].strip():
        deltas.append(event["delta"])
    if event_type == "done":
        done_events.append(event)
if not deltas:
    raise SystemExit("未收到有效 answer delta")
if len(done_events) != 1:
    raise SystemExit(f"done 数量异常：{len(done_events)}")
done = done_events[0]
assistant = ((done.get("data") or {}).get("assistant_message") or {})
answer = str(assistant.get("content") or "")
streamed_answer = "".join(deltas)
if sentinel not in answer or sentinel not in streamed_answer:
    raise SystemExit("最终回答或流式增量未包含哨兵事实")
result = assistant.get("result") or {}
evidence = result.get("evidence") if isinstance(result, dict) else None
if not isinstance(evidence, list):
    raise SystemExit("最终回答缺少 evidence 数组")
matched = [item for item in evidence if isinstance(item, dict) and str(item.get("note_id") or item.get("source_id") or "") == expected_source_id]
if not matched:
    raise SystemExit("没有引用指向固定冒烟资料")
if not any(sentinel in str(item.get("quote") or "") for item in matched):
    raise SystemExit("固定资料引用未包含哨兵原文")
PY
    pass 'AI SSE 可核验回答' '非空 delta、done、唯一哨兵事实及 source 引用均通过'
  else
    skip 'AI SSE 首包' '显式设置为非必需'
  fi
fi

pass '生产关键旅程' '全部必需闸门通过'
exit 0
