#!/usr/bin/env python3
"""知萃管理员 CLI。

This API-first client calls the same authenticated ``/api/admin/*`` handlers
as the web admin panel. Permissions, audit logging, validation, and service
layer behaviour therefore remain in one place. It never opens the database.

The token is read from ``ZHICUI_ADMIN_TOKEN`` (or ``--token-stdin``) and is
only sent as an Authorization header. Responses are redacted before printing.
The generic ``request`` command reaches every current and future admin route;
shortcuts below document the routes used by the admin UI.
"""

from __future__ import annotations

import argparse
import getpass
import json
import mimetypes
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

DEFAULT_BASE_URL = "https://luxai.cn"
TOKEN_ENV = "ZHICUI_ADMIN_TOKEN"
BASE_URL_ENV = "ZHICUI_ADMIN_URL"
SECRET_KEY_RE = re.compile(
    r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie|secret|private[_-]?key|jwt)",
    re.IGNORECASE,
)
INLINE_SECRET_RE = re.compile(
    r"(?i)(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie|secret|jwt)\b\s*[:=]\s*)([^\s,;]+)"
)


class AdminCliError(RuntimeError):
    exit_code = 1


class UsageError(AdminCliError):
    exit_code = 2


class AuthenticationError(AdminCliError):
    exit_code = 3


class PermissionError(AdminCliError):
    exit_code = 4


@dataclass(frozen=True)
class Endpoint:
    name: str
    method: str
    path: str
    help: str
    destructive: bool = False


