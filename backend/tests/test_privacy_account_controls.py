from __future__ import annotations

import io
import json
import unittest
import zipfile

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.admin_audit_log import AdminAuditLog
from app.models.application_error_log import ApplicationErrorLog
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.operational_alert import OperationalAlert
from app.models.plan import Plan
from app.models.privacy_account import (
    AccountActionGrant,
    AccountPrivacyAuditEvent,
    UserLegalConsent,
)
from app.models.user import User
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.models.video_analysis import AnalysisCreditLedger
from app.services import privacy_account_service
from app.main import _migrate_admin_audit_logs


class PrivacyAccountControlTests(unittest.TestCase):
    def test_apple_client_identity_is_preserved(self) -> None:
        for client_type in ("macos", "ios"):
            self.assertEqual(privacy_account_service.normalize_client_type(client_type), client_type)
        self.assertEqual(privacy_account_service.normalize_client_type("unknown"), "web")

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
                AdminAuditLog.__table__,
                Note.__table__,
                Plan.__table__,
                AgentThread.__table__,
                AgentMessage.__table__,
                KnowledgeEntry.__table__,
                UserAIProviderConfig.__table__,
                UserLegalConsent.__table__,
                AccountActionGrant.__table__,
                AccountPrivacyAuditEvent.__table__,
                ApplicationErrorLog.__table__,
                OperationalAlert.__table__,
            ],
        )
        # This focused test needs the immutable ledger but not the full visual
        # analysis graph.  Create the same columns without unrelated FKs so the
        # account-deletion assertions stay isolated and deterministic.
        with self.engine.begin() as connection:
            connection.exec_driver_sql("""
                CREATE TABLE analysis_credit_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT,
                    run_id TEXT,
                    item_id TEXT,
                    entry_type TEXT NOT NULL,
                    available_delta INTEGER NOT NULL DEFAULT 0,
                    reserved_delta INTEGER NOT NULL DEFAULT 0,
                    available_after INTEGER NOT NULL DEFAULT 0,
                    reserved_after INTEGER NOT NULL DEFAULT 0,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    reason TEXT NOT NULL DEFAULT '',
                    admin_user_id TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at DATETIME NOT NULL
                )
            """)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _register(self, email: str = "privacy@example.com") -> User:
        user, error = privacy_account_service.register_with_consent(
            self.db,
            email=email,
            password="secret-123",
            username=email.split("@")[0],
            accepted_terms=True,
            accepted_privacy=True,
            terms_version=privacy_account_service.TERMS_VERSION,
            privacy_version=privacy_account_service.PRIVACY_VERSION,
            client_type="android",
        )
        self.assertIsNone(error)
        self.assertIsNotNone(user)
        return user

    def test_registration_requires_current_explicit_consent(self) -> None:
        user, error = privacy_account_service.register_with_consent(
            self.db,
            email="no-consent@example.com",
            password="secret-123",
            username="no-consent",
            accepted_terms=False,
            accepted_privacy=True,
            terms_version=privacy_account_service.TERMS_VERSION,
            privacy_version=privacy_account_service.PRIVACY_VERSION,
            client_type="web",
        )
        self.assertIsNone(user)
        self.assertIn("同意", error or "")
        self.assertEqual(self.db.query(User).count(), 0)

        user, error = privacy_account_service.register_with_consent(
            self.db,
            email="old-version@example.com",
            password="secret-123",
            username="old-version",
            accepted_terms=True,
            accepted_privacy=True,
            terms_version="old",
            privacy_version=privacy_account_service.PRIVACY_VERSION,
            client_type="web",
        )
        self.assertIsNone(user)
        self.assertIn("版本", error or "")
        self.assertEqual(self.db.query(User).count(), 0)

    def test_registration_persists_two_versioned_consent_rows(self) -> None:
        user = self._register()
        rows = self.db.query(UserLegalConsent).filter_by(user_id=user.id).all()
        self.assertEqual({row.document_type for row in rows}, {"terms", "privacy"})
        self.assertEqual({row.client_type for row in rows}, {"android"})
        self.assertEqual(
            {row.document_type: row.document_version for row in rows},
            {
                "terms": privacy_account_service.TERMS_VERSION,
                "privacy": privacy_account_service.PRIVACY_VERSION,
            },
        )

    def test_export_is_password_reverified_and_redacts_secrets(self) -> None:
        user = self._register()
        self.db.add(Note(
            user_id=user.id,
            video_id="video-1",
            video_title="安全导出测试",
            video_url="https://www.bilibili.com/video/BV-test",
            transcript_raw="这是完整文稿。",
            ai_summary=json.dumps({
                "conclusion": "结论",
                "source_meta": {
                    "source_url": "https://www.bilibili.com/video/BV-test",
                    "media_url": "https://signed.example.com/temp.mp4",
                    "server_path": "/srv/private/video.mp4",
                    "client_ip": "198.51.100.42",
                    "traceback": "internal stack must not leave the server",
                    "trace_id": "trace-private-1",
                },
            }),
            card_type="general",
            seo_title="安全导出测试",
            seo_slug="privacy-export-test",
            seo_meta="安全导出",
            pitfall_rating=3,
        ))
        self.db.add(UserAIProviderConfig(
            user_id=user.id,
            mode="custom",
            provider_name="Private Provider",
            model="private-model",
            api_base="https://api.example.com/v1",
            encrypted_api_key="ENC:must-not-export",
            enabled=True,
        ))
        self.db.commit()

        with self.assertRaises(privacy_account_service.AccountPasswordError):
            privacy_account_service.build_personal_data_archive(
                self.db,
                user=user,
                password="wrong",
                client_type="web",
            )

        archive_bytes, filename = privacy_account_service.build_personal_data_archive(
            self.db,
            user=user,
            password="secret-123",
            client_type="web",
        )
        self.assertTrue(filename.endswith(".zip"))
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            payload = archive.read("data.json").decode("utf-8")
            manifest = json.loads(archive.read("manifest.json"))
        self.assertIn("这是完整文稿", payload)
        self.assertIn("https://www.bilibili.com/video/BV-test", payload)
        self.assertNotIn("must-not-export", payload)
        self.assertNotIn("signed.example.com", payload)
        self.assertNotIn("/srv/private", payload)
        self.assertNotIn("198.51.100.42", payload)
        self.assertNotIn("internal stack", payload)
        self.assertNotIn("trace-private-1", payload)
        self.assertNotIn(user.hashed_password, payload)
        self.assertEqual(manifest["data_sha256"], __import__("hashlib").sha256(payload.encode()).hexdigest())

    def test_delete_requires_password_then_one_time_phrase_and_cleans_data(self) -> None:
        user = self._register()
        # Keep another enabled administrator so this test exercises ordinary
        # admin self-service deletion without violating the last-admin guard.
        self.db.add(User(
            email="backup-admin@example.com",
            username="backup-admin",
            hashed_password="not-used",
            is_active=True,
            is_admin=True,
        ))
        self.db.commit()
        note = Note(
            user_id=user.id,
            video_id="video-delete",
            video_title="待删除资料",
            video_url="https://example.com/source",
            transcript_raw="待删除文稿",
            ai_summary="{}",
            card_type="general",
            seo_title="待删除资料",
            seo_slug="privacy-delete-test",
            seo_meta="待删除",
            pitfall_rating=3,
        )
        thread = AgentThread(
            user_id=user.id,
            title="待删除对话",
            scope_type="all",
            scope_label="全部资料",
            source_ids_json="[]",
        )
        self.db.add_all([note, thread])
        self.db.flush()
        self.db.add(AgentMessage(
            thread_id=thread.id,
            user_id=user.id,
            role="user",
            content="待删除问题",
        ))
        self.db.add(KnowledgeEntry(
            user_id=user.id,
            title="待删除知识",
            content="待删除内容",
        ))
        self.db.add(AnalysisCreditLedger(
            user_id=user.id,
            admin_user_id=user.id,
            entry_type="grant",
            available_delta=10,
            available_after=10,
            idempotency_key="privacy-delete-ledger",
        ))
        self.db.add(ApplicationErrorLog(
            source="account-test",
            severity="warning",
            error_type="ExpectedTestEvent",
            message="审计保留记录",
            user_id=user.id,
        ))
        self.db.add(OperationalAlert(
            fingerprint="privacy-delete-alert",
            category="account-test",
            severity="warning",
            title="审计保留记录",
            message="只保留无身份关联的运维事实",
            acknowledged_by=user.id,
        ))
        self.db.add(AdminAuditLog(
            admin_user_id=user.id,
            action="privacy-delete-audit-retention",
            target_type="user",
            target_id=user.id,
            detail=json.dumps({"subject_user_id": user.id}),
            ip="127.0.0.1",
        ))
        self.db.commit()

        with self.assertRaises(privacy_account_service.AccountPasswordError):
            privacy_account_service.prepare_account_deletion(
                self.db,
                user=user,
                password="wrong",
                client_type="windows",
            )
        self.assertEqual(self.db.query(AccountActionGrant).count(), 0)

        prepared = privacy_account_service.prepare_account_deletion(
            self.db,
            user=user,
            password="secret-123",
            client_type="windows",
        )
        with self.assertRaises(privacy_account_service.AccountGrantError):
            privacy_account_service.confirm_account_deletion(
                self.db,
                user=user,
                confirmation_token=prepared["confirmation_token"],
                confirmation_phrase="删除",
            )
        self.assertIsNotNone(self.db.get(User, user.id))

        result = privacy_account_service.confirm_account_deletion(
            self.db,
            user=user,
            confirmation_token=prepared["confirmation_token"],
            confirmation_phrase=prepared["confirmation_phrase"],
        )
        self.assertTrue(result["deleted"])
        self.assertIsNone(self.db.get(User, user.id))
        self.assertEqual(self.db.query(Note).count(), 0)
        self.assertEqual(self.db.query(AgentThread).count(), 0)
        self.assertEqual(self.db.query(AgentMessage).count(), 0)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 0)
        ledger = self.db.query(AnalysisCreditLedger).one()
        self.assertIsNone(ledger.user_id)
        self.assertIsNone(ledger.admin_user_id)
        error_log = self.db.query(ApplicationErrorLog).one()
        self.assertIsNone(error_log.user_id)
        operational_alert = self.db.query(OperationalAlert).one()
        self.assertIsNone(operational_alert.acknowledged_by)
        admin_audit = self.db.query(AdminAuditLog).one()
        self.assertIsNone(admin_audit.admin_user_id)
        self.assertIsNone(admin_audit.target_id)
        self.assertIsNone(admin_audit.detail)
        self.assertIsNone(admin_audit.ip)
        self.assertEqual(admin_audit.action, "privacy-delete-audit-retention")
        audit = self.db.query(AccountPrivacyAuditEvent).filter_by(action="account_deleted").one()
        self.assertNotIn(user.id, audit.subject_reference)
        self.assertNotIn(user.id, audit.detail_json or "")

    def test_last_active_admin_cannot_delete_own_account(self) -> None:
        user = self._register("last-admin@example.com")
        with self.assertRaises(privacy_account_service.LastActiveAdminError):
            privacy_account_service.prepare_account_deletion(
                self.db,
                user=user,
                password="secret-123",
                client_type="web",
            )
        self.assertEqual(self.db.query(AccountActionGrant).count(), 0)
        self.assertIsNotNone(self.db.get(User, user.id))

    def test_legacy_sqlite_admin_audit_subject_is_migrated_nullable(self) -> None:
        legacy_engine = create_engine("sqlite://")

        @event.listens_for(legacy_engine, "connect")
        def _legacy_foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        User.__table__.create(legacy_engine)
        with legacy_engine.begin() as connection:
            connection.execute(text("""
                CREATE TABLE admin_audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_user_id VARCHAR(64) NOT NULL REFERENCES users(id),
                    action VARCHAR(64) NOT NULL,
                    target_type VARCHAR(32),
                    target_id VARCHAR(64),
                    detail TEXT,
                    ip VARCHAR(64),
                    created_at DATETIME NOT NULL
                )
            """))
            connection.execute(text("""
                INSERT INTO users (
                    id, email, username, hashed_password, is_active, is_admin,
                    email_verified, created_at, updated_at
                ) VALUES (
                    'legacy-admin', 'legacy@example.com', 'legacy', 'hash',
                    1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """))
            connection.execute(text("""
                INSERT INTO admin_audit_logs (
                    admin_user_id, action, created_at
                ) VALUES ('legacy-admin', 'legacy-action', CURRENT_TIMESTAMP)
            """))

        with legacy_engine.begin() as connection:
            _migrate_admin_audit_logs(
                connection,
                inspect(legacy_engine),
                "sqlite",
            )

        migrated = {
            column["name"]: column
            for column in inspect(legacy_engine).get_columns("admin_audit_logs")
        }
        self.assertTrue(migrated["admin_user_id"]["nullable"])
        with legacy_engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id = 'legacy-admin'"))
            retained = connection.execute(text(
                "SELECT admin_user_id, action FROM admin_audit_logs"
            )).one()
        self.assertIsNone(retained.admin_user_id)
        self.assertEqual(retained.action, "legacy-action")
        legacy_engine.dispose()


if __name__ == "__main__":
    unittest.main()
