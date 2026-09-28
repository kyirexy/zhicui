"""公开视频快取：只取元数据；媒体在下载时流式读取，不触发转录或资料导入。

公开元数据路由参考 wujunwei928/parse-video-py（MIT）；版权声明见
backend/licenses/parse-video-py-MIT.txt。网络访问复用知萃自己的 DNS 固定与域名校验。
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from urllib.parse import parse_qs, urljoin, urlsplit

import urllib3
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings
from app.services import agent_video_link_service as safe

TTL = 300
_LOCK = threading.Lock()
_POOLS = OrderedDict()
_CACHE = OrderedDict()
_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
_PAGES = ('douyin.com', 'iesdouyin.com')
_MEDIA = {**safe._MEDIA_DOMAINS, 'douyin': (*safe._MEDIA_DOMAINS['douyin'], '365yg.com')}


def _pool(url, domains):
    parsed, ip = safe._target(url, domains)
    host = parsed.hostname
    key = (host, ip)
    with _LOCK:
        pool = _POOLS.get(key)
        if pool is None:
            pool = urllib3.HTTPSConnectionPool(ip, port=443, server_hostname=host, assert_hostname=host,
                cert_reqs='CERT_REQUIRED', maxsize=4, timeout=urllib3.Timeout(connect=4, read=8))
            _POOLS[key] = pool
            if len(_POOLS) > 32:
                # 不关闭仍可能被并发请求使用的池；失去引用后由连接池释放。
                _POOLS.popitem(last=False)
        _POOLS.move_to_end(key)
    return parsed, pool


@contextmanager
def _request(url):
    parsed, pool = _pool(url, _PAGES)
    response = None
    try:
        response = pool.urlopen('GET', parsed.path + ('?' + parsed.query if parsed.query else ''),
            headers={'User-Agent': _UA, 'Host': parsed.hostname, 'Accept-Encoding': 'identity'},
            redirect=False, retries=False, preload_content=False)
        if response.status in (401, 403, 412, 429):
            raise safe.VideoLinkError('PLATFORM_AUTH_REQUIRED', '平台要求登录或验证，请稍后再试；不会自动连续重试', status=409)
        yield response
    except urllib3.exceptions.HTTPError:
        raise safe.VideoLinkError('PLATFORM_UNAVAILABLE', '平台连接暂时不可用，请稍后重试', status=502, retryable=True) from None
    finally:
        if response is not None:
            response.close()
            response.release_conn()


def normalize(value):
    match = re.search(r'https?://[^\s<>\[\]"\u3000]+', str(value))
    if not match:
        raise safe.VideoLinkError('INVALID_INPUT', '请粘贴抖音或 B站视频链接')
    url = match.group().rstrip(')）。，；')
    # 复用公开页面域名、DNS 和分 P 限制；不会请求账号或导出 Cookie。
    return safe._source(url)


def _douyin(url):
    if urlsplit(url).hostname == 'v.douyin.com':
        with _request(url) as response:
            if response.status not in (301, 302, 303, 307, 308):
                raise safe.VideoLinkError('PLATFORM_UNAVAILABLE', '短链未返回作品地址，请使用作品页面链接', status=502)
            location = response.headers.get('Location')
            if not location:
                raise safe.VideoLinkError('PLATFORM_UNAVAILABLE', '短链未返回作品地址', status=502)
            url = urljoin(url, location)
            safe._target(url, _PAGES, resolve=False)
    parsed = urlsplit(url)
    match = re.search(r'/(?:share/)?(?:video|note)/(\d+)', parsed.path)
    video_id = match.group(1) if match else parse_qs(parsed.query).get('modal_id', [''])[0]
    if not re.fullmatch(r'\d{8,32}', video_id):
        raise safe.VideoLinkError('INVALID_INPUT', '无法识别抖音作品编号')
    for suffix in ('', '&request_source=200'):
        api = f'https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/?aweme_ids=%5B{video_id}%5D{suffix}'
        with _request(api) as response:
            if response.status != 200:
                raise safe.VideoLinkError('PLATFORM_UNAVAILABLE', '平台未返回视频信息', status=502)
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise safe.VideoLinkError('INVALID_MEDIA', '平台元数据过大', status=502)
            try:
                data = json.loads(raw)
            except ValueError:
                raise safe.VideoLinkError('PLATFORM_AUTH_REQUIRED', '平台暂未开放这条视频的公开读取，请稍后重试', status=409) from None
        items = data.get('aweme_details') or []
        if items:
            item = items[0]
            if str(item.get('aweme_id')) != video_id:
                raise safe.VideoLinkError('INVALID_MEDIA', '平台返回的作品与链接不一致', status=502)
            if item.get('images'):
                raise safe.VideoLinkError('INVALID_MEDIA', '这条作品是图集，没有可下载的视频')
            urls = ((item.get('video') or {}).get('play_addr') or {}).get('url_list') or []
            media = next((u.replace('playwm', 'play') for u in urls if isinstance(u, str) and u.startswith('https://')), '')
            if not media:
                raise safe.VideoLinkError('INVALID_MEDIA', '平台未返回视频地址', status=502)
            return {'title': item.get('desc') or '抖音视频', 'video_id': video_id,
                'author': (item.get('author') or {}).get('nickname', ''), 'media': media, 'platform': 'douyin'}
    raise safe.VideoLinkError('PLATFORM_UNAVAILABLE', '平台未返回可下载的视频，请稍后重试', status=502)


def _cipher():
    key = hashlib.sha256(('zhicui-fast-media-v1:' + settings.JWT_SECRET).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def resolve(value, *, user_id, credential_id=None, refresh=False):
    started = time.perf_counter()
    url, platform = normalize(value)
    key = (str(user_id), url)
    with _LOCK:
        cached = _CACHE.get(key)
    cache_hit = bool(cached and time.monotonic() - cached[0] < 120 and not refresh)
    if cache_hit:
        item = dict(cached[1])
    elif platform == 'douyin':
        item = _douyin(url)
    else:
        info = safe._public_info(url, platform)
        if info.get('audio_url'):
            raise safe.VideoLinkError('INVALID_MEDIA', '这条 B站视频需要合并音视频，请使用资料页下载')
        item = {'platform': platform, 'video_id': info['video_id'], 'title': info['title'],
            'author': info.get('author', ''), 'media': info.get('download_url') or info.get('url', '')}
    safe._target(item['media'], _MEDIA[platform], resolve=False)
    if not cache_hit:
        with _LOCK:
            _CACHE[key] = (time.monotonic(), dict(item))
            _CACHE.move_to_end(key)
            if len(_CACHE) > 256:
                _CACHE.popitem(last=False)
    ticket = _cipher().encrypt(json.dumps({**item, 'owner': str(user_id), 'credential': credential_id}, ensure_ascii=False).encode()).decode()
    return {'title': item['title'], 'video_id': item['video_id'], 'author': item['author'], 'platform': platform,
        'media_id': ticket, 'expires_in': TTL, 'cache_hit': cache_hit,
        'resolve_ms': round((time.perf_counter()-started)*1000), 'media_prefetch_bytes': 0}


def open_ticket(ticket, *, user_id, credential_id=None):
    try:
        if len(ticket) > 12000:
            raise ValueError('size')
        item = json.loads(_cipher().decrypt(ticket.encode(), ttl=TTL))
        if item['owner'] != str(user_id) or item.get('credential') != credential_id:
            raise ValueError('owner')
        safe._target(item['media'], _MEDIA[item['platform']], resolve=False)
        return item
    except (InvalidToken, ValueError, KeyError, TypeError):
        raise safe.VideoLinkError('MEDIA_EXPIRED', '下载入口已过期或不属于当前授权，请重新解析', status=410) from None


def stream_file(ticket, *, user_id, credential_id=None):
    """读取首块并校验后立即返回，资源在断开、错误及完成时释放。"""
    from contextlib import ExitStack
    from starlette.responses import StreamingResponse
    item = open_ticket(ticket, user_id=user_id, credential_id=credential_id)
    stack = ExitStack()
    try:
        stack.enter_context(safe.user_download_slot(str(user_id)))
        deadline = time.monotonic() + safe.MAX_DOWNLOAD_SECONDS
        response = stack.enter_context(safe._get(item['media'], domains=_MEDIA[item['platform']],
            referer=f"https://www.{'douyin.com' if item['platform']=='douyin' else 'bilibili.com'}/", deadline=deadline))
        length = response.headers.get('Content-Length')
        total = int(length) if length and length.isdigit() else None
        if total is not None and total > safe.MAX_MEDIA_BYTES:
            raise safe.VideoLinkError('MEDIA_TOO_LARGE', '视频超过 512 MB 下载上限')
        first = response.read(65536)
        if len(first) < 12 or first[4:8] != b'ftyp':
            raise safe.VideoLinkError('INVALID_MEDIA', '平台没有返回可下载的 MP4，请通过资料页下载', status=502)
    except BaseException:
        stack.close()
        raise
    def chunks():
        received = 0
        try:
            chunk = first
            while chunk:
                received += len(chunk)
                if received > safe.MAX_MEDIA_BYTES or time.monotonic() > deadline:
                    raise ValueError('媒体传输超过限制')
                yield chunk
                chunk = response.read(65536)
            if total is not None and received != total:
                raise ValueError('媒体传输不完整')
        finally:
            stack.close()
    class MediaStream(StreamingResponse):
        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                stack.close()
    headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="zhicui-video.mp4"'}
    if total is not None:
        headers['Content-Length'] = str(total)
    return MediaStream(chunks(), media_type='video/mp4', headers=headers)
