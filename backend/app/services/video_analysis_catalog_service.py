"""Managed provider/offering catalog and independent visual BYOK support."""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.system_setting import SystemSetting
from app.models.video_analysis import (
    UserVisionProviderConfig,
    VideoAnalysisItem,
    VideoAnalysisOffering,
    VideoAnalysisOfferingVersion,
    VisionProvider,
)
from app.services import settings_service


FEATURE_ENABLED_KEY = "video_analysis_enabled"
QUOTE_TTL_SECONDS_KEY = "video_analysis_quote_ttl"
GLOBAL_CONCURRENCY_KEY = "video_analysis_concurrency"
AGENT_CANDIDATE_LIMIT_KEY = "video_analysis_agent_candidates"
USER_DAILY_POINTS_LIMIT_KEY = "video_analysis_user_daily_points_limit"
RUN_POINTS_LIMIT_KEY = "video_analysis_run_points_limit"
SCENE_CONCURRENCY_KEY = "video_analysis_scene_concurrency"
VISION_CONCURRENCY_KEY = "video_analysis_vision_concurrency"
RETRY_COUNT_KEY = "video_analysis_retry_count"
STALE_RUN_MINUTES_KEY = "video_analysis_stale_run_minutes"
TEMPORARY_FILE_TTL_MINUTES_KEY = "video_analysis_temporary_file_ttl_minutes"
RECOMMENDED_OFFERING_ID_KEY = "video_analysis_recommended_offering_id"
PROVIDER_FAILURE_THRESHOLD_KEY = "video_analysis_provider_failure_threshold"
PROVIDER_COOLDOWN_MINUTES_KEY = "video_analysis_provider_cooldown_minutes"

ALLOWED_DRIVERS = {
    "local_scene",
    "openai_compatible",
    "litellm_image",
    "omniroute_image",
    "native_video",
}
BYOK_DRIVERS = {"openai_compatible", "litellm_image"}
ALLOWED_METHODS = {"local_scene", "scene_frames_vlm", "native_video"}
ALLOWED_TRIGGERS = {"manual", "batch", "agent"}
ALLOWED_BILLING_UNITS = {"run", "minute"}
ALLOWED_QUOTA_PERIODS = {"day", "month", "lifetime"}
ALLOWED_QUOTA_UNITS = {"run", "minute"}
ALLOWED_COST_CLASSES = {"no_cost", "metered", "unknown"}

DEFAULT_LIMITS = {
    "max_duration_seconds": 7200,
    "max_frames": 8,
    "max_provider_calls": 1,
    "timeout_seconds": 180,
    # 0 表示仅受服务端全局下载上限约束；Provider 可声明更严格的上限。
    "max_file_bytes": 0,
}
DEFAULT_PRICING = {
    "billing_unit": "run",
    "points_per_unit": 0,
    "minimum_points": 0,
    "base_points": 0,
    "per_minute_points": 0,
    "per_frame_points": 0,
    "per_media_unit_points": 0,
    "min_points": 0,
    "max_points": 0,
    "byok_processing_points": 0,
    "billing_increment_seconds": 60,
}
DEFAULT_FREE_QUOTA: dict[str, Any] = {}
DEFAULT_FALLBACK = {"mode": "reject"}

_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")

# One real 1x1 PNG, used only inside provider capability tests.  It is never
# returned, logged, or persisted.
_TEST_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2"
    "mQAAAABJRU5ErkJggg=="
)


