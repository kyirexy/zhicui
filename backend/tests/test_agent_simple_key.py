"""日常密钥：一次创建、闲置期限、旧 PAT 兼容和账号边界。"""
from __future__ import annotations

import json
import os
import re
import unittest
from contextlib import ExitStack
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "simple-agent-key-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "simple-agent-key-test-pepper-123456789")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.agent_interface_routes import router
from app.core.config import settings
from app.core.database import Base, get_db
from app.models.admin_audit_log import AdminAuditLog
from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.models.desktop_handoff import DesktopHandoff
from app.models.desktop_login_session import DesktopLoginSession
from app.models.phone_login_session import PhoneLoginSession
from app.models.user import User
from app.services import agent_credential_service as service, auth_session_service
from app.services.auth_service import create_access_token


BASE = "/api/agent-interface/v1"


class AgentSimpleKeyTests(unittest.TestCase):
    def setUp(self):
        self.context = ExitStack()
        for name, value in {
            "AGENT_INTERFACE_ENABLED": True,
            "AGENT_INTERFACE_PROFILE": "core",
            "AGENT_INTERFACE_USER_ALLOWLIST": "",
            "AGENT_INTERFACE_ACTION_ALLOWLIST": "",
        }.items():
            self.context.enter_context(patch.object(settings, name, value))
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[
            User.__table__, UserAuthSession.__table__, AuthRefreshReceipt.__table__,
            AgentCredential.__table__, AgentDeviceAuthorization.__table__,
            AdminAuditLog.__table__, DesktopHandoff.__table__, DesktopLoginSession.__table__,
            PhoneLoginSession.__table__,
        ])
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            db.add_all([
                User(id="owner", email="owner@example.test", username="owner", hashed_password="unused", is_active=True),
                User(id="other", email="other@example.test", username="other", hashed_password="unused", is_active=True),
            ])
            db.commit()
        app = FastAPI()
        app.include_router(router)

        def override_db():
            with self.Session() as db:
                yield db

        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(app, raise_server_exceptions=False)
        self.headers = {"Authorization": "Bearer " + create_access_token("owner", "owner@example.test")}
        self.now = service.utcnow()

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        self.context.close()

    def create_key(self, body=None):
        response = self.client.post(BASE + "/credentials/agent-key", json=body or {}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    def test_one_request_creates_hashed_daily_key_and_list_never_repeats_secret(self):
        with patch.object(service, "utcnow", return_value=self.now):
            response = self.client.post(BASE + "/credentials/agent-key", json={}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        data = response.json()["data"]
        credential = data["credential"]
        self.assertEqual(credential["name"], "我的 Agent")
        self.assertEqual(credential["type"], "pat")
        self.assertEqual(credential["client_type"], "agent_key")
        self.assertEqual(credential["scopes"], sorted(service.DAILY_AGENT_SCOPE_IDS))
        self.assertEqual(credential["expiry_policy"], "sliding_inactivity")
        self.assertEqual(credential["inactivity_days"], 365)
        self.assertTrue(data["token"].startswith("zhc_pat_"))
        with self.Session() as db:
            row = db.get(AgentCredential, credential["id"])
            self.assertEqual(row.token_hash, service.token_hash(data["token"]))
            self.assertNotEqual(row.token_hash, data["token"])
            self.assertIsNone(row.refresh_hash)
            self.assertEqual(service._aware(row.expires_at), self.now + timedelta(days=365))
        listing = self.client.get(BASE + "/credentials", headers=self.headers)
        self.assertEqual(listing.status_code, 200)
        self.assertNotIn(data["token"], listing.text)
        self.assertNotIn("token_hash", listing.text)
        self.assertEqual(listing.json()["data"]["items"][0]["expiry_policy"], "sliding_inactivity")

    def test_daily_scopes_follow_current_publication_and_never_expand_existing_key(self):
        with patch.object(settings, "AGENT_INTERFACE_ACTION_ALLOWLIST", "account.me"):
            data = self.create_key()
            for headers in ({}, self.headers, {"Authorization": "Bearer " + data["token"]}):
                public = self.client.get(BASE + "/capabilities", headers=headers)
                self.assertEqual(public.status_code, 200, public.text)
                discovery = public.json()["data"]
                self.assertEqual(discovery["daily_agent_scopes"], data["credential"]["scopes"])
                self.assertIn("library:write", {scope["id"] for scope in discovery["scopes"]})
                if not headers:
                    self.assertIsNone(discovery["granted_scopes"])
        self.assertEqual(data["credential"]["scopes"], ["account:read"])
        response = self.client.get(BASE + "/capabilities", headers={"Authorization": "Bearer " + data["token"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["granted_scopes"], ["account:read"])
        self.assertEqual(response.json()["data"]["daily_agent_scopes"], sorted(service.DAILY_AGENT_SCOPE_IDS))
        with patch.object(settings, "AGENT_INTERFACE_ACTION_ALLOWLIST", "models.list"):
            response = self.client.post(BASE + "/credentials/agent-key", json={}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        with self.Session() as db:
            self.assertEqual(db.query(AgentCredential).count(), 1)

    def test_creation_only_accepts_browser_session_and_optional_name(self):
        key = self.create_key({"name": "Codex"})
        for headers in ({}, {"Authorization": "Bearer " + key["token"]}):
            response = self.client.post(BASE + "/credentials/agent-key", json={}, headers=headers)
            self.assertEqual(response.status_code, 401, response.text)
        for body in ({"scopes": ["account:read"]}, {"expires_in_days": 365}, {"client_type": "agent_key"}):
            response = self.client.post(BASE + "/credentials/agent-key", json=body, headers=self.headers)
            self.assertEqual(response.status_code, 422, response.text)
        with self.Session() as db:
            self.assertEqual(db.query(AgentCredential).count(), 1)

    def test_published_local_scope_is_retained_while_desktop_is_offline(self):
        with patch.object(settings, "AGENT_INTERFACE_ACTION_ALLOWLIST", "local.status"):
            data = self.create_key()
        self.assertEqual(data["credential"]["scopes"], ["local:invoke"])

    def test_successful_authentication_slides_expiry_and_keeps_the_same_key(self):
        with patch.object(service, "utcnow", return_value=self.now):
            data = self.create_key()
        for days in (100, 400, 700):
            now = self.now + timedelta(days=days)
            with patch.object(service, "utcnow", return_value=now), self.Session() as db:
                row = service.authenticate_access_token(db, data["token"])
                self.assertEqual(service._aware(row.expires_at), now + timedelta(days=365))
                self.assertEqual(service._aware(row.last_used_at), now)
                self.assertEqual(row.token_hash, service.token_hash(data["token"]))
                self.assertEqual(row.scopes, data["credential"]["scopes"])

    def test_expiry_boundary_and_revocation_never_revive_key(self):
        with patch.object(service, "utcnow", return_value=self.now):
            expired = self.create_key()
            revoked = self.create_key()
        with self.Session() as db:
            service.revoke_credential(db, user_id="owner", credential_id=revoked["credential"]["id"])
        for data, now, code in (
            (expired, self.now + timedelta(days=365), "CREDENTIAL_EXPIRED"),
            (revoked, self.now + timedelta(days=1), "CREDENTIAL_REVOKED"),
        ):
            with patch.object(service, "utcnow", return_value=now), self.Session() as db:
                with self.assertRaises(service.CredentialError) as caught:
                    service.authenticate_access_token(db, data["token"])
                self.assertEqual(caught.exception.code, code)
                row = db.get(AgentCredential, data["credential"]["id"])
                self.assertEqual(service._aware(row.expires_at), self.now + timedelta(days=365))
                self.assertIsNone(row.last_used_at)

    def test_invalid_secret_disabled_account_and_rollout_denial_do_not_renew(self):
        for condition, code in (("secret", "INVALID_CREDENTIAL"), ("disabled", "INVALID_CREDENTIAL"), ("rollout", "ROLLOUT_RESTRICTED")):
            with self.subTest(condition=condition):
                with patch.object(service, "utcnow", return_value=self.now):
                    data = self.create_key()
                with self.Session() as db:
                    user = db.get(User, "owner")
                    user.is_active = condition != "disabled"
                    db.commit()
                    token = data["token"] + "wrong" if condition == "secret" else data["token"]
                    with patch.object(service, "utcnow", return_value=self.now + timedelta(days=10)), patch.object(
                        settings, "AGENT_INTERFACE_USER_ALLOWLIST", "other" if condition == "rollout" else "",
                    ):
                        with self.assertRaises(service.CredentialError) as caught:
                            service.authenticate_access_token(db, token)
                    self.assertEqual(caught.exception.code, code)
                    row = db.get(AgentCredential, data["credential"]["id"])
                    self.assertEqual(service._aware(row.expires_at), self.now + timedelta(days=365))
                    self.assertIsNone(row.last_used_at)
                    user.is_active = True
                    db.commit()

    def test_legacy_read_only_pat_stays_fixed_and_cannot_be_upgraded_by_new_key(self):
        with patch.object(service, "utcnow", return_value=self.now), self.Session() as db:
            old, token = service.issue_pat(db, user_id="owner", name="旧连接", scopes=["library:read"], expires_in_days=90)
            old_id = old.id
        self.create_key()
        with patch.object(service, "utcnow", return_value=self.now + timedelta(days=30)), self.Session() as db:
            old = service.authenticate_access_token(db, token)
            self.assertEqual(old.id, old_id)
            self.assertEqual(old.scopes, ["library:read"])
            self.assertEqual(service._aware(old.expires_at), self.now + timedelta(days=90))
            self.assertEqual(old.to_public_dict()["expiry_policy"], "fixed")
            self.assertIsNone(old.to_public_dict()["inactivity_days"])
        response = self.client.post(BASE + "/credentials/pat", headers=self.headers,
            json={"name": "旧 API", "scopes": ["library:read"], "expires_in_days": 365})
        self.assertEqual(response.status_code, 422)

    def test_other_account_cannot_see_or_revoke_key(self):
        data = self.create_key()
        other = {"Authorization": "Bearer " + create_access_token("other", "other@example.test")}
        listing = self.client.get(BASE + "/credentials", headers=other)
        self.assertEqual(listing.json()["data"]["items"], [])
        revoke = self.client.post(BASE + "/credentials/" + data["credential"]["id"] + "/revoke", headers=other)
        self.assertEqual(revoke.json()["error"]["code"], "CREDENTIAL_NOT_FOUND")
        with self.Session() as db:
            self.assertIsNone(service.authenticate_access_token(db, data["token"]).revoked_at)

    def test_password_reset_revokes_key_and_new_use_is_rejected(self):
        data = self.create_key()
        with self.Session() as db:
            self.assertTrue(auth_session_service.reset_password_by_admin(
                db, user_id="owner", admin_user_id="other", new_password="test-reset-password",
            ))
        response = self.client.get(BASE + "/capabilities", headers={"Authorization": "Bearer " + data["token"]})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "CREDENTIAL_REVOKED")
        with self.Session() as db:
            row = db.get(AgentCredential, data["credential"]["id"])
            self.assertIsNotNone(row.revoked_at)
            self.assertIsNone(row.last_used_at)

    def test_stale_session_cannot_renew_a_revoked_key(self):
        data = self.create_key()
        with self.Session() as stale:
            cached = stale.get(AgentCredential, data["credential"]["id"])
            self.assertIsNone(cached.revoked_at)
            with self.Session() as other:
                service.revoke_credential(other, user_id="owner", credential_id=cached.id)
            with self.assertRaises(service.CredentialError) as caught:
                service.authenticate_access_token(stale, data["token"])
            self.assertEqual(caught.exception.code, "CREDENTIAL_REVOKED")
            self.assertIsNone(cached.last_used_at)

    def test_key_route_is_registered_as_credential_transport(self):
        interface_dir = Path(__file__).resolve().parents[1] / "app" / "agent_interface"
        inventory = json.loads((interface_dir / "route_inventory.json").read_text(encoding="utf-8"))
        key = "POST " + BASE + "/credentials/agent-key"
        self.assertEqual(inventory["routes"].count(key), 1)
        manifest = json.loads((interface_dir / "route_manifest.json").read_text(encoding="utf-8"))
        rule = next(rule for rule in manifest["rules"] if re.search(rule["pattern"], BASE + "/credentials/agent-key"))
        self.assertEqual(rule["classification"], "agent_interface")


if __name__ == "__main__":
    unittest.main()
