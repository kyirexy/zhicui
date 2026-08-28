from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.rate_limit import RateLimitMiddleware, RatePolicy, SlidingWindowLimiter, limiter
from app.core.security_headers import SecurityHeadersMiddleware
from app.models.application_error_log import ApplicationErrorLog
from app.models.creator_sync import CreatorCatalogQualityRun, CreatorSyncRun
from app.models.operational_alert import OperationalAlert
from app.services import operational_alert_service, readiness_service


class ProductionReadinessTests(unittest.TestCase):
    def test_sliding_window_returns_retry_after_and_expires(self) -> None:
        limiter = SlidingWindowLimiter()
        policy = RatePolicy("login", "POST", "/api/auth/login", 2, 60)
        self.assertEqual(limiter.check(policy, "ip:127.0.0.1", now=100), (True, 0))
        self.assertEqual(limiter.check(policy, "ip:127.0.0.1", now=101), (True, 0))
        allowed, retry_after = limiter.check(policy, "ip:127.0.0.1", now=102)
        self.assertFalse(allowed)
        self.assertEqual(retry_after, 58)
        self.assertEqual(limiter.check(policy, "ip:127.0.0.1", now=161), (True, 0))

    def test_backup_readiness_requires_checksum_restore_and_freshness(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_file = Path(directory) / "latest.json"
            completed_at = datetime.now(timezone.utc).isoformat()
            status_file.write_text(json.dumps({
                "status": "ok",
                "completed_at": completed_at,
                "checksum_verified": True,
                "restore_verified": True,
                "offsite_verified": True,
                "offsite_verified_at": completed_at,
                "offsite_provider": "rclone",
                "recovery_material_verified": True,
            }), encoding="utf-8")
            with patch.object(readiness_service.settings, "DATABASE_URL", "postgresql://example"), patch.object(
                readiness_service.settings, "BACKUP_STATUS_FILE", str(status_file)
            ):
                self.assertEqual(readiness_service._check_backup()["status"], "ready")
                payload = json.loads(status_file.read_text(encoding="utf-8"))
                payload["restore_verified"] = False
                status_file.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(readiness_service._check_backup()["status"], "not_ready")

    def test_stale_backup_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_file = Path(directory) / "latest.json"
            status_file.write_text(json.dumps({
                "status": "ok",
                "completed_at": (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat(),
                "checksum_verified": True,
                "restore_verified": True,
                "offsite_verified": True,
                "offsite_verified_at": datetime.now(timezone.utc).isoformat(),
                "recovery_material_verified": True,
            }), encoding="utf-8")
            with patch.object(readiness_service.settings, "DATABASE_URL", "postgresql://example"), patch.object(
                readiness_service.settings, "BACKUP_STATUS_FILE", str(status_file)
            ), patch.object(readiness_service.settings, "BACKUP_MAX_AGE_HOURS", 36):
                result = readiness_service._check_backup()
            self.assertEqual(result["status"], "not_ready")
            self.assertEqual(result["error_code"], "backup_stale_or_unverified")

    def test_postgres_readiness_fails_closed_without_verified_offsite_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_file = Path(directory) / "latest.json"
            completed_at = datetime.now(timezone.utc).isoformat()
            status_file.write_text(json.dumps({
                "status": "ok",
                "completed_at": completed_at,
                "checksum_verified": True,
                "restore_verified": True,
                "offsite_verified": False,
                "offsite_verified_at": None,
                "recovery_material_verified": False,
            }), encoding="utf-8")
            with patch.object(
                readiness_service.settings, "DATABASE_URL", "postgresql://example"
            ), patch.object(
                readiness_service.settings, "BACKUP_STATUS_FILE", str(status_file)
            ), patch.object(
                readiness_service.settings, "BACKUP_OFFSITE_REQUIRED", True
            ):
                result = readiness_service._check_backup()
            self.assertEqual(result["status"], "not_ready")
            self.assertEqual(result["error_code"], "backup_offsite_unverified")
            self.assertFalse(result["offsite_verified"])

    def test_public_readiness_hides_internal_error_codes(self) -> None:
        summary = readiness_service.public_summary({
            "status": "not_ready",
            "checked_at": "2026-08-28T00:00:00Z",
            "checks": {
                "database": {"status": "not_ready", "error_code": "secret-internal"},
            },
        })
        self.assertEqual(summary["checks"], {"database": {"status": "not_ready"}})
        self.assertNotIn("error_code", summary["checks"]["database"])

    def test_security_headers_are_present_without_breaking_response(self) -> None:
        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)

        @app.get("/ok")
        def ok() -> dict[str, bool]:
            return {"ok": True}

        response = TestClient(app).get("/ok")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")

    def test_auth_account_rate_limit_returns_retry_after(self) -> None:
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware)

        @app.post("/api/auth/login")
        def login() -> dict[str, bool]:
            return {"ok": True}

        limiter.clear()
        with patch("app.core.rate_limit.settings.RATE_LIMIT_ENABLED", True), patch(
            "app.services.error_log_service.record_error_safely"
        ):
            client = TestClient(app)
            responses = [
                client.post("/api/auth/login", json={"email": "same@example.com", "password": "x"})
                for _ in range(7)
            ]
        self.assertEqual([response.status_code for response in responses[:6]], [200] * 6)
        self.assertEqual(responses[6].status_code, 429)
        self.assertGreater(int(responses[6].headers["retry-after"]), 0)

    def test_user_rate_limit_does_not_reset_when_ip_changes(self) -> None:
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware)

        @app.post("/api/agent/threads/test-thread/messages")
        def generate() -> dict[str, bool]:
            return {"ok": True}

        limiter.clear()
        changing_ips = [f"198.51.100.{index}" for index in range(1, 32)]
        with patch("app.core.rate_limit.settings.RATE_LIMIT_ENABLED", True), patch(
            "app.core.rate_limit._user_id", return_value="stable-user"
        ), patch(
            "app.core.rate_limit._safe_ip", side_effect=changing_ips
        ), patch("app.services.error_log_service.record_error_safely"):
            client = TestClient(app)
            responses = [
                client.post("/api/agent/threads/test-thread/messages")
                for _ in range(31)
            ]
        self.assertEqual([response.status_code for response in responses[:30]], [200] * 30)
        self.assertEqual(responses[30].status_code, 429)


class OperationalAlertTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        ApplicationErrorLog.__table__.create(self.engine)
        OperationalAlert.__table__.create(self.engine)
        CreatorSyncRun.__table__.create(self.engine)
        CreatorCatalogQualityRun.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_repeated_errors_create_one_aggregated_alert(self) -> None:
        for _ in range(3):
            self.db.add(ApplicationErrorLog(
                source="llm",
                severity="error",
                error_type="Timeout",
                message="上游超时",
                path="/api/agent/starter-questions",
                status_code=502,
            ))
        self.db.commit()
        with patch.object(readiness_service, "get_readiness", return_value={"checks": {}}):
            result = operational_alert_service.refresh_alerts(self.db)
        rows = self.db.query(OperationalAlert).all()
        self.assertEqual(result["alerts"], 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].category, "application_error")
        self.assertNotIn("上游超时", rows[0].metadata_json)

    def test_acknowledge_records_admin_without_content(self) -> None:
        row = operational_alert_service.upsert_alert(
            self.db,
            category="backup",
            severity="critical",
            title="备份失败",
            message="请检查备份任务",
            identity=("daily",),
        )
        self.assertTrue(operational_alert_service.acknowledge(self.db, row.id, "u-admin"))
        self.db.refresh(row)
        self.assertEqual(row.status, "acknowledged")
        self.assertEqual(row.acknowledged_by, "u-admin")

    def test_recovered_readiness_alert_is_resolved(self) -> None:
        row = operational_alert_service.upsert_alert(
            self.db,
            category="readiness",
            severity="critical",
            title="数据库未就绪",
            message="请检查依赖",
            identity=("database", "database_unavailable"),
        )
        with patch.object(readiness_service, "get_readiness", return_value={
            "checks": {"database": {"status": "ready"}},
        }):
            result = operational_alert_service.refresh_alerts(self.db)
        self.db.refresh(row)
        self.assertEqual(result["resolved"], 1)
        self.assertEqual(row.status, "resolved")

    def test_creator_run_failures_create_safe_acknowledgeable_alerts(self) -> None:
        now = datetime.now(timezone.utc)
        self.db.add_all([
            CreatorSyncRun(
                user_id="private-user",
                source_id="private-source",
                platform="douyin",
                operation="recent_transcript",
                status="failed",
                error_code="media_unavailable",
                error_message="敏感博主和视频标题不得进入告警",
                updated_at=now,
            ),
            CreatorSyncRun(
                user_id="another-private-user",
                source_id="another-private-source",
                platform="bilibili",
                operation="catalog_all",
                status="partial",
                error_code="partial_catalog",
                error_message="另一段用户内容",
                updated_at=now,
            ),
            CreatorSyncRun(
                user_id="action-user",
                source_id="action-source",
                platform="douyin",
                operation="selected_transcript",
                status="succeeded",
                needs_action=True,
                needs_action_code="login_required",
                needs_action_message="用户账号信息不得进入告警",
                updated_at=now,
            ),
            CreatorCatalogQualityRun(
                requested_by_id="private-admin",
                idempotency_key="quality-alert-test",
                mode="backfill",
                platform="bilibili",
                status="failed",
                summary_json=json.dumps({"title": "敏感视频标题"}),
                updated_at=now,
            ),
        ])
        self.db.commit()

        with patch.object(readiness_service, "get_readiness", return_value={"checks": {}}):
            result = operational_alert_service.refresh_alerts(self.db)

        rows = self.db.query(OperationalAlert).order_by(OperationalAlert.category).all()
        self.assertEqual(result["alerts"], 4)
        self.assertEqual(
            {row.category for row in rows},
            {"creator_sync", "creator_catalog_quality"},
        )
        exposed = "\n".join(
            f"{row.title}\n{row.message}\n{row.metadata_json}" for row in rows
        )
        for secret in (
            "private-user", "private-source", "敏感博主", "敏感视频标题",
            "用户账号信息",
        ):
            self.assertNotIn(secret, exposed)

        actionable = next(row for row in rows if row.category == "creator_sync")
        self.assertTrue(
            operational_alert_service.acknowledge(self.db, actionable.id, "ops-admin")
        )
        self.db.refresh(actionable)
        self.assertEqual(actionable.status, "acknowledged")

    def test_creator_alert_resolves_after_recovery_or_expiry(self) -> None:
        run = CreatorSyncRun(
            user_id="user",
            source_id="source",
            platform="douyin",
            operation="recent_transcript",
            status="failed",
            error_code="temporary_failure",
            updated_at=datetime.now(timezone.utc),
        )
        self.db.add(run)
        self.db.commit()
        with patch.object(readiness_service, "get_readiness", return_value={"checks": {}}):
            operational_alert_service.refresh_alerts(self.db)
        row = self.db.query(OperationalAlert).filter_by(category="creator_sync").one()

        run.status = "succeeded"
        self.db.commit()
        with patch.object(readiness_service, "get_readiness", return_value={"checks": {}}):
            result = operational_alert_service.refresh_alerts(self.db)
        self.db.refresh(row)
        self.assertEqual(result["resolved"], 1)
        self.assertEqual(row.status, "resolved")

        run.status = "failed"
        run.updated_at = datetime.now(timezone.utc) - timedelta(hours=25)
        self.db.commit()
        with patch.object(readiness_service, "get_readiness", return_value={"checks": {}}):
            result = operational_alert_service.refresh_alerts(self.db)
        self.db.refresh(row)
        self.assertEqual(result["alerts"], 0)
        self.assertEqual(row.status, "resolved")

    def test_recent_backup_job_failure_alert_resolves_on_success_or_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            latest = state_dir / "latest.json"
            backup_status = state_dir / "last-backup.json"
            restore_status = state_dir / "last-restore-verify.json"
            backup_status.write_text(json.dumps({
                "status": "failed",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "detail": "敏感路径和归档名不得进入告警",
            }), encoding="utf-8")
            restore_status.write_text(json.dumps({
                "status": "success",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }), encoding="utf-8")

            with patch.object(
                operational_alert_service.settings, "BACKUP_STATUS_FILE", str(latest)
            ), patch.object(
                operational_alert_service.settings, "BACKUP_MAX_AGE_HOURS", 36
            ), patch.object(
                readiness_service, "get_readiness", return_value={"checks": {}}
            ):
                result = operational_alert_service.refresh_alerts(self.db)
                row = self.db.query(OperationalAlert).filter_by(category="backup_job").one()
                self.assertEqual(result["alerts"], 1)
                self.assertNotIn("敏感路径", row.metadata_json + row.message)

                backup_status.write_text(json.dumps({
                    "status": "success",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }), encoding="utf-8")
                result = operational_alert_service.refresh_alerts(self.db)
                self.db.refresh(row)
                self.assertEqual(result["resolved"], 1)
                self.assertEqual(row.status, "resolved")

                backup_status.write_text(json.dumps({
                    "status": "failed",
                    "finished_at": (
                        datetime.now(timezone.utc) - timedelta(hours=48)
                    ).isoformat(),
                }), encoding="utf-8")
                result = operational_alert_service.refresh_alerts(self.db)
                self.assertEqual(result["alerts"], 0)

    def test_staged_readiness_fields_create_and_resolve_alert(self) -> None:
        with patch.object(readiness_service, "get_readiness", return_value={
            "checks": {
                "backup": {
                    "readiness": "failed",
                    "reason_code": "restore_verification_failed",
                    "backup_completed_at": "2026-08-28T00:00:00Z",
                    "restore_verified_at": None,
                },
            },
        }):
            result = operational_alert_service.refresh_alerts(self.db)
        row = self.db.query(OperationalAlert).filter_by(category="readiness").one()
        self.assertEqual(result["alerts"], 1)
        self.assertIn("restore_verification_failed", row.metadata_json)

        with patch.object(readiness_service, "get_readiness", return_value={
            "checks": {"backup": {"ready": True}},
        }):
            result = operational_alert_service.refresh_alerts(self.db)
        self.db.refresh(row)
        self.assertEqual(result["resolved"], 1)
        self.assertEqual(row.status, "resolved")


if __name__ == "__main__":
    unittest.main()
