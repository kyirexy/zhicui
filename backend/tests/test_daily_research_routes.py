"""每日研究的真实 HTTP 鉴权和旧数据库升级回归，不访问平台/邮件/模型。"""
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "daily-research-http-test-only-not-production")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.daily_research_routes import router
from app.core.database import Base, get_db
from app.models.agent_automation import AgentAutomation, AgentAutomationRun
from app.models.daily_research import DailyResearchBatch, DailyResearchDevice, DailyResearchRecipient
from app.models.user import User
from app.services.auth_service import create_access_token


class DailyResearchHttpTests(unittest.TestCase):
    def setUp(self):
        # 注册完整模型以验证外键关系，但不启动生产 worker。
        from app import main
        self.main = main
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine)
        with self.factory() as db:
            users = [User(email=f"research-http-{i}@example.com", username=f"research-http-{i}",
                          hashed_password="unused", is_active=True) for i in range(2)]
            db.add_all(users)
            db.commit()
            self.ids = [user.id for user in users]
        self.headers = [{"Authorization": "Bearer " + create_access_token(uid, f"research-http-{i}@example.com")} for i, uid in enumerate(self.ids)]
        app = FastAPI()
        app.include_router(router)
        def database():
            with self.factory() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def create(self):
        result = self.client.post("/api/daily-research/subscriptions", headers=self.headers[0], json={})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()["data"]["id"]

    def test_authentication_and_cross_user_access(self):
        self.assertEqual(self.client.get("/api/daily-research/subscriptions").status_code, 401)
        self.assertEqual(self.client.get("/api/daily-research/subscriptions", headers={"Authorization": "Bearer invalid"}).status_code, 401)
        rule_id = self.create()
        for verb, suffix, body in (("patch", "", {"name": "另一个用户"}), ("delete", "", None), ("post", "/run", {})):
            response = self.client.request(verb, f"/api/daily-research/subscriptions/{rule_id}{suffix}", headers=self.headers[1], json=body)
            self.assertEqual(response.status_code, 404, response.text)
        result = self.client.get("/api/daily-research/subscriptions", headers=self.headers[1]).json()["data"]
        self.assertEqual(result["items"], [])

    def test_http_queue_claim_complete_and_private_lease(self):
        rule_id = self.create()
        path = f"/api/daily-research/subscriptions/{rule_id}/run"
        first = self.client.post(path, headers=self.headers[0]).json()["data"]
        second = self.client.post(path, headers=self.headers[0]).json()["data"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["status"], "queued")
        claim = self.client.post("/api/daily-research/desktop/claim", headers=self.headers[0],
                                 json={"device_id": "http-device", "capabilities_version": 1}).json()["data"]
        identity = {"device_id": "http-device", "run_id": first["id"], "lease_token": claim["lease_token"]}
        self.assertEqual(claim["request"]["source_modes"], ["like", "collect"])
        denied = self.client.post("/api/daily-research/desktop/progress", headers=self.headers[1], json=identity)
        self.assertEqual(denied.status_code, 404)
        sources = [{"platform": "douyin", "source_mode": mode, "coverage": "complete"} for mode in ("like", "collect")]
        result = self.client.post("/api/daily-research/desktop/complete", headers=self.headers[0],
                                  json={**identity, "coverage": "complete", "sources": sources})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["data"]["status"], "preparing")
        self.assertNotIn(claim["lease_token"], result.text)
        late = self.client.post("/api/daily-research/desktop/progress", headers=self.headers[0], json=identity)
        self.assertEqual(late.status_code, 409)

    def test_invalid_platform_and_secret_bearing_metadata_rejected(self):
        response = self.client.post("/api/daily-research/subscriptions", headers=self.headers[0], json={"platforms": ["bilibili"]})
        self.assertEqual(response.status_code, 422)
        response = self.client.post("/api/daily-research/desktop/batch", headers=self.headers[0], json={
            "run_id": "fake", "device_id": "device", "lease_token": "x" * 24,
            "batch_id": "one", "source_mode": "like", "items": [{"video_id": "123456789", "cookie": "do-not-store"}]})
        self.assertEqual(response.status_code, 422)

    def test_legacy_migration_is_repeatable_and_keeps_records(self):
        with self.factory() as db:
            rule = AgentAutomation(user_id=self.ids[0], name="保留旧摘要", instruction="旧规则", recipient_email="old@example.com")
            db.add(rule)
            db.flush()
            run = AgentAutomationRun(user_id=self.ids[0], automation_id=rule.id, idempotency_key="legacy-test", status="completed", result_text="旧报告")
            db.add(run)
            db.commit()
            ids = rule.id, run.id
        with self.engine.begin() as conn:
            for table, column in (("agent_automations", "report_kind"), ("agent_automations", "config_json"),
                                  ("agent_automation_runs", "state_json"), ("agent_automation_runs", "execution_token")):
                conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
        for table in (DailyResearchBatch.__table__, DailyResearchDevice.__table__, DailyResearchRecipient.__table__):
            table.drop(self.engine)
        Base.metadata.create_all(self.engine)
        with patch.object(self.main, "engine", self.engine):
            self.main._migrate_db()
            self.main._migrate_db()
        with self.factory() as db:
            rule, run = db.get(AgentAutomation, ids[0]), db.get(AgentAutomationRun, ids[1])
            self.assertEqual((rule.report_kind, rule.config_json, rule.name), ("digest", "{}", "保留旧摘要"))
            self.assertEqual((run.state_json, run.execution_token, run.result_text), ("{}", None, "旧报告"))
        self.assertTrue(all(inspect(self.engine).has_table(name) for name in
                            ("daily_research_recipients", "daily_research_devices", "daily_research_batches")))
