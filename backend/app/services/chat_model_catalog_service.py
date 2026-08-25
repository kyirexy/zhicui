"""管理员发布的聊天模型目录和用户安全视图。"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.models.chat_model import ChatModelFreeUsage, ChatModelOffering
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.services import settings_service
from app.services.user_ai_provider_service import omniroute_config


CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{1,79}$")
PROVIDER_MODES = {"platform", "omniroute"}


def _is_auto_model(model_id: str) -> bool:
    value = model_id.strip().lower()
    return value == "auto" or value.startswith("auto/")


def _validate(*, code: str, name: str, provider_mode: str, model_id: str) -> tuple[str, str, str, str]:
    clean_code = code.strip().lower()
    clean_name = name.strip()
    clean_provider = provider_mode.strip().lower()
    clean_model = model_id.strip()
    if not CODE_PATTERN.fullmatch(clean_code):
        raise ValueError("模型代码只能包含小写字母、数字、下划线和短横线")
    if not clean_name:
        raise ValueError("模型展示名称不能为空")
    if clean_provider not in PROVIDER_MODES:
        raise ValueError("模型运行来源无效")
    if not clean_model:
        raise ValueError("真实模型 ID 不能为空")
    if _is_auto_model(clean_model):
        raise ValueError("不支持智能选择，请配置一个明确的模型 ID")
    return clean_code, clean_name[:120], clean_provider, clean_model[:160]


def _today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def _icon_key(row: ChatModelOffering) -> str:
    """只下发品牌标识，不向用户暴露网关内部的真实模型 ID。"""
    value = f"{row.model_id} {row.code} {row.name}".lower()
    aliases = (
        ("deepseek", ("deepseek", "深度求索")),
        ("mimo", ("mimo", "xiaomi", "小米大模型")),
        ("hunyuan", ("hy3", "hunyuan", "混元")),
        ("felo", ("felo",)),
        ("openai", ("openai", "gpt-", "chatgpt")),
        ("claude", ("claude", "anthropic")),
        ("gemini", ("gemini", "google ai")),
        ("qwen", ("qwen", "千问", "通义")),
        ("doubao", ("doubao", "豆包")),
        ("kimi", ("kimi", "moonshot", "月之暗面")),
        ("minimax", ("minimax", "海螺")),
        ("mistral", ("mistral",)),
        ("meta", ("llama", "meta-ai", "meta ai")),
        ("grok", ("grok", "xai")),
        ("groq", ("groq",)),
        ("nvidia", ("nvidia", "nemotron")),
        ("siliconcloud", ("siliconflow", "silicon cloud", "硅基流动")),
        ("openrouter", ("openrouter",)),
        ("cohere", ("cohere", "command-r")),
        ("perplexity", ("perplexity",)),
        ("zhipu", ("zhipu", "glm", "智谱")),
    )
    return next((brand for brand, names in aliases if any(name in value for name in names)), "unknown")


def _usage(db: Session, user_id: str, offering_id: str) -> ChatModelFreeUsage | None:
    return db.query(ChatModelFreeUsage).filter(
        ChatModelFreeUsage.user_id == user_id,
        ChatModelFreeUsage.offering_id == offering_id,
        ChatModelFreeUsage.period_date == _today(),
    ).first()


def serialize_admin(row: ChatModelOffering) -> dict[str, Any]:
    try:
        metadata = json.loads(row.metadata_json or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        metadata = {}
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "provider_mode": row.provider_mode,
        "model_id": row.model_id,
        "enabled": bool(row.enabled),
        "visible_to_users": bool(row.visible_to_users),
        "is_default": bool(row.is_default),
        "is_free": bool(row.is_free),
        "free_daily_limit": int(row.free_daily_limit or 0),
        "points_per_request": int(row.points_per_request or 0),
        "supports_images": bool(row.supports_images),
        "supports_tools": bool(row.supports_tools),
        "sort_order": int(row.sort_order or 0),
        "metadata": metadata if isinstance(metadata, dict) else {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def serialize_user(db: Session, row: ChatModelOffering, user_id: str) -> dict[str, Any]:
    usage = _usage(db, user_id, row.id) if row.is_free else None
    limit = max(0, int(row.free_daily_limit or 0))
    used = int(usage.used_count or 0) if usage else 0
    reserved = int(usage.reserved_count or 0) if usage else 0
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "icon_key": _icon_key(row),
        "is_default": bool(row.is_default),
        "is_free": bool(row.is_free),
        "free_daily_limit": limit,
        "free_used_today": used,
        "free_remaining_today": None if limit == 0 else max(0, limit - used - reserved),
        "points_per_request": 0 if row.is_free else int(row.points_per_request or 0),
        "supports_images": bool(row.supports_images),
        "supports_tools": bool(row.supports_tools),
    }


def list_admin(db: Session) -> list[ChatModelOffering]:
    return db.query(ChatModelOffering).order_by(
        ChatModelOffering.sort_order.asc(), ChatModelOffering.created_at.asc()
    ).all()


def list_published(db: Session) -> list[ChatModelOffering]:
    ensure_default_offering(db)
    return db.query(ChatModelOffering).filter(
        ChatModelOffering.enabled.is_(True),
        ChatModelOffering.visible_to_users.is_(True),
    ).order_by(
        ChatModelOffering.sort_order.asc(), ChatModelOffering.created_at.asc()
    ).all()


def get_published(db: Session, offering_id: str) -> ChatModelOffering | None:
    return db.query(ChatModelOffering).filter(
        ChatModelOffering.id == offering_id,
        ChatModelOffering.enabled.is_(True),
        ChatModelOffering.visible_to_users.is_(True),
    ).first()


def default_offering(db: Session) -> ChatModelOffering:
    rows = list_published(db)
    selected = next((row for row in rows if row.is_default), None)
    return selected or rows[0]


def ensure_default_offering(db: Session) -> ChatModelOffering:
    published = db.query(ChatModelOffering).filter(
        ChatModelOffering.enabled.is_(True),
        ChatModelOffering.visible_to_users.is_(True),
    ).order_by(ChatModelOffering.sort_order.asc()).all()
    if published:
        selected = next((item for item in published if item.is_default), published[0])
        if not selected.is_default or sum(1 for item in published if item.is_default) > 1:
            db.query(ChatModelOffering).update(
                {ChatModelOffering.is_default: False}, synchronize_session=False
            )
            selected.is_default = True
            db.add(selected)
            db.commit()
            db.refresh(selected)
        return selected
    config = settings_service.get_llm_config(db)
    model_id = str(config.get("model") or "mimo-v2.5-pro").strip()
    if _is_auto_model(model_id):
        model_id = "mimo-v2.5-pro"
    row = db.query(ChatModelOffering).filter(
        ChatModelOffering.code == "platform-free"
    ).first() or ChatModelOffering(code="platform-free")
    row.name = "免费模型"
    row.description = "日常问答与视频资料整理"
    row.provider_mode = "platform"
    row.model_id = model_id
    row.enabled = True
    row.visible_to_users = True
    row.is_default = True
    row.is_free = True
    row.free_daily_limit = 30
    row.points_per_request = 0
    row.sort_order = 10
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save(
    db: Session,
    *,
    offering_id: str | None,
    code: str,
    name: str,
    description: str,
    provider_mode: str,
    model_id: str,
    enabled: bool,
    visible_to_users: bool,
    is_default: bool,
    is_free: bool,
    free_daily_limit: int,
    points_per_request: int,
    supports_images: bool,
    supports_tools: bool,
    sort_order: int,
) -> ChatModelOffering:
    clean_code, clean_name, clean_provider, clean_model = _validate(
        code=code, name=name, provider_mode=provider_mode, model_id=model_id
    )
    duplicate = db.query(ChatModelOffering).filter(ChatModelOffering.code == clean_code)
    if offering_id:
        duplicate = duplicate.filter(ChatModelOffering.id != offering_id)
    if duplicate.first():
        raise ValueError("模型代码已存在")
    row = db.query(ChatModelOffering).filter(ChatModelOffering.id == offering_id).first() if offering_id else None
    if offering_id and row is None:
        raise ValueError("聊天模型不存在")
    row = row or ChatModelOffering()
    row.code = clean_code
    row.name = clean_name
    row.description = description.strip()[:300]
    row.provider_mode = clean_provider
    row.model_id = clean_model
    row.enabled = bool(enabled)
    row.visible_to_users = bool(visible_to_users)
    row.is_default = bool(is_default and enabled and visible_to_users)
    row.is_free = bool(is_free)
    row.free_daily_limit = max(0, min(int(free_daily_limit), 100_000))
    row.points_per_request = 0 if row.is_free else max(0, int(points_per_request))
    row.supports_images = bool(supports_images)
    row.supports_tools = bool(supports_tools)
    row.sort_order = max(0, min(int(sort_order), 100_000))
    if row.is_default:
        db.query(ChatModelOffering).filter(ChatModelOffering.id != row.id).update(
            {ChatModelOffering.is_default: False}, synchronize_session=False
        )
    db.add(row)
    db.commit()
    db.refresh(row)
    if not row.is_default:
        ensure_default_offering(db)
    return row


def delete(db: Session, offering_id: str) -> bool:
    row = db.query(ChatModelOffering).filter(ChatModelOffering.id == offering_id).first()
    if row is None:
        return False
    if row.is_default:
        raise ValueError("默认模型不能删除，请先设置其他默认模型")
    db.delete(row)
    db.commit()
    return True


def selected_offering(db: Session, user_id: str) -> ChatModelOffering:
    config = db.query(UserAIProviderConfig).filter(UserAIProviderConfig.user_id == user_id).first()
    if config and config.mode == "platform" and config.model:
        selected = get_published(db, config.model)
        if selected is not None:
            return selected
    return default_offering(db)


def select_for_user(db: Session, user_id: str, offering_id: str) -> ChatModelOffering:
    offering = get_published(db, offering_id)
    if offering is None:
        raise ValueError("该模型未发布或已停用")
    row = db.query(UserAIProviderConfig).filter(UserAIProviderConfig.user_id == user_id).first()
    row = row or UserAIProviderConfig(user_id=user_id)
    row.mode = "platform"
    row.model = offering.id
    row.provider_name = "知萃平台"
    row.api_base = ""
    row.enabled = True
    db.add(row)
    db.commit()
    return offering


def effective_config(db: Session, user_id: str, offering_id: str | None = None) -> dict[str, str]:
    offering = get_published(db, offering_id or "") if offering_id else selected_offering(db, user_id)
    offering = offering or default_offering(db)
    if offering.provider_mode == "omniroute":
        omni = omniroute_config(db)
        if not omni["available"]:
            raise ValueError("该模型服务暂时不可用，请选择其他模型")
        return {
            "provider": "omniroute",
            "model": offering.model_id,
            "runtime_model": offering.model_id if offering.model_id.startswith("openai/") else f"openai/{offering.model_id}",
            "api_base": str(omni["api_base"]),
            "api_key": str(omni["api_key"]),
            "offering_id": offering.id,
        }
    config = settings_service.get_llm_config(db)
    # 平台模型 ID（如 SiliconFlow 的 `deepseek-ai/DeepSeek-V3`）只是网关内
    # 的资源名，不能靠“是否含 /”来猜供应商；统一按当前供应商规范补前缀。
    runtime_model = settings_service.to_litellm_model(
        str(config.get("provider") or ""),
        offering.model_id,
    )
    return {
        **config,
        "model": offering.model_id,
        "runtime_model": runtime_model,
        "offering_id": offering.id,
    }
