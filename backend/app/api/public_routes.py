"""Small public endpoints that do not belong to the authenticated API module."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from app.services import app_release_service

router = APIRouter()


def _ok(data: object) -> dict[str, object]:
    return {"success": True, "data": data, "error": None}


@router.get("/api/health")
def health_check() -> dict[str, object]:
    """Simple liveness probe."""
    return _ok({"status": "ok", "service": "zhicui-knowbrew"})


@router.get("/api/app/releases/latest")
def latest_android_release(response: Response) -> dict[str, object]:
    """Return public, cache-resistant Android release metadata."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    try:
        return _ok(app_release_service.get_latest_android_release())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