# This inventory is also an operator-facing map in ``--help``. ``request`` is
# the escape hatch for an endpoint added after a CLI release.
ENDPOINTS: tuple[Endpoint, ...] = (
    Endpoint("stats", "GET", "/api/admin/stats", "统计概览"),
    Endpoint("ops", "GET", "/api/admin/ops", "运维概览"),
    Endpoint("system-info", "GET", "/api/admin/system-info", "系统与密钥状态（仅布尔值）"),
    Endpoint("readiness", "GET", "/api/admin/readiness", "生产就绪检查"),
    Endpoint("alerts", "GET", "/api/admin/operational-alerts", "运维告警"),
    Endpoint("business-overview", "GET", "/api/admin/business-overview", "业务指标概览"),
    Endpoint("users.list", "GET", "/api/admin/users", "用户分页查询"),
    Endpoint("users.detail", "GET", "/api/admin/users/{id}", "用户详情"),
    Endpoint("users.update", "PATCH", "/api/admin/users/{id}", "更新用户状态或资料"),
    Endpoint("users.delete", "DELETE", "/api/admin/users/{id}", "删除用户", True),
    Endpoint("users.reset-password", "POST", "/api/admin/users/{id}/reset-password", "重置用户密码", True),
    Endpoint("notes.list", "GET", "/api/admin/notes", "资料分页查询"),
    Endpoint("notes.delete", "DELETE", "/api/admin/notes/{id}", "删除资料", True),
    Endpoint("notes.re-extract", "POST", "/api/admin/notes/{id}/re-extract", "重新抽取资料"),
    Endpoint("notes.batch-delete", "POST", "/api/admin/notes/batch-delete", "批量删除资料", True),
    Endpoint("plans.list", "GET", "/api/admin/plans", "计划分页查询"),
    Endpoint("plans.delete", "DELETE", "/api/admin/plans/{id}", "删除计划", True),
    Endpoint("feedback.list", "GET", "/api/admin/feedback", "反馈分页查询"),
    Endpoint("feedback.update", "PATCH", "/api/admin/feedback/{id}", "处理反馈"),
    Endpoint("audit-logs", "GET", "/api/admin/audit-logs", "管理员审计日志"),
    Endpoint("llm-usage", "GET", "/api/admin/llm-usage", "LLM 用量"),
    Endpoint("user-activity", "GET", "/api/admin/user-activity", "用户活动"),
    Endpoint("error-logs", "GET", "/api/admin/error-logs", "应用错误日志"),
    Endpoint("llm-config.get", "GET", "/api/admin/llm-config", "LLM 配置（密钥掩码）"),
    Endpoint("llm-config.put", "PUT", "/api/admin/llm-config", "更新 LLM 配置"),
    Endpoint("llm-config.test", "POST", "/api/admin/llm-config/test", "测试 LLM 连接"),
    Endpoint("asr-config.get", "GET", "/api/admin/asr-config", "ASR 配置（密钥掩码）"),
    Endpoint("asr-config.put", "PUT", "/api/admin/asr-config", "更新 ASR 配置"),
    Endpoint("asr-config.test", "POST", "/api/admin/asr-config/test", "测试 ASR 连接"),
    Endpoint("extraction-config.get", "GET", "/api/admin/extraction-config", "解析并发配置"),
    Endpoint("extraction-config.put", "PUT", "/api/admin/extraction-config", "更新解析并发配置"),
    Endpoint("creator-sync-config.get", "GET", "/api/admin/creator-sync-config", "博主同步配置"),
    Endpoint("creator-sync-config.put", "PUT", "/api/admin/creator-sync-config", "更新博主同步配置"),
    Endpoint("creator-sync-config.test", "POST", "/api/admin/creator-sync-config/test", "测试博主连接器"),
    Endpoint("agent-v2-config.get", "GET", "/api/admin/agent-v2-config", "Agent V2 配置"),
    Endpoint("agent-v2-config.put", "PUT", "/api/admin/agent-v2-config", "更新 Agent V2 配置"),
    Endpoint("omniroute-config.get", "GET", "/api/admin/omniroute-config", "OmniRoute 配置（密钥掩码）"),
    Endpoint("omniroute-config.put", "PUT", "/api/admin/omniroute-config", "更新 OmniRoute 配置"),
    Endpoint("omniroute.workspace", "GET", "/api/admin/omniroute/workspace", "OmniRoute 工作区"),
    Endpoint("omniroute.test", "POST", "/api/admin/omniroute/test", "测试 OmniRoute"),
    Endpoint("chat-models.list", "GET", "/api/admin/chat-models", "聊天模型目录"),
    Endpoint("chat-models.create", "POST", "/api/admin/chat-models", "创建聊天模型"),
    Endpoint("chat-models.update", "PUT", "/api/admin/chat-models/{id}", "更新聊天模型"),
    Endpoint("chat-models.delete", "DELETE", "/api/admin/chat-models/{id}", "删除聊天模型", True),
    Endpoint("community-qr.get", "GET", "/api/admin/community-qr", "交流群二维码状态"),
    Endpoint("showcase.list", "GET", "/api/admin/showcase-cases", "官网案例 CMS 列表"),
    Endpoint("showcase.create", "POST", "/api/admin/showcase-cases", "创建官网案例"),
    Endpoint("showcase.update", "PATCH", "/api/admin/showcase-cases/{id}", "更新官网案例"),
    Endpoint("showcase.delete", "DELETE", "/api/admin/showcase-cases/{id}", "删除官网案例", True),
    Endpoint("showcase.media-upload", "POST", "/api/admin/showcase-cases/{id}/media", "上传官网案例媒体"),
    Endpoint("showcase.media", "GET", "/api/admin/showcase-cases/{id}/media", "下载官网案例媒体"),
    Endpoint("showcase.poster", "GET", "/api/admin/showcase-cases/{id}/poster", "下载官网案例海报"),
    Endpoint("catalog-quality.preview", "GET", "/api/admin/catalog-quality/preview", "博主目录质量预览"),
    Endpoint("catalog-quality.runs", "GET", "/api/admin/catalog-quality/runs", "目录质量任务列表"),
    Endpoint("catalog-quality.run-create", "POST", "/api/admin/catalog-quality/runs", "创建目录质量任务"),
    Endpoint("catalog-quality.run-detail", "GET", "/api/admin/catalog-quality/runs/{id}", "目录质量任务详情"),
    Endpoint("catalog-quality.run-process", "POST", "/api/admin/catalog-quality/runs/{id}/process", "执行目录质量任务"),
    Endpoint("catalog-quality.run-cancel", "POST", "/api/admin/catalog-quality/runs/{id}/cancel", "取消目录质量任务"),
    Endpoint("video-analysis.providers", "GET", "/api/admin/video-analysis/providers", "视觉 Provider 列表"),
    Endpoint("video-analysis.provider-create", "POST", "/api/admin/video-analysis/providers", "创建视觉 Provider"),
    Endpoint("video-analysis.provider-update", "PATCH", "/api/admin/video-analysis/providers/{id}", "更新视觉 Provider"),
    Endpoint("video-analysis.provider-delete", "DELETE", "/api/admin/video-analysis/providers/{id}", "停用视觉 Provider", True),
    Endpoint("video-analysis.provider-test", "POST", "/api/admin/video-analysis/providers/{id}/test", "测试视觉 Provider"),
    Endpoint("video-analysis.offerings", "GET", "/api/admin/video-analysis/offerings", "视觉解析方案列表"),
    Endpoint("video-analysis.offering-create", "POST", "/api/admin/video-analysis/offerings", "创建视觉解析方案"),
    Endpoint("video-analysis.offering-update", "PATCH", "/api/admin/video-analysis/offerings/{id}", "更新视觉解析方案"),
    Endpoint("video-analysis.offering-publish", "POST", "/api/admin/video-analysis/offerings/{id}/publish", "发布视觉解析方案"),
    Endpoint("video-analysis.offering-delete", "DELETE", "/api/admin/video-analysis/offerings/{id}", "停用视觉解析方案", True),
    Endpoint("video-analysis.settings.get", "GET", "/api/admin/video-analysis/settings", "视觉解析运行配置"),
    Endpoint("video-analysis.settings.put", "PUT", "/api/admin/video-analysis/settings", "更新视觉解析运行配置"),
    Endpoint("video-analysis.runs", "GET", "/api/admin/video-analysis/runs", "视觉解析任务"),
    Endpoint("video-analysis.ledger", "GET", "/api/admin/video-analysis/ledger", "视觉解析积分流水"),
    Endpoint("video-analysis.usage", "GET", "/api/admin/video-analysis/usage", "视觉解析用量"),
    Endpoint("video-analysis.account", "GET", "/api/admin/video-analysis/users/{id}/account", "用户视觉积分账户"),
    Endpoint("video-analysis.credits", "POST", "/api/admin/video-analysis/users/{id}/credits", "调整用户视觉积分"),
    Endpoint("video-creation-config.get", "GET", "/api/admin/video-creation-config", "创作工坊配置"),
    Endpoint("video-creation-config.put", "PUT", "/api/admin/video-creation-config", "更新创作工坊配置"),
    Endpoint("operational-alert.ack", "POST", "/api/admin/operational-alerts/{id}/acknowledge", "确认运维告警"),
    Endpoint("community-qr.put", "PUT", "/api/admin/community-qr", "替换交流群二维码"),
)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "***redacted***" if SECRET_KEY_RE.search(str(key)) else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return INLINE_SECRET_RE.sub(r"\1***redacted***", value)
    return value


