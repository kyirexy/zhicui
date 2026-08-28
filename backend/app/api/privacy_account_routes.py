"""Public legal metadata and authenticated account-data controls."""

from __future__ import annotations

import io
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import privacy_account_service


router = APIRouter()


class PasswordReverificationRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)
    client_type: Literal["web", "windows", "android"] = "web"


class AccountDeletionConfirmRequest(BaseModel):
    confirmation_token: str = Field(..., min_length=32, max_length=160)
    confirmation_phrase: str = Field(..., min_length=1, max_length=24)


def _ok(data: object) -> dict[str, object | None]:
    return {"success": True, "data": data, "error": None}


@router.get("/api/legal/documents/current")
def current_legal_documents(response: Response) -> dict[str, object | None]:
    """Current versions are public so registration can fail closed."""
    response.headers["Cache-Control"] = "public, max-age=300, must-revalidate"
    return _ok(privacy_account_service.legal_document_summary())


@router.get("/api/account/consents")
def get_account_consents(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object | None]:
    return _ok({"items": privacy_account_service.list_consents(db, current_user.id)})


@router.post("/api/account/data-export")
def export_personal_data(
    body: PasswordReverificationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    try:
        archive_bytes, filename = privacy_account_service.build_personal_data_archive(
            db,
            user=current_user,
            password=body.password,
            client_type=body.client_type,
        )
    except privacy_account_service.AccountPasswordError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(archive_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/api/account/deletion/prepare")
def prepare_account_deletion(
    body: PasswordReverificationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object | None]:
    try:
        result = privacy_account_service.prepare_account_deletion(
            db,
            user=current_user,
            password=body.password,
            client_type=body.client_type,
        )
    except privacy_account_service.AccountPasswordError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except privacy_account_service.LastActiveAdminError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _ok(result)


@router.post("/api/account/deletion/confirm")
def confirm_account_deletion(
    body: AccountDeletionConfirmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object | None]:
    try:
        result = privacy_account_service.confirm_account_deletion(
            db,
            user=current_user,
            confirmation_token=body.confirmation_token,
            confirmation_phrase=body.confirmation_phrase,
        )
    except (
        privacy_account_service.AccountGrantError,
        privacy_account_service.LastActiveAdminError,
    ) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _ok(result)
