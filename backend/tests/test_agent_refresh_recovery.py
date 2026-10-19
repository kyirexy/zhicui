"""Agent 刷新丢包的长期恢复与撤销边界。"""
from __future__ import annotations

import os
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "agent-refresh-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "agent-refresh-test-pepper-123456789")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models.admin_audit_log import AdminAuditLog
from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
from app.models.auth_session import AuthRefreshReceipt, UserAuthSession
from app.models.desktop_handoff import DesktopHandoff
from app.models.desktop_login_session import DesktopLoginSession
from app.models.phone_login_session import PhoneLoginSession
from app.models.user import User
from app.services import agent_credential_service as service, auth_session_service
from app.services.auth_refresh_receipt import aware


def at_time(now: datetime):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(now.timestamp(), tz)

    stack = ExitStack()
    stack.enter_context(patch.object(service, "utcnow", return_value=now))
    for target in ("app.services.auth_refresh_receipt.datetime", "app.services.auth_session_service.datetime"):
        stack.enter_context(patch(target, Clock))
    return stack


class AgentRefreshRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine, tables=[model.__table__ for model in (
            User, AgentCredential, AgentDeviceAuthorization, AuthRefreshReceipt, UserAuthSession,
            AdminAuditLog, DesktopHandoff, DesktopLoginSession, PhoneLoginSession,
        )])
        self.factory = sessionmaker(bind=self.engine)
        self.db = self.factory()
        self.db.add_all([
            User(id="owner", email="owner@example.test", hashed_password="unused", is_active=True),
            User(id="other", email="other@example.test", hashed_password="unused", is_active=True),
        ])
        self.db.commit()
        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.request_id = "lost-reply-request-123456789"
        self.context = ExitStack()
        self.context.enter_context(patch.object(settings, "AGENT_INTERFACE_PROFILE", "core"))
        self.context.enter_context(patch.object(settings, "AGENT_INTERFACE_USER_ALLOWLIST", ""))
        self.addCleanup(self.context.close)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def issue(self, user_id="owner"):
        with at_time(self.now):
            _, device, code = service.create_device_authorization(
                self.db, client_name="恢复测试", client_type="cli", scopes=["library:read"],
            )
            service.approve_device_authorization(self.db, user_id=user_id, user_code=code, approve=True)
            result = service.poll_device_authorization(self.db, device_code=device)
            row = self.db.get(AgentCredential, result["credential"]["id"])
            row.created_at = self.now
            self.db.commit()
        return result

    def rotate(self, issued):
        with at_time(self.now):
            return service.rotate_refresh_token(self.db, issued["refresh_token"], self.request_id)

    def test_reply_remains_recoverable_after_ten_minutes(self):
        initial = self.issue()
        first = self.rotate(initial)
        with at_time(self.now + timedelta(minutes=15)):
            recovered = service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            self.assertEqual(recovered, first)
            row = service.authenticate_access_token(self.db, recovered["access_token"])
        self.assertIsNone(row.revoked_at)
        self.assertEqual(row.refresh_generation, 1)

    def test_days_later_recovery_renews_access_without_extending_refresh_or_grants(self):
        initial = self.issue()
        first = self.rotate(initial)
        row = self.db.get(AgentCredential, first["credential"]["id"])
        expiry = aware(row.refresh_expires_at)
        receipt = self.db.query(AuthRefreshReceipt).one()
        self.assertEqual(aware(receipt.expires_at), expiry)
        self.assertNotIn(first["access_token"], receipt.encrypted_result)
        self.assertNotIn(first["refresh_token"], receipt.encrypted_result)
        with at_time(self.now + timedelta(days=2)):
            with self.assertRaises(service.CredentialError) as expired:
                service.authenticate_access_token(self.db, first["access_token"])
            self.assertEqual(expired.exception.code, "CREDENTIAL_EXPIRED")
            recovered = service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            service.authenticate_access_token(self.db, recovered["access_token"])
            self.assertEqual(
                recovered, service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id),
            )
        self.assertNotEqual(recovered["access_token"], first["access_token"])
        self.assertEqual(recovered["refresh_token"], first["refresh_token"])
        self.assertEqual(recovered["expires_in"], 3600)
        self.assertEqual(aware(row.expires_at), self.now + timedelta(days=2, hours=1))
        self.assertEqual(aware(row.refresh_expires_at), expiry)
        self.assertEqual(row.refresh_generation, 1)
        self.assertEqual(row.scopes, ["library:read"])
        self.assertEqual(self.db.query(AuthRefreshReceipt).count(), 1)
        self.assertEqual(aware(receipt.expires_at), expiry)
        with at_time(self.now + timedelta(days=3)):
            later = service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            service.authenticate_access_token(self.db, later["access_token"])
        self.assertNotEqual(later["access_token"], recovered["access_token"])
        self.assertEqual(later["refresh_token"], first["refresh_token"])
        self.assertEqual(aware(row.refresh_expires_at), expiry)

    def test_receipts_are_bounded_per_credential_and_do_not_cross_accounts(self):
        initial = self.issue()
        current = self.rotate(initial)
        other = self.rotate(self.issue("other"))
        with at_time(self.now + timedelta(minutes=5)):
            for number in range(12):
                current = service.rotate_refresh_token(
                    self.db, current["refresh_token"], f"next-refresh-request-{number:04d}",
                )
                self.assertEqual(self.db.query(AuthRefreshReceipt).count(), 2)
            with self.assertRaises(service.CredentialError):
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            service.authenticate_access_token(self.db, current["access_token"])
            service.authenticate_access_token(self.db, other["access_token"])
        self.assertIsNone(self.db.get(AgentCredential, other["credential"]["id"]).revoked_at)

    def test_old_receipt_is_rejected_when_successor_was_rotated_without_request_id(self):
        initial = self.issue()
        first = self.rotate(initial)
        with at_time(self.now + timedelta(days=2)):
            current = service.rotate_refresh_token(self.db, first["refresh_token"])
            self.assertEqual(self.db.query(AuthRefreshReceipt).count(), 1)
            with self.assertRaises(service.CredentialError) as old:
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            self.assertEqual(old.exception.code, "INVALID_CREDENTIAL")
            service.authenticate_access_token(self.db, current["access_token"])

    def test_different_request_is_replay_and_revokes_the_current_successor(self):
        initial = self.issue()
        first = self.rotate(initial)
        with at_time(self.now + timedelta(minutes=15)):
            with self.assertRaises(service.CredentialError) as replay:
                service.rotate_refresh_token(self.db, initial["refresh_token"], "different-request-123456789")
            self.assertEqual(replay.exception.code, "REFRESH_TOKEN_REUSED")
            with self.assertRaises(service.CredentialError):
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            with self.assertRaises(service.CredentialError) as revoked:
                service.authenticate_access_token(self.db, first["access_token"])
            self.assertEqual(revoked.exception.code, "CREDENTIAL_REVOKED")

    def test_explicit_revocation_and_disabled_account_block_late_recovery(self):
        for boundary in ("revoked", "disabled"):
            with self.subTest(boundary=boundary):
                initial = self.issue()
                first = self.rotate(initial)
                row = self.db.get(AgentCredential, first["credential"]["id"])
                digest = row.token_hash
                if boundary == "revoked":
                    service.revoke_credential(self.db, user_id="owner", credential_id=row.id)
                else:
                    self.db.get(User, "owner").is_active = False
                    self.db.commit()
                with at_time(self.now + timedelta(days=2)):
                    with self.assertRaises(service.CredentialError):
                        service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
                self.assertEqual(row.token_hash, digest)

    def test_password_reset_blocks_cached_receipt_and_credential_in_another_session(self):
        initial = self.issue()
        first = self.rotate(initial)
        with self.factory() as stale:
            credential = stale.get(AgentCredential, first["credential"]["id"])
            stale.get(User, "owner")
            with at_time(self.now + timedelta(days=2)):
                auth_session_service.reset_password_by_admin(
                    self.db, user_id="owner", new_password="new-test-password", admin_user_id="other",
                )
                with self.assertRaises(service.CredentialError):
                    service.rotate_refresh_token(stale, initial["refresh_token"], self.request_id)
            self.assertIsNotNone(credential.revoked_at)
            self.assertEqual(credential.refresh_generation, 1)
        self.assertEqual(self.db.get(User, "owner").auth_version, 1)

    def test_authenticated_version_change_blocks_receipt_recovery(self):
        initial = self.issue()
        first = self.rotate(initial)
        self.db.info["authenticated_versions"] = {"owner": 0}
        with self.factory() as changed:
            changed.get(User, "owner").auth_version = 1
            changed.commit()
        with at_time(self.now + timedelta(days=2)):
            with self.assertRaises(service.CredentialError) as stale:
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
        self.assertEqual(stale.exception.code, "INVALID_CREDENTIAL")
        self.assertEqual(self.db.get(AgentCredential, first["credential"]["id"]).refresh_generation, 1)

    def test_recovery_still_checks_rollout_and_release_scope(self):
        initial = self.issue()
        first = self.rotate(initial)
        digest = self.db.get(AgentCredential, first["credential"]["id"]).token_hash
        with at_time(self.now + timedelta(days=2)):
            with patch.object(settings, "AGENT_INTERFACE_USER_ALLOWLIST", "other"):
                with self.assertRaises(service.CredentialError) as rollout:
                    service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
                self.assertEqual(rollout.exception.code, "ROLLOUT_RESTRICTED")
            with patch.object(service, "allowed_scope_ids", return_value=frozenset({"account:read"})):
                with self.assertRaises(service.CredentialError) as scope:
                    service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
                self.assertEqual(scope.exception.code, "SCOPE_UNAVAILABLE")
        self.assertEqual(self.db.get(AgentCredential, first["credential"]["id"]).token_hash, digest)

    def test_recovery_stops_at_thirty_day_idle_limit(self):
        initial = self.issue()
        first = self.rotate(initial)
        row = self.db.get(AgentCredential, first["credential"]["id"])
        self.assertEqual(aware(row.refresh_expires_at), self.now + timedelta(days=30))
        with at_time(self.now + timedelta(days=30)):
            with self.assertRaises(service.CredentialError) as expired:
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
        self.assertEqual(expired.exception.code, "REFRESH_TOKEN_EXPIRED")
        self.assertEqual(row.refresh_generation, 1)

    def test_absolute_limit_caps_receipt_and_recovered_access(self):
        initial = self.issue()
        row = self.db.get(AgentCredential, initial["credential"]["id"])
        row.created_at = self.now - timedelta(days=364)
        self.db.commit()
        first = self.rotate(initial)
        expiry = self.now + timedelta(days=1)
        self.assertEqual(aware(row.refresh_expires_at), expiry)
        self.assertEqual(aware(self.db.query(AuthRefreshReceipt).one().expires_at), expiry)
        with at_time(expiry - timedelta(minutes=30)):
            recovered = service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            service.authenticate_access_token(self.db, recovered["access_token"])
        self.assertEqual(recovered["refresh_token"], first["refresh_token"])
        self.assertEqual(recovered["expires_in"], 1800)
        self.assertEqual(aware(row.expires_at), expiry)
        with at_time(expiry):
            with self.assertRaises(service.CredentialError) as expired:
                service.rotate_refresh_token(self.db, initial["refresh_token"], self.request_id)
            self.assertEqual(expired.exception.code, "REFRESH_TOKEN_EXPIRED")
            with self.assertRaises(service.CredentialError):
                service.authenticate_access_token(self.db, recovered["access_token"])


if __name__ == "__main__":
    unittest.main()
