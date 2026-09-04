"""Small, privacy-bounded request limiter for the single-instance API.

The production deployment currently runs one Uvicorn process, so an in-memory
sliding window is both predictable and dependency-free.  Policies are kept in
one module so a future Redis implementation can preserve the same API and
response contract.
"""

from __future__ import annotations

import ipaddress
import hashlib
import json
import math
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from app.core.config import settings
from app.services import auth_service


@dataclass(frozen=True)
class RatePolicy:
    name: str
    method: str
    path_prefix: str
    limit: int
    window_seconds: int
    principal: str = "ip"


POLICIES: tuple[RatePolicy, ...] = (
    RatePolicy("auth_login", "POST", "/api/auth/login", 12, 5 * 60),
    RatePolicy("auth_register", "POST", "/api/auth/register", 5, 60 * 60),
    RatePolicy(
        "desktop_login_create",
        "POST",
        "/api/auth/desktop-login/sessions",
        12,
        5 * 60,
    ),
    RatePolicy(
        "desktop_login_approval",
        "POST",
        "/api/auth/desktop-login/sessions",
        60,
        5 * 60,
        "user",
    ),
    RatePolicy(
        "desktop_login_poll",
        "POST",
        "/api/auth/desktop-login/sessions",
        # 单个客户端每两秒轮询一次，五分钟约 150 次。共享 IP 门禁需容纳
        # 办公室、宿舍与运营商 NAT；单会话的两秒节流由业务服务继续执行。
        1200,
        5 * 60,
    ),
    RatePolicy("account_export", "POST", "/api/account/data-export", 5, 15 * 60, "user"),
    RatePolicy("account_delete_prepare", "POST", "/api/account/deletion/prepare", 5, 15 * 60, "user"),
    RatePolicy("account_delete_confirm", "POST", "/api/account/deletion/confirm", 5, 60 * 60, "user"),
    RatePolicy("agent_generate", "POST", "/api/agent/threads/", 30, 60 * 60, "user"),
    RatePolicy("douyin_sync", "POST", "/api/library/douyin/collect", 6, 60 * 60, "user"),
    RatePolicy("creator_sync", "POST", "/api/creator-sources/", 12, 60 * 60, "user"),
)


class SlidingWindowLimiter:
    def __init__(self) -> None:
        self._events: dict[tuple[str, str], Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_sweep = 0.0

    def check(self, policy: RatePolicy, key: str, now: float | None = None) -> tuple[bool, int]:
        current = time.monotonic() if now is None else now
        cutoff = current - policy.window_seconds
        bucket_key = (policy.name, key[:160])
        with self._lock:
            events = self._events[bucket_key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= policy.limit:
                retry_after = max(1, math.ceil(events[0] + policy.window_seconds - current))
                return False, retry_after
            events.append(current)
            if current - self._last_sweep >= 300:
                self._sweep(current)
            return True, 0

    def _sweep(self, now: float) -> None:
        self._last_sweep = now
        longest_window = max(policy.window_seconds for policy in POLICIES)
        cutoff = now - longest_window
        for key, events in list(self._events.items()):
            while events and events[0] <= cutoff:
                events.popleft()
            if not events:
                self._events.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
            self._last_sweep = 0.0


limiter = SlidingWindowLimiter()


def _trusted_proxy_ips() -> set[str]:
    return {
        value.strip()
        for value in settings.TRUSTED_PROXY_IPS.split(",")
        if value.strip()
    }


def _safe_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    candidate = peer
    if peer in _trusted_proxy_ips():
        candidate = request.headers.get("x-real-ip", "").strip() or peer
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return "unknown"


def _user_id(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return ""
    payload = auth_service.decode_access_token(auth_header[7:].strip())
    return str((payload or {}).get("sub") or "")[:64]


async def _account_key(request: Request) -> str:
    if request.url.path not in {"/api/auth/login", "/api/auth/register"}:
        return ""
    try:
        length = int(request.headers.get("content-length", "0") or 0)
        if length <= 0 or length > 8192:
            return ""
        payload = json.loads((await request.body()).decode("utf-8"))
        if not isinstance(payload, dict):
            return ""
        value = str(payload.get("email") or payload.get("username") or "").strip().lower()
        if not value or len(value) > 320:
            return ""
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    except (UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
        return ""


def _matches(policy: RatePolicy, request: Request) -> bool:
    if request.method.upper() != policy.method:
        return False
    path = request.url.path
    if policy.name == "desktop_login_create":
        return path == policy.path_prefix
    if policy.name == "desktop_login_approval":
        return path.endswith(("/preview", "/decision")) and path.startswith(
            policy.path_prefix + "/"
        )
    if policy.name == "desktop_login_poll":
        return path.endswith(("/token", "/cancel")) and path.startswith(
            policy.path_prefix + "/"
        )
    if policy.name == "agent_generate":
        return path.startswith(policy.path_prefix) and path.endswith(("/messages", "/messages/stream"))
    if policy.name == "creator_sync":
        return path.startswith(policy.path_prefix) and path.endswith("/runs")
    return path == policy.path_prefix or path.startswith(policy.path_prefix + "/")


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if not settings.RATE_LIMIT_ENABLED:
            return await call_next(request)
        for policy in POLICIES:
            if not _matches(policy, request):
                continue
            ip = _safe_ip(request)
            user_id = _user_id(request)
            if policy.principal == "user" and user_id:
                # 账号额度必须只由稳定的用户主体决定，不能通过更换出口 IP
                # 重置；同时叠加一个更宽松的 IP 总量门禁，限制同一出口的
                # 自动化滥用而不影响正常移动网络切换。
                principal = f"user:{user_id}"
            else:
                principal = f"ip:{ip}"
            allowed, retry_after = limiter.check(policy, principal)
            if allowed and policy.principal == "user" and user_id:
                ip_policy = RatePolicy(
                    f"{policy.name}_ip",
                    policy.method,
                    policy.path_prefix,
                    max(policy.limit * 4, policy.limit + 10),
                    policy.window_seconds,
                    "ip",
                )
                allowed, retry_after = limiter.check(ip_policy, f"ip:{ip}")
            account_key = await _account_key(request)
            if allowed and account_key:
                account_policy = RatePolicy(
                    f"{policy.name}_account",
                    policy.method,
                    policy.path_prefix,
                    max(3, policy.limit // 2),
                    policy.window_seconds,
                    "account",
                )
                allowed, retry_after = limiter.check(account_policy, f"account:{account_key}")
            if allowed:
                continue
            # Import lazily so the limiter remains usable during early app
            # imports and unit tests without creating a service cycle.
            from app.services import error_log_service

            error_log_service.record_error_safely(
                source="http",
                severity="warning",
                error_type="RateLimitExceeded",
                message="请求频率超过安全策略",
                method=request.method,
                path=request.url.path,
                status_code=429,
                user_id=user_id or None,
                ip=ip,
                metadata={"operation": policy.name},
            )
            return JSONResponse(
                status_code=429,
                headers={
                    "Retry-After": str(retry_after),
                    "Cache-Control": "no-store",
                },
                content={
                    "success": False,
                    "data": None,
                    "error": "操作过于频繁，请稍后再试",
                    "retry_after": retry_after,
                },
            )
        return await call_next(request)
