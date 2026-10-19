"""有界博主目录导入的真实 HTTP/MCP 权限、幂等与账号隔离。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import test_agent_interface_routes as route_tests
from app.core.config import settings
from app.core.database import Base
from app.models.agent_interface import AgentCredential, ProductActionRun
from app.models.creator_sync import CreatorSource, CreatorSourceItem, CreatorSyncRun, CreatorSyncRunItem
from app.models.user import User
from app.services import creator_sync_service, product_action_handlers as handlers
from app.services.agent_credential_service import DAILY_AGENT_SCOPE_IDS, issue_pat
from app.services.product_action_registry import registry
from app.services.product_action_run_service import _reconcile_creator_sync_run


class CreatorCatalogImportActionTests(unittest.TestCase):
    action_id = "creator.catalog.import"
    payload = {"platform": "bilibili", "profile_ref": "https://space.bilibili.com/12345"}

    def setUp(self):
        self.profile_patch = patch.object(settings, "AGENT_INTERFACE_PROFILE", "core")
        self.profile_patch.start()
        route_tests.AgentInterfaceRouteTests.setUp(self)
        self.client.__enter__()
        Base.metadata.create_all(self.engine, tables=[
            CreatorSource.__table__, CreatorSourceItem.__table__,
            CreatorSyncRun.__table__, CreatorSyncRunItem.__table__,
        ])
        with self.Session() as db:
            other = User(email="creator-other@example.com", username="creator-other", hashed_password="unused", is_active=True)
            db.add(other)
            db.commit()
            self.other_user_id = other.id

    def tearDown(self):
        self.client.__exit__(None, None, None)
        route_tests.AgentInterfaceRouteTests.tearDown(self)
        self.profile_patch.stop()

    def pat(self, scopes, *, user_id=None):
        with self.Session() as db:
            credential, token = issue_pat(db, user_id=user_id or self.user_id, name="目录导入验证", scopes=list(scopes), expires_in_days=1)
            return {"Authorization": "Bearer " + token}, credential.id

    def invoke(self, headers, payload=None, *, key="catalog-test", action_id=None):
        body = {"input": self.payload if payload is None else payload}
        if key is not None:
            body["idempotency_key"] = key
        return self.client.post(
            f"/api/agent-interface/v1/actions/{action_id or self.action_id}/invoke",
            headers=headers, json=body,
        )

    @staticmethod
    def create_catalog_run(db, *, user_id, platform, profile_ref, limit=20):
        """只替换外部平台调用，运行与权限数据仍存于真实隔离数据库。"""
        source = CreatorSource(user_id=user_id, platform=platform, creator_id="12345", profile_url=profile_ref, display_name="测试博主")
        db.add(source)
        db.flush()
        row = CreatorSyncRun(
            user_id=user_id, source_id=source.id, platform=platform, operation="catalog_recent",
            requested_limit=limit, target_count=limit, auto_transcribe=False, status="queued",
            source_snapshot_json='{"display_name":"测试博主"}',
        )
        db.add(row)
        db.commit()
        return row, False

    def test_descriptor_keeps_full_sync_separate_and_requires_both_scopes(self):
        response = self.client.get(f"/api/agent-interface/v1/actions/{self.action_id}")
        self.assertEqual(response.status_code, 200, response.text)
        definition = registry.get(self.action_id)
        self.assertEqual(definition.scopes, ("library:write", "creator:read"))
        self.assertEqual(definition.run_type.value, "long_task")
        self.assertEqual(definition.idempotency.value, "required")
        self.assertEqual([risk.value for risk in definition.risk], ["write"])
        self.assertFalse(definition.confirmation_required)
        self.assertEqual(set(definition.input_schema["properties"]), {"platform", "profile_ref", "limit"})
        self.assertEqual(definition.input_schema["properties"]["limit"]["enum"], [20])
        self.assertTrue({
            "CATALOG_CHANGED", "CATALOG_INCOMPLETE", "CATALOG_ORDER_UNVERIFIED", "CATALOG_LIMIT_EXCEEDED",
        }.issubset(definition.advertised_error_codes()))
        for action in ("creator.create", "creator.sync.start", "creator.sync.retry", "creator.sync.cancel", "creator.remove"):
            self.assertEqual(registry.get(action).scopes, ("creator:sync",))
            self.assertEqual(self.client.get(f"/api/agent-interface/v1/actions/{action}").status_code, 404)

    def test_daily_agent_key_keeps_exact_seven_scopes_and_can_import(self):
        response = self.client.post("/api/agent-interface/v1/credentials/agent-key", headers={"Authorization": "Bearer " + self.jwt}, json={})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()["data"]
        self.assertEqual(set(data["credential"]["scopes"]), DAILY_AGENT_SCOPE_IDS)
        self.assertEqual(len(data["credential"]["scopes"]), 7)
        headers = {"Authorization": "Bearer " + data["token"]}
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run) as helper, patch.object(handlers.creator_sync_worker.runner, "submit") as submit:
            imported = self.invoke(headers)
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()["status"], "queued")
        self.assertEqual(helper.call_args.kwargs, {"user_id": self.user_id, **self.payload, "limit": 20})
        submit.assert_called_once()
        self.assertFalse(imported.json()["data"]["result"]["creator_run"]["auto_transcribe"])
        with self.Session() as db:
            self.assertEqual(set(db.get(AgentCredential, data["credential"]["id"]).scopes), DAILY_AGENT_SCOPE_IDS)

    def test_partial_or_readonly_scopes_reject_http_and_mcp_without_writes(self):
        for scopes in (["library:read"], ["creator:read"], ["library:write"]):
            with self.subTest(scopes=scopes):
                headers, credential_id = self.pat(scopes)
                with patch.object(creator_sync_service, "import_recent_catalog") as helper:
                    denied = self.invoke(headers)
                    self.assertEqual(denied.status_code, 403, denied.text)
                    self.assertEqual(denied.json()["error"]["code"], "SCOPE_DENIED")
                    response = self.client.post("/mcp", headers=headers, json={
                        "jsonrpc": "2.0", "id": "denied", "method": "tools/call",
                        "params": {"name": self.action_id, "arguments": self.payload},
                    }).json()
                    self.assertTrue(response["result"]["isError"], response)
                    self.assertEqual(response["result"]["structuredContent"]["error"]["code"], "SCOPE_DENIED")
                    helper.assert_not_called()
                capabilities = self.client.get("/api/agent-interface/v1/capabilities", headers=headers).json()["data"]
                self.assertNotIn(self.action_id, {item["id"] for item in capabilities["actions"]})
                with self.Session() as db:
                    self.assertEqual(set(db.get(AgentCredential, credential_id).scopes), set(scopes))
                    self.assertEqual(db.query(ProductActionRun).count(), 0)
                    self.assertEqual(db.query(CreatorSyncRun).count(), 0)

    def test_import_rejects_extra_sync_fields_and_unbounded_limits_before_service(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        invalid = [
            {**self.payload, "operation": "catalog_all"},
            {**self.payload, "auto_transcribe": True},
            {**self.payload, "item_ids": ["foreign-item"]},
            {**self.payload, "source_id": "foreign-source"},
            {**self.payload, "user_id": self.other_user_id},
            {**self.payload, "cursor": "next-page"},
            *({**self.payload, "limit": limit} for limit in (None, 0, 19, 21, 50, 100, True, "20")),
            {**self.payload, "platform": "douyin"},
            {"platform": "bilibili"},
        ]
        with patch.object(creator_sync_service, "import_recent_catalog") as helper:
            for index, payload in enumerate(invalid):
                with self.subTest(payload=payload):
                    response = self.invoke(headers, payload, key=f"invalid-{index}")
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
            helper.assert_not_called()
        with self.Session() as db:
            self.assertEqual(db.query(ProductActionRun).count(), 0)

    def test_idempotency_is_required_and_replay_never_resubmits(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run) as helper, patch.object(handlers.creator_sync_worker.runner, "submit") as submit:
            missing = self.invoke(headers, key=None)
            self.assertEqual(missing.json()["error"]["code"], "IDEMPOTENCY_KEY_REQUIRED")
            first = self.invoke(headers)
            self.assertEqual(first.status_code, 200, first.text)
            second = self.invoke(headers)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(second.json()["run_id"], first.json()["run_id"])
            self.assertTrue(second.json()["meta"]["idempotent_replay"])
            conflict = self.invoke(headers, {**self.payload, "profile_ref": "https://space.bilibili.com/54321"})
            self.assertEqual(conflict.status_code, 409, conflict.text)
            self.assertEqual(conflict.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
            helper.assert_called_once()
            submit.assert_called_once()
        with self.Session() as db:
            self.assertEqual(db.query(ProductActionRun).count(), 1)
            self.assertEqual(db.query(CreatorSyncRun).count(), 1)

    def test_non_official_homepage_rejects_before_config_network_or_source_write(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        with patch.object(creator_sync_service, "_require_enabled") as feature, patch.object(creator_sync_service, "save_source") as save:
            response = self.invoke(headers, {**self.payload, "profile_ref": "https://example.invalid/creator"})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "SSRF_REJECTED")
        self.assertIn("SSRF_REJECTED", registry.get(self.action_id).advertised_error_codes())
        feature.assert_not_called()
        save.assert_not_called()
        with self.Session() as db:
            self.assertEqual(db.query(CreatorSource).count(), 0)
            self.assertEqual(db.query(CreatorSyncRun).count(), 0)

    def test_run_and_catalog_reads_do_not_cross_users_or_credentials(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        same_user_headers, _ = self.pat(["library:write", "creator:read"])
        foreign_headers, _ = self.pat(["library:write", "creator:read"], user_id=self.other_user_id)
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run), patch.object(handlers.creator_sync_worker.runner, "submit"):
            created = self.invoke(headers)
        self.assertEqual(created.status_code, 200, created.text)
        body = created.json()
        run_id = body["run_id"]
        creator_run = body["data"]["result"]["creator_run"]
        for denied_headers in (same_user_headers, foreign_headers):
            response = self.client.get(f"/api/agent-interface/v1/runs/{run_id}", headers=denied_headers)
            self.assertEqual(response.status_code, 404, response.text)
            response = self.client.post(f"/api/agent-interface/v1/runs/{run_id}/cancel", headers=denied_headers)
            self.assertEqual(response.status_code, 404, response.text)
        for action, payload in (
            ("creator.sync.get", {"run_id": creator_run["id"]}),
            ("creator.sync.items.list", {"run_id": creator_run["id"]}),
            ("creator.items.list", {"source_id": creator_run["source_id"]}),
        ):
            own = self.invoke(headers, payload, action_id=action, key=None)
            self.assertEqual(own.status_code, 200, own.text)
            self.assertEqual(own.json()["status"], "succeeded")
            denied = self.invoke(foreign_headers, payload, action_id=action, key=None)
            self.assertEqual(denied.status_code, 422, denied.text)
            self.assertEqual(denied.json()["status"], "failed", denied.text)
            self.assertIn(denied.json()["error"]["code"], ("RESOURCE_NOT_FOUND", "SOURCE_NOT_FOUND"))
        listed = self.invoke(foreign_headers, {}, action_id="creator.runs.list", key=None)
        self.assertEqual(listed.json()["data"]["result"]["items"], [])
        with self.Session() as db:
            self.assertFalse(db.get(CreatorSyncRun, creator_run["id"]).cancellation_requested)

    def test_core_resolve_rejects_other_platforms_at_schema_and_handler(self):
        headers, _ = self.pat(["creator:read"])
        for platform in ("douyin", "xiaohongshu"):
            with self.subTest(platform=platform), patch.object(creator_sync_service, "resolve_source") as helper:
                response = self.invoke(headers, {"platform": platform, "profile_ref": "public-home"}, action_id="creator.resolve", key=None)
                self.assertEqual(response.status_code, 422, response.text)
                with self.assertRaises(handlers.ActionHandlerError):
                    handlers.creator_resolve(SimpleNamespace(), {"platform": platform, "profile_ref": "public-home"})
                helper.assert_not_called()

    def test_incomplete_catalog_projects_failure_and_retains_partial_results(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run), patch.object(handlers.creator_sync_worker.runner, "submit"):
            created = self.invoke(headers)
        self.assertEqual(created.status_code, 200, created.text)
        body = created.json()
        for code in ("catalog_changed", "catalog_incomplete", "catalog_order_unverified", "catalog_limit_exceeded", ""):
            with self.subTest(code=code):
                with self.Session() as db:
                    agent_run = db.get(ProductActionRun, body["run_id"])
                    agent_run.status, agent_run.error_json, agent_run.output_json = "running", None, None
                    agent_run.completed_at = None
                    child = db.get(CreatorSyncRun, agent_run.external_id)
                    child.status, child.error_code, child.error_message = "partial", code, "本次目录只读取了部分作品"
                    child.discovered_count, child.checked_count, child.discovery_complete = 10, 10, False
                    db.commit()
                response = self.client.get(f"/api/agent-interface/v1/runs/{body['run_id']}", headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()["data"]["run"]
                self.assertEqual(response.json()["status"], "failed")
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], (code or "catalog_incomplete").upper())
                self.assertFalse(result["error"]["retryable"])
                self.assertEqual(result["data"]["creator_run"]["status"], "partial")
                self.assertEqual(result["data"]["creator_run"]["discovered_count"], 10)
                self.assertFalse(result["data"]["creator_run"]["catalog_complete"])
                self.assertIsNotNone(result["completed_at"])

    def test_full_sync_partial_success_mapping_remains_unchanged(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run), patch.object(handlers.creator_sync_worker.runner, "submit"):
            created = self.invoke(headers)
        self.assertEqual(created.status_code, 200, created.text)
        for action_id, operation in (
            ("creator.sync.start", "catalog_all"),
            ("creator.sync.start", "catalog_recent"),
            ("creator.catalog.import", "catalog_all"),
        ):
            with self.subTest(action_id=action_id, operation=operation), self.Session() as db:
                agent_run = db.get(ProductActionRun, created.json()["run_id"])
                agent_run.status, agent_run.action_id = "running", action_id
                child = db.get(CreatorSyncRun, agent_run.external_id)
                child.status, child.operation, child.error_code = "partial", operation, "catalog_incomplete"
                db.commit()
                _reconcile_creator_sync_run(db, agent_run)
                self.assertEqual(agent_run.status, "succeeded")
                self.assertIsNone(agent_run.error_json)
                self.assertEqual(agent_run.output["creator_run"]["status"], "partial")

    def test_platform_needs_action_takes_priority_over_catalog_failure(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run), patch.object(handlers.creator_sync_worker.runner, "submit"):
            created = self.invoke(headers)
        self.assertEqual(created.status_code, 200, created.text)
        with self.Session() as db:
            agent_run = db.get(ProductActionRun, created.json()["run_id"])
            child = db.get(CreatorSyncRun, agent_run.external_id)
            child.status, child.error_code, child.needs_action = "failed", "bilibili_risk_control", True
            child.needs_action_code, child.needs_action_message = "bilibili_risk_control", "请在平台完成验证"
            db.commit()
        response = self.client.get(f"/api/agent-interface/v1/runs/{created.json()['run_id']}", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["data"]["run"]
        self.assertEqual(result["status"], "waiting_for_user")
        self.assertIsNone(result["error"])
        self.assertIsNone(result["completed_at"])

    def test_import_handler_rejects_internal_parameter_bypass(self):
        with patch.object(creator_sync_service, "import_recent_catalog") as helper:
            for payload in (
                {**self.payload, "auto_transcribe": True},
                {**self.payload, "platform": "xiaohongshu"},
                {**self.payload, "limit": 100},
            ):
                with self.subTest(payload=payload), self.assertRaises(handlers.ActionHandlerError):
                    handlers.creator_catalog_import(SimpleNamespace(), payload)
            helper.assert_not_called()

    def test_mcp_publishes_import_only_to_both_scopes_and_invokes_same_handler(self):
        headers, _ = self.pat(["library:write", "creator:read"])
        tools = self.client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": "tools", "method": "tools/list", "params": {}}).json()["result"]["tools"]
        names = {item["name"] for item in tools}
        self.assertIn(self.action_id, names)
        self.assertNotIn("creator.sync.start", names)
        self.assertNotIn("creator.sync.retry", names)
        with patch.object(creator_sync_service, "import_recent_catalog", side_effect=self.create_catalog_run) as helper, patch.object(handlers.creator_sync_worker.runner, "submit"):
            response = self.client.post("/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": "catalog-import", "method": "tools/call",
                "params": {"name": self.action_id, "arguments": self.payload},
            }).json()
        self.assertFalse(response["result"]["isError"], response)
        helper.assert_called_once()
        self.assertEqual(response["result"]["structuredContent"]["data"]["result"]["creator_run"]["operation"], "catalog_recent")


if __name__ == "__main__":
    unittest.main()
