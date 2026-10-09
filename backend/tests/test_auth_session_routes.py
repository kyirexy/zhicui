"""真实 HTTP 契约：HttpOnly Cookie、迁移、重试、退出和跨站限制。"""
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
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
from app.services import auth_service, auth_session_service


def at_time(now):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(now.timestamp(), tz)

    stack = ExitStack()
    for target in ['app.services.auth_service.datetime', 'app.services.auth_session_service.datetime',
                   'app.services.auth_refresh_receipt.datetime', 'jwt.api_jwt.datetime']:
        stack.enter_context(patch(target, Clock))
    return stack


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
        self.assertEqual(first.json()['data']['refresh_token'], again.json()['data']['refresh_token'])
        self.assertEqual(first.json()['data']['session_id'], again.json()['data']['session_id'])
        self.assertEqual(self.db.query(UserAuthSession).count(), 1)
        self.assertNotIn('set-cookie', first.headers)
        self.assertIn('refresh_token', first.json()['data'])
        response = self.client.post('/api/auth/refresh', json=data, headers={'Origin': 'https://foreign.example', 'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(response.status_code, 403)

    def test_expired_source_only_recovers_its_committed_migration_with_fresh_access(self):
        now = datetime.now(timezone.utc)
        with at_time(now):
            token = auth_service.create_access_token(self.user.id, self.user.email, ttl_seconds=60)
            headers = {'Authorization': 'Bearer ' + token, 'X-Zhicui-Session-Transport': 'native'}
            body = {'request_id': 'migration-request-12345'}
            first = self.client.post('/api/auth/session/migrate', json=body, headers=headers)
        self.assertEqual(first.status_code, 200)
        initial = first.json()['data']
        expiry = auth_session_service.aware(self.db.query(UserAuthSession).one().expires_at)
        with at_time(now + timedelta(days=2)):
            self.assertIsNone(auth_service.decode_access_token(token))
            self.assertIsNone(auth_service.decode_access_token(initial['token']))
            again = self.client.post('/api/auth/session/migrate', json=body, headers=headers)
            self.assertEqual(again.status_code, 200)
            recovered = again.json()['data']
            self.assertIsNotNone(auth_service.decode_access_token(recovered['token']))
            different = self.client.post('/api/auth/session/migrate',
                json={'request_id': 'other-migration-request-12345'}, headers=headers)
            self.assertEqual(different.status_code, 401)
            self.assertEqual(different.json()['detail']['code'], 'SESSION_EXPIRED')
        self.assertEqual(recovered['refresh_token'], initial['refresh_token'])
        self.assertEqual(recovered['session_id'], initial['session_id'])
        self.assertEqual(self.db.query(UserAuthSession).count(), 1)
        self.assertEqual(auth_session_service.aware(self.db.query(UserAuthSession).one().expires_at), expiry)
        self.assertEqual(auth_session_service.aware(self.db.query(AuthRefreshReceipt).one().expires_at), expiry)

    def test_expired_source_without_receipt_cannot_create_a_session(self):
        expired = auth_service.create_access_token(self.user.id, self.user.email, ttl_seconds=-1)
        response = self.client.post('/api/auth/session/migrate', json={'request_id': 'migration-request-12345'},
            headers={'Authorization': 'Bearer ' + expired, 'X-Zhicui-Session-Transport': 'native'})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()['detail']['code'], 'SESSION_EXPIRED')
        self.assertEqual(self.db.query(UserAuthSession).count(), 0)

    def test_migration_recovery_rejects_missing_tampered_and_other_account_tokens(self):
        body = {'request_id': 'migration-request-12345'}
        headers = {'Authorization': 'Bearer ' + self.token, 'X-Zhicui-Session-Transport': 'native'}
        self.assertEqual(self.client.post('/api/auth/session/migrate', json=body, headers=headers).status_code, 200)
        other = User(id='other-owner', email='other@example.test', hashed_password='unused', is_active=True)
        self.db.add(other); self.db.commit()
        other_expired = auth_service.create_access_token(other.id, other.email, ttl_seconds=-1)
        token_head = self.token.rsplit('.', 1)[0]
        for authorization in ['', 'Basic invalid', 'Bearer ' + token_head + '.invalid', 'Bearer ' + other_expired]:
            with self.subTest(authorization_kind=authorization.split(' ', 1)[0]):
                response = self.client.post('/api/auth/session/migrate', json=body,
                    headers={'Authorization': authorization, 'X-Zhicui-Session-Transport': 'native'})
                self.assertEqual(response.status_code, 401)
        self.assertEqual(self.db.query(UserAuthSession).count(), 1)

    def test_email_verification_token_cannot_create_a_login_session(self):
        token = auth_service.create_email_verification_token(self.user, 'verification-nonce')
        response = self.client.post('/api/auth/session/migrate', json={'request_id': 'migration-request-12345'},
            headers={'Authorization': 'Bearer ' + token})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.db.query(UserAuthSession).count(), 0)

    def test_migration_recovery_rejects_rotated_revoked_disabled_and_expired_sessions(self):
        for condition in ['rotated', 'revoked', 'disabled', 'expired']:
            with self.subTest(condition=condition):
                now = datetime.now(timezone.utc)
                with at_time(now):
                    token = auth_service.create_access_token(self.user.id, self.user.email, ttl_seconds=60)
                    headers = {'Authorization': 'Bearer ' + token, 'X-Zhicui-Session-Transport': 'native'}
                    body = {'request_id': 'migration-condition-' + condition}
                    first = self.client.post('/api/auth/session/migrate', json=body, headers=headers)
                self.assertEqual(first.status_code, 200)
                data = first.json()['data']
                row = self.db.get(UserAuthSession, data['session_id'])
                if condition == 'rotated':
                    auth_session_service.refresh(self.db, data['refresh_token'], 'later-refresh-request-12345')
                elif condition == 'revoked':
                    auth_session_service.revoke(self.db, data['refresh_token'], None)
                elif condition == 'disabled':
                    self.user.is_active = False
                else:
                    row.expires_at = now + timedelta(minutes=5)
                self.db.commit()
                count = self.db.query(UserAuthSession).count()
                with at_time(now + timedelta(hours=2)):
                    again = self.client.post('/api/auth/session/migrate', json=body, headers=headers)
                self.assertEqual(again.status_code, 401)
                self.assertEqual(self.db.query(UserAuthSession).count(), count)
                # 每个子场景独立，撤销记录不会影响下一个场景的原始 JWT。
                self.db.query(AuthRefreshReceipt).delete()
                self.db.query(UserAuthSession).delete()
                self.user.is_active = True
                self.db.commit()

    def test_legacy_login_compatibility(self):
        with patch('app.api.auth_routes.auth_service.login', return_value=(self.token, self.user, None)), patch('app.api.auth_routes.activity_service.log_activity_safely'):
            response = self.client.post('/api/auth/login', json={'email': self.user.email, 'password': 'password'})
        self.assertEqual(response.json()['data']['token'], self.token)
        self.assertNotIn('set-cookie', response.headers)
