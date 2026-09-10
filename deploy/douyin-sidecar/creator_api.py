"""指定博主公开元数据接口：身份绑定、分页校验、增量去重，不下载媒体。"""
from __future__ import annotations

import asyncio
import secrets
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field


class ProfileRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    profile_url: str = Field(min_length=1, max_length=1024)


class WorksRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    creator_id: str = Field(pattern=r'^[A-Za-z0-9_-]{12,192}$')
    limit: int = Field(default=50, ge=1, le=100, strict=True)


class CatalogRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    creator_id: str = Field(pattern=r'^[A-Za-z0-9_-]{12,192}$')
    cursor: str | None = Field(default=None, max_length=32, pattern=r'^[0-9]*$')
    page_size: int = Field(default=50, ge=1, le=50, strict=True)
    catalog_id: str = Field(default='', max_length=96, pattern=r'^[A-Za-z0-9_-]*$')
    metadata_only: Literal[True] = True


def fail(code: str, message: str, status: int = 422):
    raise HTTPException(status_code=status, detail={'code': code, 'message': message})


def profile_id(value: str) -> str:
    import re
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        fail('invalid_profile', '博主主页地址格式不正确')
    if (parsed.scheme != 'https' or parsed.hostname not in {'www.douyin.com', 'douyin.com'}
            or parsed.username or parsed.password or port not in {None, 443}):
        fail('invalid_profile', '请粘贴抖音博主的官方主页链接')
    match = re.fullmatch(r'/user/([A-Za-z0-9_-]{12,192})/?', parsed.path)
    if not match:
        fail('invalid_profile', '链接不是抖音博主主页')
    return match[1]


def public_item(raw: dict, creator_id: str) -> dict:
    import re
    author = raw.get('author') if isinstance(raw.get('author'), dict) else {}
    if str(author.get('sec_uid') or author.get('sec_user_id') or '') != creator_id:
        fail('creator_identity_mismatch', '作品归属与所选博主不一致，已停止本次同步')
    video_id = str(raw.get('aweme_id') or '')
    if not re.fullmatch(r'[0-9]{5,32}', video_id):
        fail('invalid_upstream_response', '博主作品标识异常')
    video = raw.get('video') if isinstance(raw.get('video'), dict) else {}
    image_post = raw.get('image_post_info') if isinstance(raw.get('image_post_info'), dict) else {}
    images = raw.get('images') or raw.get('image_list') or image_post.get('images')
    def integer(value):
        try:
            return max(0, int(value or 0))
        except (ValueError, TypeError):
            return 0
    return {
        'aweme_id': video_id, 'creator_id': creator_id,
        'source_url': f'https://www.douyin.com/video/{video_id}',
        'desc': str(raw.get('desc') or '').strip()[:5000],
        'author_name': str(author.get('nickname') or '').strip()[:160],
        'media_type': 'gallery' if images else 'video',
        'publish_timestamp': integer(raw.get('create_time')),
        'duration_ms': min(integer(video.get('duration') or raw.get('duration')), 604800000),
        'is_top': raw.get('is_top') in (1, True, '1'),
    }


