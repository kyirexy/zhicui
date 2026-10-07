"""真实 HTTP 契约：HttpOnly Cookie、迁移、重试、退出和跨站限制。"""
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.api.auth_routes import router
from app.core.database import Base, get_db
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.models.user import User
from app.services import auth_service


class AuthSessionRoutes(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[User.__table__, UserAuthSession.__table__, AuthRefreshReceipt.__table__])
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(id='http-owner', email='http@example.test', hashed_password='unused', is_active=True)
        self.db.add(self.user); self.db.commit()
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app, base_url='https://luxai.cn')
        self.token = auth_service.create_access_token(self.user.id, self.user.email)

    def tearDown(self):
        self.client.close(); self.db.close(); self.engine.dispose()

    def test_web_cookie_rotation_and_logout(self):
        with patch('app.api.auth_routes.auth_service.login', return_value=(self.token, self.user, None)), patch('app.api.auth_routes.activity_service.log_activity_safely'):
            login = self.client.post('/api/auth/login', json={'email': self.user.email, 'password': 'password'}, headers={'X-Zhicui-Session-Version': '2'})
        self.assertEqual(login.status_code, 200, login.text)
        self.assertNotIn('refresh_token', login.json()['data'])
        self.assertIn('HttpOnly', login.headers['set-cookie']); self.assertIn('Secure', login.headers['set-cookie'])
        self.assertIn('SameSite=strict', login.headers['set-cookie'])
        value = self.client.post('/api/auth/refresh', json={'request_id': 'fixed-request-123456789'})
        self.assertEqual(value.status_code, 200, value.text)
        access = value.json()['data']['token']
        out = self.client.post('/api/auth/logout', json={'request_id': 'logout-request-123456'}, headers={'Authorization': 'Bearer ' + access})
        self.assertEqual(out.status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me', headers={'Authorization': 'Bearer ' + access}).status_code, 401)
        self.assertEqual(self.client.post('/api/auth/refresh', json={'request_id': 'fixed-request-123456789'}).status_code, 401)

    def test_native_migration_receipt_and_cross_site_denial(self):
        headers = {'Authorization': 'Bearer ' + self.token, 'X-Zhicui-Session-Transport': 'native'}
        data = {'request_id': 'migration-request-12345'}
        first = self.client.post('/api/auth/session/migrate', json=data, headers=headers)
        again = self.client.post('/api/auth/session/migrate', json=data, headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['data'], again.json()['data'])
        self.assertEqual(self.db.query(UserAuthSession).count(), 1)
        self.assertNotIn('set-cookie', first.headers)
        self.assertIn('refresh_token', first.json()['data'])
        response = self.client.post('/api/auth/refresh', json=data, headers={'Origin': 'https://foreign.example', 'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(response.status_code, 403)

    def test_legacy_login_compatibility(self):
        with patch('app.api.auth_routes.auth_service.login', return_value=(self.token, self.user, None)), patch('app.api.auth_routes.activity_service.log_activity_safely'):
            response = self.client.post('/api/auth/login', json={'email': self.user.email, 'password': 'password'})
        self.assertEqual(response.json()['data']['token'], self.token)
        self.assertNotIn('set-cookie', response.headers)
