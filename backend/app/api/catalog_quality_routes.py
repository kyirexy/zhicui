"""Administrator API for creator catalog quality audit and repair."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin
from app.core.database import get_db
from app.models.user import User
from app.services import (
    audit_service,
    creator_catalog_quality_service as quality_service,
    creator_catalog_quality_worker as quality_worker,
)


router = APIRouter(prefix="/api/admin/catalog-quality", tags=["catalog-quality"])


def _ok(data: object) -> dict:
    return {"success": True, "data": data, "error": None}


def _ip(request: Request) -> str:
    return str(request.client.host if request.client else "")[:64]


class QualityRunRequest(BaseModel):
    mode: Literal["backfill", "quarantine"]
    idempotency_key: str = Field(..., min_length=8, max_length=96)
    platform: Literal["douyin", "bilibili"] | None = None
    batch_size: int = Field(50, ge=1, le=200)
    cooldown_seconds: int = Field(5, ge=0, le=3600)


@router.get("/preview")
def preview_catalog_quality(
    platform: Literal["douyin", "bilibili"] | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    try:
        return _ok(quality_service.preview(db, platform=platform or ""))
    except quality_service.CatalogQualityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/runs")
def list_quality_runs(
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    return _ok({"items": [run.to_dict() for run in quality_service.list_runs(db, limit=limit)]})


@router.post("/runs")
def create_quality_run(
    body: QualityRunRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
) -> dict:
    try:
        run, reused = quality_service.create_run(
            db,
            requested_by_id=admin.id,
            mode=body.mode,
            idempotency_key=body.idempotency_key,
            platform=body.platform or "",
            batch_size=body.batch_size,
            cooldown_seconds=body.cooldown_seconds,
        )
    except quality_service.CatalogQualityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    scheduled = False
    if run.status not in quality_service.TERMINAL_STATUSES:
        scheduled = quality_worker.runner.submit(run.id)
    audit_service.log_action(
        db,
        admin_user_id=admin.id,
        action="catalog_quality_run_create",
        target_type="creator_catalog_quality_run",
        target_id=run.id,
        detail={
            "mode": run.mode,
            "platform": run.platform or None,
            "batch_size": run.batch_size,
            "reused": reused,
        },
        ip=_ip(request),
    )
    return _ok({"run": run.to_dict(), "reused": reused, "scheduled": scheduled})


@router.get("/runs/{run_id}")
def get_quality_run(
    run_id: str,
    item_limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    run = quality_service.get_run(db, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="质量任务不存在")
    return _ok({
        "run": run.to_dict(),
        "items": [
            item.to_dict()
            for item in quality_service.list_run_items(
                db, run_id=run.id, limit=item_limit,
            )
        ],
    })


@router.post("/runs/{run_id}/process")
def process_quality_run(
    run_id: str,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
) -> dict:
    if quality_service.get_run(db, run_id) is None:
        raise HTTPException(status_code=404, detail="质量任务不存在")
    scheduled = quality_worker.runner.submit(run_id)
    result = quality_service.get_run(db, run_id)
    audit_service.log_action(
        db,
        admin_user_id=admin.id,
        action="catalog_quality_run_process",
        target_type="creator_catalog_quality_run",
        target_id=run_id,
        detail={"status": result.status if result is not None else None, "scheduled": scheduled},
        ip=_ip(request),
    )
    return _ok({
        "run": result.to_dict() if result is not None else None,
        "scheduled": scheduled,
    })


@router.post("/runs/{run_id}/cancel")
def cancel_quality_run(
    run_id: str,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
) -> dict:
    run = quality_service.request_cancel(db, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="质量任务不存在")
    audit_service.log_action(
        db,
        admin_user_id=admin.id,
        action="catalog_quality_run_cancel",
        target_type="creator_catalog_quality_run",
        target_id=run_id,
        detail={"status": run.status},
        ip=_ip(request),
    )
    return _ok(run.to_dict())
