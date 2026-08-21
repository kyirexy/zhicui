"""User-scoped provider configuration and effective runtime resolution."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.models.user_custom_chat_model import UserCustomChatModel
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


def omniroute_config(db: Session | None = None) -> dict[str, str | bool | list[str]]:
    if db is not None:
        raw = settings_service.get_omniroute_config(db)
    else:
        raw = {
            "api_base": settings.OMNIROUTE_API_BASE.strip().rstrip("/"),
            "api_key": settings.OMNIROUTE_API_KEY.strip(),
            "model": settings.OMNIROUTE_MODEL.strip() or "auto",
            "dashboard_url": "",
        }
    api_base = str(raw.get("api_base") or "").strip().rstrip("/")
    api_key = str(raw.get("api_key") or "").strip()
    model = str(raw.get("model") or "").strip() or "auto"
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


def _model_rows(db: Session, user_id: str) -> list[UserCustomChatModel]:
    return (
        db.query(UserCustomChatModel)
        .filter(UserCustomChatModel.user_id == user_id)
        .order_by(UserCustomChatModel.created_at.asc())
        .all()
    )


def _selected_model(db: Session, user_id: str) -> UserCustomChatModel | None:
    return (
        db.query(UserCustomChatModel)
        .filter(
            UserCustomChatModel.user_id == user_id,
            UserCustomChatModel.is_selected.is_(True),
        )
        .first()
    )


def _owns_model(db: Session, user_id: str, model_id: str) -> UserCustomChatModel | None:
    return (
        db.query(UserCustomChatModel)
        .filter(
            UserCustomChatModel.user_id == user_id,
            UserCustomChatModel.id == model_id,
        )
        .first()
    )


def uses_custom_provider(db: Session, user_id: str) -> bool:
    """BYOK 请求直接使用用户自己的余额，不消耗平台聊天萃点。"""
    selected = _selected_model(db, user_id)
    return bool(selected and selected.enabled)


def _mask(value: str) -> str:
    if not value:
        return ""
    plain = settings_service.decrypt_value(value)
    if len(plain) <= 8:
        return "••••••••"
    return f"{plain[:3]}••••{plain[-4:]}"


def _mask_model(value: str) -> str:
    if not value:
        return ""
    try:
        plain = settings_service.decrypt_value(value)
    except Exception:
        return "••••••••"
    if len(plain) <= 8:
        return "••••••••"
    return f"{plain[:3]}••••{plain[-4:]}"


def _serialize_model(row: UserCustomChatModel) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "provider_name": row.provider_name,
        "model": row.model,
        "api_base": row.api_base,
        "api_key_set": bool(row.encrypted_api_key),
        "api_key_masked": _mask_model(row.encrypted_api_key),
        "enabled": bool(row.enabled),
        "is_selected": bool(row.is_selected),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def serialize(db: Session, user_id: str) -> dict:
    row = _row(db, user_id)
    custom_rows = _model_rows(db, user_id)
    selected_custom = _selected_model(db, user_id)
    # 对外 mode：只要存在选中且启用的自定义模型，就继续沿用 custom 语义，
    # 便于旧选择器保持兼容；平台 offering 选择仍存放在旧表 model 字段。
    mode = "custom" if (selected_custom and selected_custom.enabled) else "platform"
    from app.services import chat_model_catalog_service as catalog
    selected = catalog.selected_offering(db, user_id)
    platform_selected_id = None
    if row and row.mode == "platform" and row.model:
        platform_selected_id = row.model
    return {
        "mode": mode,
        "enabled": bool(mode == "platform" or (selected_custom and selected_custom.enabled)),
        "provider_name": selected_custom.provider_name if selected_custom else "知萃平台",
        "model": selected_custom.model if selected_custom else (platform_selected_id or selected.id),
        "selected_offering_id": selected.id,
        "selected_offering_name": selected.name,
        "selected_custom_model_id": selected_custom.id if selected_custom else None,
        "api_base": selected_custom.api_base if selected_custom else "",
        "api_key_set": bool(selected_custom and selected_custom.encrypted_api_key),
        "api_key_masked": _mask_model(selected_custom.encrypted_api_key) if selected_custom else "",
        "policy": PLATFORM_POLICY,
        "custom_models": [_serialize_model(item) for item in custom_rows],
    }


def _validate_custom_payload(
    *,
    name: str,
    provider_name: str,
    model: str,
    api_base: str,
    api_key: str,
    existing_key: str = "",
) -> tuple[str, str, str, str]:
    clean_name = name.strip()[:80] or "OpenAI Compatible"
    clean_model = model.strip()[:160]
    clean_base = api_base.strip().rstrip("/")[:512]
    parsed = urlparse(clean_base)
    if not clean_model:
        raise ValueError("模型名称不能为空")
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise ValueError("请输入有效的 API Base 地址")
    if not api_key.strip() and not existing_key:
        raise ValueError("API Key 不能为空")
    return clean_name, provider_name.strip()[:80] or "OpenAI Compatible", clean_model, clean_base


def list_custom_models(db: Session, user_id: str) -> dict:
    rows = _model_rows(db, user_id)
    selected = _selected_model(db, user_id)
    return {
        "items": [_serialize_model(item) for item in rows],
        "selected_id": selected.id if selected else None,
        "active_selection": {
            "kind": "custom" if selected else "platform",
            "custom_model_id": selected.id if selected else None,
        },
    }


def get_custom_model(db: Session, user_id: str, model_id: str) -> dict:
    row = _owns_model(db, user_id, model_id)
    if row is None:
        raise KeyError(model_id)
    return _serialize_model(row)


def create_custom_model(
    db: Session,
    user_id: str,
    *,
    name: str,
    provider_name: str,
    model: str,
    api_base: str,
    api_key: str,
    enabled: bool = True,
    select: bool = False,
) -> dict:
    clean_name, clean_provider, clean_model, clean_base = _validate_custom_payload(
        name=name,
        provider_name=provider_name,
        model=model,
        api_base=api_base,
        api_key=api_key,
    )
    if select:
        _clear_selection(db, user_id)
    row = UserCustomChatModel(
        user_id=user_id,
        name=clean_name,
        provider_name=clean_provider,
        model=clean_model,
        api_base=clean_base,
        encrypted_api_key=settings_service.encrypt_value(api_key.strip()),
        enabled=enabled,
        is_selected=select,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_model(row)


def update_custom_model(
    db: Session,
    user_id: str,
    model_id: str,
    *,
    name: str | None = None,
    provider_name: str | None = None,
    model: str | None = None,
    api_base: str | None = None,
    api_key: str | None = None,
    enabled: bool | None = None,
) -> dict:
    row = _owns_model(db, user_id, model_id)
    if row is None:
        raise KeyError(model_id)
    next_name = name if name is not None else row.name
    next_provider = provider_name if provider_name is not None else row.provider_name
    next_model = model if model is not None else row.model
    next_base = api_base if api_base is not None else row.api_base
    clean_name, clean_provider, clean_model, clean_base = _validate_custom_payload(
        name=next_name,
        provider_name=next_provider,
        model=next_model,
        api_base=next_base,
        api_key=api_key or "",
        existing_key=row.encrypted_api_key,
    )
    row.name = clean_name
    row.provider_name = clean_provider
    row.model = clean_model
    row.api_base = clean_base
    if enabled is not None:
        row.enabled = bool(enabled)
    if api_key and api_key.strip():
        row.encrypted_api_key = settings_service.encrypt_value(api_key.strip())
    db.commit()
    db.refresh(row)
    return _serialize_model(row)


def _clear_selection(db: Session, user_id: str) -> None:
    db.query(UserCustomChatModel).filter(
        UserCustomChatModel.user_id == user_id,
        UserCustomChatModel.is_selected.is_(True),
    ).update({UserCustomChatModel.is_selected: False}, synchronize_session=False)


def delete_custom_model(db: Session, user_id: str, model_id: str) -> dict:
    row = _owns_model(db, user_id, model_id)
    if row is None:
        raise KeyError(model_id)
    was_selected = bool(row.is_selected)
    db.delete(row)
    db.commit()
    return {"deleted": True, "selection_reset": was_selected}


def select_custom_model(db: Session, user_id: str, model_id: str) -> dict:
    row = _owns_model(db, user_id, model_id)
    if row is None:
        raise KeyError(model_id)
    if not row.enabled:
        raise ValueError("停用的模型不能设为当前，请先启用")
    _clear_selection(db, user_id)
    row.is_selected = True
    db.commit()
    db.refresh(row)
    return {
        **list_custom_models(db, user_id),
        "selected": _serialize_model(row),
    }


def select_platform(db: Session, user_id: str) -> dict:
    _clear_selection(db, user_id)
    db.commit()
    return list_custom_models(db, user_id)


def effective_custom_config(db: Session, user_id: str, model_id: str | None = None) -> dict | None:
    """解析指定或当前选中的自定义模型为一个 liteLLM 友好配置。"""
    if model_id:
        row = _owns_model(db, user_id, model_id)
    else:
        row = _selected_model(db, user_id)
    if row is None or not row.enabled:
        return None
    api_key = settings_service.decrypt_value(row.encrypted_api_key)
    if not row.model or not row.api_base or not api_key:
        return None
    return {
        "provider": "custom",
        "model": row.model,
        "runtime_model": settings_service.to_litellm_model("custom", row.model),
        "api_base": row.api_base,
        "api_key": api_key,
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
    # 语法糖：把旧“保存一条自定义模型”映射为“创建/更新并选中自定义模型”。
    row = _row(db, user_id)
    if row and row.mode == "platform":
        create_custom_model(
            db,
            user_id,
            name=provider_name.strip() or "OpenAI Compatible",
            provider_name=provider_name,
            model=model,
            api_base=api_base,
            api_key=api_key,
            select=True,
        )
        return serialize(db, user_id)
    existing = _selected_model(db, user_id)
    if existing is not None:
        update_custom_model(
            db,
            user_id,
            existing.id,
            provider_name=provider_name or None,
            model=model or None,
            api_base=api_base or None,
            api_key=api_key or None,
        )
    else:
        create_custom_model(
            db,
            user_id,
            name=provider_name.strip() or "OpenAI Compatible",
            provider_name=provider_name,
            model=model,
            api_base=api_base,
            api_key=api_key,
            select=True,
        )
    return serialize(db, user_id)


def reset(db: Session, user_id: str) -> dict:
    row = _row(db, user_id)
    if row:
        db.delete(row)
    _clear_selection(db, user_id)
    db.commit()
    return serialize(db, user_id)


def effective_config(db: Session, user_id: str | None) -> dict[str, str]:
    if not user_id:
        return settings_service.get_llm_config(db)
    custom = effective_custom_config(db, user_id)
    if custom is not None:
        return custom
    row = _row(db, user_id)
    from app.services import chat_model_catalog_service as catalog
    return catalog.effective_config(db, user_id, row.model if row and row.mode == "platform" else None)


def effective_vision_config(db: Session, user_id: str | None) -> dict[str, str]:
    """图片问答使用用户明确选择的模型，不执行智能路由。"""
    return effective_config(db, user_id)
