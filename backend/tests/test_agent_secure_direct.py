from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "secure-direct-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "secure-direct-test-pepper-123456789")

from app.api.agent_interface_routes import mcp_router, router as interface_router
from app.api.agent_secure_routes import router as secure_router
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
from app.models.user import User
from app.services.agent_credential_service import AgentPrincipal
from app.services.auth_service import create_access_token
from app.services import video_analysis_catalog_service
from app.services.product_action_registry import registry
from app.services.product_action_run_service import (
    ProductActionError,
    invoke,
    normalized_input_hash,
    require_secure_direct_confirmation,
)


class SecureDirectTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_enabled = settings.AGENT_INTERFACE_ENABLED
        settings.AGENT_INTERFACE_ENABLED = True
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
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
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            user = User(
                email="secure@example.com", username="secure",
                hashed_password="not-used", is_active=True, is_admin=False,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            self.user_id = user.id
            self.jwt = create_access_token(user.id, user.email)

        app = FastAPI()
        app.include_router(interface_router)
        app.include_router(secure_router)
        app.include_router(mcp_router)

        def override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(app, raise_server_exceptions=False)
        credential = self.client.post(
            "/api/agent-interface/v1/credentials/pat",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={
                "name": "secure-direct-tests",
                "scopes": ["account:manage", "models:write"],
                "expires_in_days": 1,
            },
        )
        self.assertEqual(credential.status_code, 200, credential.text)
        self.agent_token = credential.json()["data"]["token"]

    def tearDown(self) -> None:
        settings.AGENT_INTERFACE_ENABLED = self.previous_enabled
        self.engine.dispose()

    def _approve_confirmation(self, confirmation_id: str) -> None:
        response = self.client.post(
            f"/api/agent-interface/v1/confirmations/{confirmation_id}/approve",
            headers={"Authorization": f"Bearer {self.jwt}"},
            json={"approve": True},
        )
        self.assertEqual(response.status_code, 200, response.text)

    def _assert_confirmation_required(
        self,
        path: str,
        metadata: dict,
        *,
        action_id: str,
    ) -> str:
        response = self.client.post(
            path,
            headers={"Authorization": f"Bearer {self.agent_token}"},
            json=metadata,
        )
        self.assertEqual(response.status_code, 409, response.text)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "CONFIRMATION_REQUIRED")
        confirmation_id = payload["error"]["details"]["confirmation_id"]
        with self.Session() as db:
            row = db.query(ProductActionConfirmation).filter(
                ProductActionConfirmation.id == confirmation_id,
            ).one()
            self.assertEqual(row.action_id, action_id)
            self.assertEqual(row.input_hash, normalized_input_hash(metadata))
            self.assertEqual(row.status, "pending")
            self.assertIsNone(row.used_at)
            self.assertEqual(db.query(ProductActionRun).count(), 0)
        return confirmation_id

    def test_secure_descriptors_have_no_secret_schema_and_never_enter_mcp(self) -> None:
        secure_ids = {
            "account.data.export", "account.delete",
            "models.custom.create", "models.secret.update",
        }
        for action_id in secure_ids:
            definition = registry.get(action_id)
            self.assertIsNotNone(definition)
            assert definition is not None
            self.assertTrue(definition.available)
            self.assertTrue(definition.secure_direct)
            self.assertFalse(definition.mcp_exposed)
            if action_id in {"models.custom.create", "models.secret.update"}:
                self.assertTrue(definition.confirmation_required)
                self.assertTrue({
                    "CONFIRMATION_REQUIRED", "CONFIRMATION_MISMATCH",
                    "CONFIRMATION_REPLAYED",
                }.issubset(definition.error_codes))
            schema_text = str(definition.input_schema).lower()
            for marker in ("password", "api_key", "confirmation_phrase", "confirmation_token"):
                self.assertNotIn(marker, schema_text)

        response = self.client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {self.agent_token}"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        self.assertEqual(response.status_code, 200, response.text)
        names = {item["name"] for item in response.json()["result"]["tools"]}
        self.assertTrue(secure_ids.isdisjoint(names))

    def test_generic_invoke_rejects_before_persisting_secret_input(self) -> None:
        with self.Session() as db:
            user = db.query(User).filter(User.id == self.user_id).one()
            principal = AgentPrincipal(
                user=user, credential=None,
                scopes=frozenset({"account:manage"}), auth_type="browser_session",
            )
            with self.assertRaises(ProductActionError) as caught:
                invoke(
                    db,
                    principal=principal,
                    action_id="account.data.export",
                    raw_input={"password": "must-never-persist"},
                    request_id="secure-reject",
                    idempotency_key=None,
                    confirmation_id=None,
                )
            self.assertEqual(caught.exception.code, "SECURE_TRANSPORT_REQUIRED")
            self.assertEqual(db.query(ProductActionRun).count(), 0)
            self.assertNotIn("must-never-persist", str(db.query(ProductActionAudit).all()))

    def test_confirmation_helper_rejects_secret_fields_before_hashing(self) -> None:
        with self.Session() as db:
            user = db.query(User).filter(User.id == self.user_id).one()
            principal = AgentPrincipal(
                user=user, credential=None,
                scopes=frozenset({"models:write"}), auth_type="browser_session",
            )
            definition = registry.get("models.secret.update")
            assert definition is not None
            with self.assertRaises(ProductActionError) as caught:
                require_secure_direct_confirmation(
                    db,
                    principal=principal,
                    definition=definition,
                    normalized_input={
                        "target": "chat",
                        "model_id": "model-1",
                        "api_key": "must-never-hash",
                    },
                    confirmation_id=None,
                )
            self.assertEqual(caught.exception.code, "INVALID_INPUT")
            self.assertEqual(db.query(ProductActionConfirmation).count(), 0)

    def test_model_secret_is_rejected_until_confirmation_has_been_requested(self) -> None:
        with patch("app.api.agent_secure_routes._require_encrypted_secret_storage"):
            response = self.client.post(
                "/api/agent-interface/v1/secure/models/secret",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    "target": "chat",
                    "model_id": "model-1",
                    "api_key": "sk-too-early",
                },
            )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
        self.assertNotIn("sk-too-early", response.text)
        with self.Session() as db:
            self.assertEqual(db.query(ProductActionConfirmation).count(), 0)
            self.assertEqual(db.query(ProductActionRun).count(), 0)
            self.assertTrue(all(
                "sk-too-early" not in audit.metadata_json
                for audit in db.query(ProductActionAudit).all()
            ))

    def test_secure_export_streams_bytes_and_is_hidden_from_openapi(self) -> None:
        with patch(
            "app.api.agent_secure_routes.privacy_account_service.build_personal_data_archive",
            return_value=(b"PK\x03\x04safe-archive", "personal.zip"),
        ) as build:
            response = self.client.post(
                "/api/agent-interface/v1/secure/account/data-export",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={"password": "private-password"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"PK\x03\x04safe-archive")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(build.call_args.kwargs["password"], "private-password")
        schema = self.client.get("/openapi.json").json()
        self.assertNotIn(
            "/api/agent-interface/v1/secure/account/data-export",
            schema.get("paths", {}),
        )

    def test_secure_model_update_returns_only_masked_configuration(self) -> None:
        with (
            patch("app.api.agent_secure_routes._require_encrypted_secret_storage"),
            patch(
                "app.api.agent_secure_routes.user_ai_provider_service.update_custom_model",
                return_value={
                    "id": "model-1", "api_key_set": True,
                    "api_key_masked": "sk-••••-last",
                },
            ) as update,
        ):
            metadata = {"target": "chat", "model_id": "model-1"}
            confirmation_id = self._assert_confirmation_required(
                "/api/agent-interface/v1/secure/models/secret",
                metadata,
                action_id="models.secret.update",
            )
            update.assert_not_called()
            self._approve_confirmation(confirmation_id)
            response = self.client.post(
                "/api/agent-interface/v1/secure/models/secret",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    **metadata,
                    "confirmation_id": confirmation_id,
                    "api_key": "sk-raw-private",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        raw = response.text
        self.assertNotIn("sk-raw-private", raw)
        self.assertEqual(update.call_args.kwargs["api_key"], "sk-raw-private")
        with self.Session() as db:
            confirmation = db.query(ProductActionConfirmation).filter(
                ProductActionConfirmation.id == confirmation_id,
            ).one()
            self.assertEqual(confirmation.status, "used")
            self.assertIsNotNone(confirmation.used_at)
            audits = db.query(ProductActionAudit).all()
            self.assertGreaterEqual(len(audits), 2)
            self.assertTrue(all(
                "sk-raw-private" not in audit.metadata_json for audit in audits
            ))

        with patch("app.api.agent_secure_routes._require_encrypted_secret_storage"):
            replay = self.client.post(
                "/api/agent-interface/v1/secure/models/secret",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    **metadata,
                    "confirmation_id": confirmation_id,
                    "api_key": "sk-raw-private",
                },
            )
        self.assertEqual(replay.status_code, 409, replay.text)
        self.assertEqual(replay.json()["error"]["code"], "CONFIRMATION_REPLAYED")
        self.assertEqual(update.call_count, 1)

    def test_secure_custom_model_create_keeps_key_out_of_run_response_and_audit(self) -> None:
        with (
            patch(
                "app.api.agent_secure_routes.video_analysis_catalog_service._validate_public_user_api_base",
                return_value="https://models.example/v1",
            ),
            patch("app.api.agent_secure_routes._require_encrypted_secret_storage"),
            patch(
                "app.api.agent_secure_routes.user_ai_provider_service.create_custom_model",
                return_value={
                    "id": "model-new", "name": "工作模型", "model": "gpt-example",
                    "api_base": "https://models.example/v1", "api_key_set": True,
                    "api_key_masked": "sk-••••-last", "enabled": True,
                    "is_selected": True,
                },
            ) as create,
        ):
            metadata = {
                "name": "工作模型",
                "provider_name": "OpenAI Compatible",
                "model": "gpt-example",
                "api_base": "https://models.example/v1",
                "enabled": True,
                "select": True,
            }
            confirmation_id = self._assert_confirmation_required(
                "/api/agent-interface/v1/secure/models/custom",
                metadata,
                action_id="models.custom.create",
            )
            create.assert_not_called()
            self._approve_confirmation(confirmation_id)
            mismatch = self.client.post(
                "/api/agent-interface/v1/secure/models/custom",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    **metadata,
                    "model": "different-model",
                    "confirmation_id": confirmation_id,
                    "api_key": "sk-new-raw-private",
                },
            )
            self.assertEqual(mismatch.status_code, 409, mismatch.text)
            self.assertEqual(
                mismatch.json()["error"]["code"], "CONFIRMATION_MISMATCH",
            )
            self.assertNotIn("sk-new-raw-private", mismatch.text)
            create.assert_not_called()
            response = self.client.post(
                "/api/agent-interface/v1/secure/models/custom",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    **metadata,
                    "confirmation_id": confirmation_id,
                    "api_key": "sk-new-raw-private",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("sk-new-raw-private", response.text)
        self.assertEqual(create.call_args.kwargs["api_key"], "sk-new-raw-private")
        with self.Session() as db:
            self.assertEqual(db.query(ProductActionRun).count(), 0)
            confirmation = db.query(ProductActionConfirmation).filter(
                ProductActionConfirmation.id == confirmation_id,
            ).one()
            self.assertEqual(confirmation.status, "used")
            self.assertIsNotNone(confirmation.used_at)
            self.assertEqual(confirmation.input_hash, normalized_input_hash(metadata))
            audits = db.query(ProductActionAudit).all()
            self.assertGreaterEqual(len(audits), 2)
            self.assertTrue(all(
                audit.action_id == "models.custom.create" for audit in audits
            ))
            self.assertTrue(all(
                "sk-new-raw-private" not in audit.metadata_json for audit in audits
            ))

    def test_secure_custom_model_create_rejects_local_or_private_api_base(self) -> None:
        with patch(
            "app.api.agent_secure_routes.user_ai_provider_service.create_custom_model",
        ) as create:
            response = self.client.post(
                "/api/agent-interface/v1/secure/models/custom",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    "name": "危险端点",
                    "provider_name": "Local",
                    "model": "local-model",
                    "api_base": "https://127.0.0.1:8443/v1",
                    "api_key": "sk-must-not-be-sent",
                    "enabled": True,
                    "select": False,
                },
            )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "UNSAFE_API_BASE")
        self.assertNotIn("sk-must-not-be-sent", response.text)
        create.assert_not_called()

    def test_secure_model_key_write_refuses_plaintext_storage_fallback(self) -> None:
        error = video_analysis_catalog_service.VideoAnalysisCatalogError(
            "encryption_key_required", "missing", status_code=409,
        )
        metadata = {"target": "chat", "model_id": "model-1"}
        with patch("app.api.agent_secure_routes._require_encrypted_secret_storage"):
            confirmation_id = self._assert_confirmation_required(
                "/api/agent-interface/v1/secure/models/secret",
                metadata,
                action_id="models.secret.update",
            )
        self._approve_confirmation(confirmation_id)
        with (
            patch(
                "app.api.agent_secure_routes.video_analysis_catalog_service._require_secret_encryption",
                side_effect=error,
            ),
            patch(
                "app.api.agent_secure_routes.user_ai_provider_service.update_custom_model",
            ) as update,
        ):
            response = self.client.post(
                "/api/agent-interface/v1/secure/models/secret",
                headers={"Authorization": f"Bearer {self.agent_token}"},
                json={
                    **metadata,
                    "confirmation_id": confirmation_id,
                    "api_key": "sk-raw",
                },
            )
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["error"]["code"], "ENCRYPTION_KEY_REQUIRED")
        self.assertNotIn("sk-raw", response.text)
        update.assert_not_called()
        with self.Session() as db:
            confirmation = db.query(ProductActionConfirmation).filter(
                ProductActionConfirmation.id == confirmation_id,
            ).one()
            self.assertEqual(confirmation.status, "approved")
            self.assertIsNone(confirmation.used_at)


if __name__ == "__main__":
    unittest.main()
