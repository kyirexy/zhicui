"""首页视频操作，不删除来源或触发同步、转写。"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StrictBool
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import home_video_service

router = APIRouter(prefix="/api/home", tags=["首页视频"])


class VideoKey(BaseModel):
    platform: Literal["douyin", "bilibili"]
    video_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class Visibility(VideoKey):
    hidden: StrictBool


def _result(response: Response, action):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    try:
        return {"success": True, "data": action(), "error": None}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/video-preferences")
def list_preferences(response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _result(response, lambda: {"items": home_video_service.list_preferences(db, user.id)})


@router.patch("/video-preferences")
def set_visibility(body: Visibility, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _result(response, lambda: home_video_service.set_hidden(db, user.id, body.platform, body.video_id, body.hidden))


@router.post("/knowledge")
def save_video(body: VideoKey, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _result(response, lambda: home_video_service.save_to_knowledge(db, user.id, body.platform, body.video_id))
