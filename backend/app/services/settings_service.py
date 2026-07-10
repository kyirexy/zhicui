"""System settings service — runtime LLM/ASR configuration backed by DB.

DB values take precedence over .env (settings.*). This lets the admin panel
change LLM/ASR keys without restarting the server. .env stays as fallback
so the app still works on first boot before any DB row exists.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.system_setting import SystemSetting

# Setting keys — single source of truth for key names.
LLM_MODEL_KEY = "llm_model"
LLM_API_BASE_KEY = "llm_api_base"
LLM_API_KEY_KEY = "llm_api_key"
ASR_API_KEY_KEY = "asr_api_key"
ASR_API_BASE_URL_KEY = "asr_api_base_url"
ASR_MODEL_KEY = "asr_model"


def get_setting(db: Session, key: str, default: str = "") -> str:
    """Read a setting by key. Returns default if not set."""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if row is None or row.value is None:
        return default
    return row.value


def set_setting(db: Session, key: str, value: str) -> None:
    """Upsert a setting."""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if row is None:
        row = SystemSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()
    db.refresh(row)


def get_llm_config(db: Session) -> dict[str, str]:
    """Resolve effective LLM config: DB first, fallback to settings (.env).

    api_key fallback chain: DB LLM_API_KEY -> settings.LLM_API_KEY -> settings.API_KEY
    (so a single SiliconFlow key in .env still works for LLM if nothing else is set).
    """
    model = get_setting(db, LLM_MODEL_KEY) or settings.LLM_MODEL
    api_base = get_setting(db, LLM_API_BASE_KEY) or settings.LLM_API_BASE
    api_key = get_setting(db, LLM_API_KEY_KEY) or settings.LLM_API_KEY or settings.API_KEY
    return {"model": model, "api_base": api_base, "api_key": api_key}


def get_asr_config(db: Session) -> dict[str, str]:
    """Resolve effective ASR config: DB first, fallback to settings."""
    api_key = get_setting(db, ASR_API_KEY_KEY) or settings.API_KEY
    api_base_url = get_setting(db, ASR_API_BASE_URL_KEY) or settings.ASR_API_BASE_URL
    model = get_setting(db, ASR_MODEL_KEY) or settings.ASR_MODEL
    return {"api_key": api_key, "api_base_url": api_base_url, "model": model}


def mask_key(value: str) -> str:
    """Mask a secret, showing only the last 4 chars. Empty -> ''."""
    if not value:
        return ""
    if len(value) <= 4:
        return "****"
    return "*" * (len(value) - 4) + value[-4:]


def get_llm_config_masked(db: Session) -> dict[str, str]:
    """LLM config with api_key masked — safe to return to the admin UI."""
    cfg = get_llm_config(db)
    return {
        "model": cfg["model"],
        "api_base": cfg["api_base"],
        "api_key_masked": mask_key(cfg["api_key"]),
    }


def get_asr_config_masked(db: Session) -> dict[str, str]:
    """ASR config with api_key masked — safe to return to the admin UI."""
    cfg = get_asr_config(db)
    return {
        "api_key_masked": mask_key(cfg["api_key"]),
        "api_base_url": cfg["api_base_url"],
        "model": cfg["model"],
    }
