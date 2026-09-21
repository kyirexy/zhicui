"""Public community invite QR and administrator replacement endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.auth import get_current_admin
from app.core.database import get_db
from app.services import audit_service, community_qr_service as service

router = APIRouter()


def ok(data):
    return {"success": True, "data": data, "error": None}


@router.get("/api/community/qr-info")
def public_qr_info(db: Session = Depends(get_db)):
    return ok(service.info(db))


@router.get("/api/community/qr")
def public_qr_image(db: Session = Depends(get_db)):
    payload = service.image_bytes(db)
    if payload is None:
        raise HTTPException(404, "群二维码尚未配置")
    raw, media_type, _filename = payload
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    )


@router.get("/api/admin/community-qr")
def admin_qr_info(db: Session = Depends(get_db), admin=Depends(get_current_admin)):
    return ok(service.info(db))


@router.put("/api/admin/community-qr")
async def replace_qr(
    file: UploadFile = File(...),
    expires_at: str | None = Form(default=None),
    db: Session = Depends(get_db),
    admin=Depends(get_current_admin),
):
    raw = await file.read(service.MAX_BYTES + 1)
    result = service.save(db, raw, file.filename or "知萃交流群二维码.png", file.content_type, expires_at)
    audit_service.log_action(
        db,
        admin_user_id=admin.id,
        action="community_qr_update",
        target_type="system_setting",
        target_id=service.QR_DATA_KEY,
        detail={"filename": result.get("filename"), "expires_at": result.get("expires_at")},
    )
    return ok(result)
