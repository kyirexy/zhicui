"""System settings service — runtime LLM/ASR configuration backed by DB.

DB values take precedence over .env (settings.*). This lets the admin panel
change LLM/ASR keys without restarting the server. .env stays as fallback
so the app still works on first boot before any DB row exists.

Secret keys (llm_api_key / asr_api_key) are encrypted at rest with Fernet
when stored in the DB — the ENCRYPTION_KEY is read from .env, so a DB backup
leak does not expose plaintext credentials. Non-secret settings (model
names, api_base URLs) remain plaintext for readability.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.system_setting import SystemSetting

# Setting keys — single source of truth for key names.
LLM_MODEL_KEY = "llm_model"
LLM_API_BASE_KEY = "llm_api_base"
LLM_API_KEY_KEY = "llm_api_key"
LLM_PROVIDER_KEY = "llm_provider"
OMNIROUTE_API_BASE_KEY = "omniroute_api_base"
OMNIROUTE_API_KEY_KEY = "omniroute_api_key"
OMNIROUTE_MODEL_KEY = "omniroute_model"
OMNIROUTE_DASHBOARD_URL_KEY = "omniroute_dashboard_url"
ASR_API_KEY_KEY = "asr_api_key"
ASR_API_BASE_URL_KEY = "asr_api_base_url"
ASR_MODEL_KEY = "asr_model"
EXTRACTION_ASR_CONCURRENCY_KEY = "extraction_asr_concurrency"
EXTRACTION_LLM_CONCURRENCY_KEY = "extraction_llm_concurrency"
CREATOR_SYNC_ENABLED_KEY = "creator_sync_enabled"
CREATOR_SYNC_XHS_COOKIE_KEY = "creator_sync_xhs_cookie"
CREATOR_SYNC_DOUYIN_CONCURRENCY_KEY = "creator_sync_douyin_concurrency"
CREATOR_SYNC_BILIBILI_CONCURRENCY_KEY = "creator_sync_bilibili_concurrency"
CREATOR_SYNC_XHS_CONCURRENCY_KEY = "creator_sync_xhs_concurrency"
CREATOR_SYNC_HEALTH_KEYS = {
    "douyin": "creator_sync_douyin_healthy",
    "bilibili": "creator_sync_bilibili_healthy",
    "xiaohongshu": "creator_sync_xiaohongshu_healthy",
}
CREATOR_SYNC_CATALOG_HEALTH_KEYS = {
    "douyin": "creator_sync_douyin_catalog_healthy",
    "bilibili": "creator_sync_bilibili_catalog_healthy",
}
CREATOR_SYNC_TESTED_AT_KEYS = {
    platform: f"creator_sync_{platform}_tested_at"
    for platform in CREATOR_SYNC_HEALTH_KEYS
}
AGENT_V2_ENABLED_KEY = "agent_v2_enabled"
AGENT_V2_ROLLOUT_PERCENT_KEY = "agent_v2_rollout_percent"
AGENT_V2_ALLOWLIST_KEY = "agent_v2_allowlist"

DEEPSEEK_PROVIDER = "deepseek"
CUSTOM_PROVIDER = "custom"
OMNIROUTE_PROVIDER = "omniroute"
DEEPSEEK_API_BASE = "https://api.deepseek.com"
DEEPSEEK_MODELS = ("deepseek-v4-flash", "deepseek-v4-pro")
MAX_EXTRACTION_ASR_CONCURRENCY = 200
MAX_EXTRACTION_LLM_CONCURRENCY = 50
DEFAULT_EXTRACTION_ASR_CONCURRENCY = 200
DEFAULT_EXTRACTION_LLM_CONCURRENCY = 12
DEFAULT_CREATOR_SYNC_CONCURRENCY = {
    "douyin": 1,
    "bilibili": 2,
    "xiaohongshu": 1,
}


def _fernet():
    """Build a Fernet cipher from settings.ENCRYPTION_KEY, or None if unset."""
    if not settings.ENCRYPTION_KEY:
        return None
    from cryptography.fernet import Fernet

    return Fernet(settings.ENCRYPTION_KEY.encode())


def _encrypt(value: str) -> str:
    """Encrypt a secret. Returns 'ENC:'-prefixed ciphertext, or plaintext if no key."""
    f = _fernet()
    if f is None or not value:
        return value
    return "ENC:" + f.encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    """Decrypt a secret. Non-encrypted values pass through unchanged."""
    if not value or not value.startswith("ENC:"):
        return value
    f = _fernet()
    if f is None:
        return value  # cannot decrypt without key; return as-is
    try:
        return f.decrypt(value[4:].encode()).decode()
    except Exception:
        return value  # corrupt ciphertext or wrong key; fall back


def encrypt_value(value: str) -> str:
    """Encrypt a user-scoped secret with the application Fernet key."""
    return _encrypt(value)


def decrypt_value(value: str) -> str:
    """Decrypt a user-scoped secret without exposing storage details."""
    return _decrypt(value)


def get_setting(db: Session, key: str, default: str = "") -> str:
    """Read a setting by key. Returns default if not set. (Plaintext.)"""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if row is None or row.value is None:
        return default
    return row.value


def set_setting(db: Session, key: str, value: str) -> None:
    """Upsert a plaintext setting (model names, URLs)."""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if row is None:
        row = SystemSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()
    db.refresh(row)


def set_secret(db: Session, key: str, value: str) -> None:
    """Upsert a secret setting, encrypted at rest with Fernet."""
    set_setting(db, key, _encrypt(value))


def get_secret(db: Session, key: str, default: str = "") -> str:
    """Read and decrypt a secret setting."""
    raw = get_setting(db, key, "")
    if not raw:
        return default
    return _decrypt(raw)


def infer_llm_provider(model: str, api_base: str, stored_provider: str = "") -> str:
    """Infer a provider for installations created before provider was stored."""
    if stored_provider in {DEEPSEEK_PROVIDER, CUSTOM_PROVIDER, OMNIROUTE_PROVIDER}:
        return stored_provider
    normalized_base = (api_base or "").rstrip("/")
    if model in DEEPSEEK_MODELS or normalized_base == DEEPSEEK_API_BASE:
        return DEEPSEEK_PROVIDER
    return CUSTOM_PROVIDER


def validate_llm_preset(provider: str, model: str, api_base: str) -> dict[str, str]:
    """Normalize provider values and enforce server-side presets."""
    safe_provider = provider if provider in {DEEPSEEK_PROVIDER, CUSTOM_PROVIDER, OMNIROUTE_PROVIDER} else CUSTOM_PROVIDER
    safe_model = (model or "").strip()
    safe_base = (api_base or "").strip().rstrip("/")
    if safe_provider == DEEPSEEK_PROVIDER:
        if safe_model not in DEEPSEEK_MODELS:
            raise ValueError("请选择受支持的 DeepSeek 模型")
        safe_base = DEEPSEEK_API_BASE
    elif safe_provider == OMNIROUTE_PROVIDER:
        if not safe_model:
            raise ValueError("请选择 OmniRoute 模型")
        # api_base 留空即可；实际网关地址在 get_llm_config 阶段从
        # OmniRoute 网关配置动态解析，避免管理员重复填写。
        safe_base = ""
    elif not safe_model:
        raise ValueError("自定义模型名称不能为空")
    return {
        "provider": safe_provider,
        "model": safe_model,
        "api_base": safe_base,
    }


def to_litellm_model(provider: str, model: str) -> str:
    """Convert a display model into LiteLLM's OpenAI-compatible route."""
    if (
        provider in {DEEPSEEK_PROVIDER, OMNIROUTE_PROVIDER, CUSTOM_PROVIDER}
        and model
        and not model.startswith("openai/")
    ):
        # 这三种“运行来源”最终都走显式 api_base 的 OpenAI 兼容网关。
        # 模型名只是该网关里的资源 ID（例如 SiliconFlow 的
        # `deepseek-ai/DeepSeek-V3`），与 LiteLLM 的供应商路由无关；
        # 不显式加 openai/ 前缀会被 LiteLLM 当成未知供应商直接报错。
        return f"openai/{model}"
    return model