class VideoAnalysisCatalogError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _json(value: Any, *, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed if isinstance(parsed, type(default)) else default


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _clean_dict(value: Any, *, maximum_keys: int = 32) -> dict[str, Any]:
    parsed = _json(value, default={})
    if not isinstance(parsed, dict):
        return {}
    result: dict[str, Any] = {}
    for raw_key, raw_value in list(parsed.items())[:maximum_keys]:
        key = str(raw_key or "").strip()[:64]
        if not key or isinstance(raw_value, (bytes, bytearray)):
            continue
        if isinstance(raw_value, str):
            result[key] = raw_value.strip()[:512]
        elif isinstance(raw_value, (bool, int, float)) or raw_value is None:
            result[key] = raw_value
        elif isinstance(raw_value, list):
            result[key] = [
                item if isinstance(item, (bool, int, float)) else str(item)[:128]
                for item in raw_value[:32]
            ]
        elif isinstance(raw_value, dict):
            result[key] = _clean_dict(raw_value, maximum_keys=16)
    return result


def _normalize_limits(value: Any) -> dict[str, int]:
    supplied = _clean_dict(value)
    raw = {**DEFAULT_LIMITS, **supplied}
    raw_provider_calls = (
        supplied["max_provider_calls"]
        if "max_provider_calls" in supplied
        else supplied.get("max_model_calls", DEFAULT_LIMITS["max_provider_calls"])
    )
    max_provider_calls = _bounded_int(
        raw_provider_calls, 1, 0, 32
    )
    return {
        "max_duration_seconds": _bounded_int(
            raw.get("max_duration_seconds"), 7200, 30, 43200
        ),
        "max_frames": _bounded_int(raw.get("max_frames"), 8, 1, 64),
        "max_provider_calls": max_provider_calls,
        "max_model_calls": max_provider_calls,
        "timeout_seconds": _bounded_int(raw.get("timeout_seconds"), 180, 10, 1800),
        "max_file_bytes": _bounded_int(
            raw.get("max_file_bytes"), 0, 0, 10_000_000_000_000
        ),
    }


def effective_limits(
    offering_limits: Any,
    provider: VisionProvider | None = None,
) -> dict[str, int]:
    """Provider 技术上限与 Offering 权益上限逐项取更严格值。"""
    result = _normalize_limits(offering_limits)
    if provider is None:
        return result
    raw = provider.limits
    provider_values = {
        "max_duration_seconds": raw.get("max_duration_seconds"),
        "max_frames": raw.get("max_frames") or raw.get("max_images"),
        "max_provider_calls": raw.get("max_provider_calls")
        or raw.get("max_model_calls")
        or raw.get("max_calls"),
        "timeout_seconds": raw.get("timeout_seconds"),
        "max_file_bytes": raw.get("max_file_bytes"),
    }
    for key, value in provider_values.items():
        try:
            parsed = int(value or 0)
        except (TypeError, ValueError):
            parsed = 0
        if parsed > 0:
            if key == "max_file_bytes" and int(result[key] or 0) <= 0:
                result[key] = parsed
            else:
                result[key] = min(result[key], parsed)
    result["max_model_calls"] = result["max_provider_calls"]
    return result


def _normalize_pricing(value: Any) -> dict[str, Any]:
    supplied = _clean_dict(value)
    raw = {**DEFAULT_PRICING, **supplied}
    billing_unit = str(raw.get("billing_unit") or "run").strip()
    if billing_unit not in ALLOWED_BILLING_UNITS:
        raise VideoAnalysisCatalogError("invalid_billing_unit", "计费单位无效")
    legacy_points = _bounded_int(raw.get("points_per_unit"), 0, 0, 1_000_000_000)
    base_points = _bounded_int(raw.get("base_points"), 0, 0, 1_000_000_000)
    per_minute_points = _bounded_int(
        raw.get("per_minute_points"), 0, 0, 1_000_000_000
    )
    if "base_points" not in supplied and "per_minute_points" not in supplied:
        if billing_unit == "run":
            base_points = legacy_points
        else:
            per_minute_points = legacy_points
    minimum_points = _bounded_int(
        raw.get("minimum_points"), 0, 0, 1_000_000_000
    )
    min_points = _bounded_int(raw.get("min_points"), 0, 0, 1_000_000_000)
    if "min_points" not in supplied:
        min_points = minimum_points
    max_points = _bounded_int(raw.get("max_points"), 0, 0, 1_000_000_000)
    if max_points and max_points < min_points:
        raise VideoAnalysisCatalogError(
            "invalid_price_bounds", "max_points 不能小于 min_points"
        )
    return {
        "billing_unit": billing_unit,
        "points_per_unit": legacy_points,
        "minimum_points": minimum_points,
        "base_points": base_points,
        "per_minute_points": per_minute_points,
        "per_frame_points": _bounded_int(
            raw.get("per_frame_points"), 0, 0, 1_000_000_000
        ),
        "per_media_unit_points": _bounded_int(
            raw.get("per_media_unit_points"), 0, 0, 1_000_000_000
        ),
        "min_points": min_points,
        "max_points": max_points,
        "byok_processing_points": _bounded_int(
            raw.get("byok_processing_points"), 0, 0, 1_000_000_000
        ),
        "billing_increment_seconds": _bounded_int(
            raw.get("billing_increment_seconds"), 60, 1, 3600
        ),
    }


def pricing_max_points(
    pricing: Any,
    limits: Any,
    *,
    use_byok: bool = False,
) -> int:
    """计算单个 Item 在确认阶段可授权的服务端最高萃点。"""
    price = _normalize_pricing(pricing)
    normalized_limits = _normalize_limits(limits)
    duration_units = max(
        1,
        (
            normalized_limits["max_duration_seconds"]
            + price["billing_increment_seconds"]
            - 1
        )
        // price["billing_increment_seconds"],
    )
    base = price["byok_processing_points"] if use_byok else price["base_points"]
    points = (
        base
        + duration_units * price["per_minute_points"]
        + normalized_limits["max_frames"] * price["per_frame_points"]
        + normalized_limits["max_provider_calls"]
        * price["per_media_unit_points"]
    )
    points = max(points, price["min_points"])
    if price["max_points"] > 0:
        points = min(points, price["max_points"])
    return max(0, int(points))


def pricing_is_free(pricing: Any, limits: Any) -> bool:
    return pricing_max_points(pricing, limits) == 0


def _normalize_free_quota(value: Any, offering_code: str) -> dict[str, Any]:
    raw = _clean_dict(value)
    if not raw:
        return {}
    period = str(raw.get("period") or "month").strip()
    unit = str(raw.get("unit") or "run").strip()
    if period not in ALLOWED_QUOTA_PERIODS or unit not in ALLOWED_QUOTA_UNITS:
        raise VideoAnalysisCatalogError("invalid_free_quota", "免费额度周期或单位无效")
    units = _bounded_int(raw.get("units"), 0, 0, 1_000_000_000)
    if units <= 0:
        return {}
    scope = str(raw.get("scope") or offering_code).strip()[:64]
    return {
        "scope": scope or offering_code,
        "period": period,
        "unit": unit,
        "units": units,
        "timezone": "Asia/Shanghai",
    }


def _normalize_fallback(value: Any) -> dict[str, Any]:
    raw = _clean_dict(value)
    mode = str(raw.get("mode") or "reject").strip()
    if mode not in {"reject", "local_scene"}:
        raise VideoAnalysisCatalogError("invalid_fallback", "降级策略无效")
    return {"mode": mode}


def _normalize_triggers(value: Any) -> list[str]:
    parsed = _json(value, default=[])
    triggers = list(dict.fromkeys(
        str(item).strip() for item in parsed if str(item).strip() in ALLOWED_TRIGGERS
    ))
    if not triggers:
        triggers = ["manual"]
    return triggers


def _validate_api_base(value: str, *, required: bool) -> str:
    clean = str(value or "").strip().rstrip("/")[:512]
    if not clean and not required:
        return ""
    parsed = urlparse(clean)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise VideoAnalysisCatalogError("invalid_api_base", "请输入有效的 API Base")
    return clean


def _validate_public_user_api_base(value: str) -> str:
    """Reject BYOK endpoints that could make the server call an internal host."""
    clean = _validate_api_base(value, required=True)
    parsed = urlparse(clean)
    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname or hostname == "localhost" or hostname.endswith((".localhost", ".local")):
        raise VideoAnalysisCatalogError(
            "unsafe_byok_api_base", "视觉模型 API Base 必须是公网 HTTPS 地址"
        )
    if parsed.scheme != "https":
        raise VideoAnalysisCatalogError(
            "unsafe_byok_api_base", "视觉模型 API Base 必须使用 HTTPS"
        )
    try:
        addresses = {
            str(row[4][0]).split("%", 1)[0]
            for row in socket.getaddrinfo(
                hostname,
                parsed.port or 443,
                type=socket.SOCK_STREAM,
            )
            if row and len(row) > 4 and row[4]
        }
    except OSError as exc:
        raise VideoAnalysisCatalogError(
            "byok_api_base_unresolved", "视觉模型 API Base 暂时无法解析"
        ) from exc
    if not addresses:
        raise VideoAnalysisCatalogError(
            "byok_api_base_unresolved", "视觉模型 API Base 暂时无法解析"
        )
    try:
        unsafe = any(not ipaddress.ip_address(address).is_global for address in addresses)
    except ValueError as exc:
        raise VideoAnalysisCatalogError(
            "unsafe_byok_api_base", "视觉模型 API Base 地址无效"
        ) from exc
    if unsafe:
        raise VideoAnalysisCatalogError(
            "unsafe_byok_api_base", "视觉模型 API Base 不能指向本机或内网"
        )
    return clean


def _require_secret_encryption() -> None:
    if not str(getattr(settings, "ENCRYPTION_KEY", "") or "").strip():
        raise VideoAnalysisCatalogError(
            "encryption_key_required",
            "保存视觉模型密钥前必须先配置 ENCRYPTION_KEY",
            status_code=409,
        )


def _feature_default() -> bool:
    return bool(getattr(settings, "VIDEO_ANALYSIS_ENABLED", False))


def get_runtime_settings(db: Session) -> dict[str, Any]:
    raw_enabled = settings_service.get_setting(
        db,
        FEATURE_ENABLED_KEY,
        "true" if _feature_default() else "false",
    )
    scene_concurrency = _bounded_int(
        settings_service.get_setting(db, SCENE_CONCURRENCY_KEY, "1"), 1, 1, 4
    )
    vision_concurrency = _bounded_int(
        settings_service.get_setting(db, VISION_CONCURRENCY_KEY, "1"), 1, 1, 4
    )
    agent_max_candidates = _bounded_int(
        settings_service.get_setting(db, AGENT_CANDIDATE_LIMIT_KEY, "3"), 3, 1, 10
    )
    recommended_offering_id = str(
        settings_service.get_setting(db, RECOMMENDED_OFFERING_ID_KEY, "") or ""
    ).strip()
    return {
        "enabled": str(raw_enabled).strip().lower() in {"1", "true", "yes", "on"},
        "quote_ttl_seconds": _bounded_int(
            settings_service.get_setting(db, QUOTE_TTL_SECONDS_KEY, "300"),
            300,
            60,
            1800,
        ),
        "global_concurrency": _bounded_int(
            settings_service.get_setting(
                db, GLOBAL_CONCURRENCY_KEY, str(max(scene_concurrency, vision_concurrency))
            ),
            max(scene_concurrency, vision_concurrency),
            1,
            4,
        ),
        "scene_concurrency": scene_concurrency,
        "vision_concurrency": vision_concurrency,
        "agent_candidate_limit": agent_max_candidates,
        "agent_max_candidates": agent_max_candidates,
        "user_daily_points_limit": _bounded_int(
            settings_service.get_setting(db, USER_DAILY_POINTS_LIMIT_KEY, "0"),
            0,
            0,
            1_000_000_000,
        ),
        "run_points_limit": _bounded_int(
            settings_service.get_setting(db, RUN_POINTS_LIMIT_KEY, "0"),
            0,
            0,
            1_000_000_000,
        ),
        "retry_count": _bounded_int(
            settings_service.get_setting(db, RETRY_COUNT_KEY, "2"), 2, 0, 5
        ),
        "stale_run_minutes": _bounded_int(
            settings_service.get_setting(db, STALE_RUN_MINUTES_KEY, "30"),
            30,
            5,
            1440,
        ),
        "temporary_file_ttl_minutes": _bounded_int(
            settings_service.get_setting(
                db, TEMPORARY_FILE_TTL_MINUTES_KEY, "60"
            ),
            60,
            5,
            1440,
        ),
        "recommended_offering_id": recommended_offering_id or None,
        "provider_failure_threshold": _bounded_int(
            settings_service.get_setting(db, PROVIDER_FAILURE_THRESHOLD_KEY, "3"),
            3,
            1,
            20,
        ),
        "provider_cooldown_minutes": _bounded_int(
            settings_service.get_setting(db, PROVIDER_COOLDOWN_MINUTES_KEY, "15"),
            15,
            1,
            1440,
        ),
    }


def save_runtime_settings(
    db: Session,
    *,
    enabled: bool | None = None,
    quote_ttl_seconds: int | None = None,
    global_concurrency: int | None = None,
    agent_candidate_limit: int | None = None,
    agent_max_candidates: int | None = None,
    user_daily_points_limit: int | None = None,
    run_points_limit: int | None = None,
    scene_concurrency: int | None = None,
    vision_concurrency: int | None = None,
    retry_count: int | None = None,
    stale_run_minutes: int | None = None,
    temporary_file_ttl_minutes: int | None = None,
    recommended_offering_id: str | None = None,
    provider_failure_threshold: int | None = None,
    provider_cooldown_minutes: int | None = None,
) -> dict[str, Any]:
    values: dict[str, str] = {}
    if enabled is not None:
        values[FEATURE_ENABLED_KEY] = "true" if enabled else "false"
    if quote_ttl_seconds is not None:
        values[QUOTE_TTL_SECONDS_KEY] = str(
            _bounded_int(quote_ttl_seconds, 300, 60, 1800)
        )
    if global_concurrency is not None:
        values[GLOBAL_CONCURRENCY_KEY] = str(
            _bounded_int(global_concurrency, 1, 1, 4)
        )
    candidate_limit = (
        agent_max_candidates
        if agent_max_candidates is not None
        else agent_candidate_limit
    )
    if candidate_limit is not None:
        values[AGENT_CANDIDATE_LIMIT_KEY] = str(
            _bounded_int(candidate_limit, 3, 1, 10)
        )
    bounded_fields = (
        (USER_DAILY_POINTS_LIMIT_KEY, user_daily_points_limit, 0, 0, 1_000_000_000),
        (RUN_POINTS_LIMIT_KEY, run_points_limit, 0, 0, 1_000_000_000),
        (SCENE_CONCURRENCY_KEY, scene_concurrency, 1, 1, 4),
        (VISION_CONCURRENCY_KEY, vision_concurrency, 1, 1, 4),
        (RETRY_COUNT_KEY, retry_count, 2, 0, 5),
        (STALE_RUN_MINUTES_KEY, stale_run_minutes, 30, 5, 1440),
        (
            TEMPORARY_FILE_TTL_MINUTES_KEY,
            temporary_file_ttl_minutes,
            60,
            5,
            1440,
        ),
        (
            PROVIDER_FAILURE_THRESHOLD_KEY,
            provider_failure_threshold,
            3,
            1,
            20,
        ),
        (
            PROVIDER_COOLDOWN_MINUTES_KEY,
            provider_cooldown_minutes,
            15,
            1,
            1440,
        ),
    )
    for key, raw_value, default, minimum, maximum in bounded_fields:
        if raw_value is not None:
            values[key] = str(_bounded_int(raw_value, default, minimum, maximum))
    if recommended_offering_id is not None:
        clean_recommended = str(recommended_offering_id or "").strip()
        if clean_recommended and get_offering(db, clean_recommended) is None:
            raise VideoAnalysisCatalogError(
                "offering_not_found", "推荐解析方案不存在", status_code=404
            )
        values[RECOMMENDED_OFFERING_ID_KEY] = clean_recommended
    for key, value in values.items():
        row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
        if row is None:
            db.add(SystemSetting(key=key, value=value))
        else:
            row.value = value
    db.commit()
    return get_runtime_settings(db)


def _provider_cost_upper_bound_micros(
    provider: VisionProvider | None,
    limits: Mapping[str, Any] | dict[str, Any],
) -> int | None:
    """返回一次 Item 的保守成本上界；无法界定时返回 ``None``。"""
    if provider is None or provider.driver == "local_scene":
        return 0
    cost = provider.cost
    cost_class = str(cost.get("cost_class") or "unknown").strip().lower()
    if cost_class == "no_cost":
        return 0
    if cost_class != "metered":
        return None

    normalized = _normalize_limits(limits)
    max_calls = max(1, int(normalized["max_provider_calls"]))
    max_frames = max(1, int(normalized["max_frames"]))
    raw_limits = {**provider.limits, **_clean_dict(limits)}
    max_input_tokens = _bounded_int(
        raw_limits.get("max_input_tokens_per_call"), 0, 0, 100_000_000
    )
    max_output_tokens = _bounded_int(
        raw_limits.get("max_output_tokens_per_call"), 0, 0, 100_000_000
    )
    max_tokens = _bounded_int(
        raw_limits.get("max_tokens_per_call"),
        max_input_tokens + max_output_tokens,
        0,
        100_000_000,
    )
    max_request_cost = _bounded_int(
        cost.get("max_request_cost_micros") or cost.get("max_call_cost_micros"),
        0,
        0,
        10_000_000_000_000,
    )

    metering = provider.metering
    unit = str(metering.get("unit") or "call").strip().lower()
    per_unit = _bounded_int(
        cost.get("micros_per_unit"), 0, 0, 10_000_000_000_000
    )
    generic_total = 0
    if per_unit:
        if unit in {"image", "images", "frame", "frames"}:
            quantity = max_frames
        elif unit in {"call", "calls", "request", "requests", "media", "video"}:
            quantity = max_calls
        elif unit in {"token", "tokens"}:
            if max_tokens <= 0:
                return max_calls * max_request_cost if max_request_cost else None
            quantity = max_calls * max_tokens
        elif unit in {"1k_token", "1k_tokens", "thousand_tokens"}:
            if max_tokens <= 0:
                return max_calls * max_request_cost if max_request_cost else None
            quantity = max_calls * ((max_tokens + 999) // 1000)
        else:
            return max_calls * max_request_cost if max_request_cost else None
        generic_total = quantity * per_unit

    per_call = _bounded_int(
        cost.get("per_call_micros") or cost.get("per_request_micros"),
        0,
        0,
        10_000_000_000_000,
    )
    per_image = _bounded_int(
        cost.get("per_image_micros"), 0, 0, 10_000_000_000_000
    )
    per_provider_unit = _bounded_int(
        cost.get("per_provider_unit_micros") or cost.get("per_media_unit_micros"),
        0,
        0,
        10_000_000_000_000,
    )
    per_input_1k = _bounded_int(
        cost.get("per_1k_input_tokens_micros"), 0, 0, 10_000_000_000_000
    )
    per_output_1k = _bounded_int(
        cost.get("per_1k_output_tokens_micros"), 0, 0, 10_000_000_000_000
    )
    per_total_1k = _bounded_int(
        cost.get("per_1k_tokens_micros"), 0, 0, 10_000_000_000_000
    )
    if (per_input_1k and max_input_tokens <= 0) or (
        per_output_1k and max_output_tokens <= 0
    ) or (per_total_1k and max_tokens <= 0):
        return max_calls * max_request_cost if max_request_cost else None

    detailed_total = (
        max_calls * per_call
        + max_frames * per_image
        + max_calls * per_provider_unit
        + max_calls * ((max_input_tokens + 999) // 1000) * per_input_1k
        + max_calls * ((max_output_tokens + 999) // 1000) * per_output_1k
    )
    if not per_input_1k and not per_output_1k:
        detailed_total += (
            max_calls * ((max_tokens + 999) // 1000) * per_total_1k
        )
    total = max(generic_total + detailed_total, max_calls * max_request_cost)
    return total if total > 0 else None


def _provider_cost_known(
    provider: VisionProvider | None,
    limits: Mapping[str, Any] | dict[str, Any] | None = None,
) -> bool:
    if provider is None:
        return True
    return _provider_cost_upper_bound_micros(
        provider, limits or provider.limits or DEFAULT_LIMITS
    ) is not None


def estimate_provider_cost_micros(
    provider: VisionProvider | None,
    limits: Mapping[str, Any] | dict[str, Any],
) -> int:
    upper_bound = _provider_cost_upper_bound_micros(provider, limits)
    return max(0, int(upper_bound or 0))


def serialize_provider(provider: VisionProvider) -> dict[str, Any]:
    decrypted = settings_service.decrypt_value(provider.encrypted_api_key)
    capabilities = provider.capabilities
    metering = provider.metering
    limits = provider.limits
    cost = provider.cost
    return {
        "id": provider.id,
        "code": provider.code,
        "name": provider.name,
        "driver": provider.driver,
        "default_model": provider.default_model,
        "model": provider.default_model,
        "api_base": provider.api_base,
        "api_key_set": bool(decrypted and not decrypted.startswith("ENC:")),
        "api_key_masked": settings_service.mask_key(decrypted),
        "enabled": bool(provider.enabled),
        "capabilities": capabilities,
        "metering": metering,
        "limits": limits,
        "cost": cost,
        "supports_images": bool(capabilities.get("supports_images")),
        "supports_native_video": bool(capabilities.get("supports_native_video")),
        "supports_ocr": bool(capabilities.get("supports_ocr")),
        "supports_audio": bool(capabilities.get("supports_audio")),
        "supports_byok": provider.driver in BYOK_DRIVERS,
        "free": str(cost.get("cost_class") or "unknown") == "no_cost",
        "metering_unit": str(metering.get("unit") or ""),
        "cost_per_unit_micros": cost.get("micros_per_unit"),
        "max_images": limits.get("max_images"),
        "max_duration_seconds": limits.get("max_duration_seconds"),
        "max_file_bytes": limits.get("max_file_bytes"),
        "concurrency": provider.max_concurrency,
        "timeout_seconds": limits.get("timeout_seconds"),
        "cost_known": _provider_cost_known(provider),
        "max_concurrency": provider.max_concurrency,
        "daily_budget_micros": provider.daily_budget_micros,
        "health_status": provider.health_status,
        "health_message": provider.health_message,
        "last_tested_at": (
            provider.last_tested_at.isoformat() if provider.last_tested_at else None
        ),
        "last_test_succeeded_at": (
            provider.last_test_succeeded_at.isoformat()
            if provider.last_test_succeeded_at
            else None
        ),
        "circuit_open_until": (
            provider.circuit_open_until.isoformat()
            if provider.circuit_open_until
            else None
        ),
        "created_at": provider.created_at.isoformat() if provider.created_at else None,
        "updated_at": provider.updated_at.isoformat() if provider.updated_at else None,
    }


def list_providers(db: Session) -> list[VisionProvider]:
    return db.query(VisionProvider).order_by(VisionProvider.created_at.asc()).all()


def get_provider(db: Session, provider_id: str) -> VisionProvider | None:
    return db.query(VisionProvider).filter(VisionProvider.id == provider_id).first()


def create_provider(
    db: Session,
    *,
    code: str,
    name: str,
    driver: str,
    default_model: str = "",
    api_base: str = "",
    api_key: str = "",
    enabled: bool = False,
    capabilities: dict[str, Any] | None = None,
    metering: dict[str, Any] | None = None,
    limits: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
    max_concurrency: int = 1,
    daily_budget_micros: int = 0,
) -> VisionProvider:
    clean_code = str(code or "").strip().lower()
    if not _CODE_PATTERN.fullmatch(clean_code):
        raise VideoAnalysisCatalogError("invalid_provider_code", "Provider 标识格式无效")
    if db.query(VisionProvider).filter(VisionProvider.code == clean_code).first():
        raise VideoAnalysisCatalogError("provider_exists", "Provider 标识已存在", status_code=409)
    if driver not in ALLOWED_DRIVERS:
        raise VideoAnalysisCatalogError("invalid_driver", "视觉 Provider 驱动无效")
    clean_name = str(name or "").strip()[:128]
    if not clean_name:
        raise VideoAnalysisCatalogError("provider_name_required", "Provider 名称不能为空")
    needs_endpoint = driver not in {"local_scene"}
    clean_base = _validate_api_base(api_base, required=needs_endpoint)
    clean_model = str(default_model or "").strip()[:160]
    if clean_model and not _MODEL_PATTERN.fullmatch(clean_model):
        raise VideoAnalysisCatalogError("invalid_model", "Provider 默认模型名称无效")
    clean_cost = _clean_dict(cost)
    cost_class = str(clean_cost.get("cost_class") or "unknown")
    if cost_class not in ALLOWED_COST_CLASSES:
        raise VideoAnalysisCatalogError("invalid_cost_class", "Provider 成本类别无效")
    clean_cost["cost_class"] = cost_class
    if api_key.strip():
        _require_secret_encryption()
    provider = VisionProvider(
        code=clean_code,
        name=clean_name,
        driver=driver,
        default_model=clean_model,
        api_base=clean_base,
        encrypted_api_key=(
            settings_service.encrypt_value(api_key.strip()) if api_key.strip() else ""
        ),
        enabled=bool(enabled),
        capabilities_json=_dump(_clean_dict(capabilities)),
        metering_json=_dump(_clean_dict(metering)),
        limits_json=_dump(_clean_dict(limits)),
        cost_json=_dump(clean_cost),
        max_concurrency=_bounded_int(max_concurrency, 1, 1, 32),
        daily_budget_micros=_bounded_int(
            daily_budget_micros, 0, 0, 10_000_000_000_000
        ),
    )
    db.add(provider)
    db.commit()
    db.refresh(provider)
    return provider


def update_provider(
    db: Session,
    provider: VisionProvider,
    **changes: Any,
) -> VisionProvider:
    if "name" in changes and changes["name"] is not None:
        name = str(changes["name"] or "").strip()[:128]
        if not name:
            raise VideoAnalysisCatalogError("provider_name_required", "Provider 名称不能为空")
        provider.name = name
    if "driver" in changes and changes["driver"] is not None:
        driver = str(changes["driver"])
        if driver not in ALLOWED_DRIVERS:
            raise VideoAnalysisCatalogError("invalid_driver", "视觉 Provider 驱动无效")
        if driver != provider.driver and (
            db.query(VideoAnalysisOfferingVersion.id)
            .filter(VideoAnalysisOfferingVersion.provider_id == provider.id)
            .first()
            is not None
        ):
            raise VideoAnalysisCatalogError(
                "provider_driver_immutable",
                "已发布版本引用的 Provider 不能更换驱动，请新建 Provider 并重新发布方案",
                status_code=409,
            )
        provider.driver = driver
        provider.health_status = "untested"
    model_change = changes.get("default_model", changes.get("model"))
    if model_change is not None:
        clean_model = str(model_change or "").strip()[:160]
        if clean_model and not _MODEL_PATTERN.fullmatch(clean_model):
            raise VideoAnalysisCatalogError("invalid_model", "Provider 默认模型名称无效")
        provider.default_model = clean_model
        provider.health_status = "untested"
    if "api_base" in changes and changes["api_base"] is not None:
        provider.api_base = _validate_api_base(
            str(changes["api_base"]), required=provider.driver != "local_scene"
        )
        provider.health_status = "untested"
    if str(changes.get("api_key") or "").strip():
        _require_secret_encryption()
        provider.encrypted_api_key = settings_service.encrypt_value(
            str(changes["api_key"]).strip()
        )
        provider.health_status = "untested"
    if "enabled" in changes and changes["enabled"] is not None:
        provider.enabled = bool(changes["enabled"])
    for input_name, column_name in (
        ("capabilities", "capabilities_json"),
        ("metering", "metering_json"),
        ("limits", "limits_json"),
    ):
        if input_name in changes and changes[input_name] is not None:
            setattr(provider, column_name, _dump(_clean_dict(changes[input_name])))
            provider.health_status = "untested"
    if "cost" in changes and changes["cost"] is not None:
        cost = _clean_dict(changes["cost"])
        cost_class = str(cost.get("cost_class") or "unknown")
        if cost_class not in ALLOWED_COST_CLASSES:
            raise VideoAnalysisCatalogError("invalid_cost_class", "Provider 成本类别无效")
        cost["cost_class"] = cost_class
        provider.cost_json = _dump(cost)
    if "max_concurrency" in changes and changes["max_concurrency"] is not None:
        provider.max_concurrency = _bounded_int(changes["max_concurrency"], 1, 1, 32)
    if "daily_budget_micros" in changes and changes["daily_budget_micros"] is not None:
        provider.daily_budget_micros = _bounded_int(
            changes["daily_budget_micros"], 0, 0, 10_000_000_000_000
        )
    db.commit()
    db.refresh(provider)
    return provider


def disable_provider(db: Session, provider: VisionProvider) -> VisionProvider:
    provider.enabled = False
    db.commit()
    db.refresh(provider)
    return provider


def _runtime_model(driver: str, model: str) -> str:
    if driver in {"openai_compatible", "omniroute_image"} and not model.startswith("openai/"):
        return f"openai/{model}"
    return model


def _test_image_completion(
    *,
    driver: str,
    model: str,
    api_base: str,
    api_key: str,
) -> None:
    if not model or not _MODEL_PATTERN.fullmatch(model):
        raise RuntimeError("未配置可测试的图片模型")
    from litellm import completion

    image_data = "data:image/png;base64," + base64.b64encode(_TEST_PNG).decode("ascii")
    kwargs: dict[str, Any] = {
        "model": _runtime_model(driver, model),
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "请只回复：图片可见"},
                {"type": "image_url", "image_url": {"url": image_data}},
            ],
        }],
        "max_tokens": 16,
        "temperature": 0,
        "timeout": 30,
        # Connection tests are explicit single-shot probes. Hidden SDK
        # retries could multiply BYOK cost and make one Action non-idempotent.
        "num_retries": 0,
    }
    if api_base:
        kwargs["api_base"] = api_base
    if api_key:
        kwargs["api_key"] = api_key
    response = completion(**kwargs)
    message = response.choices[0].message
    if not str(getattr(message, "content", "") or "").strip():
        raise RuntimeError("图片模型没有返回可见内容")


def test_provider(
    db: Session,
    provider: VisionProvider,
    *,
    model: str = "",
) -> dict[str, Any]:
    provider.last_tested_at = _utcnow()
    try:
        if provider.driver == "local_scene":
            import scenedetect  # noqa: F401
        elif provider.driver == "native_video":
            from app.services.video_analysis_engine import native_video_driver_installed

            capabilities = provider.capabilities
            driver_name = str(capabilities.get("native_video_driver") or provider.code)
            if (
                not capabilities.get("native_video_driver_installed")
                or not native_video_driver_installed(driver_name)
            ):
                raise RuntimeError("原生视频驱动尚未安装")
        else:
            api_key = settings_service.decrypt_value(provider.encrypted_api_key)
            test_model = (
                model.strip()
                or provider.default_model
                or str(provider.capabilities.get("test_model") or "")
            )
            _test_image_completion(
                driver=provider.driver,
                model=test_model,
                api_base=provider.api_base,
                api_key=api_key,
            )
        provider.health_status = "healthy"
        provider.health_message = "连接与能力测试成功"
        provider.last_test_succeeded_at = provider.last_tested_at
        provider.consecutive_failures = 0
        provider.circuit_open_until = None
        ok = True
    except Exception:
        provider.health_status = "unhealthy"
        provider.health_message = "连接或能力测试失败，请检查配置"
        provider.consecutive_failures += 1
        ok = False
    db.commit()
    db.refresh(provider)
    return {
        "ok": ok,
        "provider": serialize_provider(provider),
        "message": provider.health_message,
    }


def _offering_payload(offering: VideoAnalysisOffering) -> dict[str, Any]:
    return {
        "code": offering.code,
        "name": offering.name,
        "description": offering.description,
        "method": offering.method,
        "provider_id": offering.provider_id,
        "model": offering.model,
        "recommended": bool(offering.recommended),
        "sort_order": int(offering.sort_order),
        "byok_allowed": bool(offering.byok_allowed),
        "triggers": _normalize_triggers(offering.triggers_json),
        "limits": _normalize_limits(offering.limits_json),
        "pricing": _normalize_pricing(offering.pricing_json),
        "free_quota": _normalize_free_quota(
            offering.free_quota_json,
            offering.code,
        ),
        "fallback": _normalize_fallback(offering.fallback_json),
    }


def serialize_offering(
    offering: VideoAnalysisOffering,
    *,
    version: VideoAnalysisOfferingVersion | None = None,
    public: bool = False,
) -> dict[str, Any]:
    if version is not None:
        limits = _normalize_limits(version.limits_json)
        pricing = _normalize_pricing(version.pricing_json)
        is_free = pricing_is_free(pricing, limits)
        free_quota = _normalize_free_quota(version.free_quota_json, version.code)
        fallback = _normalize_fallback(version.fallback_json)
        allowed_triggers = _normalize_triggers(version.triggers_json)
        data = {
            "id": offering.id,
            "code": version.code,
            "name": version.name,
            "description": version.description,
            "method": version.method,
            "model": version.model,
            "recommended": bool(version.recommended),
            "is_recommended": bool(version.recommended),
            "sort_order": version.sort_order,
            "byok_allowed": bool(version.byok_allowed),
            "supports_byok": bool(version.byok_allowed),
            "triggers": allowed_triggers,
            "allowed_triggers": allowed_triggers,
            "limits": limits,
            "pricing": pricing,
            "price": {**pricing, "is_free": is_free},
            "is_free": is_free,
            "free_quota": free_quota,
            "fallback": fallback,
            "version_id": version.id,
            "version": version.version_number,
            "published_at": version.published_at.isoformat(),
            "published": True,
            "enabled": True,
            "allow_manual": "manual" in allowed_triggers,
            "allow_batch": "batch" in allowed_triggers,
            "allow_agent": "agent" in allowed_triggers,
            "allow_byok": bool(version.byok_allowed),
        }
        if not public:
            data["provider_id"] = version.provider_id
            data["provider_snapshot"] = _json(
                version.provider_snapshot_json, default={}
            )
        return data
    payload = _offering_payload(offering)
    draft_is_free = pricing_is_free(payload["pricing"], payload["limits"])
    draft_triggers = payload["triggers"]
    return {
        "id": offering.id,
        **payload,
        "is_recommended": bool(offering.recommended),
        "supports_byok": bool(offering.byok_allowed),
        "allowed_triggers": payload["triggers"],
        "price": {**payload["pricing"], "is_free": draft_is_free},
        "is_free": draft_is_free,
        "published": offering.status == "published",
        "enabled": offering.status == "published",
        "allow_manual": "manual" in draft_triggers,
        "allow_batch": "batch" in draft_triggers,
        "allow_agent": "agent" in draft_triggers,
        "allow_byok": bool(offering.byok_allowed),
        "status": offering.status,
        "current_version_id": offering.current_version_id,
        "next_version": offering.next_version,
        "created_at": offering.created_at.isoformat() if offering.created_at else None,
        "updated_at": offering.updated_at.isoformat() if offering.updated_at else None,
    }


def list_offerings(db: Session) -> list[VideoAnalysisOffering]:
    return (
        db.query(VideoAnalysisOffering)
        .order_by(VideoAnalysisOffering.sort_order.asc(), VideoAnalysisOffering.created_at.asc())
        .all()
    )


def get_offering(db: Session, offering_id: str) -> VideoAnalysisOffering | None:
    return (
        db.query(VideoAnalysisOffering)
        .filter(VideoAnalysisOffering.id == offering_id)
        .first()
    )


def get_offering_version(
    db: Session,
    version_id: str,
) -> VideoAnalysisOfferingVersion | None:
    return (
        db.query(VideoAnalysisOfferingVersion)
        .filter(VideoAnalysisOfferingVersion.id == version_id)
        .first()
    )


def current_version(
    db: Session,
    offering: VideoAnalysisOffering,
) -> VideoAnalysisOfferingVersion | None:
    if not offering.current_version_id:
        return None
    return get_offering_version(db, offering.current_version_id)


def create_offering(
    db: Session,
    *,
    code: str,
    name: str,
    description: str = "",
    method: str = "local_scene",
    provider_id: str | None = None,
    model: str = "",
    recommended: bool = False,
    sort_order: int = 100,
    byok_allowed: bool = False,
    triggers: list[str] | None = None,
    limits: dict[str, Any] | None = None,
    pricing: dict[str, Any] | None = None,
    free_quota: dict[str, Any] | None = None,
    fallback: dict[str, Any] | None = None,
) -> VideoAnalysisOffering:
    clean_code = str(code or "").strip().lower()
    if not _CODE_PATTERN.fullmatch(clean_code):
        raise VideoAnalysisCatalogError("invalid_offering_code", "Offering 标识格式无效")
    if db.query(VideoAnalysisOffering).filter(VideoAnalysisOffering.code == clean_code).first():
        raise VideoAnalysisCatalogError("offering_exists", "Offering 标识已存在", status_code=409)
    if method not in ALLOWED_METHODS:
        raise VideoAnalysisCatalogError("invalid_method", "解析方式无效")
    clean_name = str(name or "").strip()[:128]
    if not clean_name:
        raise VideoAnalysisCatalogError("offering_name_required", "Offering 名称不能为空")
    if provider_id and get_provider(db, provider_id) is None:
        raise VideoAnalysisCatalogError("provider_not_found", "视觉 Provider 不存在", status_code=404)
    clean_model = str(model or "").strip()[:160]
    if clean_model and not _MODEL_PATTERN.fullmatch(clean_model):
        raise VideoAnalysisCatalogError("invalid_model", "模型名称无效")
    offering = VideoAnalysisOffering(
        code=clean_code,
        name=clean_name,
        description=str(description or "").strip()[:512],
        method=method,
        provider_id=provider_id,
        model=clean_model,
        recommended=bool(recommended),
        sort_order=_bounded_int(sort_order, 100, 0, 10000),
        byok_allowed=bool(byok_allowed),
        triggers_json=_dump(
            _normalize_triggers(triggers or ["manual", "batch", "agent"])
        ),
        limits_json=_dump(_normalize_limits(limits)),
        pricing_json=_dump(_normalize_pricing(pricing)),
        free_quota_json=_dump(_normalize_free_quota(free_quota, clean_code)),
        fallback_json=_dump(_normalize_fallback(fallback)),
    )
    db.add(offering)
    db.commit()
    db.refresh(offering)
    return offering


def update_offering(
    db: Session,
    offering: VideoAnalysisOffering,
    **changes: Any,
) -> VideoAnalysisOffering:
    if "name" in changes and changes["name"] is not None:
        name = str(changes["name"] or "").strip()[:128]
        if not name:
            raise VideoAnalysisCatalogError("offering_name_required", "Offering 名称不能为空")
        offering.name = name
    if "description" in changes and changes["description"] is not None:
        offering.description = str(changes["description"] or "").strip()[:512]
    if "method" in changes and changes["method"] is not None:
        method = str(changes["method"])
        if method not in ALLOWED_METHODS:
            raise VideoAnalysisCatalogError("invalid_method", "解析方式无效")
        offering.method = method
    if "provider_id" in changes:
        provider_id = changes["provider_id"]
        if provider_id and get_provider(db, str(provider_id)) is None:
            raise VideoAnalysisCatalogError("provider_not_found", "视觉 Provider 不存在", status_code=404)
        offering.provider_id = str(provider_id) if provider_id else None
    if "model" in changes and changes["model"] is not None:
        model = str(changes["model"] or "").strip()[:160]
        if model and not _MODEL_PATTERN.fullmatch(model):
            raise VideoAnalysisCatalogError("invalid_model", "模型名称无效")
        offering.model = model
    if "recommended" in changes and changes["recommended"] is not None:
        offering.recommended = bool(changes["recommended"])
    if "sort_order" in changes and changes["sort_order"] is not None:
        offering.sort_order = _bounded_int(changes["sort_order"], 100, 0, 10000)
    if "byok_allowed" in changes and changes["byok_allowed"] is not None:
        offering.byok_allowed = bool(changes["byok_allowed"])
    if "triggers" in changes and changes["triggers"] is not None:
        offering.triggers_json = _dump(_normalize_triggers(changes["triggers"]))
    if "limits" in changes and changes["limits"] is not None:
        offering.limits_json = _dump(_normalize_limits(changes["limits"]))
    if "pricing" in changes and changes["pricing"] is not None:
        offering.pricing_json = _dump(_normalize_pricing(changes["pricing"]))
    if "free_quota" in changes and changes["free_quota"] is not None:
        offering.free_quota_json = _dump(
            _normalize_free_quota(changes["free_quota"], offering.code)
        )
    if "fallback" in changes and changes["fallback"] is not None:
        offering.fallback_json = _dump(_normalize_fallback(changes["fallback"]))
    db.commit()
    db.refresh(offering)
    return offering


def _validate_publish(
    db: Session,
    offering: VideoAnalysisOffering,
) -> tuple[dict[str, Any], VisionProvider | None]:
    payload = _offering_payload(offering)
    provider = get_provider(db, offering.provider_id) if offering.provider_id else None
    if offering.method == "local_scene":
        if provider and provider.driver != "local_scene":
            raise VideoAnalysisCatalogError(
                "provider_method_mismatch", "本地场景方案只能关联 local_scene Provider"
            )
        if provider and (not provider.enabled or provider.health_status != "healthy"):
            raise VideoAnalysisCatalogError(
                "provider_not_ready", "本地 Provider 必须先启用并通过依赖测试"
            )
    else:
        if provider is None:
            raise VideoAnalysisCatalogError("provider_required", "该解析方式必须关联 Provider")
        if not provider.enabled or provider.health_status != "healthy":
            raise VideoAnalysisCatalogError(
                "provider_not_ready", "关联 Provider 必须先启用并通过能力测试"
            )
        effective_model = offering.model or provider.default_model
        if not effective_model or not _MODEL_PATTERN.fullmatch(effective_model):
            raise VideoAnalysisCatalogError("model_required", "请配置有效模型名称")
        payload["model"] = effective_model
        if offering.method == "scene_frames_vlm" and not provider.capabilities.get(
            "supports_images", True
        ):
            raise VideoAnalysisCatalogError("image_capability_missing", "Provider 未声明图片能力")
        if offering.method == "native_video" and not provider.capabilities.get(
            "native_video_driver_installed", False
        ):
            raise VideoAnalysisCatalogError(
                "native_driver_missing", "原生视频驱动尚未安装并通过测试"
            )
        if offering.method == "native_video":
            from app.services.video_analysis_engine import native_video_driver_installed

            driver_name = str(
                provider.capabilities.get("native_video_driver") or provider.code
            )
            if not native_video_driver_installed(driver_name):
                raise VideoAnalysisCatalogError(
                    "native_driver_missing", "原生视频驱动尚未实际安装"
                )
    pricing = payload["pricing"]
    paid = not pricing_is_free(pricing, payload["limits"])
    if (
        offering.method in {"scene_frames_vlm", "native_video"}
        and int(payload["limits"].get("max_provider_calls") or 0) < 1
    ):
        raise VideoAnalysisCatalogError(
            "provider_calls_required", "视觉解析方案至少需要授权 1 次 Provider 调用"
        )
    if paid and provider is not None and not _provider_cost_known(
        provider, effective_limits(payload["limits"], provider)
    ):
        raise VideoAnalysisCatalogError(
            "provider_cost_unknown",
            "收费 Offering 必须配置可计算的上游成本上界",
        )
    if not paid and provider is not None:
        fallback = payload["fallback"]
        if (
            str(provider.cost.get("cost_class") or "unknown") != "no_cost"
            and fallback.get("mode") != "local_scene"
        ):
            raise VideoAnalysisCatalogError(
                "free_fallback_required",
                "免费 Offering 使用非零成本 Provider 时必须允许 local_scene 降级",
            )
    if offering.byok_allowed and offering.method != "scene_frames_vlm":
        raise VideoAnalysisCatalogError(
            "byok_method_unsupported", "首版 BYOK 仅支持关键帧图片模型"
        )
    return payload, provider


def publish_offering(
    db: Session,
    offering: VideoAnalysisOffering,
    *,
    admin_user_id: str,
) -> VideoAnalysisOfferingVersion:
    payload, provider = _validate_publish(db, offering)
    version_number = max(1, int(offering.next_version or 1))
    version = VideoAnalysisOfferingVersion(
        offering_id=offering.id,
        version_number=version_number,
        code=payload["code"],
        name=payload["name"],
        description=payload["description"],
        method=payload["method"],
        provider_id=payload["provider_id"],
        model=payload["model"],
        recommended=payload["recommended"],
        sort_order=payload["sort_order"],
        byok_allowed=payload["byok_allowed"],
        triggers_json=_dump(payload["triggers"]),
        limits_json=_dump(payload["limits"]),
        pricing_json=_dump(payload["pricing"]),
        free_quota_json=_dump(payload["free_quota"]),
        fallback_json=_dump(payload["fallback"]),
        provider_snapshot_json=_dump({
            "id": provider.id if provider else None,
            "code": provider.code if provider else "local",
            "name": provider.name if provider else "本地场景检测",
            "driver": provider.driver if provider else "local_scene",
            "default_model": provider.default_model if provider else "",
            "cost_class": (
                str(provider.cost.get("cost_class") or "unknown")
                if provider
                else "no_cost"
            ),
        }),
        published_by_admin_id=admin_user_id,
    )
    db.add(version)
    db.flush()
    offering.current_version_id = version.id
    offering.next_version = version_number + 1
    offering.status = "published"
    db.commit()
    db.refresh(version)
    return version


def disable_offering(
    db: Session,
    offering: VideoAnalysisOffering,
) -> VideoAnalysisOffering:
    offering.status = "disabled"
    db.commit()
    db.refresh(offering)
    return offering


def ensure_default_drafts(db: Session) -> dict[str, str | bool]:
    """幂等创建首启草稿；绝不自动启用 Provider 或发布 Offering。"""
    provider = (
        db.query(VisionProvider)
        .filter(VisionProvider.code == "local-scene")
        .first()
    )
    provider_created = False
    if provider is None:
        provider = create_provider(
            db,
            code="local-scene",
            name="本地场景检测",
            driver="local_scene",
            enabled=False,
            capabilities={"supports_images": False, "local_only": True},
            cost={"cost_class": "no_cost"},
            max_concurrency=1,
        )
        provider_created = True
    offering = (
        db.query(VideoAnalysisOffering)
        .filter(VideoAnalysisOffering.code == "free-basic")
        .first()
    )
    offering_created = False
    if offering is None:
        offering = create_offering(
            db,
            code="free-basic",
            name="免费基础解析",
            description="使用 PySceneDetect 生成本地场景结构，不调用视觉大模型。",
            method="local_scene",
            provider_id=provider.id,
            recommended=True,
            byok_allowed=False,
            triggers=["manual", "batch", "agent"],
            limits={
                "max_duration_seconds": 7200,
                "max_frames": 8,
                "max_provider_calls": 0,
                "timeout_seconds": 180,
            },
            pricing={
                "base_points": 0,
                "per_minute_points": 0,
                "per_frame_points": 0,
                "per_media_unit_points": 0,
                "min_points": 0,
                "max_points": 0,
            },
            free_quota={
                "scope": "free-basic",
                "period": "day",
                "unit": "run",
                "units": 1,
            },
            fallback={"mode": "reject"},
        )
        offering_created = True
    return {
        "provider_id": provider.id,
        "offering_id": offering.id,
        "provider_created": provider_created,
        "offering_created": offering_created,
    }


def published_catalog(db: Session, *, trigger: str = "manual") -> dict[str, Any]:
    runtime = get_runtime_settings(db)
    if not runtime["enabled"]:
        return {"enabled": False, "reason": "feature_disabled", "items": []}
    offerings = (
        db.query(VideoAnalysisOffering)
        .filter(
            VideoAnalysisOffering.status == "published",
            VideoAnalysisOffering.current_version_id.is_not(None),
        )
        .order_by(
            VideoAnalysisOffering.recommended.desc(),
            VideoAnalysisOffering.sort_order.asc(),
        )
        .all()
    )
    items: list[dict[str, Any]] = []
    for offering in offerings:
        version = current_version(db, offering)
        if version is None or trigger not in _normalize_triggers(version.triggers_json):
            continue
        provider = get_provider(db, version.provider_id) if version.provider_id else None
        fallback = _normalize_fallback(version.fallback_json)
        fallback_allowed = (
            fallback.get("mode") == "local_scene"
            and pricing_is_free(version.pricing, version.limits)
        )
        provider_ready = (
            version.method == "local_scene" and not version.provider_id
        ) or bool(provider and provider.enabled and provider.health_status == "healthy")
        if (
            not pricing_is_free(version.pricing, version.limits)
            and provider is not None
            and not _provider_cost_known(
                provider, effective_limits(version.limits, provider)
            )
        ):
            continue
        if not provider_ready and not fallback_allowed:
            continue
        item = serialize_offering(offering, version=version, public=True)
        item["provider_name"] = (
            provider.name if provider else "本地场景检测"
        )
        item["provider_available"] = provider_ready
        item["degraded_to_local"] = not provider_ready
        items.append(item)
    preferred_id = str(runtime.get("recommended_offering_id") or "")
    if preferred_id:
        items.sort(
            key=lambda item: (
                0 if str(item.get("id")) == preferred_id else 1,
                int(item.get("sort_order") or 0),
            )
        )
    recommendation = items[0] if items else None
    return {
        "enabled": bool(items),
        "reason": "" if items else "no_published_offering",
        "items": items,
        "offerings": items,
        "recommendation": recommendation,
        "recommended_offering_id": recommendation["id"] if recommendation else None,
        "runtime": {
            "quote_ttl_seconds": runtime["quote_ttl_seconds"],
            "points_per_cny": 1000,
        },
    }


def _shanghai_day_window() -> tuple[datetime, datetime]:
    local_now = _utcnow().astimezone(ZoneInfo("Asia/Shanghai"))
    start_local = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _provider_spend_today(db: Session, provider_id: str) -> int:
    start_utc, end_utc = _shanghai_day_window()
    return int(
        db.query(func.coalesce(func.sum(VideoAnalysisItem.platform_cost_micros), 0))
        .filter(
            VideoAnalysisItem.provider_id == provider_id,
            VideoAnalysisItem.finished_at >= start_utc,
            VideoAnalysisItem.finished_at < end_utc,
        )
        .scalar()
        or 0
    )


def _provider_reserved_today(db: Session, provider_id: str) -> int:
    # 未结束的预留不因跨日而消失；否则长队列可绕过 Provider 日预算。
    return int(
        db.query(
            func.coalesce(func.sum(VideoAnalysisItem.platform_cost_reserved_micros), 0)
        )
        .filter(
            VideoAnalysisItem.provider_id == provider_id,
            VideoAnalysisItem.status.in_(
                ["queued", "running", "reauthorization_required"]
            ),
            VideoAnalysisItem.use_byok.is_(False),
        )
        .scalar()
        or 0
    )


def record_provider_outcome(
    db: Session,
    provider_id: str | None,
    *,
    succeeded: bool,
    message: str = "",
) -> None:
    """记录平台凭证真实调用结果；用户 BYOK 不进入此健康与熔断状态。"""
    if not provider_id:
        return
    provider = get_provider(db, provider_id)
    if provider is None:
        return
    now = _utcnow()
    if succeeded:
        provider.consecutive_failures = 0
        provider.health_status = "healthy"
        provider.health_message = "最近一次实际调用成功"
        provider.last_test_succeeded_at = now
        provider.circuit_open_until = None
    else:
        runtime = get_runtime_settings(db)
        provider.consecutive_failures = int(provider.consecutive_failures or 0) + 1
        provider.health_message = str(message or "最近一次实际调用失败")[:256]
        if provider.consecutive_failures >= int(runtime["provider_failure_threshold"]):
            provider.health_status = "circuit_open"
            provider.circuit_open_until = now + timedelta(
                minutes=int(runtime["provider_cooldown_minutes"])
            )
        else:
            # 阈值前保持可用，下一次真实调用继续承担半开探测职责。
            provider.health_status = "healthy"
    provider.last_tested_at = now
    db.flush()


def resolve_runtime_provider(
    db: Session,
    item: VideoAnalysisItem,
) -> dict[str, Any]:
    version = get_offering_version(db, item.offering_version_id)
    if version is None:
        raise VideoAnalysisCatalogError("offering_version_missing", "解析方案版本不存在")
    if item.use_byok:
        if not version.byok_allowed:
            raise VideoAnalysisCatalogError("byok_not_allowed", "该解析方案不支持自有视觉模型")
        row = (
            db.query(UserVisionProviderConfig)
            .filter(UserVisionProviderConfig.user_id == item.user_id)
            .first()
        )
        if row is None or not row.enabled or row.health_status != "healthy":
            raise VideoAnalysisCatalogError(
                "byok_not_ready", "自有视觉模型尚未配置或未通过图片测试"
            )
        _validate_public_user_api_base(row.api_base)
        api_key = settings_service.decrypt_value(row.encrypted_api_key)
        if not api_key or api_key.startswith("ENC:"):
            raise VideoAnalysisCatalogError("byok_key_unavailable", "自有视觉模型密钥不可用")
        return {
            "credential_source": "byok",
            "provider_id": None,
            "provider_label": row.provider_name,
            "driver": row.driver,
            "model": row.model,
            "runtime_model": _runtime_model(row.driver, row.model),
            "api_base": row.api_base,
            "api_key": api_key,
            "limits": version.limits,
        }

    if version.method == "local_scene" and not version.provider_id:
        return {
            "credential_source": "platform",
            "provider_id": None,
            "provider_label": "本地场景检测",
            "driver": "local_scene",
            "model": "",
            "runtime_model": "",
            "api_base": "",
            "api_key": "",
            "limits": version.limits,
        }

    paid = not pricing_is_free(version.pricing, version.limits)
    fallback = _normalize_fallback(version.fallback_json)

    def local_scene_fallback(
        reason: str,
        provider: VisionProvider | None = None,
    ) -> dict[str, Any] | None:
        """Downgrade only explicitly configured free platform offerings.

        A free visual provider can become unavailable after an offering was
        quoted (disabled, circuit-open, missing credentials, or over budget).
        Those cases must retain the promised free local result.  Paid and BYOK
        runs deliberately never enter this branch.
        """
        if fallback.get("mode") != "local_scene" or paid:
            return None
        return {
            "credential_source": "platform",
            "provider_id": provider.id if provider is not None else version.provider_id,
            "provider_label": provider.name if provider is not None else "视觉 Provider",
            "driver": "local_scene",
            "model": "",
            "runtime_model": "",
            "api_base": "",
            "api_key": "",
            "limits": version.limits,
            "degraded_reason": reason,
        }

    provider = get_provider(db, version.provider_id or "")
    if provider is None or not provider.enabled:
        degraded = local_scene_fallback("provider_disabled", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError("provider_disabled", "视觉 Provider 当前不可用")
    provider_snapshot = _json(version.provider_snapshot_json, default={})
    snapshot_driver = str(
        provider_snapshot.get("driver") if isinstance(provider_snapshot, dict) else ""
    ).strip()
    if snapshot_driver and snapshot_driver != provider.driver:
        degraded = local_scene_fallback("provider_version_mismatch", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError(
            "provider_version_mismatch", "Provider 驱动已变化，请重新发布解析方案"
        )
    now = _utcnow()
    if provider.circuit_open_until and provider.circuit_open_until > now:
        degraded = local_scene_fallback("provider_circuit_open", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError("provider_circuit_open", "视觉 Provider 暂时熔断")
    if provider.circuit_open_until and provider.circuit_open_until <= now:
        provider.circuit_open_until = None
        provider.health_status = "healthy"
        provider.health_message = "熔断冷却结束，等待半开调用验证"
        db.flush()
    if provider.health_status != "healthy":
        degraded = local_scene_fallback("provider_unhealthy", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError("provider_unhealthy", "视觉 Provider 未通过健康检查")
    spent = _provider_spend_today(db, provider.id)
    reserved_cost = _provider_reserved_today(db, provider.id)
    if (
        provider.daily_budget_micros > 0
        and spent + reserved_cost > provider.daily_budget_micros
    ):
        degraded = local_scene_fallback("provider_budget_exhausted", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError("provider_budget_exhausted", "视觉 Provider 今日预算已用尽")
    api_key = settings_service.decrypt_value(provider.encrypted_api_key)
    if provider.driver != "local_scene" and (not api_key or api_key.startswith("ENC:")):
        degraded = local_scene_fallback("provider_key_unavailable", provider)
        if degraded is not None:
            return degraded
        raise VideoAnalysisCatalogError("provider_key_unavailable", "视觉 Provider 密钥不可用")
    execution_limits = effective_limits(version.limits, provider)
    if paid and not _provider_cost_known(provider, execution_limits):
        raise VideoAnalysisCatalogError(
            "provider_cost_unknown", "视觉 Provider 成本上界不可计算"
        )
    return {
        "credential_source": "platform",
        "provider_id": provider.id,
        "provider_label": provider.name,
        "driver": provider.driver,
        "model": version.model or provider.default_model,
        "runtime_model": _runtime_model(
            provider.driver, version.model or provider.default_model
        ),
        "api_base": provider.api_base,
        "api_key": api_key,
        "limits": execution_limits,
        "metering": provider.metering,
        "cost": provider.cost,
    }


def _user_config(db: Session, user_id: str) -> UserVisionProviderConfig | None:
    return (
        db.query(UserVisionProviderConfig)
        .filter(UserVisionProviderConfig.user_id == user_id)
        .first()
    )


def serialize_user_vision_config(
    db: Session,
    user_id: str,
) -> dict[str, Any]:
    row = _user_config(db, user_id)
    if row is None:
        return {
            "configured": False,
            "enabled": False,
            "provider_name": "",
            "driver": "openai_compatible",
            "model": "",
            "api_base": "",
            "api_key_set": False,
            "api_key_masked": "",
            "health_status": "untested",
            "health_message": "",
            "last_tested_at": None,
        }
    api_key = settings_service.decrypt_value(row.encrypted_api_key)
    return {
        "configured": True,
        "enabled": bool(row.enabled),
        "provider_name": row.provider_name,
        "driver": row.driver,
        "model": row.model,
        "api_base": row.api_base,
        "api_key_set": bool(api_key and not api_key.startswith("ENC:")),
        "api_key_masked": settings_service.mask_key(api_key),
        "health_status": row.health_status,
        "health_message": row.health_message,
        "capabilities": _json(row.capabilities_json, default={}),
        "last_tested_at": row.last_tested_at.isoformat() if row.last_tested_at else None,
        "last_test_succeeded_at": (
            row.last_test_succeeded_at.isoformat()
            if row.last_test_succeeded_at
            else None
        ),
    }


def save_user_vision_config(
    db: Session,
    user_id: str,
    *,
    provider_name: str,
    driver: str,
    model: str,
    api_base: str,
    api_key: str,
    enabled: bool = True,
) -> dict[str, Any]:
    if driver not in BYOK_DRIVERS:
        raise VideoAnalysisCatalogError("byok_driver_not_allowed", "该视觉驱动不支持 BYOK")
    clean_name = str(provider_name or "").strip()[:80]
    clean_model = str(model or "").strip()[:160]
    if not clean_name or not _MODEL_PATTERN.fullmatch(clean_model):
        raise VideoAnalysisCatalogError("invalid_byok_config", "请填写供应商名称和有效模型")
    clean_base = _validate_public_user_api_base(api_base)
    row = _user_config(db, user_id) or UserVisionProviderConfig(
        user_id=user_id,
        provider_name=clean_name,
        driver=driver,
        model=clean_model,
        api_base=clean_base,
        encrypted_api_key="",
    )
    if not api_key.strip() and not row.encrypted_api_key:
        raise VideoAnalysisCatalogError("byok_key_required", "API Key 不能为空")
    row.provider_name = clean_name
    row.driver = driver
    row.model = clean_model
    row.api_base = clean_base
    row.enabled = bool(enabled)
    if api_key.strip():
        _require_secret_encryption()
        row.encrypted_api_key = settings_service.encrypt_value(api_key.strip())
    row.health_status = "untested"
    row.health_message = ""
    db.add(row)
    db.commit()
    db.refresh(row)
    return serialize_user_vision_config(db, user_id)


def delete_user_vision_config(db: Session, user_id: str) -> dict[str, Any]:
    row = _user_config(db, user_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return serialize_user_vision_config(db, user_id)


def test_user_vision_config(db: Session, user_id: str) -> dict[str, Any]:
    row = _user_config(db, user_id)
    if row is None:
        raise VideoAnalysisCatalogError("byok_not_configured", "尚未配置自有视觉模型")
    row.last_tested_at = _utcnow()
    try:
        _validate_public_user_api_base(row.api_base)
        api_key = settings_service.decrypt_value(row.encrypted_api_key)
        if not api_key or api_key.startswith("ENC:"):
            raise RuntimeError("密钥不可用")
        _test_image_completion(
            driver=row.driver,
            model=row.model,
            api_base=row.api_base,
            api_key=api_key,
        )
        row.health_status = "healthy"
        row.health_message = "图片能力测试成功"
        row.last_test_succeeded_at = row.last_tested_at
        row.capabilities_json = _dump({"supports_images": True})
        ok = True
    except Exception:
        row.health_status = "unhealthy"
        row.health_message = "图片能力测试失败，请检查模型、端点和访问权限"
        ok = False
    db.commit()
    db.refresh(row)
    return {
        "ok": ok,
        "message": row.health_message,
        "config": serialize_user_vision_config(db, user_id),
    }
