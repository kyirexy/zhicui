"""User-scoped provider configuration and effective runtime resolution."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.services import settings_service


PLATFORM_POLICY = {
    "mode": "platform",
    "label": "知萃基础 AI",
    "allowance": "包含基础问答额度；高频或深度研究可能受到频率限制",
    "features": ["视频与知识库问答", "摘要整理", "基础行动建议"],
    "custom_unlocks": ["使用自己的模型余额", "自选兼容模型", "更高频率与长上下文由供应商决定"],
}

OMNIROUTE_POLICY = {
    "label": "OmniRoute 智能路由",
    "description": "由知萃服务器托管的统一模型入口，可按可用性和策略选择已连接供应商。",
    "features": ["统一 OpenAI 兼容入口", "模型路由与故障回退", "费用与额度由已连接供应商决定"],
}

VALID_MODES = {"platform", "custom"}
OMNIROUTE_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")


def omniroute_config() -> dict[str, str | bool | list[str]]:
    api_base = settings.OMNIROUTE_API_BASE.strip().rstrip("/")
    api_key = settings.OMNIROUTE_API_KEY.strip()
    model = settings.OMNIROUTE_MODEL.strip() or "auto"
    return {
        "available": bool(api_base and api_key),
        "label": OMNIROUTE_POLICY["label"],
        "description": OMNIROUTE_POLICY["description"],
        "features": list(OMNIROUTE_POLICY["features"]),
        "model": model,
        "api_base": api_base,
        "api_key": api_key,
    }


def _row(db: Session, user_id: str) -> UserAIProviderConfig | None:
    return db.query(UserAIProviderConfig).filter(UserAIProviderConfig.user_id == user_id).first()


def uses_custom_provider(db: Session, user_id: str) -> bool:
    """BYOK 请求直接使用用户自己的余额，不消耗平台聊天萃点。"""
    row = _row(db, user_id)
    return bool(row and row.mode == "custom" and row.enabled)


def _mask(value: str) -> str:
    if not value:
        return ""
    plain = settings_service.decrypt_value(value)
    if len(plain) <= 8:
        return "••••••••"
    return f"{plain[:3]}••••{plain[-4:]}"


def serialize(db: Session, user_id: str) -> dict:
    row = _row(db, user_id)
    mode = row.mode if row and row.mode in VALID_MODES else "platform"
    from app.services import chat_model_catalog_service as catalog
    selected = catalog.selected_offering(db, user_id)
    return {
        "mode": mode,
        "enabled": bool(mode == "platform" or (row and row.enabled)),
        "provider_name": row.provider_name if mode == "custom" and row else "知萃平台",
        "model": row.model if mode == "custom" and row else selected.id,
        "selected_offering_id": selected.id,
        "selected_offering_name": selected.name,
        "api_base": row.api_base if row and mode == "custom" else "",
        "api_key_set": bool(row and row.encrypted_api_key),
        "api_key_masked": _mask(row.encrypted_api_key) if row else "",
        "policy": PLATFORM_POLICY,
    }


def save(
    db: Session,
    user_id: str,
    *,
    mode: str,
    provider_name: str,
    model: str,
    api_base: str,
    api_key: str,
) -> dict:
    if mode not in VALID_MODES:
        raise ValueError("AI 服务模式无效")
    if mode == "platform":
        from app.services import chat_model_catalog_service as catalog
        selected = catalog.default_offering(db) if not model.strip() else catalog.select_for_user(
            db, user_id, model.strip()
        )
        if not model.strip():
            catalog.select_for_user(db, user_id, selected.id)
        return serialize(db, user_id)
    row = _row(db, user_id) or UserAIProviderConfig(user_id=user_id)
    if mode == "custom":
        clean_model = model.strip()[:160]
        clean_base = api_base.strip().rstrip("/")[:512]
        parsed = urlparse(clean_base)
        if not clean_model:
            raise ValueError("模型名称不能为空")
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("请输入有效的 API Base 地址")
        if not api_key.strip() and not row.encrypted_api_key:
            raise ValueError("API Key 不能为空")
        row.model = clean_model
        row.api_base = clean_base
        row.provider_name = provider_name.strip()[:80] or "OpenAI Compatible"
        if api_key.strip():
            row.encrypted_api_key = settings_service.encrypt_value(api_key.strip())
        row.enabled = True
    row.mode = mode
    db.add(row)
    db.commit()
    db.refresh(row)
    return serialize(db, user_id)


def reset(db: Session, user_id: str) -> dict:
    row = _row(db, user_id)
    if row:
        db.delete(row)
        db.commit()
    return serialize(db, user_id)


def effective_config(db: Session, user_id: str | None) -> dict[str, str]:
    if not user_id:
        return settings_service.get_llm_config(db)
    row = _row(db, user_id)
    if not row or row.mode != "custom" or not row.enabled:
        from app.services import chat_model_catalog_service as catalog
        return catalog.effective_config(db, user_id, row.model if row and row.mode == "platform" else None)
    api_key = settings_service.decrypt_value(row.encrypted_api_key)
    if not row.model or not row.api_base or not api_key:
        return settings_service.get_llm_config(db)
    return {
        "provider": "custom",
        "model": row.model,
        "runtime_model": row.model if "/" in row.model else f"openai/{row.model}",
        "api_base": row.api_base,
        "api_key": api_key,
    }


def effective_vision_config(db: Session, user_id: str | None) -> dict[str, str]:
    """图片问答使用用户明确选择的模型，不执行智能路由。"""
    return effective_config(db, user_id)