def get_llm_config(db: Session) -> dict[str, str]:
    """Resolve effective LLM config: DB first, fallback to settings (.env).

    api_key fallback chain: DB LLM_API_KEY (decrypted) -> settings.LLM_API_KEY
    -> settings.API_KEY (so a single SiliconFlow key in .env still works).
    """
    model = get_setting(db, LLM_MODEL_KEY) or settings.LLM_MODEL
    api_base = get_setting(db, LLM_API_BASE_KEY) or settings.LLM_API_BASE
    api_key = get_secret(db, LLM_API_KEY_KEY) or settings.LLM_API_KEY or settings.API_KEY
    stored_provider = get_setting(db, LLM_PROVIDER_KEY)
    provider = infer_llm_provider(model, api_base, stored_provider)
    if provider == DEEPSEEK_PROVIDER:
        api_base = DEEPSEEK_API_BASE
    elif provider == OMNIROUTE_PROVIDER:
        # 复用已配置的 OmniRoute 网关：地址与密钥由网关配置统一管理，
        # 管理员只需在 UI 里选一个免费模型。
        omni = get_omniroute_config(db)
        if omni["api_base"]:
            api_base = str(omni["api_base"])
        if omni["api_key"]:
            api_key = str(omni["api_key"])
    return {
        "provider": provider,
        "model": model,
        "runtime_model": to_litellm_model(provider, model),
        "api_base": api_base,
        "api_key": api_key,
    }


