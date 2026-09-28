import json
import time
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from tests import test_agent_interface_routes as routes
from app.services import fast_video_service as fast
from app.services.agent_video_link_service import VideoLinkError

SAMPLE={'title':'测试视频','author':'作者','video_id':'7659724478275947822','platform':'douyin','media':'https://v11-default.365yg.com/video.mp4'}

class FastVideoTests(unittest.TestCase):
    def setUp(self):
        fast._CACHE.clear()

    def test_resolve_never_reads_media_and_cache_stays_user_scoped(self):
        with patch.object(fast,'_douyin',return_value=SAMPLE) as parse:
            a=fast.resolve('分享 https://v.douyin.com/fY_wQtEXhHw/ 打开抖音',user_id='a',credential_id='pat-a')
            b=fast.resolve('https://v.douyin.com/fY_wQtEXhHw/',user_id='a',credential_id='pat-a')
            fast.resolve('https://v.douyin.com/fY_wQtEXhHw/',user_id='b',credential_id='pat-b')
            self.assertEqual(parse.call_count,2)
            self.assertFalse(a['cache_hit']); self.assertTrue(b['cache_hit'])
            self.assertEqual(a['media_prefetch_bytes'],0)
            self.assertNotIn(SAMPLE['media'],json.dumps(a))
            self.assertEqual(fast.open_ticket(a['media_id'],user_id='a',credential_id='pat-a')['media'],SAMPLE['media'])
            for user,credential in [('b','pat-a'),('a','pat-b'),('a',None)]:
                with self.assertRaises(VideoLinkError): fast.open_ticket(a['media_id'],user_id=user,credential_id=credential)

    def test_expired_and_tampered_ticket_rejected(self):
        payload={**SAMPLE,'owner':'a','credential':None}
        token=fast._cipher().encrypt_at_time(json.dumps(payload).encode(),int(time.time())-fast.TTL-1).decode()
        for value in (token,token+'bad','../x'):
            with self.assertRaises(VideoLinkError): fast.open_ticket(value,user_id='a')

    def test_untrusted_source_rejected_before_network(self):
        for url in ('https://127.0.0.1/x','https://douyin.com.evil.invalid/video/12345678','https://user:pass@www.douyin.com/video/12345678','https://www.bilibili.com/video/BV123456/?p=2'):
            with self.subTest(url=url),patch.object(fast,'_request') as network:
                with self.assertRaises(VideoLinkError): fast.resolve(url,user_id='a')
                network.assert_not_called()

    def test_get_metadata_does_not_request_media(self):
        urls=[]
        class Reply:
            status=200
            headers={}
            def read(self,n):
                return json.dumps({'aweme_details':[{'aweme_id':SAMPLE['video_id'],'desc':'测试','video':{'play_addr':{'url_list':[SAMPLE['media']]}},'author':{}}]}).encode()
        @contextmanager
        def request(url):
            urls.append(url); yield Reply()
        with patch.object(fast,'_request',side_effect=request):
            result=fast._douyin('https://www.douyin.com/video/'+SAMPLE['video_id'])
        self.assertEqual(result['media'],SAMPLE['media'])
        self.assertEqual(len(urls),1)
        self.assertIn('/slidesinfo/',urls[0])

class FastVideoRoutesTests(unittest.TestCase):
    def setUp(self): routes.AgentInterfaceRouteTests.setUp(self)
    def tearDown(self): routes.AgentInterfaceRouteTests.tearDown(self)

    def test_web_requires_session_and_returns_real_media_link(self):
        from app.api.fast_video_routes import router
        self.client.app.include_router(router)
        self.assertEqual(self.client.post('/api/video/fast/resolve',json={'url':'https://v.douyin.com/test/'}).status_code,401)
        with patch.object(fast,'_douyin',return_value=SAMPLE):
            response=self.client.post('/api/video/fast/resolve',headers={'Authorization':'Bearer '+self.jwt},json={'url':'https://www.douyin.com/video/'+SAMPLE['video_id']})
        self.assertEqual(response.status_code,200,response.text)
        data=response.json()['data']
        self.assertEqual(data['media_url'],SAMPLE['media'])
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertEqual(fast.open_ticket(data['media_id'],user_id=self.user_id)['media'],SAMPLE['media'])

    def test_action_is_discoverable_and_download_rechecks_credential(self):
        issued=self.client.post('/api/agent-interface/v1/credentials/pat',headers={'Authorization':'Bearer '+self.jwt},json={'name':'fast-test','scopes':['library:read'],'expires_in_days':1}).json()['data']
        headers={'Authorization':'Bearer '+issued['token']}
        with patch.object(fast,'_douyin',return_value=SAMPLE):
            response=self.client.post('/api/agent-interface/v1/actions/library.media.resolve/invoke',headers=headers,json={'input':{'url':'https://www.douyin.com/video/'+SAMPLE['video_id']}})
        self.assertEqual(response.status_code,200,response.text)
        body=response.json()['data']['result']
        self.assertIn('media_id',body)
        self.assertNotIn(SAMPLE['media'],response.text)
        denied=self.client.get('/api/agent-interface/v1/media/'+body['media_id'])
        self.assertEqual(denied.status_code,401)
        with patch.object(fast,'stream_file') as stream:
            from starlette.responses import Response
            stream.return_value=Response(b'video',media_type='video/mp4')
            result=self.client.get('/api/agent-interface/v1/media/'+body['media_id'],headers=headers)
        self.assertEqual(result.status_code,200)
        self.assertEqual(stream.call_args.kwargs['user_id'],self.user_id)
        self.assertIsNotNone(stream.call_args.kwargs['credential_id'])