class CreatorReader:
    def __init__(self, deps, client_factory, cookie_valid):
        self.deps = deps
        self.client_factory = client_factory
        self.cookie_valid = cookie_valid
        self.jobs = {}

    def session(self, scope):
        if scope == 'default':
            fail('session_expired', '请先连接自己的抖音账号', 401)
        scoped = self.deps.session(scope)
        if not self.cookie_valid(scoped.cookie_manager, allow_legacy=False):
            fail('session_expired', '抖音登录已失效，请重新连接', 401)
        return scoped

    def client(self, scoped):
        return self.client_factory(scoped.cookie_manager.get_cookies(), proxy=scoped.config.get('proxy'))

    @staticmethod
    def upstream_error(client):
        signal = str(getattr(client, 'last_response_signal', '') or '')
        if signal in {'verification_required', 'anti_bot_empty', 'http_403', 'http_429'}:
            fail('verification_required', '抖音需要验证，请在账号连接页面完成验证后重试', 409)
        fail('invalid_upstream_response', '抖音未返回完整的博主数据，请稍后重试', 502)

    async def resolve(self, scope, creator_id):
        scoped = self.session(scope)
        async with self.client(scoped) as client:
            await scoped.rate_limiter.acquire()
            try:
                user = await asyncio.wait_for(client.get_user_info(creator_id), timeout=8)
            except Exception:
                user = None
            if not isinstance(user, dict) or not user.get('nickname'):
                # 官方主页资料接口受限时，只从已校验归属的公开作品取得真实作者名。
                items, _, _ = await self.page(scope, creator_id, '0', 1)
                author_name = next((row['author_name'] for row in items if row['author_name']), '')
                if not author_name:
                    self.upstream_error(client)
                user = {'sec_uid': creator_id, 'nickname': author_name}
            if str(user.get('sec_uid') or user.get('sec_user_id') or '') != creator_id:
                fail('creator_identity_mismatch', '抖音返回的主页与目标博主不一致')
            return {'creator_id': creator_id, 'display_name': str(user['nickname'])[:160],
                    'avatar_url': '', 'profile_url': f'https://www.douyin.com/user/{creator_id}'}

    async def page(self, scope, creator_id, cursor, count):
        scoped = self.session(scope)
        async with self.client(scoped) as client:
            await scoped.rate_limiter.acquire()
            try:
                page = await asyncio.wait_for(client.get_user_post(creator_id, int(cursor or 0), count), timeout=25)
            except Exception:
                self.upstream_error(client)
            raw = page.get('raw') if isinstance(page, dict) else None
            # 归一化函数会把空响应补成 status_code=0，必须检查原始列表和成功标记。
            if (not isinstance(raw, dict) or raw.get('status_code') != 0
                    or not isinstance(raw.get('aweme_list'), list)
                    or raw.get('has_more') not in (0, 1, False, True)):
                self.upstream_error(client)
            flags = page.get('risk_flags') or {}
            if flags.get('verify_page') or flags.get('login_tip'):
                fail('verification_required', '抖音需要重新验证账号', 409)
            rows = raw['aweme_list']
            if any(not isinstance(row, dict) for row in rows):
                self.upstream_error(client)
            items = [public_item(row, creator_id) for row in rows]
            has_more = bool(raw['has_more'])
            next_cursor = str(raw.get('max_cursor', ''))
            if has_more and (not next_cursor.isdigit() or next_cursor == str(cursor or '0')):
                fail('invalid_discovery_cursor', '抖音分页未推进，已保留确认的作品', 502)
            return items, has_more, next_cursor

    def job(self, scope, request):
        now = time.monotonic()
        self.jobs = {key: state for key, state in self.jobs.items() if now - state['touched'] < 1800}
        identity = request.catalog_id or secrets.token_hex(20)
        key = (scope, identity)
        state = self.jobs.get(key)
        if state is None:
            if request.cursor not in (None, '', '0'):
                fail('catalog_expired', '分页任务已过期，请重新同步；已有资料保留', 409)
            if len(self.jobs) >= 256:
                fail('connector_busy', '当前博主任务较多，请稍后重试', 429)
            state = {'creator_id': request.creator_id, 'cursor': '0', 'seen': set(), 'cursors': set(),
                     'cancelled': False, 'touched': now, 'lock': asyncio.Lock(), 'last': None,
                     'page_size': request.page_size, 'complete': False}
            self.jobs[key] = state
        if state['creator_id'] != request.creator_id or state['page_size'] != request.page_size:
            fail('catalog_identity_mismatch', '不能复用其他博主或不同范围的分页任务', 409)
        state['touched'] = now
        return identity, state

    async def catalog(self, scope, request):
        self.session(scope)
        identity, state = self.job(scope, request)
        cursor = str(request.cursor or '0')
        async with state['lock']:
            if state['cancelled']:
                fail('cancelled', '博主同步已取消', 409)
            if state['last'] and state['last'][0] == cursor:
                return state['last'][1]
            if cursor != state['cursor'] or state['complete']:
                fail('invalid_discovery_cursor', '分页顺序不匹配，请重新同步', 409)
            items, has_more, next_cursor = await self.page(scope, request.creator_id, cursor, request.page_size)
            if state['cancelled']:
                fail('cancelled', '博主同步已取消', 409)
            if has_more and next_cursor in state['cursors']:
                fail('invalid_discovery_cursor', '抖音返回重复分页，已停止继续读取', 502)
            fresh = []
            for item in items:
                if item['aweme_id'] not in state['seen']:
                    state['seen'].add(item['aweme_id'])
                    fresh.append(item)
            if len(state['seen']) > 50000:
                fail('catalog_safety_limit', '本次作品数量达到上限，已有资料保留', 409)
            state['cursors'].add(cursor)
            state['cursor'] = next_cursor
            state['complete'] = not has_more
            result = {'creator_id': request.creator_id, 'catalog_id': identity, 'items': fresh,
                      'next_cursor': next_cursor if has_more else None, 'has_more': has_more,
                      'complete': not has_more, 'total_count': len(state['seen']) if not has_more else None,
                      'needs_action': None}
            state['last'] = (cursor, result)
            return result

    async def works(self, scope, request):
        items, seen, cursor, cursors = [], set(), '0', set()
        for _ in range(100):
            page, has_more, next_cursor = await self.page(scope, request.creator_id, cursor, min(50, request.limit))
            for item in page:
                if item['media_type'] != 'video' or item['is_top'] or item['aweme_id'] in seen:
                    continue
                seen.add(item['aweme_id'])
                items.append(item)
            if len(items) >= request.limit or not has_more:
                return {'creator_id': request.creator_id, 'items': items[:request.limit],
                        'complete': not has_more, 'coverage': 'complete' if not has_more else 'limited'}
            cursors.add(cursor)
            if next_cursor in cursors:
                fail('invalid_discovery_cursor', '抖音返回重复分页，请重试', 502)
            cursor = next_cursor
        fail('catalog_safety_limit', '本次未能确认近期作品范围，请稍后重试', 409)


