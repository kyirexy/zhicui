"""Production readiness and administrator alert endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin
from app.core.database import get_db
from app.models.user import User
from app.services import operational_alert_service, readiness_service


router = APIRouter(tags=["operations"])


def _ok(data: object) -> dict[str, object]:
    return {"success": True, "data": data, "error": None}


@router.get("/api/readiness")
def public_readiness(db: Session = Depends(get_db)):
    result = readiness_service.get_readiness(db)
    summary = readiness_service.public_summary(result)
    return JSONResponse(
        status_code=200 if result.get("status") == "ready" else 503,
        headers={"Cache-Control": "no-store"},
        content=_ok(summary),
    )


@router.get("/api/admin/readiness")
def admin_readiness(
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
) -> dict[str, object]:
    return _ok(readiness_service.get_readiness(db, force=refresh))


@router.get("/api/admin/operational-alerts")
def admin_alerts(
    status: str | None = Query(None),
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
) -> dict[str, object]:
    refresh_result = operational_alert_service.refresh_alerts(db) if refresh else None
    return _ok({
        "items": operational_alert_service.list_alerts(db, status=status),
        "refresh": refresh_result,
    })


@router.post("/api/admin/operational-alerts/{alert_id}/acknowledge")
def admin_acknowledge_alert(
    alert_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin),
) -> dict[str, object]:
    if not operational_alert_service.acknowledge(db, alert_id, current_user.id):
        raise HTTPException(status_code=404, detail="告警不存在")
    return _ok({"acknowledged": True})
