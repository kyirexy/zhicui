from __future__ import annotations

import asyncio
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "agent-interface-route-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "agent-interface-route-pepper-123456789")

from app.api.agent_interface_routes import get_action_events, mcp_router, router
from app.core.config import settings
from app.core.database import Base, get_db
from app.models.agent_interface import (
    AgentCredential,
    AgentDeviceAuthorization,
    ProductActionAudit,
    ProductActionConfirmation,
    ProductActionEvent,
    ProductActionIdempotency,
    ProductActionRateWindow,
    ProductActionRun,
)
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.user import User
from app.services.agent_credential_service import (
    AgentPrincipal,
    issue_pat,
    revoke_credential,
)
from app.services.auth_service import create_access_token


class AgentInterfaceRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_enabled = settings.AGENT_INTERFACE_ENABLED
        self.previous_user_allowlist = settings.AGENT_INTERFACE_USER_ALLOWLIST
        self.previous_action_allowlist = settings.AGENT_INTERFACE_ACTION_ALLOWLIST
        settings.AGENT_INTERFACE_ENABLED = True
        settings.AGENT_INTERFACE_USER_ALLOWLIST = ""
        settings.AGENT_INTERFACE_ACTION_ALLOWLIST = ""
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )

        @event.listens_for(self.engine, "connect")
        def _foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__, AgentCredential.__table__, AgentDeviceAuthorization.__table__,
                ProductActionRun.__table__, ProductActionEvent.__table__,
                ProductActionIdempotency.__table__, ProductActionConfirmation.__table__,
                ProductActionAudit.__table__, ProductActionRateWindow.__table__,
                Note.__table__, KnowledgeEntry.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            self.user = User(
                email="routes@example.com", username="routes",
                hashed_password="not-used", is_active=True, is_admin=True,
            )
            db.add(self.user)
            db.commit()
            db.refresh(self.user)
            self.user_id = self.user.id
            self.jwt = create_access_token(self.user.id, self.user.email)

        app = FastAPI()
        app.include_router(router)
        app.include_router(mcp_router)

        def override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        settings.AGENT_INTERFACE_ENABLED = self.previous_enabled
        settings.AGENT_INTERFACE_USER_ALLOWLIST = self.previous_user_allowlist
        settings.AGENT_INTERFACE_ACTION_ALLOWLIST = self.previous_action_allowlist
        self.engine.dispose()

    def test_beta_rollout_filters_users_and_actions(self) -> None:
        settings.AGENT_INTERFACE_USER_ALLOWLIST = "another-user-id"
        denied_user = self.client.get(
            "/api/agent-interface/v1/capabilities",
            headers={"Authorization": f"Bearer {self.jwt}"},
        )
        self.assertEqual(denied_user.status_code, 403, denied_user.text)
        self.assertEqual(denied_user.json()["error"]["code"], "ROLLOUT_RESTRICTED")

        settings.AGENT_INTERFACE_USER_ALLOWLIST = self.user_id
        settings.AGENT_INTERFACE_ACTION_ALLOWLIST = "account.me"
        capabilities = self.client.get(
            "/api/agent-interface/v1/capabilities",
            headers={"Authorization": f"Bearer {self.jwt}"},
        )
        self.assertEqual(capabilities.status_code, 200, capabilities.text)
        self.assertEqual(
            {item["id"] for item in capabilities.json()["data"]["actions"]},
            {"account.me"},
        )
        hidden = self.client.get(
            "/api/agent-interface/v1/actions/knowledge.list",
        )
        self.assertEqual(hidden.status_code, 404, hidden.text)
        self.assertEqual(hidden.json()["error"]["code"], "ACTION_NOT_FOUND")

        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "name": "灰度测试",
                "scopes": ["account:read", "knowledge:read"],
                "expires_in_days": 30,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        token = created.json()["data"]["token"]
        hidden_invoke = self.client.post(
            "/api/agent-interface/v1/actions/knowledge.list/invoke",
            headers={"Authorization": f"Bearer {token}"},
            json={"input": {}},
        )
        self.assertEqual(hidden_invoke.status_code, 404, hidden_invoke.text)
        self.assertEqual(hidden_invoke.json()["error"]["code"], "ACTION_NOT_FOUND")
        tools = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={"jsonrpc": "2.0", "id": "rollout", "method": "tools/list", "params": {}},
        ).json()["result"]["tools"]
        self.assertEqual(
            {item["name"] for item in tools},
            {"account.me", "run.get", "run.events"},
        )

    def test_capabilities_pat_invoke_runs_events_and_mcp(self) -> None:
        capabilities = self.client.get("/api/agent-interface/v1/capabilities")
        self.assertEqual(capabilities.status_code, 200)
        capability_body = capabilities.json()
        self.assertEqual(capability_body["api_version"], "v1")
        ids = {item["id"] for item in capability_body["data"]["actions"]}
        self.assertIn("account.me", ids)
        self.assertFalse(any(action_id.startswith("admin.") for action_id in ids))

        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"name": "Codex", "scopes": ["account:read"], "expires_in_days": 30},
        )
        self.assertEqual(created.status_code, 200, created.text)
        token = created.json()["data"]["token"]
        self.assertTrue(token.startswith("zhc_pat_"))

        invoked = self.client.post(
            "/api/agent-interface/v1/actions/account.me/invoke",
            headers={"Authorization": f"Bearer {token}", "Idempotency-Key": "route-smoke"},
            json={"input": {}},
        )
        self.assertEqual(invoked.status_code, 200, invoked.text)
        invocation = invoked.json()
        self.assertEqual(invocation["status"], "succeeded")
        self.assertNotIn("is_admin", invocation["data"]["result"])
        run_id = invocation["run_id"]

        run_response = self.client.get(
            f"/api/agent-interface/v1/runs/{run_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(run_response.status_code, 200)
        self.assertEqual(run_response.json()["data"]["run"]["status"], "succeeded")

        events = self.client.get(
            f"/api/agent-interface/v1/runs/{run_id}/events?after=0",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        items = events.json()["data"]["items"]
        self.assertEqual([item["sequence"] for item in items], sorted(item["sequence"] for item in items))
        self.assertEqual(sum(1 for item in items if item["terminal"]), 1)

        initialize = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        self.assertEqual(initialize.json()["result"]["serverInfo"]["name"], "zhicui")
        tool_list = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        tool_names = {tool["name"] for tool in tool_list.json()["result"]["tools"]}
        self.assertEqual(tool_names, {
            "account.me", "account.email.status", "account.consents",
            "run.get", "run.events",
        })

        mcp_run = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "run.get", "arguments": {"run_id": run_id}},
            },
        ).json()
        self.assertFalse(mcp_run["result"]["isError"], mcp_run)
        self.assertEqual(
            mcp_run["result"]["structuredContent"]["data"]["run"]["id"],
            run_id,
        )
        mcp_events = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {
                    "name": "run.events",
                    "arguments": {"run_id": run_id, "after": 0},
                },
            },
        ).json()
        self.assertFalse(mcp_events["result"]["isError"], mcp_events)
        self.assertEqual(
            sum(
                bool(item["terminal"])
                for item in mcp_events["result"]["structuredContent"]["data"]["items"]
            ),
            1,
        )

        initialized = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        )
        self.assertEqual(initialized.status_code, 202)
        self.assertEqual(initialized.content, b"")

    @staticmethod
    def _sse_request(run_id: str) -> Request:
        return Request({
            "type": "http",
            "method": "GET",
            "path": f"/api/agent-interface/v1/runs/{run_id}/events",
            "query_string": b"",
            "headers": [(b"accept", b"text/event-stream")],
            "scheme": "https",
            "server": ("testserver", 443),
        })

    def test_terminal_sse_drains_more_than_one_event_page(self) -> None:
        with self.Session() as db:
            credential, _token = issue_pat(
                db,
                user_id=self.user_id,
                name="large-sse",
                scopes=["account:read"],
                expires_in_days=1,
            )
            user = db.query(User).filter(User.id == self.user_id).one()
            run = ProductActionRun(
                request_id="large-sse",
                user_id=self.user_id,
                credential_id=credential.id,
                action_id="account.me",
                action_version="1.0.0",
                run_type="stream",
                execution_location="cloud",
                status="succeeded",
                input_hash="a" * 64,
                next_sequence=503,
            )
            db.add(run)
            db.flush()
            db.add_all([
                ProductActionEvent(
                    run_id=run.id,
                    user_id=self.user_id,
                    sequence=sequence,
                    event_type="completed" if sequence == 502 else "progress",
                    status="succeeded" if sequence == 502 else "running",
                    message="done" if sequence == 502 else "working",
                    data_json="{}",
                    terminal=sequence == 502,
                    terminal_key="terminal" if sequence == 502 else None,
                )
                for sequence in range(1, 503)
            ])
            db.commit()
            principal = AgentPrincipal(
                user=user,
                credential=credential,
                scopes=frozenset(credential.scopes),
                auth_type=credential.kind,
            )
            response = get_action_events(
                run.id,
                self._sse_request(run.id),
                after=0,
                principal=principal,
                db=db,
            )

        async def collect() -> str:
            chunks: list[str] = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
            return "".join(chunks)

        with patch("app.api.agent_interface_routes.SessionLocal", self.Session), patch(
            "app.api.agent_interface_routes.time.sleep", return_value=None
        ):
            payload = asyncio.run(collect())
        self.assertEqual(payload.count("\nevent: progress\n"), 501)
        self.assertEqual(payload.count("\nevent: completed\n"), 1)
        self.assertIn("id: 502\n", payload)

    def test_open_sse_stops_after_credential_revocation(self) -> None:
        with self.Session() as db:
            credential, _token = issue_pat(
                db,
                user_id=self.user_id,
                name="revoked-sse",
                scopes=["account:read"],
                expires_in_days=1,
            )
            credential_id = credential.id
            user = db.query(User).filter(User.id == self.user_id).one()
            run = ProductActionRun(
                request_id="revoked-sse",
                user_id=self.user_id,
                credential_id=credential_id,
                action_id="account.me",
                action_version="1.0.0",
                run_type="stream",
                execution_location="cloud",
                status="running",
                input_hash="b" * 64,
                next_sequence=2,
            )
            db.add(run)
            db.flush()
            db.add(ProductActionEvent(
                run_id=run.id,
                user_id=self.user_id,
                sequence=1,
                event_type="progress",
                status="running",
                message="working",
                data_json="{}",
                terminal=False,
            ))
            db.commit()
            principal = AgentPrincipal(
                user=user,
                credential=credential,
                scopes=frozenset(credential.scopes),
                auth_type=credential.kind,
            )
            response = get_action_events(
                run.id,
                self._sse_request(run.id),
                after=0,
                principal=principal,
                db=db,
            )

        async def read_across_revocation() -> tuple[str, str]:
            first = await response.body_iterator.__anext__()
            with self.Session() as revoke_db:
                revoke_credential(
                    revoke_db,
                    user_id=self.user_id,
                    credential_id=credential_id,
                )
            second = await response.body_iterator.__anext__()
            await response.body_iterator.aclose()
            return (
                first.decode() if isinstance(first, bytes) else first,
                second.decode() if isinstance(second, bytes) else second,
            )

        with patch("app.api.agent_interface_routes.SessionLocal", self.Session), patch(
            "app.api.agent_interface_routes.time.sleep", return_value=None
        ):
            first, second = asyncio.run(read_across_revocation())
        self.assertIn("event: progress", first)
        self.assertIn("event: error", second)
        self.assertIn("CREDENTIAL_REVOKED", second)

    def test_run_access_is_bound_to_originating_credential(self) -> None:
        browser_headers = {"Authorization": f"Bearer {self.jwt}"}
        tokens: list[str] = []
        for name in ("origin", "other"):
            response = self.client.post(
                "/api/agent-interface/v1/credentials/pat",
                headers=browser_headers,
                json={
                    "name": name,
                    "scopes": ["account:read"],
                    "expires_in_days": 1,
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            tokens.append(response.json()["data"]["token"])

        origin_headers = {"Authorization": f"Bearer {tokens[0]}"}
        other_headers = {"Authorization": f"Bearer {tokens[1]}"}
        invoked = self.client.post(
            "/api/agent-interface/v1/actions/account.me/invoke",
            headers=origin_headers,
            json={"input": {}},
        )
        self.assertEqual(invoked.status_code, 200, invoked.text)
        run_id = invoked.json()["run_id"]

        self.assertEqual(
            self.client.get(
                f"/api/agent-interface/v1/runs/{run_id}",
                headers=origin_headers,
            ).status_code,
            200,
        )
        for method, path in (
            ("get", f"/api/agent-interface/v1/runs/{run_id}"),
            ("get", f"/api/agent-interface/v1/runs/{run_id}/events?after=0"),
            ("post", f"/api/agent-interface/v1/runs/{run_id}/cancel"),
        ):
            response = getattr(self.client, method)(path, headers=other_headers)
            self.assertEqual(response.status_code, 404, response.text)
            self.assertEqual(response.json()["error"]["code"], "RUN_NOT_FOUND")

        tool_list = self.client.post(
            "/mcp",
            headers=other_headers,
            json={"jsonrpc": "2.0", "id": 40, "method": "tools/list", "params": {}},
        ).json()
        tool_names = {item["name"] for item in tool_list["result"]["tools"]}
        self.assertNotIn("run.cancel", tool_names)
        mcp_read = self.client.post(
            "/mcp",
            headers=other_headers,
            json={
                "jsonrpc": "2.0",
                "id": 41,
                "method": "tools/call",
                "params": {"name": "run.get", "arguments": {"run_id": run_id}},
            },
        ).json()
        self.assertTrue(mcp_read["result"]["isError"], mcp_read)
        self.assertEqual(
            mcp_read["result"]["structuredContent"]["error"]["code"],
            "RUN_NOT_FOUND",
        )

    def test_browser_jwt_cannot_invoke_actions_runs_or_mcp_tools(self) -> None:
        headers = {"Authorization": f"Bearer {self.jwt}"}
        invoke = self.client.post(
            "/api/agent-interface/v1/actions/account.me/invoke",
            headers=headers,
            json={"input": {}},
        )
        self.assertEqual(invoke.status_code, 401, invoke.text)
        self.assertEqual(invoke.json()["detail"]["code"], "INVALID_CREDENTIAL")

        run = self.client.get(
            "/api/agent-interface/v1/runs/not-a-run",
            headers=headers,
        )
        self.assertEqual(run.status_code, 401, run.text)
        self.assertEqual(run.json()["detail"]["code"], "INVALID_CREDENTIAL")

        mcp = self.client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 42, "method": "tools/list", "params": {}},
        ).json()
        self.assertEqual(mcp["error"]["code"], -32001)
        self.assertNotIn("result", mcp)

    def test_mcp_tools_call_rejects_hidden_secure_local_and_unavailable_actions(self) -> None:
        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "name": "MCP 边界",
                "scopes": ["account:manage", "models:write", "local:invoke"],
                "expires_in_days": 30,
            },
        )
        token = created.json()["data"]["token"]
        attempts = [
            ("account.email.confirm", {"token": "one-time-secret"}),
            ("models.custom.create", {}),
            ("local.status", {}),
        ]
        for index, (name, arguments) in enumerate(attempts, start=1):
            with self.subTest(name=name):
                response = self.client.post(
                    "/mcp",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "jsonrpc": "2.0",
                        "id": f"hidden-{index}",
                        "method": "tools/call",
                        "params": {"name": name, "arguments": arguments},
                    },
                ).json()
                self.assertTrue(response["result"]["isError"], response)
                self.assertEqual(
                    response["result"]["structuredContent"]["error"]["code"],
                    "ACTION_NOT_FOUND",
                )
        denied = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "jsonrpc": "2.0",
                "id": "scope-denied",
                "method": "tools/call",
                "params": {"name": "knowledge.list", "arguments": {}},
            },
        ).json()
        self.assertTrue(denied["result"]["isError"], denied)
        self.assertEqual(
            denied["result"]["structuredContent"]["error"]["code"],
            "SCOPE_DENIED",
        )
        with self.Session() as db:
            self.assertEqual(db.query(ProductActionRun).count(), 0)

    def test_mcp_required_idempotency_is_derived_from_jsonrpc_id(self) -> None:
        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "name": "MCP 幂等",
                "scopes": ["creator:sync"],
                "expires_in_days": 30,
            },
        )
        token = created.json()["data"]["token"]
        call = {
            "jsonrpc": "2.0",
            "id": "stable-request-1",
            "method": "tools/call",
            "params": {
                "name": "creator.sync.start",
                "arguments": {"source_id": "source-1"},
            },
        }
        handler = lambda _ctx, payload: {"accepted": payload["source_id"]}
        with patch(
            "app.services.product_action_run_service.get_handler",
            return_value=handler,
        ):
            first = self.client.post(
                "/mcp", headers={"Authorization": f"Bearer {token}"}, json=call,
            ).json()
            replay = self.client.post(
                "/mcp", headers={"Authorization": f"Bearer {token}"}, json=call,
            ).json()
            conflicting = {
                **call,
                "params": {
                    **call["params"],
                    "arguments": {"source_id": "source-2"},
                },
            }
            conflict = self.client.post(
                "/mcp",
                headers={"Authorization": f"Bearer {token}"},
                json=conflicting,
            ).json()

        self.assertFalse(first["result"]["isError"], first)
        self.assertFalse(replay["result"]["isError"], replay)
        self.assertTrue(
            replay["result"]["structuredContent"]["meta"]["idempotent_replay"],
        )
        self.assertTrue(conflict["result"]["isError"], conflict)
        self.assertEqual(
            conflict["result"]["structuredContent"]["error"]["code"],
            "IDEMPOTENCY_CONFLICT",
        )
        with self.Session() as db:
            runs = db.query(ProductActionRun).all()
            self.assertEqual(len(runs), 1)
            self.assertTrue(str(runs[0].idempotency_key).startswith("mcp:"))
            self.assertLessEqual(len(str(runs[0].idempotency_key)), 160)

    def test_mcp_fixed_run_tools_enforce_user_ownership_and_cancel(self) -> None:
        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "name": "运行控制",
                "scopes": ["creator:sync"],
                "expires_in_days": 1,
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        token = created.json()["data"]["token"]
        credential_id = created.json()["data"]["credential"]["id"]

        with self.Session() as db:
            other = User(
                email="other-run@example.com",
                username="other-run",
                hashed_password="not-used",
                is_active=True,
            )
            db.add(other)
            db.flush()
            own = ProductActionRun(
                request_id="own-run-request",
                user_id=self.user_id,
                credential_id=credential_id,
                action_id="creator.sync.start",
                action_version="1.0.0",
                run_type="long_task",
                execution_location="cloud",
                input_json="{}",
                input_hash="a" * 64,
                status="queued",
            )
            foreign = ProductActionRun(
                request_id="foreign-run-request",
                user_id=other.id,
                action_id="creator.sync.start",
                action_version="1.0.0",
                run_type="long_task",
                execution_location="cloud",
                input_json="{}",
                input_hash="b" * 64,
                status="queued",
            )
            db.add_all([own, foreign])
            db.commit()
            own_id = own.id
            foreign_id = foreign.id

        headers = {"Authorization": f"Bearer {token}"}
        cancel = self.client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0", "id": 30, "method": "tools/call",
                "params": {"name": "run.cancel", "arguments": {"run_id": own_id}},
            },
        ).json()
        self.assertFalse(cancel["result"]["isError"], cancel)
        self.assertEqual(
            cancel["result"]["structuredContent"]["data"]["run"]["status"],
            "canceled",
        )
        foreign = self.client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0", "id": 31, "method": "tools/call",
                "params": {"name": "run.get", "arguments": {"run_id": foreign_id}},
            },
        ).json()
        self.assertTrue(foreign["result"]["isError"], foreign)
        self.assertEqual(
            foreign["result"]["structuredContent"]["error"]["code"],
            "RUN_NOT_FOUND",
        )

    def test_pat_and_device_lists_do_not_duplicate_connections(self) -> None:
        headers = {"Authorization": f"Bearer {self.jwt}"}
        pat = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers=headers,
            json={"name": "CI", "scopes": ["account:read"], "expires_in_days": 30},
        )
        self.assertEqual(pat.status_code, 200, pat.text)

        started = self.client.post(
            "/api/agent-interface/v1/auth/device",
            json={"client_name": "Codex", "client_type": "cli", "scopes": ["account:read"]},
        )
        self.assertEqual(started.status_code, 200, started.text)
        auth_data = started.json()["data"]
        preview = self.client.get(
            "/api/agent-interface/v1/auth/device/request",
            headers=headers,
            params={"user_code": auth_data["user_code"]},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        preview_data = preview.json()["data"]
        self.assertEqual(preview_data["status"], "pending")
        self.assertEqual(preview_data["client_name"], "Codex")
        self.assertEqual(preview_data["scopes"], ["account:read"])
        self.assertNotIn("device_code", preview_data)
        self.assertNotIn("user_code", preview_data)
        approved = self.client.post(
            "/api/agent-interface/v1/auth/device/approve",
            headers=headers,
            json={"user_code": auth_data["user_code"], "approve": True},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        issued = self.client.post(
            "/api/agent-interface/v1/auth/device/token",
            json={"device_code": auth_data["device_code"]},
        )
        self.assertEqual(issued.status_code, 200, issued.text)

        credentials = self.client.get(
            "/api/agent-interface/v1/credentials", headers=headers,
        ).json()["data"]["items"]
        devices = self.client.get(
            "/api/agent-interface/v1/devices", headers=headers,
        ).json()["data"]["items"]
        self.assertEqual([item["type"] for item in credentials], ["pat"])
        self.assertEqual([item["type"] for item in devices], ["access"])
        self.assertTrue({item["id"] for item in credentials}.isdisjoint(
            {item["id"] for item in devices}
        ))

    def test_mcp_confirmation_meta_replays_without_polluting_action_input(self) -> None:
        with self.Session() as db:
            row = KnowledgeEntry(
                user_id=self.user_id,
                title="待删除知识",
                summary="",
                content="测试内容",
                source_label="测试",
            )
            db.add(row)
            db.commit()
            db.refresh(row)
            entry_id = row.id

        created = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"name": "MCP 写入", "scopes": ["knowledge:write"], "expires_in_days": 30},
        )
        token = created.json()["data"]["token"]
        call = {
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": {
                "name": "knowledge.remove",
                "arguments": {"entry_id": entry_id},
            },
        }
        first = self.client.post(
            "/mcp", headers={"Authorization": f"Bearer {token}"}, json=call,
        ).json()
        first_payload = first["result"]["structuredContent"]
        self.assertTrue(first["result"]["isError"])
        self.assertEqual(first_payload["error"]["code"], "CONFIRMATION_REQUIRED")
        confirmation_id = first_payload["error"]["details"]["confirmation_id"]

        approved = self.client.post(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}/approve",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"approve": True},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        call["params"]["_meta"] = {"zhicui/confirmationId": confirmation_id}
        second = self.client.post(
            "/mcp", headers={"Authorization": f"Bearer {token}"}, json=call,
        ).json()
        self.assertFalse(second["result"]["isError"], second)
        self.assertTrue(second["result"]["structuredContent"]["data"]["result"]["deleted"])
        with self.Session() as db:
            self.assertIsNone(db.query(KnowledgeEntry).filter_by(id=entry_id).first())

    def test_device_request_can_be_previewed_then_really_denied(self) -> None:
        started = self.client.post(
            "/api/agent-interface/v1/auth/device",
            json={
                "client_name": "Claude Code on Windows",
                "client_type": "claude",
                "scopes": ["library:read", "ask:run"],
            },
        )
        self.assertEqual(started.status_code, 200, started.text)
        auth_data = started.json()["data"]
        headers = {"Authorization": f"Bearer {self.jwt}"}

        preview = self.client.get(
            "/api/agent-interface/v1/auth/device/request",
            headers=headers,
            params={"user_code": auth_data["user_code"]},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["data"]["client_name"], "Claude Code on Windows")
        self.assertEqual(preview.json()["data"]["client_type"], "claude")
        self.assertEqual(
            preview.json()["data"]["scopes"], ["ask:run", "library:read"],
        )

        denied = self.client.post(
            "/api/agent-interface/v1/auth/device/approve",
            headers=headers,
            json={"user_code": auth_data["user_code"], "approve": False},
        )
        self.assertEqual(denied.status_code, 200, denied.text)
        self.assertEqual(denied.json()["data"]["status"], "denied")
        issued = self.client.post(
            "/api/agent-interface/v1/auth/device/token",
            json={"device_code": auth_data["device_code"]},
        )
        self.assertEqual(issued.status_code, 403, issued.text)
        self.assertEqual(issued.json()["error"]["code"], "ACCESS_DENIED")

    def test_confirmation_list_detail_reject_and_cross_user_isolation(self) -> None:
        with self.Session() as db:
            entry = KnowledgeEntry(
                user_id=self.user_id,
                title="只能由本人确认删除",
                summary="",
                content="测试内容",
                source_label="测试",
            )
            other = User(
                email="other-routes@example.com",
                username="other-routes",
                hashed_password="not-used",
                is_active=True,
                is_admin=False,
            )
            db.add_all([entry, other])
            db.commit()
            db.refresh(entry)
            db.refresh(other)
            entry_id = entry.id
            other_jwt = create_access_token(other.id, other.email)

        headers = {"Authorization": f"Bearer {self.jwt}"}
        pat = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers=headers,
            json={
                "name": "删除操作测试",
                "scopes": ["knowledge:write"],
                "expires_in_days": 30,
            },
        )
        token = pat.json()["data"]["token"]
        requested = self.client.post(
            "/api/agent-interface/v1/actions/knowledge.remove/invoke",
            headers={"Authorization": f"Bearer {token}"},
            json={"input": {"entry_id": entry_id}},
        )
        self.assertEqual(requested.status_code, 409, requested.text)
        confirmation_id = requested.json()["error"]["details"]["confirmation_id"]

        listed = self.client.get(
            "/api/agent-interface/v1/confirmations?limit=1", headers=headers,
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        items = listed.json()["data"]["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], confirmation_id)
        self.assertNotIn("input", items[0])
        self.assertNotIn("input_hash", items[0])

        detail = self.client.get(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}",
            headers=headers,
        )
        self.assertEqual(detail.status_code, 200, detail.text)
        safe_detail = detail.json()["data"]["confirmation"]
        self.assertEqual(safe_detail["action_id"], "knowledge.remove")
        self.assertNotIn("input", safe_detail)
        self.assertNotIn("input_hash", safe_detail)
        summary = safe_detail["confirmation_summary"]
        self.assertEqual(summary["operation"], "删除知识页")
        self.assertEqual(summary["targets"][0]["label"], "知识页")
        self.assertTrue(summary["targets"][0]["reference"].endswith(entry_id[-10:]))
        self.assertNotIn(entry_id, json.dumps(safe_detail, ensure_ascii=False))

        other_headers = {"Authorization": f"Bearer {other_jwt}"}
        other_list = self.client.get(
            "/api/agent-interface/v1/confirmations", headers=other_headers,
        )
        self.assertEqual(other_list.json()["data"]["items"], [])
        other_detail = self.client.get(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}",
            headers=other_headers,
        )
        self.assertEqual(other_detail.status_code, 404, other_detail.text)
        other_approve = self.client.post(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}/approve",
            headers=other_headers,
            json={"approve": True},
        )
        self.assertEqual(other_approve.status_code, 404, other_approve.text)

        rejected = self.client.post(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}/reject",
            headers=headers,
        )
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertEqual(
            rejected.json()["data"]["confirmation"]["status"], "denied",
        )
        self.assertEqual(
            self.client.get(
                "/api/agent-interface/v1/confirmations", headers=headers,
            ).json()["data"]["items"],
            [],
        )
        with self.Session() as db:
            self.assertIsNotNone(
                db.query(KnowledgeEntry).filter_by(id=entry_id).first(),
            )

    def test_recent_calls_honors_limit(self) -> None:
        headers = {"Authorization": f"Bearer {self.jwt}"}
        pat = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers=headers,
            json={"name": "审计", "scopes": ["account:read"], "expires_in_days": 30},
        )
        token = pat.json()["data"]["token"]
        for index in range(3):
            response = self.client.post(
                "/api/agent-interface/v1/actions/account.me/invoke",
                headers={"Authorization": f"Bearer {token}"},
                json={"input": {}, "idempotency_key": f"audit-{index}"},
            )
            self.assertEqual(response.status_code, 200, response.text)
        recent = self.client.get(
            "/api/agent-interface/v1/recent-calls?limit=2", headers=headers,
        )
        self.assertEqual(recent.status_code, 200, recent.text)
        self.assertEqual(len(recent.json()["data"]["items"]), 2)
        self.assertGreaterEqual(recent.json()["data"]["total"], 3)
        too_large = self.client.get(
            "/api/agent-interface/v1/recent-calls?limit=101", headers=headers,
        )
        self.assertEqual(too_large.status_code, 422)

    def test_confirmation_list_detail_reject_expiry_and_cross_user_isolation(self) -> None:
        with self.Session() as db:
            other = User(
                email="other-confirmations@example.com",
                username="other-confirmations",
                hashed_password="not-used",
                is_active=True,
            )
            db.add(other)
            db.flush()
            other_id = other.id
            other_jwt = create_access_token(other.id, other.email)
            pending = ProductActionConfirmation(
                user_id=self.user_id,
                action_id="knowledge.remove",
                input_hash="a" * 64,
                status="pending",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
            expired = ProductActionConfirmation(
                user_id=self.user_id,
                action_id="plan.remove",
                input_hash="b" * 64,
                status="pending",
                expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
            )
            foreign = ProductActionConfirmation(
                user_id=other_id,
                action_id="knowledge.remove",
                input_hash="c" * 64,
                status="pending",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
            db.add_all([pending, expired, foreign])
            db.commit()
            pending_id = pending.id
            expired_id = expired.id

        own_headers = {"Authorization": f"Bearer {self.jwt}"}
        other_headers = {"Authorization": f"Bearer {other_jwt}"}
        listed = self.client.get(
            "/api/agent-interface/v1/confirmations", headers=own_headers,
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        items = listed.json()["data"]["items"]
        self.assertEqual([item["id"] for item in items], [pending_id])
        self.assertNotIn("input_hash", items[0])

        foreign_detail = self.client.get(
            f"/api/agent-interface/v1/confirmations/{pending_id}",
            headers=other_headers,
        )
        self.assertEqual(foreign_detail.status_code, 404, foreign_detail.text)
        foreign_approve = self.client.post(
            f"/api/agent-interface/v1/confirmations/{pending_id}/approve",
            headers=other_headers,
            json={"approve": True},
        )
        self.assertEqual(foreign_approve.status_code, 404, foreign_approve.text)

        expired_detail = self.client.get(
            f"/api/agent-interface/v1/confirmations/{expired_id}",
            headers=own_headers,
        )
        self.assertEqual(expired_detail.status_code, 200, expired_detail.text)
        self.assertEqual(
            expired_detail.json()["data"]["confirmation"]["status"], "expired",
        )
        expired_approve = self.client.post(
            f"/api/agent-interface/v1/confirmations/{expired_id}/approve",
            headers=own_headers,
            json={"approve": True},
        )
        self.assertEqual(expired_approve.status_code, 409, expired_approve.text)

        rejected = self.client.post(
            f"/api/agent-interface/v1/confirmations/{pending_id}/reject",
            headers=own_headers,
        )
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertEqual(
            rejected.json()["data"]["confirmation"]["status"], "denied",
        )
        empty = self.client.get(
            "/api/agent-interface/v1/confirmations", headers=own_headers,
        )
        self.assertEqual(empty.json()["data"]["items"], [])


if __name__ == "__main__":
    unittest.main()
