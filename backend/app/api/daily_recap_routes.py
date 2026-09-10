"""首页昨日回顾；日期依据首次同步台账，不触发平台抓取或模型请求。"""

from datetime import date as Date

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.services import daily_recap_service

router = APIRouter(prefix="/api/library", tags=["视频资料回顾"])


@router.get("/daily-recap")
def get_daily_recap(
    response: Response,
    date: Date | None = Query(None),
    timezone: str = Query("Asia/Shanghai", min_length=1, max_length=64),
    limit: int = Query(100, ge=1, le=daily_recap_service.MAX_RECAP_ITEMS),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    try:
        data = daily_recap_service.get_daily_recap(
            db, user_id=current_user.id, target_date=date,
            timezone_name=timezone, limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"success": True, "data": data, "error": None}
