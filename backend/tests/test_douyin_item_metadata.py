"""单条绑定元数据读取：精确身份、超时、会话边界与旧连接器兼容。"""
import asyncio
import importlib.util
from pathlib import Path
import runpy
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from app.services import douyin_library


SIDECAR_ROOT = Path(__file__).resolve().parents[2] / 'deploy/douyin-sidecar'
spec = importlib.util.spec_from_file_location('single_item_creator_api', SIDECAR_ROOT / 'creator_api.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
VIDEO_ID = '7681642132423200019'
SCOPE = 'a' * 32
BINDING = 'dyb-' + '1' * 20


class ItemMetadataProtocolTests(unittest.TestCase):
    def setUp(self):
        self.valid = True
        self.calls = []
        self.scopes = {}
        self.raw = {
            'aweme_id': VIDEO_ID,
            'desc': '【闪客】公开教程',
            'author': {'nickname': '飞天闪客'},
            'video': {'duration': 123000, 'play_addr': {'url_list': ['PRIVATE_MEDIA_URL']}},
            'cookie': 'PRIVATE_COOKIE', 'create_time': 1700000000,
        }
        owner = self

        class Client:
            def __init__(self, cookies, **_kwargs):
                self.cookies = cookies
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): pass
            async def get_video_detail(self, video_id):
                owner.calls.append((self.cookies['scope'], video_id))
                return owner.raw

        def session(scope):
            if scope not in self.scopes:
                self.scopes[scope] = SimpleNamespace(
                    cookie_manager=SimpleNamespace(get_cookies=lambda: {'scope': scope}),
                    config={}, rate_limiter=SimpleNamespace(acquire=AsyncMock()),
                    media_resolve_semaphore=asyncio.Semaphore(8), media_stream_cache={},
                )
            return self.scopes[scope]

        async def prewarm(scoped, rows):
            self.assertEqual(rows, [self.raw])
            scoped.media_stream_cache[VIDEO_ID] = 'SESSION_ONLY_MEDIA'

        self.prewarm = AsyncMock(side_effect=prewarm)
        app = FastAPI()
        def scope(value: str = Header(default=SCOPE, alias='X-Zhicui-Scope')):
            return value
        module.install_creator_routes(app, SimpleNamespace(session=session), scope, Client,
                                     lambda *_args, **_kwargs: self.valid, self.prewarm)
        self.reader = app.state.creator_reader
        self.client = TestClient(app)

    def get(self, scope=SCOPE, video_id=VIDEO_ID):
        return self.client.get('/api/v1/items/' + video_id, headers={'X-Zhicui-Scope': scope})

    def test_exact_item_metadata_and_media_cache_remain_scoped(self):
        response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['aweme_id'], VIDEO_ID)
        self.assertEqual(response.json()['desc'], '【闪客】公开教程')
        self.assertEqual(response.json()['author_name'], '飞天闪客')
        self.assertEqual(response.json()['duration_ms'], 123000)
        self.assertNotIn('PRIVATE', response.text)
        self.assertEqual(self.calls, [(SCOPE, VIDEO_ID)])
        self.assertEqual(self.scopes[SCOPE].media_stream_cache[VIDEO_ID], 'SESSION_ONLY_MEDIA')
        other = 'b' * 32
        self.get(other)
        self.assertEqual(self.calls[-1], (other, VIDEO_ID))
        self.assertIsNot(self.scopes[SCOPE].media_stream_cache, self.scopes[other].media_stream_cache)
        self.assertIn('item_metadata', self.client.get('/api/v1/creators/health').json()['operations'])

    def test_wrong_identity_does_not_warm_media_or_return_metadata(self):
        self.raw['aweme_id'] = '7681642132423200020'
        response = self.get()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail']['code'], 'video_identity_mismatch')
        self.prewarm.assert_not_awaited()

    def test_cache_only_miss_never_requests_platform(self):
        result = self.client.get('/api/v1/items/' + VIDEO_ID + '/cached')
        self.assertEqual(result.status_code, 404)
        self.assertEqual(self.calls, [])
        self.prewarm.assert_not_awaited()

    def test_media_metadata_cache_avoids_another_detail_request(self):
        scoped = self.reader.session(SCOPE)
        self.reader.remember_item(scoped, VIDEO_ID, self.raw)
        cached = self.client.get('/api/v1/items/' + VIDEO_ID + '/cached')
        self.assertEqual(cached.status_code, 200)
        self.assertEqual(cached.json()['author_name'], '飞天闪客')
        self.assertNotIn('PRIVATE', repr(scoped.item_metadata_cache))
        self.assertEqual(self.get().status_code, 200)
        self.assertEqual(self.calls, [])
        other = self.client.get('/api/v1/items/' + VIDEO_ID + '/cached',
                                headers={'X-Zhicui-Scope': 'b' * 32})
        self.assertEqual(other.status_code, 404)
        self.valid = False
        self.assertEqual(self.client.get('/api/v1/items/' + VIDEO_ID + '/cached').status_code, 401)

    def test_cache_is_bounded_expires_and_returns_a_copy(self):
        scoped = self.reader.session(SCOPE)
        with patch.object(module, 'ITEM_METADATA_CACHE_MAX_ITEMS', 2), \
                patch.object(module, 'ITEM_METADATA_CACHE_TTL_SECONDS', 10), \
                patch.object(module.time, 'monotonic', return_value=100):
            for video_id in ['10001', '10002', '10003']:
                self.reader.remember_item(scoped, video_id, {**self.raw, 'aweme_id': video_id})
            self.assertEqual(list(scoped.item_metadata_cache), ['10002', '10003'])
            copy = self.reader.cached_item(scoped, '10003')
            copy['desc'] = 'changed'
            self.assertEqual(self.reader.cached_item(scoped, '10003')['desc'], self.raw['desc'])
        with patch.object(module.time, 'monotonic', return_value=111):
            self.assertIsNone(self.reader.cached_item(scoped, '10003'))
            self.reader.remember_item(scoped, VIDEO_ID, self.raw)
        self.assertEqual(list(scoped.item_metadata_cache), [VIDEO_ID])

    def test_default_or_expired_session_cannot_resolve(self):
        self.assertEqual(self.get('default').status_code, 401)
        self.valid = False
        self.assertEqual(self.get().status_code, 401)
        self.assertEqual(self.calls, [])

    def test_invalid_identifier_never_reaches_platform(self):
        self.assertEqual(self.get(video_id='bad-id').status_code, 422)
        self.assertEqual(self.calls, [])

    def test_deadline_includes_rate_limiter_wait(self):
        scoped = self.reader.session(SCOPE)
        scoped.rate_limiter.acquire = AsyncMock(side_effect=lambda: None)
        async def wait_forever():
            await asyncio.sleep(5)
        scoped.rate_limiter.acquire.side_effect = wait_forever
        with patch.object(module, 'ITEM_METADATA_TIMEOUT_SECONDS', 0.02):
            response = self.get()
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()['detail']['code'], 'network_error')
        self.assertEqual(self.calls, [])

    def test_platform_exception_is_sanitized(self):
        self.reader.client_factory = Mock(side_effect=RuntimeError('PRIVATE_COOKIE'))
        response = self.get()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('PRIVATE', response.text)


