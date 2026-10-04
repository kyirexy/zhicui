"""Web 快速视频入口：登录后解析、立即下载，不等待文稿。"""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Literal
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.services.agent_credential_service import AgentPrincipal
from app.services.product_action_registry import registry
from app.services.product_action_run_service import consume_rate_limit, ProductActionError
from app.services import fast_video_service as fast
from app.services.agent_video_link_service import VideoLinkError

router = APIRouter(prefix='/api/video/fast', tags=['video'])

class ResolveRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    refresh: bool = False
    kind: Literal['video', 'audio'] = 'video'

def _error(exc):
    return JSONResponse(status_code=exc.http_status, content={'success': False, 'data': None, 'error': str(exc), 'code': exc.code}, headers={'Cache-Control':'no-store'})

@router.post('/resolve')
def resolve_video(body: ResolveRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        consume_rate_limit(db, principal=AgentPrincipal(user, None, frozenset(ALL_SCOPE_IDS), 'browser_session'), definition=registry.get('library.media.resolve'))
        data=fast.resolve(body.url, user_id=user.id, refresh=body.refresh, kind=body.kind)
        # 直链只在用户直接请求的 Web 响应中提供；不写入 Action 日志。
        if body.kind == 'video':
            data['media_url']=fast.open_ticket(data['media_id'], user_id=user.id)['media']
        return JSONResponse({'success': True, 'data': data, 'error': None}, headers={'Cache-Control':'no-store'})
    except (VideoLinkError, ProductActionError) as exc:
        return _error(exc)

@router.get('/file/{media_id}')
def download_video(media_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        user_id = user.id
        def recheck():
            db.expire_all()
            active = db.get(User, user_id)
            if active is None or not active.is_active:
                raise VideoLinkError('AUTH_REQUIRED', '账号已失效，请重新登录', status=401)
        return fast.stream_file(media_id, user_id=user_id, after_prepare=recheck)
    except VideoLinkError as exc:
        return _error(exc)
