"""Security and lifecycle tests for Android -> desktop QR login v2."""

from __future__ import annotations

import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("JWT_SECRET", "desktop-qr-test-secret-0123456789abcdef")

from app.api.desktop_login_routes import router
from app.core.database import Base, get_db
from app.core.rate_limit import POLICIES, _matches
from app.core.security_headers import SecurityHeadersMiddleware
from app.models.desktop_login_session import DesktopLoginSession
from app.models.user import User
from app.services import desktop_login_service
from app.services.auth_service import create_access_token


class DesktopQrLoginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "desktop-login.db"
        self.engine = create_engine(
            f"sqlite:///{database_path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 30},
        )

        @event.listens_for(self.engine, "connect")
        def _sqlite_options(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")

        Base.metadata.create_all(
            self.engine,
            tables=[User.__table__, DesktopLoginSession.__table__],
        )
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.Session() as db:
            first = User(
                email="first@example.com",
                username="first",
                hashed_password="unused",
                is_active=True,
                is_admin=False,
            )
            second = User(
                email="second@example.com",
                username="second",
                hashed_password="unused",
                is_active=True,
                is_admin=False,
            )
            db.add_all([first, second])
            db.commit()
            self.first_id = first.id
            self.second_id = second.id
            self.first_token = create_access_token(first.id, first.email)
            self.second_token = create_access_token(second.id, second.email)

        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)
        app.include_router(router)

        def override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_db
        self.activity_patch = patch(
            "app.api.desktop_login_routes.activity_service.log_activity_safely",
            return_value=None,
        )
        self.activity_log = self.activity_patch.start()
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        self.client.close()
        self.activity_patch.stop()
        self.engine.dispose()
        self.temp_dir.cleanup()

    def _create(self) -> dict:
        response = self.client.post(
            "/api/auth/desktop-login/sessions",
            json={"client_name": "untrusted label", "client_type": "windows"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("no-store", response.headers.get("cache-control", ""))
        data = response.json()["data"]
        self.assertEqual(data["client_name"], "Windows 客户端")
        return data

    @staticmethod
    def _approval_body(created: dict) -> dict:
        return {"approval_token": created["approval_token"]}

    @staticmethod
    def _poll_body(created: dict) -> dict:
        return {"poll_secret": created["poll_secret"]}

    def _approve(self, created: dict, token: str | None = None):
        return self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/decision",
            headers={"Authorization": f"Bearer {token or self.first_token}"},
            json={**self._approval_body(created), "decision": "approve"},
        )

    def test_normal_lifecycle_separates_hashes_and_consumes_once(self) -> None:
        created = self._create()
        self.assertNotIn(created["poll_secret"], created["approval_url"])
        self.assertIn("#desktop-login=", created["approval_url"])
        self.assertEqual(created["poll_interval_seconds"], 2)
        self.assertTrue(created["expires_at"].endswith("Z"))
        expires_at = datetime.fromisoformat(created["expires_at"].replace("Z", "+00:00"))
        self.assertEqual(expires_at.utcoffset(), timedelta(0))

        with self.Session() as db:
            row = db.query(DesktopLoginSession).filter(
                DesktopLoginSession.id == created["session_id"]
            ).one()
            self.assertNotEqual(row.approval_token_hash, created["approval_token"])
            self.assertNotEqual(row.poll_secret_hash, created["poll_secret"])
            self.assertEqual(
                row.approval_token_hash,
                desktop_login_service.approval_token_hash(created["approval_token"]),
            )
            self.assertEqual(
                row.poll_secret_hash,
                desktop_login_service.poll_secret_hash(created["poll_secret"]),
            )
            self.assertNotEqual(row.approval_token_hash, row.poll_secret_hash)

        preview = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/preview",
            json=self._approval_body(created),
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["data"]["status"], "pending")
        self.assertNotIn("approval_token", preview.text)
        self.assertNotIn("poll_secret", preview.text)

        approved = self._approve(created)
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["data"]["status"], "approved")
        other_account = self._approve(created, self.second_token)
        self.assertEqual(other_account.status_code, 409, other_account.text)

        consumed = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/token",
            json=self._poll_body(created),
        )
        self.assertEqual(consumed.status_code, 200, consumed.text)
        payload = consumed.json()["data"]
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["user"]["id"], self.first_id)
        self.assertTrue(payload["token"])

        replay = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/token",
            json=self._poll_body(created),
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["data"]["status"], "consumed")
        self.assertNotIn("token", replay.json()["data"])
        logged = repr(self.activity_log.call_args_list)
        self.assertNotIn(created["approval_token"], logged)
        self.assertNotIn(created["poll_secret"], logged)
        self.assertNotIn(payload["token"], logged)

    def test_credentials_cannot_be_swapped_and_errors_are_no_store(self) -> None:
        created = self._create()
        wrong_poll = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/token",
            json={"poll_secret": created["approval_token"]},
        )
        self.assertEqual(wrong_poll.status_code, 404, wrong_poll.text)
        self.assertIn("no-store", wrong_poll.headers.get("cache-control", ""))

        wrong_approval = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/preview",
            json={"approval_token": created["poll_secret"]},
        )
        self.assertEqual(wrong_approval.status_code, 404, wrong_approval.text)
        self.assertIn("no-store", wrong_approval.headers.get("cache-control", ""))

        malformed = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/token",
            json={"poll_secret": "short"},
        )
        self.assertEqual(malformed.status_code, 404, malformed.text)
        self.assertIn("no-store", malformed.headers.get("cache-control", ""))
        self.assertNotIn("short", malformed.text)

        missing = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/token",
            json={},
        )
        self.assertEqual(missing.status_code, 422, missing.text)
        self.assertIn("no-store", missing.headers.get("cache-control", ""))

    def test_rate_limit_policies_cover_create_approval_and_poll_operations(self) -> None:
        policy_map = {policy.name: policy for policy in POLICIES}
        self.assertGreaterEqual(policy_map["desktop_login_poll"].limit, 1200)

        def request(path: str) -> Request:
            return Request({
                "type": "http",
                "method": "POST",
                "path": path,
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 1234),
                "server": ("testserver", 80),
                "scheme": "http",
            })

        session_id = "dls-" + "a" * 32
        self.assertTrue(_matches(
            policy_map["desktop_login_create"],
            request("/api/auth/desktop-login/sessions"),
        ))
        self.assertTrue(_matches(
            policy_map["desktop_login_approval"],
            request(f"/api/auth/desktop-login/sessions/{session_id}/decision"),
        ))
        self.assertTrue(_matches(
            policy_map["desktop_login_approval"],
            request(f"/api/auth/desktop-login/sessions/{session_id}/preview"),
        ))
        self.assertTrue(_matches(
            policy_map["desktop_login_poll"],
            request(f"/api/auth/desktop-login/sessions/{session_id}/token"),
        ))
        self.assertTrue(_matches(
            policy_map["desktop_login_poll"],
            request(f"/api/auth/desktop-login/sessions/{session_id}/cancel"),
        ))
        self.assertFalse(_matches(
            policy_map["desktop_login_create"],
            request(f"/api/auth/desktop-login/sessions/{session_id}/token"),
        ))

    def test_sqlite_naive_expiry_is_serialized_with_explicit_utc(self) -> None:
        created = self._create()
        with self.Session() as db:
            row = db.query(DesktopLoginSession).filter(
                DesktopLoginSession.id == created["session_id"]
            ).one()
            self.assertIsNone(row.expires_at.tzinfo)

        preview = self.client.post(
            f"/api/auth/desktop-login/sessions/{created['session_id']}/preview",
            json=self._approval_body(created),
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        serialized = preview.json()["data"]["expires_at"]
        self.assertTrue(serialized.endswith("Z"), serialized)
        parsed = datetime.fromisoformat(serialized.replace("Z", "+00:00"))
        self.assertEqual(parsed.utcoffset(), timedelta(0))

    def test_pending_poll_is_interval_limited_but_approval_can_complete(self) -> None:
        created = self._create()
        path = f"/api/auth/desktop-login/sessions/{created['session_id']}/token"
        first = self.client.post(path, json=self._poll_body(created))
        second = self.client.post(path, json=self._poll_body(created))
        self.assertEqual(first.json()["data"]["status"], "pending")
        self.assertEqual(second.json()["data"]["status"], "slow_down")
        self.assertGreaterEqual(second.json()["data"]["retry_after_seconds"], 1)

        approved = self._approve(created)
        self.assertEqual(approved.status_code, 200, approved.text)
        completed = self.client.post(path, json=self._poll_body(created))
        self.assertEqual(completed.json()["data"]["status"], "success")

    def test_expired_denied_cancelled_and_disabled_user_never_receive_token(self) -> None:
        expired = self._create()
        with self.Session() as db:
            db.query(DesktopLoginSession).filter(
                DesktopLoginSession.id == expired["session_id"]
            ).update({
                DesktopLoginSession.expires_at:
                    datetime.now(timezone.utc) - timedelta(seconds=1),
            })
            db.commit()
        expired_preview = self.client.post(
            f"/api/auth/desktop-login/sessions/{expired['session_id']}/preview",
            json=self._approval_body(expired),
        )
        self.assertEqual(expired_preview.json()["data"]["status"], "expired")
        expired_poll = self.client.post(
            f"/api/auth/desktop-login/sessions/{expired['session_id']}/token",
            json=self._poll_body(expired),
        )
        self.assertEqual(expired_poll.json()["data"]["status"], "expired")
        self.assertNotIn("token", expired_poll.text)

        denied = self._create()
        denied_response = self.client.post(
            f"/api/auth/desktop-login/sessions/{denied['session_id']}/decision",
            headers={"Authorization": f"Bearer {self.first_token}"},
            json={**self._approval_body(denied), "decision": "deny"},
        )
        self.assertEqual(denied_response.json()["data"]["status"], "denied")
        denied_poll = self.client.post(
            f"/api/auth/desktop-login/sessions/{denied['session_id']}/token",
            json=self._poll_body(denied),
        )
        self.assertEqual(denied_poll.json()["data"]["status"], "denied")

        cancelled = self._create()
        cancelled_response = self.client.post(
            f"/api/auth/desktop-login/sessions/{cancelled['session_id']}/cancel",
            json=self._poll_body(cancelled),
        )
        self.assertEqual(cancelled_response.json()["data"]["status"], "cancelled")
        cancelled_poll = self.client.post(
            f"/api/auth/desktop-login/sessions/{cancelled['session_id']}/token",
            json=self._poll_body(cancelled),
        )
        self.assertEqual(cancelled_poll.json()["data"]["status"], "cancelled")

        disabled = self._create()
        self.assertEqual(self._approve(disabled).status_code, 200)
        with self.Session() as db:
            user = db.query(User).filter(User.id == self.first_id).one()
            user.is_active = False
            db.commit()
        disabled_poll = self.client.post(
            f"/api/auth/desktop-login/sessions/{disabled['session_id']}/token",
            json=self._poll_body(disabled),
        )
        self.assertEqual(
            disabled_poll.json()["data"]["status"],
            "account_unavailable",
        )
        self.assertNotIn("token", disabled_poll.json()["data"])

    def test_two_accounts_race_but_only_one_is_bound(self) -> None:
        created = self._create()

        def decide(user_id: str):
            with self.Session() as db:
                status, session = desktop_login_service.decide_session(
                    db,
                    session_id=created["session_id"],
                    approval_token=created["approval_token"],
                    user_id=user_id,
                    decision="approve",
                )
                return status, session.user_id if session else None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(decide, [self.first_id, self.second_id]))
        with self.Session() as db:
            row = db.query(DesktopLoginSession).filter(
                DesktopLoginSession.id == created["session_id"]
            ).one()
            self.assertEqual(row.status, "approved")
            self.assertIn(row.user_id, {self.first_id, self.second_id})
        self.assertEqual(sum(bound == user for (_, bound), user in zip(results, [self.first_id, self.second_id])), 1)

    def test_two_pollers_race_and_only_one_receives_success(self) -> None:
        created = self._create()
        self.assertEqual(self._approve(created).status_code, 200)

        def poll():
            with self.Session() as db:
                result = desktop_login_service.poll_and_consume(
                    db,
                    session_id=created["session_id"],
                    poll_secret=created["poll_secret"],
                )
                return result.status

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _value: poll(), range(2)))
        self.assertEqual(results.count("success"), 1, results)
        self.assertEqual(results.count("consumed"), 1, results)

    def test_cleanup_expires_active_and_deletes_old_terminal_rows(self) -> None:
        current = datetime.now(timezone.utc)
        with self.Session() as db:
            active = desktop_login_service.create_session(db, now=current - timedelta(days=2))
            terminal = desktop_login_service.create_session(db, now=current - timedelta(days=2))
            db.query(DesktopLoginSession).filter(
                DesktopLoginSession.id == terminal.session.id
            ).update({DesktopLoginSession.status: "denied"})
            db.commit()
            expired_count, deleted_count = desktop_login_service.cleanup_stale_sessions(
                db,
                now=current,
            )
            self.assertGreaterEqual(expired_count, 1)
            self.assertGreaterEqual(deleted_count, 2)
            self.assertEqual(db.query(DesktopLoginSession).count(), 0)


if __name__ == "__main__":
    unittest.main()
