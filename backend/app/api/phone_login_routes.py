"""电脑已登录时授权手机登录，所有秘密仅出现在不缓存的请求/响应体。"""
from typing import Literal
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import phone_login_service as service, auth_service, activity_service
from app.api.desktop_login_routes import _response

router = APIRouter(prefix="/api/auth/phone-login/sessions")


class ClaimBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scan_secret: str
    claim_secret: str
    client_type: Literal["android", "ios"]


class TokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    claim_secret: str


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "cancel"]
    verification_code: str = ""


def result(data):
    if data is None:
        return _response(error="登录码无效、已被其他手机扫描或无权操作，请在电脑上重新生成", status_code=404)
    if data.get("error"):
        return _response(error=data["error"], status_code=409)
    return _response(data)


@router.post("", include_in_schema=False)
def create(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return result(service.create(db, user.id))


@router.post("/{session_id}/status", include_in_schema=False)
def status(session_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = service.owned(db, session_id, user.id)
    return result(service.public(row) if row else None)


@router.post("/{session_id}/claim", include_in_schema=False)
def claim(session_id: str, body: ClaimBody, db: Session = Depends(get_db)):
    return result(service.claim(db, session_id, body.scan_secret, body.claim_secret, body.client_type))


@router.post("/{session_id}/decision", include_in_schema=False)
def decision(session_id: str, body: DecisionBody, request: Request,
             db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    data = service.decide(db, session_id, user.id, body.decision, body.verification_code)
    if data and not data.get("error"):
        activity_service.log_activity_safely(user_id=user.id, action="phone_login_" + body.decision,
            method="POST", path="/api/auth/phone-login/sessions/{session_id}/decision", status_code=200,
            ip=request.client.host if request.client else None,
            detail={"session_id": session_id, "status": data["status"]},
            event_key=f"phone-login:{session_id}:{body.decision}")
    return result(data)


@router.post("/{session_id}/token", include_in_schema=False)
def token(session_id: str, body: TokenBody, request: Request, db: Session = Depends(get_db)):
    data, user = service.consume(db, session_id, body.claim_secret)
    if user is not None:
        data = {**data, "token": auth_service.create_access_token(user.id, user.email, session_id=session_id), "user": user.to_dict()}
        activity_service.log_activity_safely(user_id=user.id, action="phone_login_consumed", method="POST",
            path="/api/auth/phone-login/sessions/{session_id}/token", status_code=200,
            ip=request.client.host if request.client else None, detail={"session_id": session_id},
            event_key=f"phone-login:{session_id}:consumed")
    return result(data)
