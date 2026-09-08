"""头像白名单、持久化及当前用户边界回归。"""
import os
import unittest
os.environ.setdefault('JWT_SECRET', 'avatar-test-only-secret-not-production')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.api.avatar_routes import router
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User

class AvatarTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        User.__table__.create(self.engine)
        self.db = Session(self.engine)
        self.user = User(email='one@example.test', username='one', hashed_password='not-a-login')
        self.other = User(email='two@example.test', username='two', hashed_password='not-a-login')
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def test_all_presets_persist_only_for_current_user(self):
        for number in range(1, 13):
            avatar = f'portrait-{number:02d}'
            result = self.client.patch('/api/auth/avatar', json={'avatar_id': avatar, 'user_id': self.other.id})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['data']['avatar_id'], avatar)
            self.db.expire_all()
            self.assertEqual(self.user.avatar_id, avatar)
            self.assertIsNone(self.other.avatar_id)

    def test_invalid_urls_and_unknown_ids_rejected(self):
        for avatar in ['', 'portrait-00', 'portrait-13', 'https://example.com/avatar', '../secret']:
            self.assertEqual(self.client.patch('/api/auth/avatar', json={'avatar_id': avatar}).status_code, 422)
        self.assertIsNone(self.user.avatar_id)

    def test_requires_login(self):
        self.app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.patch('/api/auth/avatar', json={'avatar_id': 'portrait-01'}).status_code, 401)

if __name__ == '__main__':
    unittest.main()
