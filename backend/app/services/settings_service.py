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
ASR_API_KEY_KEY = "asr_api_key"
ASR_API_BASE_URL_KEY = "asr_api_base_url"
ASR_MODEL_KEY = "asr_model"
EXTRACTION_ASR_CONCURRENCY_KEY = "extraction_asr_concurrency"
EXTRACTION_LLM_CONCURRENCY_KEY = "extraction_llm_concurrency"

DEEPSEEK_PROVIDER = "deepseek"
CUSTOM_PROVIDER = "custom"
DEEPSEEK_API_BASE = "https://api.deepseek.com"
DEEPSEEK_MODELS = ("deepseek-v4-flash", "deepseek-v4-pro")
MAX_EXTRACTION_ASR_CONCURRENCY = 200
MAX_EXTRACTION_LLM_CONCURRENCY = 50
DEFAULT_EXTRACTION_ASR_CONCURRENCY = 200
DEFAULT_EXTRACTION_LLM_CONCURRENCY = 12


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
    if stored_provider in {DEEPSEEK_PROVIDER, CUSTOM_PROVIDER}:
        return stored_provider
    normalized_base = (api_base or "").rstrip("/")
    if model in DEEPSEEK_MODELS or normalized_base == DEEPSEEK_API_BASE:
        return DEEPSEEK_PROVIDER
    return CUSTOM_PROVIDER


def validate_llm_preset(provider: str, model: str, api_base: str) -> dict[str, str]:
    """Normalize provider values and enforce server-side DeepSeek presets."""
    safe_provider = provider if provider in {DEEPSEEK_PROVIDER, CUSTOM_PROVIDER} else CUSTOM_PROVIDER
    safe_model = (model or "").strip()
    safe_base = (api_base or "").strip().rstrip("/")
    if safe_provider == DEEPSEEK_PROVIDER:
        if safe_model not in DEEPSEEK_MODELS:
            raise ValueError("请选择受支持的 DeepSeek 模型")
        safe_base = DEEPSEEK_API_BASE
    elif not safe_model:
        raise ValueError("自定义模型名称不能为空")
    return {
        "provider": safe_provider,
        "model": safe_model,
        "api_base": safe_base,
    }


def to_litellm_model(provider: str, model: str) -> str:
    """Convert a display model into LiteLLM's OpenAI-compatible route."""
    if provider == DEEPSEEK_PROVIDER and not model.startswith("openai/"):
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
