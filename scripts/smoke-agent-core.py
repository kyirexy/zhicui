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
    "library.transcript.batch", "creator.sync.start",
    "analysis.catalog", "automation.status", "local.status", "models.selection.get",
    "account.email.status",
)

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
    for action in ("library.import_link", "library.transcript.generate", "library.media.download"):
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

    for scope in ("analysis:read", "automation:read", "local:invoke"):
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
    print("Core 现有资料、知识计划、模型读取及排除动作/权限边界通过")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        raise SystemExit("Core 冒烟传输或响应契约失败（敏感诊断未输出）") from None
