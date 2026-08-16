"""按需视频详细解析的用户与管理 API。"""

from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin, get_current_user
from app.core.database import get_db
from app.models.user import User, get_user_by_id
from app.models.video_analysis import (
    AnalysisCreditLedger,
    VideoAnalysisItem,
    VideoAnalysisOffering,
    VideoAnalysisRun,
)
from app.services import audit_service
from app.services import video_analysis_billing_service as billing
from app.services import video_analysis_catalog_service as catalog
from app.services import video_analysis_service as analysis


router = APIRouter()


def _ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


def _error(exc: Exception) -> JSONResponse:
    if isinstance(
        exc,
        (
            analysis.VideoAnalysisServiceError,
            billing.VideoAnalysisBillingError,
            catalog.VideoAnalysisCatalogError,
        ),
    ):
        return JSONResponse(
            status_code=int(exc.status_code),
            content={
                "success": False,
                "data": None,
                "error": str(exc),
                "code": exc.code,
            },
        )
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "data": None,
            "error": "视频详细解析服务暂时不可用",
            "code": "video_analysis_internal_error",
        },
    )


def _ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return forwarded or (request.client.host if request.client else None)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PrepareRunRequest(StrictModel):
    note_ids: list[str] = Field(min_length=1, max_length=50)
    offering_id: str | None = None
    use_byok: bool = False
    trigger: Literal["manual", "batch"] = "manual"


class ConfirmRunRequest(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=160)


class UserVisionProviderRequest(StrictModel):
    provider_name: str = Field(min_length=1, max_length=80)
    driver: str = Field(min_length=1, max_length=48)
    model: str = Field(min_length=1, max_length=160)
    api_base: str = Field(min_length=1, max_length=512)
    api_key: str = Field(default="", max_length=4096)
    enabled: bool = True


class ProviderCreateRequest(StrictModel):
    code: str | None = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    driver: str = Field(min_length=1, max_length=48)
    default_model: str = Field(default="", max_length=160)
    model: str = Field(default="", max_length=160)
    api_base: str = Field(default="", max_length=512)
    api_key: str = Field(default="", max_length=4096)
    enabled: bool = False
    capabilities: dict[str, Any] = Field(default_factory=dict)
    metering: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)
    cost: dict[str, Any] = Field(default_factory=dict)
    max_concurrency: int = Field(default=1, ge=1, le=32)
    daily_budget_micros: int = Field(default=0, ge=0)


class ProviderUpdateRequest(StrictModel):
    name: str | None = Field(default=None, max_length=128)
    driver: str | None = Field(default=None, max_length=48)
    default_model: str | None = Field(default=None, max_length=160)
    model: str | None = Field(default=None, max_length=160)
    api_base: str | None = Field(default=None, max_length=512)
    api_key: str | None = Field(default=None, max_length=4096)
    enabled: bool | None = None
    capabilities: dict[str, Any] | None = None
    metering: dict[str, Any] | None = None
    limits: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=32)
    daily_budget_micros: int | None = Field(default=None, ge=0)


class ProviderTestRequest(StrictModel):
    model: str = Field(default="", max_length=160)


class OfferingRequestBase(StrictModel):
    name: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=512)
    method: str | None = Field(default=None, max_length=32)
    provider_id: str | None = None
    model: str | None = Field(default=None, max_length=160)
    recommended: bool | None = None
    is_recommended: bool | None = None
    sort_order: int | None = Field(default=None, ge=0, le=10000)
    byok_allowed: bool | None = None
    supports_byok: bool | None = None
    allow_byok: bool | None = None
    triggers: list[str] | None = None
    allowed_triggers: list[str] | None = None
    allow_manual: bool | None = None
    allow_batch: bool | None = None
    allow_agent: bool | None = None
    limits: dict[str, Any] | None = None
    pricing: dict[str, Any] | None = None
    price: dict[str, Any] | None = None
    free_quota: dict[str, Any] | None = None
    fallback: dict[str, Any] | None = None
    base_points: int | None = Field(default=None, ge=0)
    per_minute_points: int | None = Field(default=None, ge=0)
    per_frame_points: int | None = Field(default=None, ge=0)
    per_media_unit_points: int | None = Field(default=None, ge=0)
    min_points: int | None = Field(default=None, ge=0)
    max_points: int | None = Field(default=None, ge=0)