def _json_load(raw: str, *, label: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UsageError(f"{label} 不是合法 JSON：{exc.msg}") from exc


def _read_body(args: argparse.Namespace) -> Any | None:
    supplied = [bool(args.body_json), bool(args.body_file), bool(args.body_stdin)]
    if sum(supplied) > 1:
        raise UsageError("--body-json、--body-file、--body-stdin 只能选一个")
    if args.body_json:
        return _json_load(args.body_json, label="--body-json")
    if args.body_file:
        try:
            raw = Path(args.body_file).read_text(encoding="utf-8")
        except OSError as exc:
            raise UsageError(f"无法读取请求文件：{exc}") from exc
        return _json_load(raw, label="--body-file")
    if args.body_stdin:
        return _json_load(sys.stdin.read(), label="标准输入")
    return None


def _query_values(values: Iterable[str] | None) -> list[tuple[str, str]]:
    query: list[tuple[str, str]] = []
    for entry in values or []:
        if "=" not in entry:
            raise UsageError(f"--query 需要 key=value：{entry}")
        key, value = entry.split("=", 1)
        if not key:
            raise UsageError("--query 的 key 不能为空")
        query.append((key, value))
    return query


def _safe_admin_path(path: str) -> str:
    if not path.startswith("/api/admin/"):
        raise UsageError("CLI 只允许访问 /api/admin/ 管理接口")
    if "?" in path or "#" in path:
        raise UsageError("查询参数请使用 --query，禁止把参数拼在 path 中")
    decoded = unquote(path)
    parts = path.split("/")
    if decoded != path or "\\" in path or any(part in {"", ".", ".."} for part in parts[1:]):
        raise UsageError("管理接口 path 不允许编码字符或目录跳转")
    return path


def _format_endpoint(endpoint: Endpoint, identifier: str | None) -> str:
    if "{id}" not in endpoint.path:
        return endpoint.path
    if not identifier:
        raise UsageError(f"{endpoint.name} 需要 <id>")
    return endpoint.path.replace("{id}", identifier)


class AdminClient:
    def __init__(self, *, base_url: str, token: str, timeout: float) -> None:
        base_url = base_url.rstrip("/")
        parsed = urlsplit(base_url)
        local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not (parsed.scheme == "https" or local_http)
        ):
            raise UsageError("管理 CLI 只接受 HTTPS 远端地址；本地可用 localhost/127.0.0.1")
        self.base_url = base_url
        self.token = token
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Iterable[tuple[str, str]] = (),
        body: Any | None = None,
        file_path: str | None = None,
        expires_at: str | None = None,
        output_path: str | None = None,
    ) -> Any:
        path = _safe_admin_path(path)
        if file_path and body is not None:
            raise UsageError("multipart 上传不能同时提供 JSON body")
        target = urljoin(self.base_url + "/", path.lstrip("/"))
        query_values = list(query)
        if query_values:
            target = f"{target}?{urlencode(query_values)}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "User-Agent": "zhicui-admin-cli/1",
        }
        payload: bytes | None = None
        if file_path:
            max_bytes = 512 * 1024 if path.rstrip("/") == "/api/admin/community-qr" else 100 * 1024 * 1024
            payload, content_type = _multipart_file(file_path, expires_at, max_bytes=max_bytes)
            headers["Content-Type"] = content_type
        elif body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(target, data=payload, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                if output_path:
                    destination = Path(output_path)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(raw)
                    return {"saved_to": str(destination), "bytes": len(raw)}
                return _parse_response(raw, int(response.status))
        except HTTPError as exc:
            detail = _response_error(exc.read(), exc.code)
            if exc.code == 401:
                raise AuthenticationError(detail) from exc
            if exc.code == 403:
                raise PermissionError(detail) from exc
            raise AdminCliError(detail) from exc
        except URLError as exc:
            raise AdminCliError(f"无法连接管理 API：{exc.reason}") from exc
        except TimeoutError as exc:
            raise AdminCliError("管理 API 请求超时") from exc


def _parse_response(raw: bytes, status: int) -> Any:
    try:
        data = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AdminCliError(f"管理 API 返回了非 JSON 响应（HTTP {status}）") from exc
    if isinstance(data, dict) and data.get("success") is False:
        raise AdminCliError(str(_redact(data.get("error") or f"管理 API 请求失败（HTTP {status}）")))
    return _redact(data)


def _response_error(raw: bytes, status: int) -> str:
    try:
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict):
            detail = data.get("detail") or data.get("error")
            if detail:
                return str(_redact(detail))
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    return f"管理 API 请求失败（HTTP {status}）"


