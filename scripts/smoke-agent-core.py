#!/usr/bin/env python3
"""Core 发布的真实只读调用与排除动作边界；由 smoke-agent-interface.sh 调用。"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import uuid
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


EXCLUDED_ACTIONS = (
    "library.transcript.batch", "creator.create", "creator.sync.start",
    "creator.sync.retry", "creator.sync.cancel", "creator.remove",
    "platform.binding.start", "platform.binding.poll", "platform.binding.disconnect",
    "analysis.catalog", "automation.status", "local.media.delete", "models.selection.get",
    "account.email.status",
)
CREATOR_READONLY_CREDENTIAL_NAME = "production-core-creator-readonly-smoke"


def verify_creator_boundaries(call, require, invoke, browser: str) -> None:
    """只用无效主页及随机标识验证边界，不请求平台目录或触发转写。"""
    status, payload = call("/api/auth/me", token=browser)
    user = payload.get("data") or {}
    require(status == 200 and user.get("username") == "zhicui_production_smoke"
            and user.get("is_admin") is False, "Core 博主冒烟必须使用固定非管理员账号")

    runs = invoke("creator.runs.list")
    require(isinstance(runs, dict) and isinstance(runs.get("items"), list), "Core 博主运行列表契约无效")
    binding = invoke("platform.binding.status", {"platform": "bilibili"})
    require(isinstance(binding, dict), "Core 平台绑定只读状态契约无效")
    forbidden_fields = ("cookie", "api_key", "access_token", "refresh_token", "password")
    serialized = json.dumps(binding).lower()
    require(not any(f'"{key}":' in serialized for key in forbidden_fields), "Core 平台绑定状态暴露秘密字段")

    missing = str(uuid.uuid4())
    for action, inputs, code in (
        ("creator.get", {"source_id": missing}, "SOURCE_NOT_FOUND"),
        ("creator.items.list", {"source_id": missing}, "SOURCE_NOT_FOUND"),
        ("creator.sync.get", {"run_id": missing}, "RESOURCE_NOT_FOUND"),
        ("creator.sync.items.list", {"run_id": missing}, "RESOURCE_NOT_FOUND"),
    ):
        status, result = call(f"/api/agent-interface/v1/actions/{action}/invoke", {"input": inputs})
        require(status == 422 and (result.get("error") or {}).get("code") == code,
                f"Core {action} 未拒绝不存在或不归属本人的资源")

    invalid_profile = {"platform": "bilibili", "profile_ref": "https://example.invalid/creator-smoke"}
    for action in ("creator.resolve", "creator.catalog.import"):
        status, result = call(f"/api/agent-interface/v1/actions/{action}/invoke", {
            "input": invalid_profile, "idempotency_key": "core-invalid-profile-" + uuid.uuid4().hex,
        })
        require(status == 422 and (result.get("error") or {}).get("code") == "SSRF_REJECTED",
                f"Core {action} 未在平台请求前拒绝无效主页")

    for action, inputs in (
        ("creator.resolve", {**invalid_profile, "platform": "douyin"}),
        ("creator.catalog.import", {**invalid_profile, "platform": "douyin"}),
        ("creator.catalog.import", {**invalid_profile, "limit": 50}),
        ("creator.catalog.import", {**invalid_profile, "operation": "catalog_all"}),
        ("creator.catalog.import", {**invalid_profile, "auto_transcribe": True}),
    ):
        status, result = call(f"/api/agent-interface/v1/actions/{action}/invoke", {
            "input": inputs, "idempotency_key": "core-bounded-catalog-" + uuid.uuid4().hex,
        })
        require(status == 422 and (result.get("error") or {}).get("code") == "INVALID_INPUT",
                "Core 博主目录导入未严格限制为 B站前 20 条且不转写")

    # 外层 Shell 也会按固定保留名称找回、吊销凭证，覆盖签发响应传输中断的情况。
    credential_id = None
    try:
        status, result = call("/api/agent-interface/v1/credentials/pat", {
            "name": CREATOR_READONLY_CREDENTIAL_NAME, "scopes": ["library:read"], "expires_in_days": 1,
        }, token=browser)
        data = result.get("data") or {}
        credential = data.get("credential") or {}
        credential_id = credential.get("id")
        readonly = data.get("token")
        require(status == 200 and isinstance(readonly, str) and readonly.startswith("zhc_pat_")
                and credential_id and credential.get("scopes") == ["library:read"]
                and credential.get("expiry_policy") == "fixed", "Core 博主只读凭证签发契约无效")
        status, result = call("/api/agent-interface/v1/capabilities", token=readonly)
        data = result.get("data") or {}
        require(status == 200 and data.get("granted_scopes") == ["library:read"]
                and "creator.catalog.import" not in {item.get("id") for item in data.get("actions", [])},
                "Core 原有只读权限获得了博主目录写能力")
        status, result = call("/api/agent-interface/v1/actions/creator.catalog.import/invoke", {
            "input": invalid_profile, "idempotency_key": "core-readonly-" + uuid.uuid4().hex,
        }, token=readonly)
        require(status == 403 and (result.get("error") or {}).get("code") == "SCOPE_DENIED",
                "Core 只读凭证仍可导入博主目录")
        status, result = call("/mcp", {"jsonrpc": "2.0", "id": "core-creator-readonly", "method": "tools/list"}, token=readonly)
        names = {item.get("name") for item in ((result.get("result") or {}).get("tools") or [])}
        require(status == 200 and "creator.catalog.import" not in names, "Core 只读 MCP 暴露博主目录导入")
        status, result = call("/mcp", {"jsonrpc": "2.0", "id": "core-creator-readonly-denied", "method": "tools/call",
            "params": {"name": "creator.catalog.import", "arguments": invalid_profile}}, token=readonly)
        tool = result.get("result") or {}
        require(status == 200 and tool.get("isError") is True
                and ((tool.get("structuredContent") or {}).get("error") or {}).get("code") == "SCOPE_DENIED",
                "Core 只读凭证仍可通过 MCP 导入博主目录")
        status, result = call("/api/agent-interface/v1/credentials", token=browser)
        current = next((item for item in ((result.get("data") or {}).get("items") or [])
                        if item.get("id") == credential_id), {})
        require(status == 200 and current.get("scopes") == ["library:read"]
                and current.get("expires_at") == credential.get("expires_at")
                and current.get("expiry_policy") == "fixed", "Core 只读凭证权限或原有效期发生变化")
    finally:
        if credential_id:
            status, result = call(f"/api/agent-interface/v1/credentials/{credential_id}/revoke", token=browser, method="POST")
            revoked = ((result.get("data") or {}).get("credential") or {})
            require(status == 200 and revoked.get("id") == credential_id and revoked.get("revoked_at"),
                    "Core 博主只读冒烟凭证未确认吊销")

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> None:
    base, browser_path, pat_path, source_id, thread_id = sys.argv[1:]
    browser = Path(browser_path).read_text(encoding="utf-8").strip()
    pat = Path(pat_path).read_text(encoding="utf-8").strip()
    opener = build_opener(NoRedirect())

    def call(path: str, body=None, *, token=pat, method=None):
        request = Request(
            f"{base.rstrip('/')}{path}",
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method=method or ("POST" if body is not None else "GET"),
        )
        try:
            response = opener.open(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def require(condition: bool, label: str) -> None:
        if not condition:
            raise SystemExit(label)

    def invoke(action: str, payload=None):
        status, result = call(f"/api/agent-interface/v1/actions/{action}/invoke", {"input": payload or {}, "idempotency_key": "core-smoke-" + uuid.uuid4().hex})
        require(status == 200 and result.get("status") == "succeeded", f"Core {action} 运行时调用失败")
        return (result.get("data") or {}).get("result")

    library = invoke("library.list", {"per_page": 3})
    require(isinstance(library, dict) and isinstance(library.get("items"), list), "Core 资料列表契约无效")
    source = invoke("library.get", {"note_id": source_id})
    require(isinstance(source, dict) and "ZHICUI-SMOKE-94731" in str(source.get("transcript_raw") or ""), "Core 固定资料缺少现有文稿哨兵")
    transcript = invoke("library.transcript.generate", {"note_id": source_id, "operation": "transcript"})
    require(isinstance(transcript, dict) and transcript.get("already_existed") is True and "ZHICUI-SMOKE-94731" in str(transcript.get("transcript_raw") or ""), "Core 单条文稿未复用已有资料")
    for action in ("library.import_link", "library.transcript.generate", "library.media.download", "library.activity.record", "local.platform.sync", "local.platform.status"):
        status, _ = call(f"/api/agent-interface/v1/actions/{action}")
        require(status == 200, f"Core 显式链接能力未开放：{action}")
    status, result = call(f"/api/agent-interface/v1/library/{uuid.uuid4()}/media")
    require(status == 404 and (result.get("error") or {}).get("code") == "RESOURCE_NOT_FOUND", "Core 下载未限制在已有本人资料")
    for action in ("creator.list", "knowledge.list", "plan.list", "plan.overview", "models.list", "models.custom.list"):
        result = invoke(action)
        require(isinstance(result, (dict, list)), f"Core {action} 输出契约无效")
        if action.startswith("models."):
            serialized = json.dumps(result).lower()
            require(not any(f'"{key}":' in serialized for key in ("api_key", "access_token", "refresh_token", "password")), "Core 模型读取暴露秘密字段")

    verify_creator_boundaries(call, require, invoke, browser)

    for action in EXCLUDED_ACTIONS:
        for path, body in (
            (f"/api/agent-interface/v1/actions/{action}", None),
            (f"/api/agent-interface/v1/actions/{action}/invoke", {"input": {}}),
        ):
            status, result = call(path, body)
            require(status == 404 and (result.get("error") or {}).get("code") == "ACTION_NOT_FOUND", "Core 排除动作仍可读取或调用")
        status, result = call("/mcp", {"jsonrpc": "2.0", "id": "core-excluded", "method": "tools/call", "params": {"name": action, "arguments": {}}})
        tool = result.get("result") or {}
        error = (tool.get("structuredContent") or {}).get("error") or {}
        require(status == 200 and tool.get("isError") is True and error.get("code") == "ACTION_NOT_FOUND", "Core 排除动作仍可通过 MCP 调用")

    recap = invoke("library.recap.get", {"day": "yesterday", "mode": "like"})
    require(isinstance(recap, dict) and recap.get("time_basis") == "first_discovered" and isinstance(recap.get("items"), list), "Core 每日清单契约无效")

    for scope in ("creator:sync", "analysis:read", "automation:read", "models:write"):
        status, result = call("/api/agent-interface/v1/credentials/pat", {
            "name": "production-stable-capability-smoke", "scopes": [scope], "expires_in_days": 1,
        }, token=browser)
        credential_id = (((result.get("data") or {}).get("credential") or {}).get("id"))
        if credential_id:
            # 若服务错误签发，先撤销；外层清理也会回收该保留名称。
            call(f"/api/agent-interface/v1/credentials/{credential_id}/revoke", token=browser, method="POST")
        require(status == 400 and (result.get("error") or {}).get("code") == "SCOPE_UNAVAILABLE", "Core 排除权限仍能签发 PAT")

    status, result = call("/api/agent-interface/v1/actions/ask.turn.start/invoke", {"input": {
        "thread_id": thread_id, "client_turn_id": f"core-no-web-{uuid.uuid4().hex}",
        "question": "不应执行的外部检索", "web_scope": "auto",
    }})
    require(status == 422 and (result.get("error") or {}).get("code") == "INVALID_INPUT", "Core 问答未限制在已有视频文稿")
    print("Core 现有资料、B站有界目录输入、只读凭证、资源归属及排除能力边界通过")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        raise SystemExit("Core 冒烟传输或响应契约失败（敏感诊断未输出）") from None
