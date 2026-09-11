"""网页端用户本人扫码授权入口，与 CLI 共用绑定服务。"""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import bilibili_binding_service as binding

router = APIRouter(prefix="/api/platform-connections/bilibili")


class PollInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")


def respond(operation):
    try:
        data = operation()
        content, status = {"success": True, "data": data, "error": None}, 200
    except binding.BilibiliBindingError as exc:
        content, status = {"success": False, "data": None, "error": str(exc), "code": exc.code}, exc.status_code
    return JSONResponse(content=content, status_code=status, headers={"Cache-Control": "no-store"})


@router.get("")
def status(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return respond(lambda: binding.public(binding.get(db, user.id)))


@router.post("/login")
def start(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return respond(lambda: binding.login_start(db, user.id))


@router.post("/login/poll")
def poll(body: PollInput, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return respond(lambda: binding.login_poll(db, user.id, body.session_id))


@router.delete("")
def disconnect(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return respond(lambda: binding.disconnect(db, user.id))
