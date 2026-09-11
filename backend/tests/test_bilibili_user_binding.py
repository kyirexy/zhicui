"""B站个人授权的所有权、撤销与扫码结果安全边界。"""
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from cryptography.fernet import Fernet
import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import app.main  # 注册完整外键模型，不启动应用或 worker。
from app.core.database import Base
from app.models.user import User
from app.services import bilibili_binding_service as binding, bilibili_user_catalog as catalog
from app.services import creator_connectors, product_action_handlers


class BilibiliBindingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.Factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Factory()
        self.db.add_all([User(id=uid, username=uid, email=uid + "@example.test", hashed_password="unused") for uid in ("owner", "other")])
        self.db.commit()
        self.key = patch.object(binding.settings, "ENCRYPTION_KEY", Fernet.generate_key().decode())
        self.key.start()
        self.client = requests.Session()
        self.session_patch = patch.object(binding, "session", side_effect=lambda *a, **k: self.fake_session())
        self.session_patch.start()
        self.api_patch = patch.object(binding, "api", side_effect=self.upstream)
        self.api = self.api_patch.start()
        self.polled = False

    @contextmanager
    def fake_session(self):
        yield self.client

    def tearDown(self):
        self.api_patch.stop(); self.session_patch.stop(); self.key.stop()
        self.client.close(); self.db.close(); self.engine.dispose()

    def upstream(self, client, url, params=None):
        if url.endswith("generate"):
            return {"url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?code=test-only", "qrcode_key": "private-test-challenge"}
        if url.endswith("poll"):
            self.polled = True
            client.cookies.set("SESSDATA", "private-test-cookie", domain=".bilibili.com")
            client.cookies.set("DedeUserID", "123", domain=".bilibili.com")
            return {"code": 0, "refresh_token": "must-not-persist"}
        if url.endswith("nav"):
            return {"isLogin": True, "mid": 123, "uname": "测试 B站账号", "wbi_img": {
                "img_url": "https://i0.hdslb.com/bfs/wbi/" + "a" * 32 + ".png",
                "sub_url": "https://i0.hdslb.com/bfs/wbi/" + "b" * 32 + ".png"}}
        raise AssertionError("unexpected request")

    def connect(self, user_id="owner"):
        started = binding.login_start(self.db, user_id)
        row = binding.get(self.db, user_id)
        row.next_poll_at = binding.now() - timedelta(seconds=1)
        self.db.commit()
        return binding.login_poll(self.db, user_id, started["session_id"])

    def test_scan_persists_only_encrypted_credentials_for_owner(self):
        result = self.connect()
        row = binding.get(self.db, "owner")
        self.assertTrue(result["connected"])
        self.assertEqual(binding.unseal(row.credential_encrypted)["SESSDATA"], "private-test-cookie")
        self.assertNotIn("private-test-cookie", row.credential_encrypted)
        self.assertNotIn("private", str(result))
        self.assertEqual(row.challenge_encrypted, "")
        self.assertIsNone(binding.get(self.db, "other"))

    def test_other_user_cannot_poll_or_use_owner_binding(self):
        started = binding.login_start(self.db, "owner")
        with self.assertRaises(binding.BilibiliBindingError) as raised:
            binding.login_poll(self.db, "other", started["session_id"])
        self.assertEqual(raised.exception.code, "binding_session_not_found")
        self.assertFalse(self.polled)
        self.connect()
        with self.assertRaises(binding.BilibiliBindingError):
            binding.require_binding(self.db, "other")

    def test_disconnect_rejects_late_poll_and_old_generation(self):
        result = self.connect()
        generation = binding.get(self.db, "owner").generation
        binding.disconnect(self.db, "owner")
        with self.assertRaises(binding.BilibiliBindingError):
            binding.login_poll(self.db, "owner", result["session_id"])
        with self.assertRaises(binding.BilibiliBindingError):
            binding.require_binding(self.db, "owner", generation)
        self.assertEqual(binding.get(self.db, "owner").credential_encrypted, "")

    def test_repeated_start_reuses_challenge_and_poll_is_throttled(self):
        first = binding.login_start(self.db, "owner")
        second = binding.login_start(self.db, "owner")
        self.assertEqual(first["session_id"], second["session_id"])
        self.api.assert_called_once()
        self.assertEqual(binding.login_poll(self.db, "owner", first["session_id"])["status"], "pending")
        self.api.assert_called_once()

    def test_expired_challenge_cannot_complete_or_replace_new_session(self):
        first = binding.login_start(self.db, "owner")
        row = binding.get(self.db, "owner")
        row.challenge_expires_at = binding.now() - timedelta(seconds=1)
        self.db.commit()
        self.assertEqual(binding.login_poll(self.db, "owner", first["session_id"])["status"], "expired")
        second = binding.login_start(self.db, "owner")
        self.assertNotEqual(first["session_id"], second["session_id"])
        with self.assertRaises(binding.BilibiliBindingError):
            binding.login_poll(self.db, "owner", first["session_id"])

    def test_encryption_must_be_configured_before_requesting_qr(self):
        with patch.object(binding.settings, "ENCRYPTION_KEY", ""):
            with self.assertRaises(binding.BilibiliBindingError):
                binding.login_start(self.db, "owner")
        self.api.assert_not_called()

    def test_failed_old_session_does_not_expire_rebound_account(self):
        self.connect()
        old = binding.get(self.db, "owner").generation
        binding.disconnect(self.db, "owner")
        self.connect()
        binding.invalidate(self.db, "owner", old)
        self.assertTrue(binding.public(binding.get(self.db, "owner"))["connected"])

    def test_action_does_not_persist_qr_challenge(self):
        result = product_action_handlers.platform_binding_start(SimpleNamespace(db=self.db, user=SimpleNamespace(id="owner")), {"platform": "bilibili"})
        self.assertIn("login_url", result)
        self.assertNotIn("qr_url", result)
        self.assertNotIn("private-test-challenge", str(result))

    def test_catalog_uses_owner_cookie_and_stops_on_disconnect(self):
        self.connect()
        owner_cookie = []
        @contextmanager
        def authenticated(cookies):
            owner_cookie.append(cookies["SESSDATA"])
            yield self.client
        def api(client, url, params=None):
            if url.endswith("nav"):
                return self.upstream(client, url, params)
            with self.Factory() as db:
                binding.disconnect(db, "owner")
            return {"page": {"count": 1}, "list": {"vlist": [{"bvid": "BV1234567890", "title": "公开视频", "created": 1700000000}]}}
        with patch.object(catalog, "SessionLocal", self.Factory), patch.object(binding, "session", side_effect=authenticated), patch.object(binding, "api", side_effect=api):
            with self.assertRaises(binding.BilibiliBindingError):
                catalog.discover("owner", "https://space.bilibili.com/123/video")
        self.assertEqual(owner_cookie, ["private-test-cookie"])

    def test_catalog_rejects_unbound_user_without_network_or_shared_sidecar(self):
        self.connect()
        self.api.reset_mock()
        with patch.object(catalog, "SessionLocal", self.Factory), patch.object(creator_connectors.yutto_catalog_client, "discover_bilibili_catalog") as shared:
            with self.assertRaises(creator_connectors.CreatorConnectorError) as raised:
                creator_connectors.discover_catalog(SimpleNamespace(platform="bilibili", profile_url="https://space.bilibili.com/123/video"), bilibili_user_id="other")
        self.assertEqual(raised.exception.code, "bilibili_login_required")
        self.api.assert_not_called(); shared.assert_not_called()

    def test_api_rejects_redirect_and_never_sends_cookies_to_other_host(self):
        self.api_patch.stop()
        client = SimpleNamespace(get=unittest.mock.Mock(return_value=SimpleNamespace(status_code=302)))
        with self.assertRaises(binding.BilibiliBindingError):
            binding.api(client, "https://api.bilibili.com/x/web-interface/nav")
        self.assertFalse(client.get.call_args.kwargs["allow_redirects"])
        with self.assertRaises(binding.BilibiliBindingError):
            binding.api(client, "https://evil.example/")
        client.get.assert_called_once()

    def test_http_requires_login_and_isolates_status_poll_disconnect(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.api.platform_connection_routes import router
        from app.core.auth import get_current_user
        from app.core.database import get_db
        application = FastAPI()
        application.include_router(router)
        application.dependency_overrides[get_db] = lambda: self.db
        client = TestClient(application)
        for method, path in [("GET", ""), ("POST", "/login"), ("DELETE", "")]:
            self.assertIn(client.request(method, "/api/platform-connections/bilibili" + path).status_code, (401, 403))
        own = self.connect()
        application.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="other")
        response = client.get("/api/platform-connections/bilibili")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertFalse(response.json()["data"]["connected"])
        self.assertEqual(client.post("/api/platform-connections/bilibili/login/poll", json={"session_id": own["session_id"]}).status_code, 404)
        client.delete("/api/platform-connections/bilibili")
        self.assertTrue(binding.public(binding.get(self.db, "owner"))["connected"])
        self.assertEqual(client.post("/api/platform-connections/bilibili/login/poll", json={"session_id": own["session_id"], "user_id": "owner"}).status_code, 422)

    def test_risk_response_is_throttled_and_not_silently_retried(self):
        started = binding.login_start(self.db, "owner")
        row = binding.get(self.db, "owner")
        row.next_poll_at = binding.now() - timedelta(seconds=1)
        self.db.commit()
        self.api.side_effect = binding.BilibiliBindingError("bilibili_risk_control", "请完成平台验证")
        with self.assertRaises(binding.BilibiliBindingError):
            binding.login_poll(self.db, "owner", started["session_id"])
        self.db.rollback()
        self.api.reset_mock()
        result = binding.login_poll(self.db, "owner", started["session_id"])
        self.api.assert_not_called()
        self.assertEqual(result["status"], "pending")

    def test_verified_empty_catalog_and_incomplete_catalog_are_distinguished(self):
        self.connect()
        def upstream(client, url, params=None):
            if url.endswith("nav"):
                return self.upstream(client, url, params)
            return {"page": {"count": count}, "list": {"vlist": []}}
        with patch.object(catalog, "SessionLocal", self.Factory), patch.object(binding, "api", side_effect=upstream):
            count = 0
            result = catalog.discover("owner", "https://space.bilibili.com/123/video")
            self.assertTrue(result["complete"])
            self.assertEqual(result["total_count"], 0)
            count = 1
            with self.assertRaises(binding.BilibiliBindingError) as raised:
                catalog.discover("owner", "https://space.bilibili.com/123/video")
            self.assertEqual(raised.exception.code, "catalog_incomplete")

    def test_wbi_signature_fixed_input_vector(self):
        nav = {"wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", "sub_url": "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"}}
        with patch.object(catalog.time, "time", return_value=1702204169):
            result = catalog._sign({"foo": "114", "bar": "514", "baz": 1919810}, nav)
        self.assertEqual(result["w_rid"], "6149fdadf571698ca7e6a567265cd0ee")


if __name__ == "__main__":
    unittest.main()