def get_asr_config(db: Session) -> dict[str, str]:
    """Resolve effective ASR config: DB first, fallback to settings."""
    api_key = get_secret(db, ASR_API_KEY_KEY) or settings.API_KEY
    api_base_url = get_setting(db, ASR_API_BASE_URL_KEY) or settings.ASR_API_BASE_URL
    model = get_setting(db, ASR_MODEL_KEY) or settings.ASR_MODEL
    return {"api_key": api_key, "api_base_url": api_base_url, "model": model}


def get_omniroute_config(db: Session) -> dict[str, str]:
    """Resolve effective OmniRoute config: DB first, fallback to settings (.env)."""
    api_base = (get_setting(db, OMNIROUTE_API_BASE_KEY) or settings.OMNIROUTE_API_BASE).strip().rstrip("/")
    api_key = get_secret(db, OMNIROUTE_API_KEY_KEY) or settings.OMNIROUTE_API_KEY
    model = (get_setting(db, OMNIROUTE_MODEL_KEY) or settings.OMNIROUTE_MODEL).strip() or "auto"
    dashboard_url = (get_setting(db, OMNIROUTE_DASHBOARD_URL_KEY) or settings.OMNIROUTE_DASHBOARD_URL).strip()
    return {
        "api_base": api_base,
        "api_key": api_key,
        "model": model,
        "dashboard_url": dashboard_url,
    }


def get_omniroute_config_masked(db: Session) -> dict[str, Any]:
    """OmniRoute config with api_key masked — safe to return to the admin UI."""
    cfg = get_omniroute_config(db)
    return {
        "configured": bool(cfg["api_base"] and cfg["api_key"]),
        "api_base": cfg["api_base"],
        "api_key_masked": mask_key(cfg["api_key"]),
        "model": cfg["model"] or "auto",
        "dashboard_url": cfg["dashboard_url"],
    }


def set_omniroute_config(
    db: Session,
    *,
    api_base: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    dashboard_url: str | None = None,
) -> dict[str, Any]:
    """Persist the server-managed OmniRoute gateway credentials.

    ``api_key`` is encrypted at rest; an empty value leaves it unchanged.
    The dashboard URL is an optional browser-facing admin console link.
    """
    if api_base is not None:
        set_setting(db, OMNIROUTE_API_BASE_KEY, api_base.strip().rstrip("/"))
    if api_key is not None and api_key.strip():
        set_secret(db, OMNIROUTE_API_KEY_KEY, api_key.strip())
    if model is not None:
        set_setting(db, OMNIROUTE_MODEL_KEY, model.strip() or "auto")
    if dashboard_url is not None:
        set_setting(db, OMNIROUTE_DASHBOARD_URL_KEY, dashboard_url.strip())
    return get_omniroute_config_masked(db)


