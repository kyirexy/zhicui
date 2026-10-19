"""密码重置必须收回旧授权，且密码、撤销和审计不能部分成功。"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import jwt
from fastapi import HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import create_engine
from sqlalchemy.orm import Query, sessionmaker

from app.core.auth import get_current_user
from app.core.database import Base
from app.models.user import User
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.models.admin_audit_log import AdminAuditLog
from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
from app.models.desktop_handoff import DesktopHandoff
from app.models.desktop_login_session import DesktopLoginSession
from app.models.phone_login_session import PhoneLoginSession
from app.services import auth_service, auth_session_service as service, audit_service
from app.services import agent_credential_service as agent_credentials, desktop_handoff_service


class PasswordResetRevocationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine, tables=[model.__table__ for model in (
            User, UserAuthSession, AuthRefreshReceipt, AdminAuditLog, AgentCredential,
            AgentDeviceAuthorization, DesktopHandoff, DesktopLoginSession, PhoneLoginSession)])
        self.factory = sessionmaker(bind=self.engine)
        self.db = self.factory()
        self.db.add_all([User(id=uid, email=f"{uid}@example.test", username=uid,
            hashed_password=auth_service.hash_password("old-test-password"), is_active=True,
            is_admin=uid == "admin") for uid in ("owner", "other", "admin")])
        self.db.commit()
        self.owner = self.db.get(User, "owner")

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def reset_password(self, **kwargs):
        return service.reset_password_by_admin(self.db, user_id="owner", new_password="new-test-password",
            admin_user_id="admin", **kwargs)

    def legacy_token(self, uid="owner", *, expired=False):
        return jwt.encode({"sub": uid, "email": f"{uid}@example.test",
            "exp": datetime.now(timezone.utc) + timedelta(hours=-1 if expired else 1)},
            auth_service.SECRET_KEY, algorithm="HS256")

    def current_user(self, token, db=None):
        return get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token), db or self.db)

    def test_reset_revokes_legacy_access_refresh_and_migration_receipts_but_not_other_users(self):
        legacy = self.legacy_token()
        other = self.legacy_token("other")
        self.assertEqual(self.current_user(legacy).id, "owner")
        migrated = service.migrate(self.db, legacy, "migration-before-reset")
        original = service.issue(self.db, self.owner)
        rotated = service.refresh(self.db, original["refresh_token"], "refresh-before-reset")
        self.assertTrue(self.reset_password())
        for token in (legacy, original["token"], rotated["token"], migrated["token"]):
            with self.assertRaises(HTTPException):
                self.current_user(token)
        for refresh_token, request_id in ((original["refresh_token"], "refresh-before-reset"),
                (rotated["refresh_token"], "new-refresh-after-reset")):
            with self.assertRaises(HTTPException):
                service.refresh(self.db, refresh_token, request_id)
        for token, request_id in ((legacy, "migration-before-reset"), (legacy, "new-migration"),
                (self.legacy_token(expired=True), "expired-migration")):
            with self.assertRaises(HTTPException):
                service.migrate(self.db, token, request_id)
        self.assertEqual(self.current_user(other).id, "other")
        self.assertEqual(self.db.get(User, "other").auth_version, 0)
        self.assertEqual(self.db.get(User, "owner").auth_version, 1)
        self.assertIsNone(auth_service.login(self.db, "owner", "old-test-password")[0])
        token, user, error = auth_service.login(self.db, "owner", "new-test-password")
        self.assertIsNone(error)
        self.assertEqual(self.current_user(token).id, "owner")
        for headers in ([], [(b"x-zhicui-session-version", b"2")]):
            result = service.login_payload(self.db, user,
                Request({"type": "http", "headers": headers, "scheme": "https", "server": ("test", 443), "path": "/"}),
                Response(), token)
            self.assertEqual(self.current_user(result["token"]).id, "owner")
        self.assertEqual(self.db.query(AdminAuditLog).count(), 1)
        self.assertNotIn("password", self.db.query(AdminAuditLog).one().detail)

    def test_cached_identity_cannot_issue_or_refresh_after_reset(self):
        original = service.issue(self.db, self.owner)
        stale = self.factory()
        stale_user = stale.get(User, "owner")
        stale_session = stale.get(UserAuthSession, original["session_id"])
        self.assertIsNone(stale_session.revoked_at)
        self.reset_password()
        with self.assertRaises(HTTPException):
            service.issue(stale, stale_user)
        with self.assertRaises(HTTPException):
            service.refresh(stale, original["refresh_token"], "stale-refresh-after-reset")
        with self.assertRaises(HTTPException):
            self.current_user(original["token"], stale)
        stale.close()

    def test_audit_failure_rolls_back_password_and_revocations(self):
        original = service.issue(self.db, self.owner)
        with patch.object(audit_service, "log_action", side_effect=RuntimeError("audit unavailable")):
            with self.assertRaises(RuntimeError):
                self.reset_password()
        self.assertTrue(auth_service.verify_password("old-test-password", self.db.get(User, "owner").hashed_password))
        self.assertEqual(self.db.get(User, "owner").auth_version, 0)
        self.assertIsNone(self.db.get(UserAuthSession, original["session_id"]).revoked_at)
        self.assertEqual(self.current_user(original["token"]).id, "owner")

    def test_caller_can_include_rename_in_one_transaction(self):
        self.owner.username = "new-test-name"
        self.db.flush()
        self.reset_password(commit=False)
        self.db.rollback()
        self.assertEqual(self.db.get(User, "owner").username, "owner")
        self.assertEqual(self.db.get(User, "owner").auth_version, 0)
        self.assertEqual(self.db.query(AdminAuditLog).count(), 0)

    def test_agent_access_refresh_and_lost_response_receipt_are_revoked(self):
        with patch.object(agent_credentials, "user_is_enabled", return_value=True):
            _, device, code = agent_credentials.create_device_authorization(self.db,
                client_name="test", client_type="cli", scopes=["account:read"])
            agent_credentials.approve_device_authorization(self.db, user_id="owner", user_code=code, approve=True)
            issued = agent_credentials.poll_device_authorization(self.db, device_code=device)
            rotated = agent_credentials.rotate_refresh_token(self.db, issued["refresh_token"], "before-password-reset")
            self.reset_password()
            with self.assertRaises(agent_credentials.CredentialError):
                agent_credentials.authenticate_access_token(self.db, rotated["access_token"])
            for token, request_id in ((issued["refresh_token"], "before-password-reset"),
                    (rotated["refresh_token"], "after-password-reset")):
                with self.assertRaises(agent_credentials.CredentialError):
                    agent_credentials.rotate_refresh_token(self.db, token, request_id)

    def test_authorization_becoming_owned_between_reads_is_retried_without_issuing(self):
        _, device, _ = agent_credentials.create_device_authorization(self.db,
            client_name="test", client_type="cli", scopes=["account:read"])
        real_scalar = Query.scalar
        changed = []
        def approve_after_owner_read(query):
            value = real_scalar(query)
            if not changed and query.column_descriptions[0]["name"] == "approved_user_id":
                changed.append(True)
                self.db.query(AgentDeviceAuthorization).update({"approved_user_id": "owner", "status": "approved"})
                self.db.commit()
            return value
        with patch.object(Query, "scalar", approve_after_owner_read):
            with self.assertRaises(agent_credentials.CredentialError) as error:
                agent_credentials.poll_device_authorization(self.db, device_code=device)
        self.assertEqual(error.exception.code, "AUTHORIZATION_PENDING")
        self.assertEqual(self.db.query(AgentCredential).count(), 0)

        ticket = "handoff-test-" * 4
        desktop_handoff_service.create_handoff(self.db, ticket)
        changed.clear()
        def claim_after_owner_read(query):
            value = real_scalar(query)
            if not changed and query.column_descriptions[0]["name"] == "user_id":
                changed.append(True)
                self.db.query(DesktopHandoff).update({"user_id": "owner", "status": "claimed"})
                self.db.commit()
            return value
        with patch.object(Query, "scalar", claim_after_owner_read):
            self.assertEqual(desktop_handoff_service.consume_handoff(self.db, ticket), ("pending", None))
        self.assertEqual(self.db.query(DesktopHandoff).one().status, "claimed")

    def test_pending_authorizations_and_independent_agent_credentials_are_cancelled(self):
        now = datetime.now(timezone.utc)
        for uid in ("owner", "other"):
            self.db.add_all([
                AgentCredential(id=uid.ljust(32, "0"), user_id=uid, kind="pat", token_hash=uid,
                    token_prefix="test", expires_at=now + timedelta(days=1)),
                AgentDeviceAuthorization(id="device-" + uid, approved_user_id=uid, status="approved",
                    device_code_hash=uid, user_code_hash=uid, user_code_hint="TEST", expires_at=now + timedelta(minutes=5)),
                DesktopHandoff(id="handoff-" + uid, session_id=uid * 12, user_id=uid, status="claimed",
                    expires_at=now + timedelta(minutes=5)),
                DesktopLoginSession(id="desktop-" + uid, user_id=uid, approval_token_hash=uid,
                    poll_secret_hash=uid, status="approved", client_name="test", client_type="web",
                    verification_code="1234", expires_at=now + timedelta(minutes=5)),
                PhoneLoginSession(id="phone-" + uid, user_id=uid, scan_hash=uid, status="approved",
                    created_at=now, expires_at=now + timedelta(minutes=5)),
            ])
        self.db.commit()
        self.reset_password()
        self.assertIsNotNone(self.db.get(AgentCredential, "owner".ljust(32, "0")).revoked_at)
        self.assertIsNone(self.db.get(AgentCredential, "other".ljust(32, "0")).revoked_at)
        for model, prefix, expected in ((AgentDeviceAuthorization, "device-", "denied"),
                (DesktopHandoff, "handoff-", "expired"), (DesktopLoginSession, "desktop-", "cancelled"),
                (PhoneLoginSession, "phone-", "cancelled")):
            self.assertEqual(self.db.get(model, prefix + "owner").status, expected)
            self.assertEqual(self.db.get(model, prefix + "other").status, "claimed" if model is DesktopHandoff else "approved")


if __name__ == "__main__":
    unittest.main()