class ItemMetadataAdapterTests(unittest.TestCase):
    def test_resolver_uses_one_bounded_detail_request(self):
        raw = {'aweme_id': VIDEO_ID, 'desc': '真实标题', 'author_name': '真实作者',
               'duration_ms': 45000, 'media_type': 'video'}
        with patch.object(douyin_library, '_request', return_value=raw) as request:
            result = douyin_library.resolve_item_metadata(SCOPE, BINDING, VIDEO_ID)
        request.assert_called_once_with('GET', '/api/v1/items/' + VIDEO_ID,
                                        session_scope=SCOPE, timeout=10.0, missing_ok=True)
        self.assertEqual(result['title'], '真实标题')
        self.assertEqual(result['author_name'], '真实作者')
        self.assertEqual(result['duration'], 45)
        self.assertEqual(result['aweme_id'], VIDEO_ID)
        self.assertIn(BINDING, result['media_url'])

    def test_old_connector_returns_no_metadata_without_scanning_catalog(self):
        with patch.object(douyin_library, '_request', return_value=None), \
                patch.object(douyin_library, 'list_items') as listing:
            self.assertIsNone(douyin_library.resolve_item_metadata(SCOPE, BINDING, VIDEO_ID))
        listing.assert_not_called()

    def test_cache_only_uses_distinct_compatible_path_and_two_second_budget(self):
        with patch.object(douyin_library, '_request', return_value=None) as request:
            self.assertIsNone(douyin_library.resolve_item_metadata(SCOPE, BINDING, VIDEO_ID, cache_only=True))
        request.assert_called_once_with('GET', '/api/v1/items/' + VIDEO_ID + '/cached',
                                        session_scope=SCOPE, timeout=2.0, missing_ok=True)

    def test_wrong_identity_is_rejected(self):
        with patch.object(douyin_library, '_request', return_value={'aweme_id': '7681642132423200020'}):
            with self.assertRaises(douyin_library.DouyinLibraryError) as raised:
                douyin_library.resolve_item_metadata(SCOPE, BINDING, VIDEO_ID)
        self.assertEqual(raised.exception.code, 'video_identity_mismatch')

    def test_missing_ok_only_relaxes_not_found(self):
        response = Mock(status_code=404, is_redirect=False, is_permanent_redirect=False)
        session = Mock()
        session.request.return_value = response
        context = Mock()
        context.__enter__ = Mock(return_value=session)
        context.__exit__ = Mock(return_value=None)
        with patch.object(douyin_library, '_base_url', return_value='http://127.0.0.1:9000'), \
                patch.object(douyin_library.requests, 'Session', return_value=context):
            self.assertIsNone(douyin_library._request('GET', '/api/v1/items/' + VIDEO_ID, missing_ok=True))
            response.status_code = 401
            response.ok = False
            response.json.return_value = {'detail': {'code': 'session_expired'}}
            with self.assertRaises(douyin_library.DouyinLibraryError) as raised:
                douyin_library._request('GET', '/api/v1/items/' + VIDEO_ID, missing_ok=True)
        self.assertEqual(raised.exception.code, 'session_expired')

    def test_installer_upgrades_existing_hook_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'server').mkdir()
            app = root / 'server/app.py'
            app.write_text('async def _prewarm_media_stream_urls(scoped, rows):\n    pass\n'
                           'def build_app():\n'
                           '    async def stream_media():\n'
                           '        async def resolve_media():\n'
                           '            async with lock:\n'
                           '                async with semaphore:\n'
                           '                    async with client:\n'
                           '                        detail = await api_client.get_video_detail(clean_id)\n'
                           '                        if not detail:\n'
                           '                            raise HTTPException(status_code=404, detail="未找到作品")\n'
                           '                        downloader = DownloaderFactory.create()\n'
                           '    async def import_cookie():\n'
                           '        scoped.media_stream_cache.clear()\n'
                           '    async def logout():\n'
                           '        scoped.media_stream_cache.clear()\n'
                           '    from server.creator_api import install_creator_routes\n'
                           '    install_creator_routes(app, deps, _session_scope, DouyinAPIClient, _cookie_state_is_valid)\n'
                           '    return app\n', encoding='utf-8')
            with patch.object(sys, 'argv', ['install_creator_api.py', str(root)]):
                runpy.run_path(str(SIDECAR_ROOT / 'install_creator_api.py'))
                once = app.read_text(encoding='utf-8')
                runpy.run_path(str(SIDECAR_ROOT / 'install_creator_api.py'))
            self.assertEqual(app.read_text(encoding='utf-8'), once)
            self.assertIn('_cookie_state_is_valid, _prewarm_media_stream_urls)', once)
            self.assertEqual(once.count('install_creator_routes(app,'), 1)
            self.assertEqual(once.count('creator_reader.remember_item(scoped,'), 1)
            self.assertEqual(once.count('getattr(scoped, "item_metadata_cache", {}).clear()'), 2)
            self.assertLess(once.index('if not detail:'), once.index('creator_reader.remember_item(scoped,'))
            self.assertLess(once.index('creator_reader.remember_item(scoped,'), once.index('DownloaderFactory.create()'))
            self.assertEqual((root / 'server/creator_api.py').read_bytes(), (SIDECAR_ROOT / 'creator_api.py').read_bytes())

            # 执行安装器实际插入的媒体片段：不匹配的 ID 在媒体地址生成前被拒绝。
            snippet = once[once.index('                        detail = '):once.index('    async def import_cookie():')]
            namespace = {
                'api_client': SimpleNamespace(get_video_detail=AsyncMock(return_value={'aweme_id': '10001'})),
                'clean_id': VIDEO_ID, 'scoped': SimpleNamespace(), 'HTTPException': HTTPException,
                'app': SimpleNamespace(state=SimpleNamespace(creator_reader=module.CreatorReader)),
                'DownloaderFactory': SimpleNamespace(create=Mock()),
            }
            exec('async def resolve():\n' + textwrap.indent(textwrap.dedent(snippet), '    '), namespace)
            with self.assertRaises(HTTPException):
                asyncio.run(namespace['resolve']())
            namespace['DownloaderFactory'].create.assert_not_called()
            namespace['api_client'].get_video_detail.return_value = {'aweme_id': VIDEO_ID, 'desc': '真实标题'}
            asyncio.run(namespace['resolve']())
            namespace['DownloaderFactory'].create.assert_called_once()
            self.assertEqual(module.CreatorReader.cached_item(namespace['scoped'], VIDEO_ID)['desc'], '真实标题')
            scoped = namespace['scoped']
            scoped.media_stream_cache = {VIDEO_ID: 'PRIVATE_MEDIA'}
            clear = once[once.index('        scoped.media_stream_cache.clear()'):once.index('    async def logout():')]
            exec(textwrap.dedent(clear), {'scoped': scoped})
            self.assertEqual(scoped.item_metadata_cache, {})
            self.assertEqual(scoped.media_stream_cache, {})


if __name__ == '__main__':
    unittest.main()
