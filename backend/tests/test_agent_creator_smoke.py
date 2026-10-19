"""生产博主边界探针在真实隔离 HTTP 栈上的验收与失败清理。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from tests import test_agent_interface_routes as route_tests
from app.agent_interface.profiles import CORE_SCOPE_IDS
from app.api.auth_routes import router as auth_router
from app.core.config import settings
from app.core.database import Base
from app.models.agent_interface import AgentCredential
from app.models.bilibili_account_binding import BilibiliAccountBinding
from app.models.creator_sync import CreatorSource, CreatorSourceItem, CreatorSyncRun, CreatorSyncRunItem
from app.models.user import User
from app.services import creator_sync_service
from app.services.agent_credential_service import issue_pat


path = Path(__file__).resolve().parents[2] / "scripts" / "smoke-agent-core.py"
spec = importlib.util.spec_from_file_location("creator_core_smoke", path)
smoke = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(smoke)


class CreatorProductionSmokeTests(unittest.TestCase):
    def setUp(self):
        self.profile = patch.object(settings, "AGENT_INTERFACE_PROFILE", "core")
        self.profile.start()
        route_tests.AgentInterfaceRouteTests.setUp(self)
        self.client.app.include_router(auth_router)
        self.client.__enter__()
        Base.metadata.create_all(self.engine, tables=[
            CreatorSource.__table__, CreatorSourceItem.__table__, CreatorSyncRun.__table__,
            CreatorSyncRunItem.__table__, BilibiliAccountBinding.__table__,
        ])
        with self.Session() as db:
            user = db.get(User, self.user_id)
            user.username = "zhicui_production_smoke"
            user.is_admin = False
            db.commit()
            _, self.full_pat = issue_pat(db, user_id=self.user_id, name="隔离探针全权限",
                                         scopes=sorted(CORE_SCOPE_IDS), expires_in_days=1)
        self.config = patch.object(creator_sync_service, "_feature_config", return_value={
            "enabled": True, "platforms": {"bilibili": True}, "catalog_platforms": {"bilibili": False},
        })
        self.config.start()

    def tearDown(self):
        self.config.stop()
        self.client.__exit__(None, None, None)
        route_tests.AgentInterfaceRouteTests.tearDown(self)
        self.profile.stop()

    def call(self, path, body=None, *, token=None, method=None):
        response = self.client.request(method or ("POST" if body is not None else "GET"), path,
            json=body, headers={"Authorization": "Bearer " + (token or self.full_pat)})
        return response.status_code, response.json()

    def require(self, condition, label):
        self.assertTrue(condition, label)

    def invoke_with_input(self, action, inputs=None):
        status, payload = self.call(f"/api/agent-interface/v1/actions/{action}/invoke", {"input": inputs or {}})
        self.assertEqual(status, 200, payload)
        return payload["data"]["result"]

    def assert_fixture_clean(self):
        with self.Session() as db:
            credentials = db.query(AgentCredential).filter_by(name=smoke.CREATOR_READONLY_CREDENTIAL_NAME).all()
            self.assertEqual(len(credentials), 1)
            self.assertTrue(credentials[0].revoked_at)
            self.assertEqual(credentials[0].scopes, ["library:read"])
            self.assertEqual(db.query(CreatorSource).count(), 0)
            self.assertEqual(db.query(CreatorSyncRun).count(), 0)

    def test_real_probe_rejects_boundaries_without_platform_request_and_revokes_pat(self):
        with patch("requests.sessions.Session.request", side_effect=AssertionError("不得请求外部平台")) as network:
            smoke.verify_creator_boundaries(self.call, self.require, self.invoke_with_input, self.jwt)
            network.assert_not_called()
        self.assert_fixture_clean()

    def test_probe_failure_still_revokes_readonly_pat(self):
        def fail_after_readonly_issue(path, body=None, **kwargs):
            if path == "/api/agent-interface/v1/capabilities":
                raise RuntimeError("模拟只读验证传输失败")
            return self.call(path, body, **kwargs)

        with self.assertRaisesRegex(RuntimeError, "模拟只读验证传输失败"):
            smoke.verify_creator_boundaries(fail_after_readonly_issue, self.require, self.invoke_with_input, self.jwt)
        self.assert_fixture_clean()

    def test_probe_refuses_admin_before_creating_smoke_credential(self):
        with self.Session() as db:
            db.get(User, self.user_id).is_admin = True
            db.commit()
        with self.assertRaisesRegex(AssertionError, "固定非管理员"):
            smoke.verify_creator_boundaries(self.call, self.require, self.invoke_with_input, self.jwt)
        with self.Session() as db:
            self.assertEqual(db.query(AgentCredential).filter_by(name=smoke.CREATOR_READONLY_CREDENTIAL_NAME).count(), 0)

    def test_shell_descriptor_guard_rejects_expanded_catalog_limit(self):
        script = (path.parent / "smoke-agent-interface.sh").read_text(encoding="utf-8")
        marker = 'python3 - "$WORK_DIR/full-capabilities.response" "$REQUIRE_ASK_SENTINEL" "$AGENT_PROFILE"'
        code = script.split(marker, 1)[1].split("\n", 1)[1].split("\nPY\n", 1)[0]
        _, payload = self.call("/api/agent-interface/v1/capabilities")
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "capabilities.json"
            fixture.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(sys, "argv", ["-", str(fixture), "1", "core"]):
                exec(compile(code, "production-creator-schema-gate", "exec"), {})
            action = next(item for item in payload["data"]["actions"] if item["id"] == "creator.catalog.import")
            action["input_schema"]["properties"]["limit"]["enum"] = [20, 50]
            fixture.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(sys, "argv", ["-", str(fixture), "1", "core"]), self.assertRaisesRegex(SystemExit, "前 20 条"):
                exec(compile(code, "production-creator-schema-gate", "exec"), {})


if __name__ == "__main__":
    unittest.main()
