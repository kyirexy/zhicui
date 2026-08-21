"""OmniRoute 工作台的只读、安全且可缓存的数据适配层。"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from typing import Any

import requests
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services import settings_service
from app.services.user_ai_provider_service import omniroute_config


_CACHE_TTL_SECONDS = 60
_CACHE: tuple[float, dict[str, Any]] | None = None
_CACHE_LOCK = Lock()


def _management_base(api_base: str) -> str:
    base = api_base.strip().rstrip("/")
    return base[:-3] if base.endswith("/v1") else base


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
    }


def _fetch_json(base: str, path: str, api_key: str) -> dict[str, Any]:
    response = requests.get(
        f"{base}{path}",
        headers=_headers(api_key),
        timeout=(2.5, 8),
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("OmniRoute 返回了无效响应")
    return payload


def _number(value: Any) -> int | float:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def _model_free_hint(model: dict[str, Any]) -> bool:
    model_id = str(model.get("id") or "").lower()
    return bool(
        model.get("free") is True
        or model_id.endswith(":free")
        or "/free/" in model_id
        or model_id.startswith(("oc/", "felo/", "pollinations/"))
    )


def _normalize_catalog(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("data")
    if not isinstance(rows, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        model_id = str(raw.get("id") or "").strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        capabilities = raw.get("capabilities")
        if isinstance(capabilities, dict):
            capability_names = [str(key) for key, enabled in capabilities.items() if enabled]
        elif isinstance(capabilities, list):
            capability_names = [str(item) for item in capabilities[:12]]
        else:
            capability_names = []
        provider = str(raw.get("owned_by") or model_id.split("/", 1)[0] or "unknown")
        result.append({
            "id": model_id,
            "name": str(raw.get("name") or raw.get("root") or model_id),
            "provider": provider,
            "available": True,
            "free": _model_free_hint(raw),
            "free_type": "",
            "monthly_tokens": 0,
            "credit_tokens": 0,
            "context_length": int(_number(raw.get("context_length"))),
            "capabilities": capability_names,
        })
        if len(result) >= 900:
            break
    return result


def _merge_free_models(
    models: list[dict[str, Any]],
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    rows = payload.get("models")
    if not isinstance(rows, list):
        return models
    by_id = {str(model["id"]).lower(): model for model in models}
    for raw in rows[:900]:
        if not isinstance(raw, dict):
            continue
        provider = str(raw.get("provider") or "unknown").strip()
        model_id = str(raw.get("modelId") or "").strip()
        if not model_id:
            continue
        candidates = [model_id.lower(), f"{provider}/{model_id}".lower()]
        matched = next((by_id[key] for key in candidates if key in by_id), None)
        if matched is None:
            matched = next(
                (
                    model
                    for key, model in by_id.items()
                    if key.endswith(f"/{model_id.lower()}")
                    and str(model.get("provider", "")).lower() == provider.lower()
                ),
                None,
            )
        if matched is None:
            canonical_id = f"{provider}/{model_id}" if provider != "unknown" else model_id
            matched = {
                "id": canonical_id,
                "name": str(raw.get("displayName") or model_id),
                "provider": provider,
                "available": False,
                "free": True,
                "free_type": "",
                "monthly_tokens": 0,
                "credit_tokens": 0,
                "context_length": 0,
                "capabilities": [],
            }
            models.append(matched)
            by_id[canonical_id.lower()] = matched
        matched["free"] = True
        matched["free_type"] = str(raw.get("freeType") or "")
        matched["monthly_tokens"] = _number(raw.get("monthlyTokens"))
        matched["credit_tokens"] = _number(raw.get("creditTokens"))
        matched["tos"] = str(raw.get("tos") or "")
    return models[:1200]


def _normalize_routes(payload: dict[str, Any], model_ids: set[str]) -> list[dict[str, Any]]:
    rows = payload.get("combos")
    result: list[dict[str, Any]] = []
    if isinstance(rows, list):
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            route_id = str(raw.get("id") or "").strip()
            if not route_id or not route_id.startswith("auto"):
                continue
            result.append({
                "id": route_id,
                "name": str(raw.get("name") or route_id),
                "candidate_count": int(_number(raw.get("candidateCount"))),
                "context_length": int(_number(raw.get("context_length"))),
                "available": True,
            })
            if len(result) >= 120:
                break
    if result:
        return result

    fallback = [
        ("auto", "自动平衡"),
        ("auto/best-free", "免费优先"),
        ("auto/fast", "速度优先"),
        ("auto/smart", "质量探索"),
        ("auto/offline", "稳定优先"),
        ("auto/coding:free", "免费代码模型"),
        ("auto/reasoning:free", "免费推理模型"),
    ]
    return [
        {
            "id": route_id,
            "name": name,
            "candidate_count": 0,
            "context_length": 0,
            "available": route_id in model_ids,
        }
        for route_id, name in fallback
    ]


def _normalize_rankings(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("rankings")
    if not isinstance(rows, list):
        return []
    result: list[dict[str, Any]] = []
    for raw in rows[:36]:
        if not isinstance(raw, dict):
            continue
        top = raw.get("topModel") if isinstance(raw.get("topModel"), dict) else {}
        result.append({
            "id": str(raw.get("id") or ""),
            "name": str(raw.get("name") or raw.get("id") or "未知供应商"),
            "category": str(raw.get("category") or ""),
            "model_count": int(_number(raw.get("modelCount"))),
            "score": round(float(_number(raw.get("averageScore"))), 1),
            "top_model_id": str(top.get("modelId") or ""),
            "top_model_name": str(top.get("modelName") or ""),
        })
    return result


def _normalize_summary(payload: dict[str, Any]) -> dict[str, Any]:
    no_credential = payload.get("noCredentialProviders")
    return {
        "steady_tokens": _number(payload.get("steadyRecurringTokens")),
        "first_month_tokens": _number(payload.get("firstMonthTokens")),
        "used_this_month": _number(payload.get("usedThisMonth")),
        "remaining": _number(payload.get("remaining")),
        "provider_pools": int(_number(payload.get("providerPoolCount"))),
        "model_count": int(_number(payload.get("modelCount"))),
        "catalog_updated_at": str(payload.get("catalogUpdatedAt") or ""),
        "no_credential_providers": (
            [str(item) for item in no_credential[:100]]
            if isinstance(no_credential, list)
            else []
        ),
    }


def _empty_workspace(*, configured: bool, message: str) -> dict[str, Any]:
    return {
        "status": {
            "configured": configured,
            "online": False,
            "partial": False,
            "latency_ms": 0,
            "message": message,
        },
        "models": [],
        "routes": [],
        "rankings": [],
        "summary": _normalize_summary({}),
        "sections": {
            "models": False,
            "free_models": False,
            "free_summary": False,
            "rankings": False,
            "routes": False,
        },
    }


def _build_workspace(db: Session | None = None) -> dict[str, Any]:
    config = omniroute_config(db)
    if not config["available"]:
        return _empty_workspace(
            configured=False,
            message="OmniRoute 尚未由管理员启用",
        )

    api_base = str(config["api_base"])
    management_base = _management_base(api_base)
    api_key = str(config["api_key"])
    jobs = {
        "health": (management_base, "/api/health/ping"),
        "models": (api_base, "/models"),
        "free_models": (management_base, "/api/free-models"),
        "free_summary": (management_base, "/api/free-tier/summary"),
        "rankings": (management_base, "/api/free-provider-rankings?limit=36"),
        "routes": (management_base, "/api/combos/auto"),
    }
    payloads: dict[str, dict[str, Any]] = {}
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(jobs)) as executor:
        pending = {
            executor.submit(_fetch_json, base, path, api_key): name
            for name, (base, path) in jobs.items()
        }
        for future in as_completed(pending):
            name = pending[future]
            try:
                payloads[name] = future.result()
            except (requests.RequestException, ValueError, TypeError):
                continue

    health = payloads.get("health", {})
    online = health.get("status") == "ok" or "models" in payloads
    models = _normalize_catalog(payloads.get("models", {}))
    models = _merge_free_models(models, payloads.get("free_models", {}))
    model_ids = {str(model["id"]) for model in models if model.get("available")}
    routes = _normalize_routes(payloads.get("routes", {}), model_ids)
    sections = {key: key in payloads for key in jobs if key != "health"}
    partial = online and not all(sections.values())
    return {
        "status": {
            "configured": True,
            "online": online,
            "partial": partial,
            "latency_ms": int((time.monotonic() - started) * 1000),
            "message": (
                "网关在线，部分目录暂时不可用"
                if partial
                else "网关在线"
                if online
                else "网关暂时无法连接"
            ),
        },
        "models": models,
        "routes": routes,
        "rankings": _normalize_rankings(payloads.get("rankings", {})),
        "summary": _normalize_summary(payloads.get("free_summary", {})),
        "sections": sections,
    }


def get_workspace(
    *,
    refresh: bool = False,
    include_admin: bool = False,
    db: Session | None = None,
) -> dict[str, Any]:
    global _CACHE
    now = time.monotonic()
    with _CACHE_LOCK:
        if not refresh and _CACHE and _CACHE[0] > now:
            workspace = dict(_CACHE[1])
        else:
            workspace = _build_workspace(db)
            _CACHE = (now + _CACHE_TTL_SECONDS, workspace)

    result = dict(workspace)
    if include_admin:
        dashboard = (db and settings_service.get_setting(db, "omniroute_dashboard_url")) or settings.OMNIROUTE_DASHBOARD_URL
        result["advanced_console_url"] = (dashboard or "").strip()
    else:
        result["advanced_console_url"] = ""
    return result


def clear_cache() -> None:
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None
