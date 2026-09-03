from __future__ import annotations

import hashlib
import json
import os
import unittest
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "agent-interface-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "agent-interface-pepper-123456789")

from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.core.config import settings
from app.core.database import Base
from app.core.request_context import get_current_user_id
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
from app.models.creator_sync import CreatorSource, CreatorSourceItem, CreatorSyncRun
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.note import Note
from app.models.user import User
from app.services.agent_credential_service import (
    AgentPrincipal,
    CredentialError,
    approve_device_authorization,
    authenticate_access_token,
    create_device_authorization,
    issue_pat,
    poll_device_authorization,
    revoke_credential,
    rotate_refresh_token,
    utcnow,
)
from app.services.product_action_registry import ProductActionDefinition, registry
from app.services import product_action_handlers
from app.services.product_action_run_service import (
    ProductActionError,
    _validate_output,
    _validate_input,
    append_event,
    approve_confirmation,
    claim_run,
    consume_confirmation,
    consume_rate_limit,
    create_confirmation,
    get_run,
    heartbeat_run,
    invoke,
    normalized_input_hash,
    redact_secrets,
    request_cancel,
    recover_stale_runs,
    repair_missing_terminal_events,
    reconcile_external_run,
    transition_run,
)


class AgentInterfaceV1Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                AgentCredential.__table__,
                AgentDeviceAuthorization.__table__,
                ProductActionRun.__table__,
                ProductActionEvent.__table__,
                ProductActionIdempotency.__table__,
                ProductActionConfirmation.__table__,
                ProductActionAudit.__table__,
                ProductActionRateWindow.__table__,
                CreatorSource.__table__,
                CreatorSyncRun.__table__,
                Note.__table__,
                CreatorSourceItem.__table__,
                LibraryHiddenItem.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(
            email="agent-one@example.com", username="agent-one",
            hashed_password="not-used", is_active=True, is_admin=True,
        )
        self.other = User(
            email="agent-two@example.com", username="agent-two",
            hashed_password="not-used", is_active=True, is_admin=False,
        )
        self.db.add_all([self.user, self.other])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _principal(self, scopes: list[str] | None = None) -> AgentPrincipal:
        row, token = issue_pat(
            self.db,
            user_id=self.user.id,
            name="测试 PAT",
            scopes=scopes or ["account:read"],
        )
        authenticated = authenticate_access_token(self.db, token)
        return AgentPrincipal(
            user=self.user,
            credential=authenticated,
            scopes=frozenset(authenticated.scopes),
            auth_type="pat",
        )

    def test_stale_unbound_run_is_closed_once_after_process_restart(self) -> None:
        run = ProductActionRun(
            request_id="req-stale",
            user_id=self.user.id,
            action_id="library.list",
            action_version="1.0.0",
            run_type="sync",
            execution_location="cloud",
            status="running",
            input_json="{}",
            input_hash=normalized_input_hash({}),
            updated_at=utcnow() - timedelta(minutes=10),
        )
        self.db.add(run)
        self.db.commit()

        self.assertEqual(recover_stale_runs(self.db, older_than_seconds=60), 1)
        self.db.refresh(run)
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error["code"], "RUN_INTERRUPTED")
        terminal = self.db.query(ProductActionEvent).filter(
            ProductActionEvent.run_id == run.id,
            ProductActionEvent.terminal.is_(True),
        ).all()
        self.assertEqual(len(terminal), 1)
        self.assertEqual(recover_stale_runs(self.db, older_than_seconds=60), 0)

    def test_terminal_run_missing_final_event_is_repaired_once(self) -> None:
        run = ProductActionRun(
            request_id="req-terminal-gap",
            user_id=self.user.id,
            action_id="library.list",
            action_version="1.0.0",
            run_type="sync",
            execution_location="cloud",
            status="succeeded",
            input_json="{}",
            output_json='{"items":[]}',
            input_hash=normalized_input_hash({}),
            completed_at=utcnow(),
        )
        self.db.add(run)
        self.db.commit()

        self.assertEqual(repair_missing_terminal_events(self.db), 1)
        event_row = self.db.query(ProductActionEvent).filter(
            ProductActionEvent.run_id == run.id,
            ProductActionEvent.terminal_key == "terminal",
        ).one()
        self.assertEqual(event_row.status, "succeeded")
        self.assertEqual(repair_missing_terminal_events(self.db), 0)

    def test_confirmation_summary_migration_is_additive_and_idempotent(self) -> None:
        from app import main as app_main

        legacy_engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        try:
            with legacy_engine.begin() as conn:
                conn.execute(text(
                    "CREATE TABLE product_action_confirmations ("
                    "id VARCHAR(32) PRIMARY KEY, status VARCHAR(24) NOT NULL)"
                ))
                conn.execute(text(
                    "INSERT INTO product_action_confirmations (id, status) "
                    "VALUES ('legacy-confirmation', 'pending')"
                ))

            with patch.object(app_main, "engine", legacy_engine):
                app_main._migrate_db()
                app_main._migrate_db()

            columns = {
                column["name"]
                for column in inspect(legacy_engine).get_columns(
                    "product_action_confirmations"
                )
            }
            self.assertIn("confirmation_summary_json", columns)
            with legacy_engine.connect() as conn:
                value = conn.execute(text(
                    "SELECT confirmation_summary_json "
                    "FROM product_action_confirmations "
                    "WHERE id='legacy-confirmation'"
                )).scalar_one()
            self.assertEqual(value, "{}")
        finally:
            legacy_engine.dispose()

    def test_registry_has_no_admin_or_private_research_tools(self) -> None:
        definitions = registry.all()
        ids = {definition.id for definition in definitions}
        # Deliberate explicit inventory: changing either count requires a
        # reviewed Registry update instead of accidental route reflection.
        self.assertEqual(len(ids), 120)
        self.assertEqual(sum(definition.available for definition in definitions), 102)
        self.assertFalse(any(action_id.startswith("admin.") for action_id in ids))
        self.assertTrue(ids.isdisjoint({
            "video.source_scan", "video.transcript_map", "web.public_research",
            "video.answer_synthesize", "video.claim_validate", "video.claim_repair",
        }))
        for definition in registry.all():
            self.assertTrue(set(definition.scopes).issubset(ALL_SCOPE_IDS))
            self.assertEqual(definition.input_schema.get("type"), "object")
            self.assertEqual(definition.output_schema.get("type"), "object")
            if not definition.available and any(
                scope.endswith(":read") for scope in definition.scopes
            ):
                self.assertEqual(
                    [risk.value for risk in definition.risk],
                    ["read"],
                    definition.id,
                )

    def test_stable_capability_manifest_matches_the_reviewed_registry(self) -> None:
        manifest = json.loads((
            Path(__file__).resolve().parents[1]
            / "app" / "agent_interface" / "stable_capabilities_v1.json"
        ).read_text(encoding="utf-8"))
        descriptors = sorted(
            (
                definition.descriptor().model_dump(mode="json")
                for definition in registry.all()
            ),
            key=lambda item: item["id"],
        )
        digest = hashlib.sha256(json.dumps(
            descriptors,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["interface_version"], "v1")
        self.assertEqual(manifest["action_count"], len(descriptors))
        self.assertEqual(
            manifest["cloud_action_count"],
            sum(item["execution_location"] == "cloud" for item in descriptors),
        )
        self.assertEqual(
            manifest["local_windows_action_count"],
            sum(item["execution_location"] == "local_windows" for item in descriptors),
        )
        self.assertEqual(
            manifest["available_cloud_action_count"],
            sum(
                item["available"] and item["execution_location"] == "cloud"
                for item in descriptors
            ),
        )
        self.assertEqual(
            manifest["unavailable_local_windows_action_count"],
            sum(
                not item["available"]
                and item["execution_location"] == "local_windows"
                for item in descriptors
            ),
        )
        self.assertEqual(manifest["scope_count"], len(ALL_SCOPE_IDS))
        self.assertEqual(
            manifest["remote_mcp_tool_count"],
            sum(
                item["available"]
                and item["execution_location"] == "cloud"
                and item["mcp_exposed"]
                for item in descriptors
            ) + 3,
        )
        self.assertEqual(manifest["descriptor_sha256"], digest)

    def test_action_output_schema_is_enforced_before_persistence(self) -> None:
        schema = {
            "type": "object",
            "properties": {"count": {"type": "integer", "minimum": 0}},
            "required": ["count"],
            "additionalProperties": False,
        }
        self.assertEqual(_validate_output(schema, {"count": 2}), {"count": 2})
        with self.assertRaises(product_action_handlers.ActionHandlerError) as captured:
            _validate_output(schema, {"count": -1})
        self.assertEqual(captured.exception.code, "INVALID_OUTPUT")

    def test_invalid_handler_output_fails_run_without_persisting_result(self) -> None:
        principal = self._principal(["account:read"])
        definition = ProductActionDefinition(
            id="account.me",
            title="输出契约测试",
            description="验证处理器输出会在持久化前经过 Schema 校验。",
            scopes=("account:read",),
            handler_name="invalid_output_test",
            output_schema={
                "type": "object",
                "properties": {"count": {"type": "integer", "minimum": 0}},
                "required": ["count"],
                "additionalProperties": False,
            },
        )

        with (
            patch.object(registry, "get", return_value=definition),
            patch.dict(
                product_action_handlers.HANDLERS,
                {"invalid_output_test": lambda _ctx, _payload: {"count": -1}},
            ),
            self.assertRaises(ProductActionError) as captured,
        ):
            invoke(
                self.db,
                principal=principal,
                action_id="account.me",
                raw_input={},
                request_id="invalid-output-contract",
                idempotency_key=None,
                confirmation_id=None,
            )

        self.assertEqual(captured.exception.code, "INVALID_OUTPUT")
        run = self.db.query(ProductActionRun).filter(
            ProductActionRun.request_id == "invalid-output-contract"
        ).one()
        self.assertEqual(run.status, "failed")
        self.assertIsNone(run.output)
        self.assertEqual(run.error["code"], "INVALID_OUTPUT")
        terminal_events = self.db.query(ProductActionEvent).filter(
            ProductActionEvent.run_id == run.id,
            ProductActionEvent.terminal_key == "terminal",
        ).all()
        self.assertEqual(len(terminal_events), 1)

    def test_promoted_cloud_actions_have_reviewed_handlers_and_safe_schemas(self) -> None:
        promoted = {
            "library.sync.status", "library.sync.start",
            "library.transcript.generate", "library.hidden.list",
            "library.hidden.restore", "library.visual.ask",
            "knowledge.candidate.list", "knowledge.candidate.save",
            "plan.create", "plan.focus.replace", "plan.review",
            "plan.task.reorder", "plan.coach.preview", "plan.coach.apply",
            "account.email.status", "account.email.send",
            "account.email.confirm", "account.consents",
            "analysis.run.remove", "models.selection.get",
            "models.selection.set", "models.custom.list",
            "models.custom.update", "models.custom.remove",
            "models.custom.test", "models.vision.get",
            "models.vision.update", "models.vision.remove",
            "models.vision.test",
        }
        for action_id in promoted:
            definition = registry.get(action_id)
            self.assertIsNotNone(definition, action_id)
            assert definition is not None
            self.assertTrue(definition.available, action_id)
            self.assertTrue(definition.handler_name, action_id)

        email_confirm = registry.get("account.email.confirm")
        assert email_confirm is not None
        self.assertFalse(email_confirm.mcp_exposed)
        self.assertFalse(email_confirm.secure_direct)

        custom_create = registry.get("models.custom.create")
        assert custom_create is not None
        self.assertTrue(custom_create.available)
        self.assertTrue(custom_create.secure_direct)
        self.assertFalse(custom_create.mcp_exposed)
        self.assertIsNone(custom_create.handler_name)

        plan_preview = registry.get("plan.coach.preview")
        plan_apply = registry.get("plan.coach.apply")
        assert plan_preview is not None and plan_apply is not None
        self.assertEqual(plan_preview.run_type.value, "long_task")
        self.assertIn("billable", [risk.value for risk in plan_preview.risk])
        self.assertTrue(plan_apply.confirmation_required)
        self.assertEqual(
            set(plan_apply.input_schema["properties"]),
            {"preview_message_id"},
        )

        forbidden_input_keys = {
            "api_key", "password", "cookie", "jwt", "access_token",
            "refresh_token", "ephemeral_media_url", "media_url",
        }

        def property_names(schema):
            if isinstance(schema, dict):
                for key, value in (schema.get("properties") or {}).items():
                    yield str(key).lower()
                    yield from property_names(value)
                yield from property_names(schema.get("items"))
            elif isinstance(schema, list):
                for value in schema:
                    yield from property_names(value)

        for definition in registry.all():
            if not definition.mcp_exposed:
                continue
            names = set(property_names(definition.input_schema))
            self.assertTrue(
                names.isdisjoint(forbidden_input_keys),
                f"{definition.id}: {sorted(names & forbidden_input_keys)}",
            )

    def test_plan_coach_apply_requires_user_confirmation_before_handler(self) -> None:
        principal = self._principal(["plan:write"])
        with self.assertRaises(ProductActionError) as required:
            invoke(
                self.db,
                principal=principal,
                action_id="plan.coach.apply",
                raw_input={"preview_message_id": "message-owned"},
                request_id="plan-apply-confirmation",
                idempotency_key="plan-apply-confirmation-key",
                confirmation_id=None,
            )
        self.assertEqual(required.exception.code, "CONFIRMATION_REQUIRED")
        self.assertEqual(self.db.query(ProductActionRun).count(), 0)

    def test_action_handler_executes_with_authenticated_user_context(self) -> None:
        principal = self._principal(["account:read"])
        observed: dict[str, str | None] = {}

        def capture_context(_ctx, _payload):
            observed["user_id"] = get_current_user_id()
            return {"user_id": observed["user_id"]}

        with patch.dict(
            product_action_handlers.HANDLERS,
            {"account_me": capture_context},
        ):
            envelope, _run, _replayed = invoke(
                self.db,
                principal=principal,
                action_id="account.me",
                raw_input={},
                request_id="context-binding",
                idempotency_key=None,
                confirmation_id=None,
            )
        self.assertEqual(observed["user_id"], self.user.id)
        self.assertEqual(envelope.data["result"]["user_id"], self.user.id)
        self.assertIsNone(get_current_user_id())

    def test_nested_adapter_validation_rejects_unsafe_values(self) -> None:
        ctx = SimpleNamespace(
            db=self.db,
            user=self.user,
            run=SimpleNamespace(id="run-test"),
        )
        with self.assertRaises(product_action_handlers.ActionHandlerError):
            product_action_handlers.library_hidden_restore(
                ctx, {"aweme_ids": ["../not-an-id"]}
            )
        with self.assertRaises(product_action_handlers.ActionHandlerError):
            product_action_handlers.plan_create(
                ctx,
                {
                    "title": "计划",
                    "first_task": {"title": "任务", "duration_minutes": 99999},
                },
            )
        with self.assertRaises(product_action_handlers.ActionHandlerError):
            product_action_handlers.plan_task_reorder(
                ctx,
                {"plan_id": "p", "task_ids": ["x"] * 2001},
            )
        with self.assertRaises(product_action_handlers.ActionHandlerError):
            product_action_handlers.models_vision_update(ctx, {})

    def test_connector_job_projection_omits_url_and_raw_error(self) -> None:
        projected = product_action_handlers._safe_sync_job({
            "job_id": "job-1",
            "status": "failed",
            "url": "http://127.0.0.1:18081/private",
            "error": "cookie=/secret/path",
            "error_code": "connector_error",
            "failed": 1,
        })
        self.assertEqual(projected["job_id"], "job-1")
        self.assertNotIn("url", projected)
        self.assertNotIn("error", projected)

    def test_local_action_descriptors_publish_exact_bridge_schemas(self) -> None:
        platform_actions = (
            "local.platform.login", "local.platform.status",
            "local.platform.disconnect", "local.platform.logout",
            "local.platform.rebind",
        )
        for action_id in platform_actions:
            definition = registry.get(action_id)
            self.assertIsNotNone(definition, action_id)
            assert definition is not None
            self.assertFalse(definition.available)
            self.assertEqual(definition.execution_location.value, "local_windows")
            self.assertEqual(
                set(definition.input_schema.get("required") or []),
                {"platform"},
                action_id,
            )
            self.assertNotIn("profile_key", definition.input_schema.get("properties") or {})
        collect = registry.get("local.platform.collect")
        sync = registry.get("local.platform.sync")
        for definition in (collect, sync):
            self.assertIsNotNone(definition)
            assert definition is not None
            self.assertEqual(
                set(definition.input_schema.get("required") or []),
                {"platform", "mode", "limit"},
            )
            self.assertNotIn("profile_key", definition.input_schema.get("properties") or {})
        for action_id in ("local.media.open", "local.media.delete"):
            definition = registry.get(action_id)
            self.assertIsNotNone(definition)
            assert definition is not None
            self.assertEqual(
                definition.input_schema.get("required"), ["aweme_id"]
            )
        for action_id in (
            "local.platform.cancel",
            "local.update.check", "local.update.install",
            "local.client.update.check", "local.client.update.install",
        ):
            definition = registry.get(action_id)
            self.assertIsNotNone(definition, action_id)
            assert definition is not None
            self.assertEqual(definition.input_schema.get("properties"), {})

    def test_pat_is_hashed_scoped_expiring_and_revocable(self) -> None:
        row, token = issue_pat(
            self.db, user_id=self.user.id, name="Codex",
            scopes=["account:read", "library:read"],
        )
        self.assertNotEqual(row.token_hash, token)
        self.assertNotIn(token, json.dumps(row.to_public_dict(), ensure_ascii=False))
        authenticated = authenticate_access_token(self.db, token)
        self.assertEqual(authenticated.id, row.id)

        revoke_credential(self.db, user_id=self.user.id, credential_id=row.id)
        with self.assertRaises(CredentialError) as revoked:
            authenticate_access_token(self.db, token)
        self.assertEqual(revoked.exception.code, "CREDENTIAL_REVOKED")

        expired, expired_token = issue_pat(
            self.db, user_id=self.user.id, name="Expired", scopes=["account:read"]
        )
        expired.expires_at = utcnow() - timedelta(seconds=1)
        self.db.commit()
        with self.assertRaises(CredentialError) as expiry:
            authenticate_access_token(self.db, expired_token)
        self.assertEqual(expiry.exception.code, "CREDENTIAL_EXPIRED")

    def test_device_flow_and_refresh_rotation_rejects_replay(self) -> None:
        authorization, device_code, user_code = create_device_authorization(
            self.db,
            client_name="Codex",
            client_type="cli",
            scopes=["account:read", "library:read"],
        )
        self.assertEqual(authorization.status, "pending")
        self.assertEqual(authorization.user_code_hint, user_code[-4:])
        self.assertNotEqual(authorization.user_code_hint, user_code)
        with self.assertRaises(CredentialError) as pending:
            poll_device_authorization(self.db, device_code=device_code)
        self.assertEqual(pending.exception.code, "AUTHORIZATION_PENDING")

        approve_device_authorization(
            self.db, user_id=self.user.id, user_code=user_code, approve=True
        )
        issued = poll_device_authorization(self.db, device_code=device_code)
        self.assertTrue(issued["access_token"].startswith("zhc_access_"))
        self.assertTrue(issued["refresh_token"].startswith("zhc_refresh_"))
        credential_id = issued["credential"]["id"]
        with self.assertRaises(CredentialError) as malformed:
            rotate_refresh_token(
                self.db,
                f"zhc_refresh_{credential_id}_not-a-real-refresh-token",
            )
        self.assertEqual(malformed.exception.code, "INVALID_CREDENTIAL")
        # A random mismatch must not revoke a connection whose public id is
        # known; only a digest matching an actually rotated token is replay.
        authenticate_access_token(self.db, issued["access_token"])
        old_refresh = issued["refresh_token"]
        rotated = rotate_refresh_token(self.db, old_refresh)
        self.assertNotEqual(rotated["refresh_token"], old_refresh)
        with self.assertRaises(CredentialError) as replay:
            rotate_refresh_token(self.db, old_refresh)
        self.assertEqual(replay.exception.code, "REFRESH_TOKEN_REUSED")

    def test_device_and_refresh_tokens_obey_user_rollout_gate(self) -> None:
        authorization, device_code, user_code = create_device_authorization(
            self.db,
            client_name="Codex Beta",
            client_type="cli",
            scopes=["account:read"],
        )
        self.assertEqual(authorization.status, "pending")
        approve_device_authorization(
            self.db, user_id=self.user.id, user_code=user_code, approve=True,
        )
        with patch.object(settings, "AGENT_INTERFACE_USER_ALLOWLIST", self.other.id):
            with self.assertRaises(CredentialError) as restricted_issue:
                poll_device_authorization(self.db, device_code=device_code)
        self.assertEqual(restricted_issue.exception.code, "ROLLOUT_RESTRICTED")

        with patch.object(settings, "AGENT_INTERFACE_USER_ALLOWLIST", self.user.id):
            issued = poll_device_authorization(self.db, device_code=device_code)
        with patch.object(settings, "AGENT_INTERFACE_USER_ALLOWLIST", self.other.id):
            with self.assertRaises(CredentialError) as restricted_refresh:
                rotate_refresh_token(self.db, issued["refresh_token"])
        self.assertEqual(restricted_refresh.exception.code, "ROLLOUT_RESTRICTED")

    def test_scope_denial_and_admin_identity_do_not_expand_pat(self) -> None:
        principal = self._principal(["account:read"])
        with self.assertRaises(ProductActionError) as denied:
            invoke(
                self.db,
                principal=principal,
                action_id="feedback.submit",
                raw_input={"category": "bug", "subject": "测试反馈", "content": "这是测试反馈内容"},
                request_id="scope-test",
                idempotency_key="scope-test",
                confirmation_id=None,
            )
        self.assertEqual(denied.exception.code, "SCOPE_DENIED")
        self.assertTrue(self.user.is_admin)

    def test_idempotent_invoke_conflict_and_cross_user_isolation(self) -> None:
        principal = self._principal(["account:read"])
        first, run, replayed = invoke(
            self.db,
            principal=principal,
            action_id="account.me",
            raw_input={},
            request_id="request-one",
            idempotency_key="same-key",
            confirmation_id=None,
        )
        self.assertFalse(replayed)
        self.assertEqual(first.status, "succeeded")
        replay, replay_run, replayed = invoke(
            self.db,
            principal=principal,
            action_id="account.me",
            raw_input={},
            request_id="request-two",
            idempotency_key="same-key",
            confirmation_id=None,
        )
        self.assertTrue(replayed)
        self.assertEqual(replay_run.id, run.id)
        self.assertEqual(replay.meta["idempotent_replay"], True)
        self.assertIsNone(get_run(self.db, run_id=run.id, user_id=self.other.id))

        with self.assertRaises(ProductActionError) as conflict:
            # Reuse the same tuple directly to exercise payload conflict even
            # though account.me itself has no allowed input fields.
            record = self.db.query(ProductActionIdempotency).filter_by(run_id=run.id).one()
            record.input_hash = "another-input"
            self.db.commit()
            invoke(
                self.db,
                principal=principal,
                action_id="account.me",
                raw_input={},
                request_id="request-three",
                idempotency_key="same-key",
                confirmation_id=None,
            )
        self.assertEqual(conflict.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_confirmation_is_bound_single_use_and_replay_safe(self) -> None:
        principal = self._principal(["account:read"])
        digest = normalized_input_hash({"resource_id": "owned"})
        confirmation = create_confirmation(
            self.db,
            principal=principal,
            action_id="test.destructive",
            input_hash=digest,
        )
        approve_confirmation(self.db, user_id=self.user.id, confirmation_id=confirmation.id)
        definition = ProductActionDefinition(
            id="test.destructive",
            title="测试",
            description="测试一次确认",
            scopes=("account:read",),
            handler_name="account_me",
            confirmation_required=True,
        )
        consume_confirmation(
            self.db,
            principal=principal,
            confirmation_id=confirmation.id,
            definition=definition,
            input_hash=digest,
        )
        with self.assertRaises(ProductActionError) as replay:
            consume_confirmation(
                self.db,
                principal=principal,
                confirmation_id=confirmation.id,
                definition=definition,
                input_hash=digest,
            )
        self.assertEqual(replay.exception.code, "CONFIRMATION_REPLAYED")

    def test_library_remove_many_is_confirmed_scoped_atomic_and_idempotent(self) -> None:
        principal = self._principal(["library:write"])
        owned_note = Note(
            user_id=self.user.id,
            video_id="douyin-owned-1",
            video_title="待删除资料",
            video_url="https://www.douyin.com/video/douyin-owned-1",
            ai_summary=json.dumps({"source_meta": {"platform": "douyin"}}),
            seo_title="待删除资料",
            seo_slug=f"remove-many-{uuid.uuid4().hex}",
            seo_meta="测试",
        )
        foreign_note = Note(
            user_id=self.other.id,
            video_id="douyin-foreign-1",
            video_title="其他用户资料",
            video_url="https://www.douyin.com/video/douyin-foreign-1",
            ai_summary=json.dumps({"source_meta": {"platform": "douyin"}}),
            seo_title="其他用户资料",
            seo_slug=f"foreign-{uuid.uuid4().hex}",
            seo_meta="测试",
        )
        source = CreatorSource(
            user_id=self.user.id,
            platform="douyin",
            creator_id="creator-owned",
            profile_url="https://www.douyin.com/user/creator-owned",
            display_name="测试博主",
        )
        self.db.add_all([owned_note, foreign_note, source])
        self.db.flush()
        source_item = CreatorSourceItem(
            user_id=self.user.id,
            source_id=source.id,
            note_id=owned_note.id,
            platform="douyin",
            external_id=owned_note.video_id,
            source_url=owned_note.video_url,
            title=owned_note.video_title,
            state="ready",
        )
        self.db.add(source_item)
        self.db.commit()

        missing_id = str(uuid.uuid4())
        payload = {
            "note_ids": [owned_note.id, foreign_note.id, missing_id],
        }
        with self.assertRaises(ProductActionError) as required:
            invoke(
                self.db,
                principal=principal,
                action_id="library.remove_many",
                raw_input=payload,
                request_id="remove-many-confirmation",
                idempotency_key="remove-many-once",
                confirmation_id=None,
            )
        self.assertEqual(required.exception.code, "CONFIRMATION_REQUIRED")
        self.assertIsNotNone(self.db.get(Note, owned_note.id))
        confirmation_id = required.exception.details["confirmation_id"]
        approve_confirmation(
            self.db,
            user_id=self.user.id,
            confirmation_id=confirmation_id,
        )

        envelope, run, replayed = invoke(
            self.db,
            principal=principal,
            action_id="library.remove_many",
            raw_input=payload,
            request_id="remove-many-execute",
            idempotency_key="remove-many-once",
            confirmation_id=confirmation_id,
        )
        self.assertFalse(replayed)
        self.assertEqual(envelope.status, "succeeded")
        result = envelope.data["result"]
        self.assertEqual(result["deleted_ids"], [owned_note.id])
        self.assertEqual(result["missing_ids"], [foreign_note.id, missing_id])
        self.assertIsNone(self.db.get(Note, owned_note.id))
        self.assertIsNotNone(self.db.get(Note, foreign_note.id))
        hidden = self.db.query(LibraryHiddenItem).filter_by(
            user_id=self.user.id,
            aweme_id="douyin-owned-1",
        ).one()
        self.assertEqual(hidden.hide_mode, "permanent")
        self.db.refresh(source_item)
        self.assertEqual(source_item.state, "removed")
        self.assertIsNone(source_item.note_id)

        replay, replay_run, replayed = invoke(
            self.db,
            principal=principal,
            action_id="library.remove_many",
            raw_input=payload,
            request_id="remove-many-replay",
            idempotency_key="remove-many-once",
            confirmation_id=None,
        )
        self.assertTrue(replayed)
        self.assertEqual(replay_run.id, run.id)
        self.assertTrue(replay.meta["idempotent_replay"])

        with self.assertRaises(ProductActionError) as confirmation_replay:
            invoke(
                self.db,
                principal=principal,
                action_id="library.remove_many",
                raw_input=payload,
                request_id="remove-many-confirmation-replay",
                idempotency_key="remove-many-second-key",
                confirmation_id=confirmation_id,
            )
        self.assertEqual(confirmation_replay.exception.code, "CONFIRMATION_REPLAYED")

    def test_billable_analysis_confirm_cannot_bypass_user_confirmation(self) -> None:
        principal = self._principal(["analysis:run"])
        with self.assertRaises(ProductActionError) as required:
            invoke(
                self.db,
                principal=principal,
                action_id="analysis.run.confirm",
                raw_input={"run_id": "analysis-run-id"},
                request_id="analysis-confirm",
                idempotency_key="analysis-confirm-key",
                confirmation_id=None,
            )
        self.assertEqual(required.exception.code, "CONFIRMATION_REQUIRED")
        confirmation_id = required.exception.details.get("confirmation_id")
        self.assertTrue(confirmation_id)
        row = self.db.query(ProductActionConfirmation).filter_by(
            id=confirmation_id
        ).one()
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.action_id, "analysis.run.confirm")
        self.assertEqual(self.db.query(ProductActionRun).count(), 0)

    def test_events_have_one_terminal_and_queued_run_can_cancel(self) -> None:
        run = ProductActionRun(
            request_id="events",
            user_id=self.user.id,
            action_id="account.me",
            action_version="1.0.0",
            run_type="long_task",
            execution_location="cloud",
            status="queued",
            input_json="{}",
            input_hash=normalized_input_hash({}),
        )
        self.db.add(run)
        self.db.commit()
        first = append_event(
            self.db, run=run, event_type="run.succeeded", status="succeeded", terminal=True
        )
        second = append_event(
            self.db, run=run, event_type="run.failed", status="failed", terminal=True
        )
        self.assertEqual(first.id, second.id)
        self.assertEqual(
            self.db.query(ProductActionEvent).filter_by(run_id=run.id, terminal=True).count(), 1
        )

        cancel_run = ProductActionRun(
            request_id="cancel",
            user_id=self.user.id,
            action_id="test.long",
            action_version="1.0.0",
            run_type="long_task",
            execution_location="cloud",
            status="queued",
            input_json="{}",
            input_hash=normalized_input_hash({}),
        )
        self.db.add(cancel_run)
        self.db.commit()
        request_cancel(self.db, run=cancel_run)
        self.assertEqual(cancel_run.status, "canceled")

    def test_run_lease_heartbeat_and_state_transition_guards(self) -> None:
        run = ProductActionRun(
            request_id="lease",
            user_id=self.user.id,
            action_id="test.long",
            action_version="1.0.0",
            run_type="long_task",
            execution_location="cloud",
            status="queued",
            input_json="{}",
            input_hash=normalized_input_hash({}),
        )
        self.db.add(run)
        self.db.commit()

        claimed = claim_run(self.db, run_id=run.id)
        self.assertIsNotNone(claimed)
        claimed_run, lease_token = claimed or (None, "")
        assert claimed_run is not None
        self.assertEqual(claimed_run.status, "running")
        self.assertTrue(heartbeat_run(self.db, run_id=run.id, lease_token=lease_token))
        self.assertFalse(heartbeat_run(self.db, run_id=run.id, lease_token="stale-worker"))

        with self.assertRaises(ProductActionError) as stale_worker:
            transition_run(
                self.db,
                run=claimed_run,
                status="succeeded",
                message="不应提交",
                data={"ok": False},
                lease_token="stale-worker",
            )
        self.assertEqual(stale_worker.exception.code, "RUN_LEASE_LOST")

        succeeded = transition_run(
            self.db,
            run=claimed_run,
            status="succeeded",
            message="处理完成",
            data={"ok": True},
            lease_token=lease_token,
        )
        self.assertEqual(succeeded.status, "succeeded")
        self.assertIsNone(succeeded.lease_token)
        self.assertEqual(
            self.db.query(ProductActionEvent).filter_by(run_id=run.id, terminal=True).count(),
            1,
        )

        with self.assertRaises(ProductActionError) as illegal:
            transition_run(
                self.db,
                run=succeeded,
                status="running",
                message="不允许从终态恢复",
            )
        self.assertEqual(illegal.exception.code, "INVALID_RUN_TRANSITION")

    def test_creator_sync_projects_progress_and_one_terminal_event(self) -> None:
        source = CreatorSource(
            user_id=self.user.id,
            platform="douyin",
            creator_id="creator-external",
            profile_url="https://www.douyin.com/user/test",
            display_name="测试博主",
        )
        self.db.add(source)
        self.db.flush()
        external = CreatorSyncRun(
            user_id=self.user.id,
            source_id=source.id,
            platform="douyin",
            status="queued",
            operation="recent_transcript",
            requested_limit=20,
        )
        public = ProductActionRun(
            request_id="creator-project",
            user_id=self.user.id,
            action_id="creator.sync.start",
            action_version="1.0.0",
            run_type="long_task",
            execution_location="cloud",
            status="queued",
            input_json="{}",
            input_hash=normalized_input_hash({}),
            external_type="creator_sync",
        )
        self.db.add_all([external, public])
        self.db.flush()
        public.external_id = external.id
        self.db.commit()

        external.status = "transcribing"
        external.processed_count = 2
        external.checked_count = 2
        self.db.commit()
        reconcile_external_run(self.db, public)
        self.assertEqual(public.status, "running")
        self.assertEqual(public.external_event_cursor, 2)

        external.status = "succeeded"
        external.processed_count = 3
        external.checked_count = 3
        external.new_count = 3
        self.db.commit()
        reconcile_external_run(self.db, public)
        self.assertEqual(public.status, "succeeded")
        self.assertEqual(
            self.db.query(ProductActionEvent).filter_by(run_id=public.id, terminal=True).count(),
            1,
        )

    def test_video_analysis_projects_progress_billing_result_and_one_terminal(self) -> None:
        public = ProductActionRun(
            request_id="analysis-project",
            user_id=self.user.id,
            action_id="analysis.run.confirm",
            action_version="1.0.0",
            run_type="long_task",
            execution_location="cloud",
            status="queued",
            input_json="{}",
            input_hash=normalized_input_hash({}),
            external_type="video_analysis",
            external_id="external-analysis",
        )
        self.db.add(public)
        self.db.commit()
        external = SimpleNamespace(
            id="external-analysis", status="running",
            error_code="", error_detail="",
        )
        serialized = {
            "id": external.id,
            "status": "running",
            "progress": 35,
            "current_stage": "analyzing_visuals",
            "completed_count": 0,
            "failed_count": 0,
            "actual_points": 0,
            "reserved_points": 120,
        }
        with (
            patch(
                "app.services.product_action_run_service.video_analysis_service.get_run",
                return_value=external,
            ),
            patch(
                "app.services.product_action_run_service.video_analysis_service._run_items",
                return_value=[],
            ),
            patch(
                "app.services.product_action_run_service.video_analysis_service.serialize_run",
                side_effect=lambda _run, items: dict(serialized),
            ),
        ):
            reconcile_external_run(self.db, public)
            self.assertEqual(public.status, "running")
            self.assertEqual(public.external_event_cursor, 35_000)

            external.status = "succeeded"
            serialized.update({
                "status": "succeeded", "progress": 100,
                "completed_count": 1, "actual_points": 80,
                "reserved_points": 80,
            })
            reconcile_external_run(self.db, public)
            self.assertEqual(public.status, "succeeded")
            self.assertEqual(public.output["run"]["actual_points"], 80)
            self.assertEqual(
                self.db.query(ProductActionEvent).filter_by(
                    run_id=public.id, terminal=True
                ).count(),
                1,
            )
            reconcile_external_run(self.db, public)
            self.assertEqual(
                self.db.query(ProductActionEvent).filter_by(
                    run_id=public.id, terminal=True
                ).count(),
                1,
            )
        reconcile_external_run(self.db, public)
        self.assertEqual(
            self.db.query(ProductActionEvent).filter_by(run_id=public.id, terminal=True).count(),
            1,
        )

    def test_database_rate_limit_and_secret_redaction(self) -> None:
        principal = self._principal(["account:read"])
        definition = ProductActionDefinition(
            id="test.rate",
            title="限流测试",
            description="测试",
            scopes=("account:read",),
            handler_name="account_me",
            rate_limit_per_minute=1,
        )
        consume_rate_limit(self.db, principal=principal, definition=definition)
        with self.assertRaises(ProductActionError) as limited:
            consume_rate_limit(self.db, principal=principal, definition=definition)
        self.assertEqual(limited.exception.code, "RATE_LIMITED")
        redacted = redact_secrets({
            "api_key": "secret", "cookie": "session", "nested": {"refresh_token": "raw"},
            "title": "safe",
        })
        self.assertEqual(redacted["api_key"], "[REDACTED]")
        self.assertEqual(redacted["nested"]["refresh_token"], "[REDACTED]")
        self.assertEqual(redacted["title"], "safe")

    def test_registry_schema_validation_covers_nested_arrays_limits_and_patterns(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 2,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "pattern": "^[a-z0-9_-]+$",
                                "maxLength": 12,
                            },
                            "rank": {"type": "integer", "minimum": 0, "maximum": 9},
                        },
                        "required": ["id", "rank"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        }
        valid = {"items": [{"id": "video_1", "rank": 0}]}
        self.assertEqual(_validate_input(schema, valid), valid)
        for invalid in (
            {"items": []},
            {"items": [{"id": "BAD!", "rank": 0}]},
            {"items": [{"id": "video_1", "rank": 10}]},
            {"items": [{"id": "video_1", "rank": 1, "secret": "x"}]},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ProductActionError) as raised:
                _validate_input(schema, invalid)
            self.assertEqual(raised.exception.code, "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