class OfferingCreateRequest(OfferingRequestBase):
    code: str | None = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    method: str = Field(min_length=1, max_length=32)


class OfferingUpdateRequest(OfferingRequestBase):
    pass


class RuntimeSettingsRequest(StrictModel):
    enabled: bool | None = None
    recommended_offering_id: str | None = None
    quote_ttl_seconds: int | None = Field(default=None, ge=60, le=1800)
    global_concurrency: int | None = Field(default=None, ge=1, le=4)
    agent_candidate_limit: int | None = Field(default=None, ge=1, le=10)
    agent_max_candidates: int | None = Field(default=None, ge=1, le=10)
    user_daily_points_limit: int | None = Field(default=None, ge=0)
    run_points_limit: int | None = Field(default=None, ge=0)
    scene_concurrency: int | None = Field(default=None, ge=1, le=4)
    vision_concurrency: int | None = Field(default=None, ge=1, le=4)
    retry_count: int | None = Field(default=None, ge=0, le=5)
    stale_run_minutes: int | None = Field(default=None, ge=5, le=1440)
    temporary_file_ttl_minutes: int | None = Field(default=None, ge=5, le=1440)
    provider_failure_threshold: int | None = Field(default=None, ge=1, le=20)
    provider_cooldown_minutes: int | None = Field(default=None, ge=1, le=1440)


class CreditAdjustmentRequest(StrictModel):
    points: int
    reason: str = Field(min_length=1, max_length=256)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=160)
    entry_type: Literal["grant", "purchase", "adjustment", "refund"] = "adjustment"


def _generated_code(prefix: str, value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:40]
    if len(slug) < 2:
        slug = uuid.uuid4().hex[:8]
    return f"{prefix}-{slug}"[:64]


def _offering_changes(body: OfferingRequestBase) -> dict[str, Any]:
    raw = body.model_dump(exclude_unset=True, exclude_none=True)
    changes: dict[str, Any] = {}
    for key in (
        "name",
        "description",
        "method",
        "provider_id",
        "model",
        "sort_order",
        "limits",
        "free_quota",
        "fallback",
    ):
        if key in raw:
            changes[key] = raw[key]
    recommended = raw.get("recommended", raw.get("is_recommended"))
    if recommended is not None:
        changes["recommended"] = recommended
    byok = raw.get(
        "byok_allowed", raw.get("supports_byok", raw.get("allow_byok"))
    )
    if byok is not None:
        changes["byok_allowed"] = byok
    triggers = raw.get("triggers", raw.get("allowed_triggers"))
    if triggers is None and any(
        key in raw for key in ("allow_manual", "allow_batch", "allow_agent")
    ):
        triggers = [
            name
            for name, key in (
                ("manual", "allow_manual"),
                ("batch", "allow_batch"),
                ("agent", "allow_agent"),
            )
            if bool(raw.get(key))
        ]
    if triggers is not None:
        changes["triggers"] = triggers
    pricing = dict(raw.get("pricing") or raw.get("price") or {})
    for key in (
        "base_points",
        "per_minute_points",
        "per_frame_points",
        "per_media_unit_points",
        "min_points",
        "max_points",
    ):
        if key in raw:
            pricing[key] = raw[key]
    if pricing:
        changes["pricing"] = pricing
    return changes