def install_creator_routes(app, deps, scope_dependency, client_factory, cookie_valid):
    reader = CreatorReader(deps, client_factory, cookie_valid)
    app.state.creator_reader = reader

    @app.get('/api/v1/creators/health')
    async def health():
        return {'status': 'ok', 'protocol_version': 1, 'storage_mode': 'metadata_only',
                'operations': ['resolve', 'recent', 'catalog', 'cancel'], 'identity_checked': True}

    @app.post('/api/v1/creators/resolve')
    async def resolve(req: ProfileRequest, scope: str = Depends(scope_dependency)):
        return await reader.resolve(scope, profile_id(req.profile_url))

    @app.post('/api/v1/creators/works')
    async def works(req: WorksRequest, scope: str = Depends(scope_dependency)):
        try:
            return await asyncio.wait_for(reader.works(scope, req), timeout=40)
        except asyncio.TimeoutError:
            fail('network_error', '抖音作品读取超时，请稍后重试', 504)

    @app.post('/api/v1/creators/catalog')
    async def catalog(req: CatalogRequest, scope: str = Depends(scope_dependency)):
        return await reader.catalog(scope, req)

    @app.delete('/api/v1/creators/catalog/{catalog_id}')
    async def cancel(catalog_id: str, scope: str = Depends(scope_dependency)):
        state = reader.jobs.get((scope, catalog_id))
        if state is None:
            fail('catalog_not_found', '分页任务不存在', 404)
        state['cancelled'] = True
        return {'cancelled': True}