def _bounded_int_setting(
    db: Session,
    key: str,
    default: int,
    *,
    minimum: int = 1,
    maximum: int = 50,
) -> int:
    raw = get_setting(db, key, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def get_extraction_concurrency(db: Session) -> dict[str, int]:
    """Return stage limits for newly created concurrent extraction jobs."""
    return {
        "asr": _bounded_int_setting(
            db,
            EXTRACTION_ASR_CONCURRENCY_KEY,
            DEFAULT_EXTRACTION_ASR_CONCURRENCY,
            maximum=MAX_EXTRACTION_ASR_CONCURRENCY,
        ),
        "llm": _bounded_int_setting(
            db,
            EXTRACTION_LLM_CONCURRENCY_KEY,
            DEFAULT_EXTRACTION_LLM_CONCURRENCY,
            maximum=MAX_EXTRACTION_LLM_CONCURRENCY,
        ),
    }


def _as_bool(value: str, default: bool = False) -> bool:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return default
    return normalized in {"1", "true", "yes", "on", "enabled"}


def get_creator_sync_config(db: Session, *, include_secret: bool = False) -> dict[str, Any]:
    """Return the admin-controlled creator sync feature configuration.

    The feature is deliberately disabled until an administrator enables it.
    The XHS service credential is never included unless server-side connector
    code explicitly requests it.
    """
    xhs_cookie = get_secret(db, CREATOR_SYNC_XHS_COOKIE_KEY) or getattr(settings, "XHS_COOKIE", "")
    platform_health = {
        platform: _as_bool(get_setting(db, health_key, "false"))
        and (platform != "xiaohongshu" or bool(xhs_cookie))
        for platform, health_key in CREATOR_SYNC_HEALTH_KEYS.items()
    }
    catalog_health = {
        platform: _as_bool(
            get_setting(
                db,
                health_key,
                "true" if platform_health.get(platform) else "false",
            )
        )
        for platform, health_key in CREATOR_SYNC_CATALOG_HEALTH_KEYS.items()
    }
    result: dict[str, Any] = {
        "enabled": _as_bool(get_setting(db, CREATOR_SYNC_ENABLED_KEY, "false")),
        "platforms": platform_health,
        "catalog_platforms": catalog_health,
        "last_tested_at": {
            platform: get_setting(db, CREATOR_SYNC_TESTED_AT_KEYS[platform], "") or None
            for platform in CREATOR_SYNC_HEALTH_KEYS
        },
        "concurrency": {
            "douyin": _bounded_int_setting(
                db, CREATOR_SYNC_DOUYIN_CONCURRENCY_KEY, 1, maximum=4
            ),
            "bilibili": _bounded_int_setting(
                db, CREATOR_SYNC_BILIBILI_CONCURRENCY_KEY, 2, maximum=4
            ),
            "xiaohongshu": _bounded_int_setting(
                db, CREATOR_SYNC_XHS_CONCURRENCY_KEY, 1, maximum=4
            ),
        },
        "xhs_cookie_masked": mask_key(xhs_cookie),
    }
    if include_secret:
        result["xhs_cookie"] = xhs_cookie
    return result


def get_agent_v2_config(db: Session) -> dict[str, Any]:
    raw_allowlist = get_setting(db, AGENT_V2_ALLOWLIST_KEY, "")
    allowlist = sorted({
        value.strip() for value in raw_allowlist.replace("\n", ",").split(",")
        if value.strip()
    })
    return {
        "enabled": _as_bool(get_setting(db, AGENT_V2_ENABLED_KEY, "false")),
        "rollout_percent": _bounded_int_setting(
            db, AGENT_V2_ROLLOUT_PERCENT_KEY, 0, minimum=0, maximum=100
        ),
        "allowlist": allowlist,
    }


def set_agent_v2_config(
    db: Session,
    *,
    enabled: bool,
    rollout_percent: int,
    allowlist: list[str],
) -> dict[str, Any]:
    normalized_allowlist = sorted({
        str(value or "").strip()[:160]
        for value in allowlist[:500]
        if str(value or "").strip()
    })
    set_setting(db, AGENT_V2_ENABLED_KEY, "true" if enabled else "false")
    set_setting(
        db,
        AGENT_V2_ROLLOUT_PERCENT_KEY,
        str(max(0, min(int(rollout_percent), 100))),
    )
    set_setting(db, AGENT_V2_ALLOWLIST_KEY, ",".join(normalized_allowlist))
    return get_agent_v2_config(db)


def agent_v2_enabled_for_user(db: Session, user_id: str) -> bool:
    """Stable rollout assignment; allowlisted users bypass percentage."""
    import hashlib

    config = get_agent_v2_config(db)
    if not config["enabled"]:
        return False
    if user_id in set(config["allowlist"]):
        return True
    rollout = int(config["rollout_percent"])
    if rollout <= 0:
        return False
    bucket = int(hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:8], 16) % 100
    return bucket < rollout