def _multipart_file(
    file_path: str,
    expires_at: str | None,
    *,
    max_bytes: int = 100 * 1024 * 1024,
) -> tuple[bytes, str]:
    path = Path(file_path)
    if not path.is_file():
        raise UsageError(f"文件不存在：{file_path}")
    if path.stat().st_size > max_bytes:
        raise UsageError(f"上传文件超过 {max_bytes // (1024 * 1024) or 1} MiB，拒绝发送")
    boundary = "----zhicui-admin-cli-boundary"
    filename = path.name.replace('"', "'")
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    chunks = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n".encode(),
        path.read_bytes(),
        b"\r\n",
    ]
    if expires_at:
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"expires_at\"\r\n\r\n{expires_at}\r\n".encode()
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _token_from_args(args: argparse.Namespace) -> str:
    token = os.environ.get(TOKEN_ENV, "").strip()
    if args.token_stdin:
        token = sys.stdin.read().strip()
    if not token:
        if args.non_interactive:
            raise AuthenticationError(f"请设置 {TOKEN_ENV} 或使用 --token-stdin")
        token = getpass.getpass("知萃管理员 Token（不会回显）：").strip()
    if not token:
        raise AuthenticationError("管理员 Token 不能为空")
    return token


def _print_json(value: Any) -> None:
    print(json.dumps(_redact(value), ensure_ascii=False, indent=2, sort_keys=True))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zhicui-admin",
        description="知萃管理员 API CLI（复用正式管理端接口与审计）",
        epilog=(
            "令牌只从 ZHICUI_ADMIN_TOKEN 或 --token-stdin 读取；响应中的密钥、Token、Cookie、密码会被掩码。\n"
            "所有管理端点均可用 request 调用，例如：request GET /api/admin/readiness。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--base-url", default=os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL), help=f"API 地址（默认 ${BASE_URL_ENV} 或 {DEFAULT_BASE_URL}）")
    parser.add_argument("--token-stdin", action="store_true", help="从标准输入读取管理员 Token（不会回显）")
    parser.add_argument("--non-interactive", action="store_true", help="缺少 Token 时不询问")
    parser.add_argument("--timeout", type=float, default=30, help="请求超时秒数")
    sub = parser.add_subparsers(dest="command", required=True)

    request_parser = sub.add_parser("request", help="调用任意 /api/admin/* 接口")
    request_parser.add_argument("method", choices=("GET", "POST", "PUT", "PATCH", "DELETE"))
    request_parser.add_argument("path")
    request_parser.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    request_parser.add_argument("--body-json")
    request_parser.add_argument("--body-file")
    request_parser.add_argument("--body-stdin", action="store_true")
    request_parser.add_argument("--file", dest="file_path", help="multipart 文件（交流群二维码或官网案例媒体）")
    request_parser.add_argument("--expires-at", help="二维码过期日期（配合 --file）")
    request_parser.add_argument("--output", help="保存二进制管理资源到文件")
    request_parser.add_argument("--yes", action="store_true", help="确认破坏性操作")

    for endpoint in ENDPOINTS:
        command = endpoint.name.replace(".", "-")
        ep = sub.add_parser(command, help=f"{endpoint.method} {endpoint.path}：{endpoint.help}")
        if "{id}" in endpoint.path:
            ep.add_argument("id")
        ep.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
        if endpoint.method != "GET":
            ep.add_argument("--body-json")
            ep.add_argument("--body-file")
            ep.add_argument("--body-stdin", action="store_true")
        if endpoint.name in {"showcase.media", "showcase.poster"}:
            ep.add_argument("--output", required=True, help="保存二进制媒体到文件")
        if endpoint.name == "showcase.media-upload":
            ep.add_argument("--file", dest="file_path", required=True, help="案例视频或图片文件")
        if endpoint.name == "community-qr.put":
            ep.add_argument("--file", dest="file_path", required=True, help="二维码图片文件")
        ep.add_argument("--yes", action="store_true", help="确认破坏性操作" if endpoint.destructive else "确认执行")
    return parser


