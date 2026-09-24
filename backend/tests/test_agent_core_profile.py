"""基础接入的真实 HTTP 鉴权、固定能力边界与 full 回归。"""

from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pydantic import ValidationError

from tests import test_agent_interface_routes as route_tests
from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.agent_interface.profiles import CORE_ACTION_IDS, CORE_SCOPE_IDS, allowed_scope_ids
from app.api.agent_secure_routes import _definition as secure_definition
from app.core.config import Settings, settings
from app.models.agent_interface import ProductActionRun
from app.models.note import Note
from app.models.user import User
from app.services import product_action_handlers as handlers, readiness_service as readiness
from app.services.agent_credential_service import AgentPrincipal, create_device_authorization, approve_device_authorization, CredentialError
from app.services.agent_rollout_service import action_is_enabled
from app.services.automation_runner import AutomationRunner
from app.services.product_action_registry import registry
from app.services.product_action_run_service import ProductActionError, claim_run


class CoreProfileTests(unittest.TestCase):
    def setUp(self):
        self.profile_patch = patch.object(settings, "AGENT_INTERFACE_PROFILE", "core")
        self.profile_patch.start()
        route_tests.AgentInterfaceRouteTests.setUp(self)

    def tearDown(self):
        route_tests.AgentInterfaceRouteTests.tearDown(self)
        self.profile_patch.stop()

    def pat(self, scopes=None):
        response = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"name": "core 验证", "scopes": scopes or sorted(CORE_SCOPE_IDS), "expires_in_days": 1},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": "Bearer " + response.json()["data"]["token"]}

    def test_manifest_and_mcp_match_exact_reviewed_core_inventory(self):
        response = self.client.get("/api/agent-interface/v1/capabilities")
        self.assertEqual(response.status_code, 200)
        body = response.json()["data"]
        self.assertEqual(body["release_profile"], "core")
        self.assertTrue(body["limitations"])
        self.assertEqual({item["id"] for item in body["actions"]}, CORE_ACTION_IDS)
        self.assertEqual({item["id"] for item in body["scopes"]}, CORE_SCOPE_IDS)
        self.assertEqual({scope for item in body["actions"] for scope in item["scopes"]}, CORE_SCOPE_IDS)
        descriptors = sorted(body["actions"], key=lambda item: item["id"])
        digest = hashlib.sha256(json.dumps(descriptors, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        manifest = json.loads((Path(__file__).resolve().parents[1] / "app/agent_interface/core_capabilities_v1.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["descriptor_sha256"], digest)
        self.assertEqual(manifest["action_count"], len(CORE_ACTION_IDS))
        tools = self.client.post("/mcp", headers=self.pat(), json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {},
        }).json()["result"]["tools"]
        self.assertEqual({tool["name"] for tool in tools}, CORE_ACTION_IDS | {"run.get", "run.events", "run.cancel"})
        self.assertEqual(manifest["remote_mcp_tool_count"], len(tools))

    def test_excluded_actions_cannot_be_called_by_full_scope_legacy_pat(self):
        with patch.object(settings, "AGENT_INTERFACE_PROFILE", "full"):
            headers = self.pat(sorted(ALL_SCOPE_IDS))
        for action in ("creator.resolve", "creator.sync.start", "library.import_link", "library.transcript.generate", "analysis.catalog", "local.capabilities.get", "automation.list"):
            with self.subTest(action=action):
                response = self.client.get(f"/api/agent-interface/v1/actions/{action}")
                self.assertEqual(response.status_code, 404)
                response = self.client.post(f"/api/agent-interface/v1/actions/{action}/invoke", headers=headers, json={"input": {}})
                self.assertEqual(response.status_code, 404, response.text)
                self.assertEqual(response.json()["error"]["code"], "ACTION_NOT_FOUND")
                result = self.client.post("/mcp", headers=headers, json={
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": action, "arguments": {}},
                }).json()
                self.assertTrue(result["result"]["isError"], result)
        with self.Session() as db:
            principal = AgentPrincipal(self.user, None, ALL_SCOPE_IDS, "test")
            for definition in registry.all():
                if definition.secure_direct:
                    with self.assertRaises(ProductActionError) as caught:
                        secure_definition(principal, definition.id, db)
                    self.assertEqual(caught.exception.code, "ACTION_NOT_FOUND")

    def test_new_pat_and_device_reject_every_unpublished_scope_atomically(self):
        for scope in ALL_SCOPE_IDS - CORE_SCOPE_IDS:
            for path, extra in (("/credentials/pat", {"name": "unsupported"}), ("/auth/device", {"client_name": "unsupported"})):
                response = self.client.post("/api/agent-interface/v1" + path,
                    headers={"Authorization": f"Bearer {self.jwt}"},
                    json={"scopes": ["account:read", scope], **extra})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["error"]["code"], "SCOPE_UNAVAILABLE")
        with self.Session() as db, patch.object(settings, "AGENT_INTERFACE_PROFILE", "full"):
            _, _, code = create_device_authorization(db, client_name="legacy", client_type="cli", scopes=["local:invoke"])
        with self.Session() as db, self.assertRaises(CredentialError) as caught:
            approve_device_authorization(db, user_id=self.user_id, user_code=code, approve=True)
        self.assertEqual(caught.exception.code, "SCOPE_UNAVAILABLE")

    def test_allowlist_cannot_expand_core_and_invalid_profile_fails_closed(self):
        with patch.object(settings, "AGENT_INTERFACE_ACTION_ALLOWLIST", "*,creator.sync.start"):
            self.assertTrue(action_is_enabled("library.get"))
            self.assertFalse(action_is_enabled("creator.sync.start"))
        with patch.object(settings, "AGENT_INTERFACE_PROFILE", "misspelled"):
            self.assertFalse(action_is_enabled("account.me"))
            self.assertFalse(allowed_scope_ids())
            self.assertEqual(readiness._check_agent_interface()["status"], "not_ready")
        with self.assertRaises(ValidationError):
            Settings(_env_file=None, AGENT_INTERFACE_PROFILE="misspelled")

    def test_existing_material_is_readable_but_other_users_material_is_not(self):
        headers = self.pat(["library:read"])
        with self.Session() as db:
            other = User(email="core-other@example.com", username="core-other", hashed_password="unused", is_active=True)
            db.add(other); db.flush()
            ids = []
            for suffix, owner in (("own", self.user_id), ("other", other.id)):
                note = Note(user_id=owner, video_id=suffix, video_title=suffix, video_url="https://www.bilibili.com/video/BV1234567890", transcript_raw="已有文稿", seo_title=suffix, seo_slug=suffix, seo_meta=suffix)
                db.add(note); db.flush(); ids.append(note.id)
            db.commit()
        own = self.client.post("/api/agent-interface/v1/actions/library.get/invoke", headers=headers, json={"input": {"note_id": ids[0]}})
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["data"]["result"]["transcript_raw"], "已有文稿")
        other = self.client.post("/api/agent-interface/v1/actions/library.get/invoke", headers=headers, json={"input": {"note_id": ids[1]}})
        self.assertEqual(other.json()["error"]["code"], "RESOURCE_NOT_FOUND")

    def test_excluded_historical_runs_cannot_resume_or_be_claimed(self):
        headers = self.pat(["account:read"])
        response = self.client.post("/api/agent-interface/v1/actions/account.me/invoke", headers=headers, json={"input": {}})
        run_id = response.json()["run_id"]
        with self.Session() as db:
            run = db.get(ProductActionRun, run_id)
            run.action_id = "creator.sync.start"
            run.status = "queued"
            db.commit()
            self.assertIsNone(claim_run(db, run_id=run_id))
        response = self.client.get(f"/api/agent-interface/v1/runs/{run_id}", headers=headers)
        self.assertEqual(response.status_code, 404, response.text)

    def test_core_preserves_per_credential_run_access(self):
        route_tests.AgentInterfaceRouteTests.test_run_access_is_bound_to_originating_credential(self)

    def test_core_ask_blocks_network_input_and_historical_turn_reuse(self):
        schema = registry.get("ask.turn.start").descriptor().input_schema
        self.assertEqual(schema["properties"]["web_scope"]["enum"], ["video_only"])
        response = self.client.post("/api/agent-interface/v1/actions/ask.turn.start/invoke", headers=self.pat(["ask:run"]), json={"input": {"thread_id": "old-thread", "client_turn_id": "id-1", "question": "问题", "web_scope": "auto"}})
        self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
        context = SimpleNamespace(db=Mock(), user=self.user, run=Mock())
        old_turn = SimpleNamespace(web_scope="auto")
        with patch.object(handlers.agent_service, "get_thread", return_value=Mock()), patch.object(handlers.agent_runtime_service, "create_or_get_turn", return_value=(old_turn, False)), patch.object(handlers.agent_runtime_worker.runner, "submit") as submit:
            with self.assertRaises(handlers.ActionHandlerError):
                handlers.ask_turn_start(context, {"thread_id": "old", "client_turn_id": "same", "question": "问题"})
            submit.assert_not_called()
        with patch.object(handlers, "_owned_turn", return_value=old_turn), patch.object(handlers.agent_runtime_worker.runner, "submit") as submit:
            with self.assertRaises(handlers.ActionHandlerError):
                handlers.ask_turn_retry(context, {"thread_id": "old", "turn_id": "same"})
            submit.assert_not_called()

    def test_core_readiness_does_not_claim_external_dependencies_are_healthy(self):
        with patch.object(readiness, "_check_database", return_value={"status": "ready"}), patch.object(readiness, "_check_ai_config", return_value={"status": "ready"}), patch.object(readiness, "_check_smtp_transport") as smtp, patch.object(readiness.settings_service, "get_creator_sync_config") as creator:
            result = readiness._check_agent_product_features(Mock())
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["release_profile"], "core")
            self.assertIn("platform_sync", result["excluded_features"])
            self.assertEqual(readiness._check_connectors(Mock())["status"], "not_required")
            self.assertEqual(readiness._check_agent_automation_runtime()["status"], "not_required")
            smtp.assert_not_called(); creator.assert_not_called()
        with patch.object(settings, "AGENT_AUTOMATION_ENABLED", True):
            runner = AutomationRunner(); runner.start()
            self.assertFalse(runner.status()["running"])


if __name__ == "__main__":
    unittest.main()
