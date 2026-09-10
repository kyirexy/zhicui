"""执行真实博主路由及后端边界，外部抖音响应使用可控桩。"""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock

from fastapi import FastAPI, Header
from fastapi.testclient import TestClient
from app.services import creator_connectors, douyin_library

spec = importlib.util.spec_from_file_location('creator_api', Path(__file__).resolve().parents[2] / 'deploy/douyin-sidecar/creator_api.py')
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
CREATOR = 'MS4wLjABAAAAcreator_target'
OTHER = 'MS4wLjABAAAAcreator_other'


def item(number, creator=CREATOR, **extra):
    return {'aweme_id': str(number), 'author': {'sec_uid': creator, 'nickname': '目标博主'},
            'desc': '公开教程', 'create_time': 1700000000,
            'video': {'duration': 31000, 'play_addr': {'url_list': ['SECRET']}},
            'cookie': 'SECRET', **extra}


def page(rows, more=0, cursor=0):
    return {'raw': {'status_code': 0, 'aweme_list': rows, 'has_more': more, 'max_cursor': cursor}}


class FakeClient:
    pages = []
    calls = []
    user = {'nickname': '目标博主', 'sec_uid': CREATOR}
    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass
    def __init__(self, *_args, **_kwargs): pass
    async def get_user_info(self, creator):
        self.calls.append(('profile', creator))
        return self.user
    async def get_user_post(self, creator, cursor, count):
        self.calls.append((creator, cursor, count))
        return self.pages.pop(0)


