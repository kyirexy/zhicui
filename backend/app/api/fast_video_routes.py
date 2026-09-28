"""Web 快速视频入口：登录后解析、立即下载，不等待文稿。"""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
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

def _error(exc):
    return JSONResponse(status_code=exc.http_status, content={'success': False, 'data': None, 'error': str(exc), 'code': exc.code}, headers={'Cache-Control':'no-store'})

@router.post('/resolve')
def resolve_video(body: ResolveRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        consume_rate_limit(db, principal=AgentPrincipal(user, None, frozenset(ALL_SCOPE_IDS), 'browser_session'), definition=registry.get('library.media.resolve'))
        data=fast.resolve(body.url, user_id=user.id, refresh=body.refresh)
        # 直链只在用户直接请求的 Web 响应中提供；不写入 Action 日志。
        data['media_url']=fast.open_ticket(data['media_id'], user_id=user.id)['media']
        return JSONResponse({'success': True, 'data': data, 'error': None}, headers={'Cache-Control':'no-store'})
    except (VideoLinkError, ProductActionError) as exc:
        return _error(exc)

@router.get('/file/{media_id}')
def download_video(media_id: str, user: User = Depends(get_current_user)):
    try:
        return fast.stream_file(media_id, user_id=user.id)
    except VideoLinkError as exc:
        return _error(exc)