@router.get("/api/video-analysis/catalog")
def get_catalog(
    note_ids: str = Query(default="", max_length=4096),
    trigger: Literal["manual", "batch", "agent"] = Query(default="manual"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        data = catalog.published_catalog(db, trigger=trigger)
        account = billing.get_or_create_account(db, current_user.id)
        db.commit()
        data["account"] = billing.serialize_account(db, account, ledger_limit=5)
        byok = catalog.serialize_user_vision_config(db, current_user.id)
        for item in data.get("items", []):
            item["byok_available"] = bool(
                item.get("supports_byok")
                and byok.get("enabled")
                and byok.get("health_status") == "healthy"
            )
        clean_note_ids = list(
            dict.fromkeys(part.strip() for part in note_ids.split(",") if part.strip())
        )[:50]
        data["selected_note_count"] = len(clean_note_ids)
        return _ok(data)
    except Exception as exc:
        return _error(exc)


@router.post("/api/video-analysis/runs/prepare")
def prepare_run(
    body: PrepareRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        prepared = analysis.prepare_run(
            db,
            user_id=current_user.id,
            note_ids=body.note_ids,
            offering_id=body.offering_id,
            use_byok=body.use_byok,
            trigger=body.trigger,
        )
        if (
            prepared["can_start"]
            and not prepared["requires_confirmation"]
            and prepared["run"].get("status") == "prepared"
        ):
            confirmed = analysis.confirm_run(
                db,
                user_id=current_user.id,
                run_id=prepared["run"]["id"],
                idempotency_key=f"auto:{prepared['run']['id']}",
            )
            prepared["run"] = confirmed["run"]
            prepared["items"] = confirmed["items"]
        return _ok(prepared)
    except Exception as exc:
        return _error(exc)


@router.post("/api/video-analysis/runs/{run_id}/confirm")
def confirm_run(
    run_id: str,
    body: ConfirmRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        current = analysis.get_run(db, user_id=current_user.id, run_id=run_id)
        if current is not None and current.trigger == "agent":
            raise analysis.VideoAnalysisServiceError(
                "agent_run_controlled",
                "Agent 视频解析必须在原审批卡中确认",
                status_code=409,
            )
        return _ok(
            analysis.confirm_run(
                db,
                user_id=current_user.id,
                run_id=run_id,
                idempotency_key=body.idempotency_key,
            )
        )
    except Exception as exc:
        return _error(exc)


@router.get("/api/video-analysis/runs/{run_id}")
def get_run(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    run = analysis.get_run(db, user_id=current_user.id, run_id=run_id)
    if run is None:
        return _error(
            analysis.VideoAnalysisServiceError(
                "run_not_found", "解析任务不存在", status_code=404
            )
        )
    items = analysis._run_items(db, run.id)
    return _ok(
        {
            "run": analysis.serialize_run(run, items=items),
            "items": [analysis.serialize_item(item) for item in items],
        }
    )


@router.get("/api/video-analysis/runs")
def list_runs(
    status: str = Query(default="active", max_length=32),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(VideoAnalysisRun).filter(VideoAnalysisRun.user_id == current_user.id)
    if status == "active":
        query = query.filter(VideoAnalysisRun.status.in_(analysis.ACTIVE_RUN_STATUSES))
    elif status == "recent":
        query = query.filter(~VideoAnalysisRun.status.in_(["prepared"]))
    elif status != "all":
        query = query.filter(VideoAnalysisRun.status == status)
    total = query.count()
    rows = (
        query.order_by(VideoAnalysisRun.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return _ok(
        {
            "items": [
                analysis.serialize_run(
                    row,
                    items=analysis._run_items(db, row.id),
                )
                for row in rows
            ],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )


@router.delete("/api/video-analysis/runs/{run_id}")
def cancel_run(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        current = analysis.get_run(db, user_id=current_user.id, run_id=run_id)
        if current is not None and current.trigger == "agent":
            raise analysis.VideoAnalysisServiceError(
                "agent_run_controlled",
                "请返回原 Agent 任务处理这次视频解析",
                status_code=409,
            )
        return _ok(analysis.cancel_run(db, user_id=current_user.id, run_id=run_id))
    except Exception as exc:
        return _error(exc)


@router.post("/api/video-analysis/runs/{run_id}/cancel")
def cancel_run_alias(
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return cancel_run(run_id, db, current_user)


@router.get("/api/user/video-analysis/account")
def get_account(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    account = billing.get_or_create_account(db, current_user.id)
    db.commit()
    return _ok(billing.serialize_account(db, account))


def _vision_with_drivers(data: dict[str, Any]) -> dict[str, Any]:
    return {
        **data,
        "supported_drivers": [
            {
                "value": "openai_compatible",
                "label": "OpenAI 兼容图片模型",
                "supports_images": True,
            },
            {
                "value": "litellm_image",
                "label": "LiteLLM 图片模型",
                "supports_images": True,
            },
        ],
    }


@router.get("/api/user/vision-provider")
def get_user_vision_provider(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _ok(_vision_with_drivers(catalog.serialize_user_vision_config(db, current_user.id)))


@router.put("/api/user/vision-provider")
def put_user_vision_provider(
    body: UserVisionProviderRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        data = catalog.save_user_vision_config(
            db,
            current_user.id,
            **body.model_dump(),
        )
        return _ok(_vision_with_drivers(data))
    except Exception as exc:
        return _error(exc)


@router.delete("/api/user/vision-provider")
def delete_user_vision_provider(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        return _ok(
            _vision_with_drivers(
                catalog.delete_user_vision_config(db, current_user.id)
            )
        )
    except Exception as exc:
        return _error(exc)


@router.post("/api/user/vision-provider/test")
def test_user_vision_provider(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        result = catalog.test_user_vision_config(db, current_user.id)
        result["connected"] = bool(result.get("ok"))
        result["config"] = _vision_with_drivers(result["config"])
        return _ok(result)
    except Exception as exc:
        return _error(exc)


@router.get("/api/admin/video-analysis/providers")
def admin_list_providers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    rows = catalog.list_providers(db)
    return _ok({"items": [catalog.serialize_provider(row) for row in rows], "total": len(rows)})


@router.post("/api/admin/video-analysis/providers")
def admin_create_provider(
    body: ProviderCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        payload = body.model_dump()
        payload["code"] = body.code or _generated_code("provider", body.name)
        payload["default_model"] = body.default_model or body.model
        payload.pop("model", None)
        row = catalog.create_provider(db, **payload)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_provider_create",
            target_type="vision_provider",
            target_id=row.id,
            detail={"code": row.code, "driver": row.driver},
            ip=_ip(request),
        )
        return _ok(catalog.serialize_provider(row))
    except Exception as exc:
        return _error(exc)


@router.patch("/api/admin/video-analysis/providers/{provider_id}")
def admin_update_provider(
    provider_id: str,
    body: ProviderUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_provider(db, provider_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "provider_not_found", "视觉 Provider 不存在", status_code=404
            )
        changes = body.model_dump(exclude_unset=True)
        if "default_model" not in changes and "model" in changes:
            changes["default_model"] = changes["model"]
        changes.pop("model", None)
        row = catalog.update_provider(db, row, **changes)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_provider_update",
            target_type="vision_provider",
            target_id=row.id,
            detail={"fields": sorted(key for key in changes if key != "api_key")},
            ip=_ip(request),
        )
        return _ok(catalog.serialize_provider(row))
    except Exception as exc:
        return _error(exc)


@router.delete("/api/admin/video-analysis/providers/{provider_id}")
def admin_disable_provider(
    provider_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_provider(db, provider_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "provider_not_found", "视觉 Provider 不存在", status_code=404
            )
        row = catalog.disable_provider(db, row)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_provider_disable",
            target_type="vision_provider",
            target_id=row.id,
            ip=_ip(request),
        )
        return _ok(catalog.serialize_provider(row))
    except Exception as exc:
        return _error(exc)


@router.post("/api/admin/video-analysis/providers/{provider_id}/test")
def admin_test_provider(
    provider_id: str,
    body: ProviderTestRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_provider(db, provider_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "provider_not_found", "视觉 Provider 不存在", status_code=404
            )
        result = catalog.test_provider(db, row, model=body.model)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_provider_test",
            target_type="vision_provider",
            target_id=row.id,
            detail={"ok": bool(result["ok"])},
            ip=_ip(request),
        )
        return _ok(result)
    except Exception as exc:
        return _error(exc)


@router.get("/api/admin/video-analysis/offerings")
def admin_list_offerings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    rows = catalog.list_offerings(db)
    return _ok({"items": [catalog.serialize_offering(row) for row in rows], "total": len(rows)})


@router.post("/api/admin/video-analysis/offerings")
def admin_create_offering(
    body: OfferingCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        changes = _offering_changes(body)
        row = catalog.create_offering(
            db,
            code=body.code or _generated_code("offering", body.name),
            **changes,
        )
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_offering_create",
            target_type="video_analysis_offering",
            target_id=row.id,
            detail={"code": row.code, "method": row.method},
            ip=_ip(request),
        )
        return _ok(catalog.serialize_offering(row))
    except Exception as exc:
        return _error(exc)


@router.patch("/api/admin/video-analysis/offerings/{offering_id}")
def admin_update_offering(
    offering_id: str,
    body: OfferingUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_offering(db, offering_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "offering_not_found", "解析方案不存在", status_code=404
            )
        changes = _offering_changes(body)
        row = catalog.update_offering(db, row, **changes)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_offering_update",
            target_type="video_analysis_offering",
            target_id=row.id,
            detail={"fields": sorted(changes)},
            ip=_ip(request),
        )
        return _ok(catalog.serialize_offering(row))
    except Exception as exc:
        return _error(exc)


@router.post("/api/admin/video-analysis/offerings/{offering_id}/publish")
def admin_publish_offering(
    offering_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_offering(db, offering_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "offering_not_found", "解析方案不存在", status_code=404
            )
        version = catalog.publish_offering(db, row, admin_user_id=current_user.id)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_offering_publish",
            target_type="video_analysis_offering",
            target_id=row.id,
            detail={"version": version.version_number, "version_id": version.id},
            ip=_ip(request),
        )
        db.refresh(row)
        return _ok(catalog.serialize_offering(row, version=version))
    except Exception as exc:
        return _error(exc)


@router.delete("/api/admin/video-analysis/offerings/{offering_id}")
def admin_disable_offering(
    offering_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        row = catalog.get_offering(db, offering_id)
        if row is None:
            raise catalog.VideoAnalysisCatalogError(
                "offering_not_found", "解析方案不存在", status_code=404
            )
        row = catalog.disable_offering(db, row)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_offering_disable",
            target_type="video_analysis_offering",
            target_id=row.id,
            ip=_ip(request),
        )
        return _ok(catalog.serialize_offering(row))
    except Exception as exc:
        return _error(exc)


@router.get("/api/admin/video-analysis/settings")
def admin_get_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    return _ok(catalog.get_runtime_settings(db))


@router.put("/api/admin/video-analysis/settings")
def admin_put_settings(
    body: RuntimeSettingsRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        changes = body.model_dump(exclude_unset=True)
        data = catalog.save_runtime_settings(db, **changes)
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_settings_update",
            target_type="system_setting",
            target_id="video_analysis",
            detail={"fields": sorted(changes)},
            ip=_ip(request),
        )
        return _ok(data)
    except Exception as exc:
        return _error(exc)


@router.get("/api/admin/video-analysis/runs")
def admin_list_runs(
    status: str = Query(default="all", max_length=32),
    user_id: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    rows = analysis.list_runs(db, user_id=user_id, status=status, limit=limit)
    return _ok(
        {
            "items": [
                analysis.serialize_run(
                    row,
                    items=analysis._run_items(db, row.id),
                    internal=True,
                )
                for row in rows
            ],
            "total": len(rows),
        }
    )


@router.get("/api/admin/video-analysis/ledger")
def admin_list_ledger(
    user_id: str | None = Query(default=None, max_length=64),
    run_id: str | None = Query(default=None, max_length=36),
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    query = db.query(AnalysisCreditLedger)
    if user_id:
        query = query.filter(AnalysisCreditLedger.user_id == user_id)
    if run_id:
        query = query.filter(AnalysisCreditLedger.run_id == run_id)
    total = query.count()
    rows = (
        query.order_by(AnalysisCreditLedger.created_at.desc(), AnalysisCreditLedger.id.desc())
        .limit(limit)
        .all()
    )
    return _ok({"items": [billing.serialize_ledger_entry(row) for row in rows], "total": total})


@router.get("/api/admin/video-analysis/usage")
def admin_usage(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    def count_runs(status: str) -> int:
        return int(
            db.query(func.count(VideoAnalysisRun.id))
            .filter(VideoAnalysisRun.status == status)
            .scalar()
            or 0
        )

    def sum_items(column: Any, *filters: Any) -> int:
        query = db.query(func.coalesce(func.sum(column), 0))
        if filters:
            query = query.filter(*filters)
        return int(query.scalar() or 0)

    points_refunded = int(
        db.query(func.coalesce(func.sum(AnalysisCreditLedger.available_delta), 0))
        .filter(AnalysisCreditLedger.entry_type == "refund")
        .scalar()
        or 0
    )
    released_points = int(
        db.query(func.coalesce(func.sum(AnalysisCreditLedger.available_delta), 0))
        .filter(AnalysisCreditLedger.entry_type == "release")
        .scalar()
        or 0
    )
    provider_cost = sum_items(VideoAnalysisItem.platform_cost_micros)
    failure_cost = sum_items(VideoAnalysisItem.failure_cost_micros)
    reconciliation_pending = int(
        db.query(func.count(VideoAnalysisItem.id))
        .filter(VideoAnalysisItem.billing_status == "reconciliation_pending")
        .scalar()
        or 0
    )
    provisional_cost = sum_items(
        VideoAnalysisItem.failure_cost_micros,
        VideoAnalysisItem.billing_status == "reconciliation_pending",
    )
    runs = int(db.query(func.count(VideoAnalysisRun.id)).scalar() or 0)
    items = int(db.query(func.count(VideoAnalysisItem.id)).scalar() or 0)
    succeeded = count_runs("succeeded")
    partial = count_runs("partial")
    failed = count_runs("failed")
    data = {
        "runs": runs,
        "items": items,
        "succeeded": succeeded,
        "succeeded_runs": succeeded,
        "partial": partial,
        "partial_runs": partial,
        "failed": failed,
        "failed_runs": failed,
        "cancelled_runs": count_runs("cancelled"),
        "active_runs": int(
            db.query(func.count(VideoAnalysisRun.id))
            .filter(VideoAnalysisRun.status.in_(analysis.ACTIVE_RUN_STATUSES))
            .scalar()
            or 0
        ),
        "byok_runs": int(
            db.query(func.count(VideoAnalysisRun.id))
            .filter(VideoAnalysisRun.use_byok.is_(True))
            .scalar()
            or 0
        ),
        "cache_hits": int(
            db.query(func.count(VideoAnalysisItem.id))
            .filter(VideoAnalysisItem.status == "cached")
            .scalar()
            or 0
        ),
        "quoted_points": int(
            db.query(func.coalesce(func.sum(VideoAnalysisRun.quoted_points), 0)).scalar()
            or 0
        ),
        "captured_points": sum_items(VideoAnalysisItem.captured_points),
        "points_captured": sum_items(VideoAnalysisItem.captured_points),
        "released_points": released_points,
        "refunded_points": points_refunded,
        "points_refunded": points_refunded,
        "platform_cost_micros": provider_cost,
        "provider_cost_micros": provider_cost,
        "failure_cost_micros": failure_cost,
        "reconciliation_pending_items": reconciliation_pending,
        "provisional_cost_micros": provisional_cost,
    }
    return _ok(data)


@router.get("/api/admin/video-analysis/users/{user_id}/account")
def admin_user_account(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    if get_user_by_id(db, user_id) is None:
        return _error(
            billing.VideoAnalysisBillingError("user_not_found", "用户不存在", status_code=404)
        )
    account = billing.get_or_create_account(db, user_id)
    db.commit()
    return _ok(billing.serialize_account(db, account, ledger_limit=50))


@router.post("/api/admin/video-analysis/users/{user_id}/credits")
def admin_adjust_credits(
    user_id: str,
    body: CreditAdjustmentRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
):
    try:
        if get_user_by_id(db, user_id) is None:
            raise billing.VideoAnalysisBillingError(
                "user_not_found", "用户不存在", status_code=404
            )
        account = billing.adjust_credits(
            db,
            user_id=user_id,
            points_delta=body.points,
            reason=body.reason,
            admin_user_id=current_user.id,
            idempotency_key=body.idempotency_key
            or f"admin-credit:{current_user.id}:{uuid.uuid4()}",
            entry_type=body.entry_type,
        )
        audit_service.log_action(
            db,
            admin_user_id=current_user.id,
            action="video_analysis_credit_adjust",
            target_type="user_analysis_account",
            target_id=user_id,
            detail={
                "points": body.points,
                "reason": body.reason,
                "entry_type": body.entry_type,
            },
            ip=_ip(request),
        )
        return _ok(billing.serialize_account(db, account, ledger_limit=50))
    except Exception as exc:
        return _error(exc)
