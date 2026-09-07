import json
import unittest
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.core.auth import get_current_user
from app.models.agent_thread import AgentThread  # 注册外键目标
from app.models.user import User
from app.models.note import Note
from app.models.llm_usage_log import LlmUsageLog
from app.models.library_extraction_batch import LibraryExtractionBatch, LibraryExtractionBatchItem
from app.services.admin_overview_service import overview
from app.api.ops_routes import router


class AdminOverviewTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(id='owner', email='owner@example.test', username='测试用户', hashed_password='private-hash', is_admin=False)
        self.db.add(self.user)
        now = datetime.now(timezone.utc)
        for index in range(13):
            self.db.add(Note(id=f'n{index:02}', user_id='owner', video_id=f'bilibili:{index}', video_title='测试资料' * 40,
                             video_url=f'https://www.bilibili.com/video/{index}?token=private-token',
                             transcript_raw='private-transcript' * 1000, ai_summary='{}', ai_initialized=True,
                             seo_title='test', seo_slug=f'test-{index}', seo_meta='test',
                             created_at=now - timedelta(days=60 if index == 12 else 1)))
        self.db.add(LlmUsageLog(provider='test', model='test-model', operation='ask', user_id='owner', total_tokens=42))
        self.db.add(LibraryExtractionBatch(id='batch', user_id='owner'))
        self.db.flush()
        for index in range(7):
            self.db.add(LibraryExtractionBatchItem(batch_id='batch', user_id='owner', aweme_id=f'video-{index}',
                                                  state='error', error='private-token private-transcript'))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_counts_pagination_and_no_sensitive_payload(self):
        statements = []
        def track(_conn, _cursor, sql, _params, _context, _many):
            statements.append(sql)
        event.listen(self.engine, 'before_cursor_execute', track)
        first = overview(self.db)
        second = overview(self.db, page=2)
        self.assertEqual(first['metrics']['new_notes'], 12)
        self.assertEqual(first['metrics']['transcripts_ready'], 12)
        self.assertEqual(first['metrics']['summaries_ready'], 0)
        self.assertEqual(first['metrics']['tokens'], 42)
        self.assertEqual(first['metrics']['model_users'], 1)
        self.assertEqual(first['tasks']['library'], [{'status': 'error', 'count': 7}])
        self.assertEqual(len(first['recent_tasks']), 5)
        self.assertEqual(len(first['recent_notes']), 10)
        self.assertEqual(len(second['recent_notes']), 2)
        self.assertFalse(set(n['id'] for n in first['recent_notes']) & set(n['id'] for n in second['recent_notes']))
        self.assertEqual(first['platforms'], [{'name': 'B站', 'count': 12}])
        body = json.dumps(first)
        self.assertLess(len(body), 12000)
        for forbidden in ['private-transcript', 'private-token', 'private-hash', 'owner@example.test']:
            self.assertNotIn(forbidden, body)
        self.assertTrue(all(s.lstrip().upper().startswith('SELECT') for s in statements))
        self.assertTrue(all(len(n['title']) <= 120 for n in first['recent_notes']))

    def test_empty_range_and_invalid_params(self):
        self.db.query(Note).delete()
        self.db.commit()
        self.assertEqual(overview(self.db)['metrics']['new_notes'], 0)
        self.assertEqual(overview(self.db)['recent_notes'], [])
        for kwargs in ({'days': 2}, {'page': 0}, {'page': 10001}):
            with self.assertRaises(ValueError):
                overview(self.db, **kwargs)

    def test_endpoint_admin_only_and_no_store(self):
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: self.db
        client = TestClient(app)
        self.assertEqual(client.get('/api/admin/business-overview').status_code, 401)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.assertEqual(client.get('/api/admin/business-overview').status_code, 403)
        self.user.is_admin = True
        response = client.get('/api/admin/business-overview')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(client.get('/api/admin/business-overview?days=2').status_code, 422)
        self.assertEqual(client.get('/api/admin/business-overview?page=0').status_code, 422)