def _endpoint_for_command(command: str) -> Endpoint:
    for endpoint in ENDPOINTS:
        if endpoint.name.replace(".", "-") == command:
            return endpoint
    raise UsageError(f"未知管理命令：{command}")


def _run(args: argparse.Namespace) -> Any:
    token = _token_from_args(args)
    client = AdminClient(base_url=args.base_url, token=token, timeout=args.timeout)
    if args.command == "request":
        destructive_request = (
            args.method == "DELETE"
            or args.path.endswith("/reset-password")
            or args.path.endswith("/batch-delete")
        )
        if destructive_request and not args.yes:
            raise UsageError("该管理请求是破坏性操作，请添加 --yes")
        body = _read_body(args)
        valid_upload = (
            args.path.rstrip("/") == "/api/admin/community-qr"
            or (args.path.startswith("/api/admin/showcase-cases/") and args.path.endswith("/media"))
        )
        if args.file_path and not valid_upload:
            raise UsageError("--file 仅支持 community-qr 或 showcase-cases/{id}/media")
        if args.path.endswith("/media") and args.method == "POST" and not args.file_path:
            raise UsageError("案例媒体上传需要 --file")
        if args.method == "GET" and args.path.endswith(("/media", "/poster")) and not args.output:
            raise UsageError("媒体接口需要 --output 指定保存文件")
        return client.request(
            args.method,
            args.path,
            query=_query_values(args.query),
            body=body,
            file_path=args.file_path,
            expires_at=args.expires_at,
            output_path=args.output,
        )

    endpoint = _endpoint_for_command(args.command)
    if endpoint.destructive and not args.yes:
        raise UsageError(f"{endpoint.name} 是破坏性操作，请添加 --yes")
    body = _read_body(args) if endpoint.method != "GET" else None
    file_path = getattr(args, "file_path", None)
    if endpoint.name == "showcase.media-upload" and not file_path:
        raise UsageError("案例媒体上传需要 --file")
    return client.request(
        endpoint.method,
        _format_endpoint(endpoint, getattr(args, "id", None)),
        query=_query_values(args.query),
        body=body,
        file_path=file_path,
        output_path=getattr(args, "output", None),
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        _print_json(_run(args))
        return 0
    except AdminCliError as exc:
        print(f"知萃管理员 CLI：{exc}", file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        print("知萃管理员 CLI：已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
