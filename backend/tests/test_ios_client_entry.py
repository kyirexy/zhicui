import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import create_app
from app.api.routes import RegisterRequest
from app.api.privacy_account_routes import PasswordReverificationRequest
from app.services.privacy_account_service import normalize_client_type


class IOSClientEntryTests(unittest.TestCase):
    def test_only_fixed_ios_origin_is_added(self):
        # 不启动 lifespan，不注册账号，不访问持久数据库。
        with patch.dict(os.environ, {"ALLOWED_ORIGINS": "https://luxai.cn"}):
            client = TestClient(create_app())
        for origin, expected in [
            ("capacitor://localhost", 200),
            ("https://luxai.cn", 200),
            ("capacitor://untrusted", 400),
            ("https://untrusted.example", 400),
        ]:
            response = client.options("/api/auth/login", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            })
            self.assertEqual(response.status_code, expected)
            self.assertEqual(response.headers.get("access-control-allow-origin"),
                             origin if expected == 200 else None)

    def test_ios_is_a_real_client_type(self):
        self.assertEqual(normalize_client_type("ios"), "ios")
        self.assertEqual(normalize_client_type("untrusted"), "web")
        self.assertEqual(PasswordReverificationRequest(password="test-only", client_type="ios").client_type, "ios")
        self.assertIn("ios", RegisterRequest.model_json_schema()["properties"]["client_type"]["enum"])