def set_creator_sync_config(
    db: Session,
    *,
    enabled: bool,
    xhs_cookie: str | None = None,
    douyin_concurrency: int = 1,
    bilibili_concurrency: int = 2,
    xiaohongshu_concurrency: int = 1,
) -> dict[str, Any]:
    """Persist the feature flag, encrypted XHS credential and safe limits."""
    set_setting(db, CREATOR_SYNC_ENABLED_KEY, "true" if enabled else "false")
    if xhs_cookie is not None and xhs_cookie.strip():
        set_secret(db, CREATOR_SYNC_XHS_COOKIE_KEY, xhs_cookie.strip())
        set_setting(db, CREATOR_SYNC_HEALTH_KEYS["xiaohongshu"], "false")
    set_setting(
        db,
        CREATOR_SYNC_DOUYIN_CONCURRENCY_KEY,
        str(max(1, min(int(douyin_concurrency), 4))),
    )
    set_setting(
        db,
        CREATOR_SYNC_BILIBILI_CONCURRENCY_KEY,
        str(max(1, min(int(bilibili_concurrency), 4))),
    )
    set_setting(
        db,
        CREATOR_SYNC_XHS_CONCURRENCY_KEY,
        str(max(1, min(int(xiaohongshu_concurrency), 4))),
    )
    return get_creator_sync_config(db)


def record_creator_connector_test(
    db: Session,
    *,
    platform: str,
    healthy: bool,
    tested_at: str,
    catalog_healthy: bool | None = None,
) -> dict[str, Any]:
    if platform not in CREATOR_SYNC_HEALTH_KEYS:
        raise ValueError("不支持的博主同步平台")
    set_setting(db, CREATOR_SYNC_HEALTH_KEYS[platform], "true" if healthy else "false")
    catalog_health_key = CREATOR_SYNC_CATALOG_HEALTH_KEYS.get(platform)
    if catalog_health_key and catalog_healthy is not None:
        set_setting(db, catalog_health_key, "true" if catalog_healthy else "false")
    set_setting(db, CREATOR_SYNC_TESTED_AT_KEYS[platform], tested_at)
    return get_creator_sync_config(db)


def set_extraction_concurrency(
    db: Session,
    *,
    asr: int,
    llm: int,
) -> dict[str, int]:
    """Persist validated ASR and LLM stage concurrency limits."""
    safe_asr = max(1, min(int(asr), MAX_EXTRACTION_ASR_CONCURRENCY))
    safe_llm = max(1, min(int(llm), MAX_EXTRACTION_LLM_CONCURRENCY))
    set_setting(db, EXTRACTION_ASR_CONCURRENCY_KEY, str(safe_asr))
    set_setting(db, EXTRACTION_LLM_CONCURRENCY_KEY, str(safe_llm))
    return {"asr": safe_asr, "llm": safe_llm}


def mask_key(value: str) -> str:
    """Mask a secret, showing only the last 4 chars. Empty -> ''."""
    if not value:
        return ""
    if len(value) <= 4:
        return "****"
    return "*" * (len(value) - 4) + value[-4:]


def get_llm_config_masked(db: Session) -> dict[str, Any]:
    """LLM config with api_key masked — safe to return to the admin UI."""
    cfg = get_llm_config(db)
    return {
        "provider": cfg["provider"],
        "model": cfg["model"],
        "api_base": cfg["api_base"],
        "api_key_masked": mask_key(cfg["api_key"]),
        "api_base_locked": cfg["provider"] == DEEPSEEK_PROVIDER,
        "available_models": list(DEEPSEEK_MODELS),
    }


def get_asr_config_masked(db: Session) -> dict[str, str]:
    """ASR config with api_key masked — safe to return to the admin UI."""
    cfg = get_asr_config(db)
    return {
        "api_key_masked": mask_key(cfg["api_key"]),
        "api_base_url": cfg["api_base_url"],
        "model": cfg["model"],
    }
