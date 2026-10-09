from __future__ import annotations
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.core.database import Base
from app.models.user import User
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.services import auth_service, auth_session_service as service


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


class SessionRefreshTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine, tables=[User.__table__, UserAuthSession.__table__, AuthRefreshReceipt.__table__])
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.user = User(id='session-owner', email='session@example.test', hashed_password='x', is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_one_hour_access_and_rolling_expiry_with_absolute_cap(self):
        result = service.issue(self.db, self.user)
        claims = auth_service.decode_access_token(result['token'])
        self.assertAlmostEqual(claims['exp'] - datetime.now(timezone.utc).timestamp(), 3600, delta=3)
        row = self.db.get(UserAuthSession, result['session_id'])
        old_expiry = datetime.now(timezone.utc) + timedelta(days=1)
        row.expires_at = old_expiry
        row.absolute_expires_at = datetime.now(timezone.utc) + timedelta(days=5)
        self.db.commit()
        renewed = service.refresh(self.db, result['refresh_token'], 'r' * 32)
        self.assertGreater(row.expires_at, old_expiry)
        self.assertEqual(row.expires_at, row.absolute_expires_at)
        self.assertNotEqual(renewed['refresh_token'], result['refresh_token'])

    def test_lost_response_can_be_recovered_without_new_rotation(self):
        initial = service.issue(self.db, self.user)
        first = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        again = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        self.assertEqual(first['refresh_token'], again['refresh_token'])
        self.assertEqual(first['session_id'], again['session_id'])
        self.assertIsNotNone(auth_service.decode_access_token(again['token']))
        receipt = self.db.query(AuthRefreshReceipt).one()
        self.assertNotIn(first['refresh_token'], receipt.encrypted_result)
        with self.assertRaises(HTTPException) as error:
            service.refresh(self.db, initial['refresh_token'], 'different-request-12345')
        self.assertEqual(error.exception.detail['code'], 'SESSION_REFRESH_REUSED')

    def test_lost_reply_recovers_after_days_with_fresh_access_and_no_expiry_extension(self):
        now = datetime.now(timezone.utc)
        with at_time(now):
            initial = service.issue(self.db, self.user)
            first = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        row = self.db.get(UserAuthSession, first['session_id'])
        expiry = service.aware(row.expires_at)
        receipt_expiry = service.aware(self.db.query(AuthRefreshReceipt).one().expires_at)
        self.assertEqual(receipt_expiry, expiry)
        with at_time(now + timedelta(days=2)):
            self.assertIsNone(auth_service.decode_access_token(first['token']))
            recovered = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
            claims = auth_service.decode_access_token(recovered['token'])
            self.assertIsNotNone(claims)
            self.assertAlmostEqual(claims['exp'] - (now + timedelta(days=2)).timestamp(), 3600, delta=1)
        self.assertEqual(recovered['refresh_token'], first['refresh_token'])
        self.assertEqual(recovered['session_id'], first['session_id'])
        self.assertEqual(service.aware(row.expires_at), expiry)
        self.assertEqual(service.aware(self.db.query(AuthRefreshReceipt).one().expires_at), receipt_expiry)

    def test_only_current_successor_is_recoverable_and_receipt_storage_is_bounded(self):
        initial = service.issue(self.db, self.user)
        current = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        for number in range(12):
            current = service.refresh(self.db, current['refresh_token'], f'next-request-number-{number:04d}')
            self.assertEqual(self.db.query(AuthRefreshReceipt).count(), 1)
        with self.assertRaises(HTTPException) as error:
            service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        self.assertEqual(error.exception.detail['code'], 'SESSION_REFRESH_REUSED')

    def test_disabled_account_cannot_recover_an_existing_receipt(self):
        initial = service.issue(self.db, self.user)
        service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        self.user.is_active = False
        self.db.commit()
        with self.assertRaises(HTTPException) as error:
            service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        self.assertEqual(error.exception.detail['code'], 'ACCOUNT_DISABLED')

    def test_recovery_ends_at_session_expiry_and_expired_receipts_are_collected(self):
        now = datetime.now(timezone.utc)
        with at_time(now):
            initial = service.issue(self.db, self.user)
            row = self.db.get(UserAuthSession, initial['session_id'])
            row.absolute_expires_at = now + timedelta(days=1)
            self.db.commit()
            service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        self.assertEqual(service.aware(self.db.query(AuthRefreshReceipt).one().expires_at), now + timedelta(days=1))
        with at_time(now + timedelta(days=1, seconds=1)):
            with self.assertRaises(HTTPException) as error:
                service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
            self.assertEqual(error.exception.detail['code'], 'SESSION_EXPIRED')
            other = service.issue(self.db, self.user)
            service.refresh(self.db, other['refresh_token'], 'new-session-request-1234')
        receipts = self.db.query(AuthRefreshReceipt).all()
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0].owner, 'session:' + other['session_id'])

    def test_revocation_blocks_access_refresh_and_recovery(self):
        initial = service.issue(self.db, self.user)
        current = service.refresh(self.db, initial['refresh_token'], 'same-request-123456789')
        service.revoke(self.db, current['refresh_token'], current['token'])
        with self.assertRaises(HTTPException):
            service.assert_session_active(self.db, auth_service.decode_access_token(current['token']))
        for token in [initial['refresh_token'], current['refresh_token']]:
            with self.assertRaises(HTTPException):
                service.refresh(self.db, token, 'same-request-123456789')

    def test_lost_refresh_reply_can_still_be_logged_out_with_old_refresh(self):
        old = service.issue(self.db, self.user)
        new = service.refresh(self.db, old['refresh_token'], 'same-request-123456789')
        service.revoke(self.db, old['refresh_token'], None)
        with self.assertRaises(HTTPException):
            service.refresh(self.db, new['refresh_token'], 'next-request-123456789')

    def test_disabled_account_and_expired_refresh_do_not_recover(self):
        current = service.issue(self.db, self.user)
        self.user.is_active = False
        self.db.commit()
        with self.assertRaises(HTTPException): service.refresh(self.db, current['refresh_token'], 'r' * 32)
        self.user.is_active = True
        self.db.get(UserAuthSession, current['session_id']).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.db.commit()
        with self.assertRaises(HTTPException): service.refresh(self.db, current['refresh_token'], 'r' * 32)

    def test_old_valid_jwt_migrates_but_cannot_revive_revoked_session(self):
        old = auth_service.create_access_token(self.user.id, self.user.email)
        current = service.issue(self.db, self.user, 'desktop', old)
        service.assert_session_active(self.db, auth_service.decode_access_token(old), old)
        service.revoke(self.db, current['refresh_token'], None)
        with self.assertRaises(HTTPException): service.assert_session_active(self.db, auth_service.decode_access_token(old), old)