class CreatorProtocolTests(unittest.TestCase):
    def setUp(self):
        FakeClient.pages, FakeClient.calls = [], []
        FakeClient.user = {'nickname': '目标博主', 'sec_uid': CREATOR}
        self.valid = True
        scoped = SimpleNamespace(cookie_manager=SimpleNamespace(get_cookies=lambda: {}),
                                 config={}, rate_limiter=SimpleNamespace(acquire=AsyncMock()))
        deps = SimpleNamespace(session=lambda _scope: scoped)
        app = FastAPI()
        def scope(value: str = Header(default='a' * 32, alias='X-Zhicui-Scope')):
            return value
        module.install_creator_routes(app, deps, scope, FakeClient, lambda *_a, **_kw: self.valid)
        self.reader = app.state.creator_reader
        self.client = TestClient(app)

    def post(self, **fields):
        return self.client.post('/api/v1/creators/catalog', json={'creator_id': CREATOR, 'catalog_id': 'run1', **fields})

    def test_real_routes_and_profile_identity(self):
        health = self.client.get('/api/v1/creators/health').json()
        self.assertTrue(health['identity_checked'])
        result = self.client.post('/api/v1/creators/resolve', json={'profile_url': 'https://www.douyin.com/user/' + CREATOR})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['display_name'], '目标博主')
        self.assertNotIn('SECRET', result.text)
        FakeClient.user = {'nickname': '其他人', 'sec_uid': OTHER}
        self.assertEqual(self.client.post('/api/v1/creators/resolve', json={'profile_url': 'https://www.douyin.com/user/' + CREATOR}).status_code, 422)

    def test_scope_login_and_url_are_checked(self):
        self.valid = False
        self.assertEqual(self.post().status_code, 401)
        self.valid = True
        self.assertEqual(self.client.post('/api/v1/creators/resolve', json={'profile_url': 'https://evil.test/user/' + CREATOR}).status_code, 422)
        self.assertEqual(self.client.post('/api/v1/creators/works', json={'creator_id': CREATOR, 'limit': True}).status_code, 422)

    def test_profile_fallback_uses_real_owned_author(self):
        FakeClient.user = None
        FakeClient.pages = [page([item(10001)])]
        result = self.client.post('/api/v1/creators/resolve', json={'profile_url': 'https://www.douyin.com/user/' + CREATOR})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['display_name'], '目标博主')

    def test_pages_preserve_order_deduplicate_and_replay_without_request(self):
        FakeClient.pages = [page([item(10002), item(10001)], 1, 5), page([item(10001), item(10003)])]
        first = self.post()
        self.assertEqual(first.status_code, 200)
        self.assertNotIn('SECRET', first.text)
        self.assertEqual(first.json(), self.post().json())
        self.assertEqual(len(FakeClient.calls), 1)
        final = self.post(cursor='5').json()
        self.assertEqual([x['aweme_id'] for x in first.json()['items']], ['10002', '10001'])
        self.assertEqual([x['aweme_id'] for x in final['items']], ['10003'])
        self.assertEqual(final['total_count'], 3)
        self.assertTrue(final['complete'])

    def test_empty_upstream_is_not_empty_success(self):
        FakeClient.pages = [{'items': [], 'has_more': False, 'status_code': 0, 'raw': {}}]
        self.assertEqual(self.post().status_code, 502)
        FakeClient.pages = [page([])]
        self.assertTrue(self.post().json()['complete'])

    def test_wrong_author_invalid_cursor_and_cancellation_stop(self):
        FakeClient.pages = [page([item(10001, OTHER)])]
        self.assertEqual(self.post().json()['detail']['code'], 'creator_identity_mismatch')
        FakeClient.pages = [page([item(10001)], 1, 0)]
        self.assertEqual(self.post().json()['detail']['code'], 'invalid_discovery_cursor')
        self.client.delete('/api/v1/creators/catalog/run1')
        self.assertEqual(self.post().json()['detail']['code'], 'cancelled')

    def test_scope_and_creator_cannot_reuse_another_run(self):
        FakeClient.pages = [page([item(10001)], 1, 5)]
        self.post()
        self.assertEqual(self.post(creator_id=OTHER).status_code, 409)
        other = self.client.delete('/api/v1/creators/catalog/run1', headers={'X-Zhicui-Scope': 'b' * 32})
        self.assertEqual(other.status_code, 404)
        self.assertEqual(self.post(cursor='999').status_code, 409)

    def test_recent_filters_gallery_pinned_and_duplicates(self):
        FakeClient.pages = [page([item(10001, is_top=1), item(10002, images=[{}]), item(10003)], 1, 5), page([item(10003), item(10004)])]
        response = self.client.post('/api/v1/creators/works', json={'creator_id': CREATOR, 'limit': 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row['aweme_id'] for row in response.json()['items']], ['10003', '10004'])
        self.assertTrue(all(call[0] == CREATOR for call in FakeClient.calls))

    def test_backend_never_falls_back_to_self_or_shared_library(self):
        with patch.object(douyin_library, '_request', side_effect=douyin_library.DouyinLibraryError('failed')) as request:
            with self.assertRaises(douyin_library.DouyinLibraryError):
                douyin_library.list_creator_works('s' * 32, '', CREATOR, 20)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[1], '/api/v1/creators/works')
            request.reset_mock()
            with self.assertRaises(douyin_library.DouyinLibraryError):
                douyin_library.resolve_creator('s' * 32, 'https://www.douyin.com/user/' + CREATOR)
            self.assertEqual(request.call_count, 1)

    def test_backend_rejects_mixed_creator_identity(self):
        result = {'creator_id': CREATOR, 'items': [{'creator_id': OTHER, 'aweme_id': '10001', 'media_type': 'video'}]}
        with patch.object(douyin_library, '_request', return_value=result):
            with self.assertRaises(douyin_library.DouyinLibraryError):
                douyin_library.list_creator_works('s' * 32, '', CREATOR, 20)

    def test_shared_message_and_official_share_user_url(self):
        url = 'https://www.iesdouyin.com/share/user/' + CREATOR + '?tracking=discard'
        self.assertEqual(creator_connectors.normalize_profile_ref('douyin', url)['profile_url'], 'https://www.douyin.com/user/' + CREATOR)
        with patch.object(creator_connectors, '_follow_official_short_link', return_value=url):
            result = creator_connectors.normalize_profile_ref('douyin', '长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/test/')
            self.assertEqual(result['creator_id'], CREATOR)

    def test_advertised_capability_without_protocol_does_not_enable(self):
        with patch.object(douyin_library, '_request', return_value={'status': 'ok', 'storage_mode': 'metadata_only', 'capabilities': ['creator_catalog']}):
            self.assertFalse(creator_connectors.catalog_health('douyin')['supports_catalog_all'])


if __name__ == '__main__':
    unittest.main()
