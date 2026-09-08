"""账号头像：只接受预设标识，不允许任意 URL 或修改他人资料。"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User

router = APIRouter()

class AvatarUpdate(BaseModel):
    avatar_id: str = Field(pattern=r"^portrait-(0[1-9]|1[0-2])$")

@router.patch('/api/auth/avatar')
def update_avatar(body: AvatarUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user.avatar_id = body.avatar_id
    db.commit()
    db.refresh(user)
    return {'success': True, 'data': user.to_dict(), 'error': None}
