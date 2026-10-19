"""可选 PostgreSQL 回归：在随机隔离 schema 验证真实外键锁，不接触业务表。

设置 ZHICUI_TEST_POSTGRES_URL 后运行 unittest；未设置时跳过。
调用方应提供专用测试数据库，账号需有 CREATE SCHEMA 权限。
"""
from __future__ import annotations

import os
import json
import time
import unittest
import uuid
from unittest.mock import patch

from fastapi import Request, Response
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.api.auth_routes import auth_login, LoginRequest
from app.api import agent_interface_routes as agent_routes
from app.core.config import settings
from app.core.database import Base
from app.models.user import User
from app.models.user_activity_log import UserActivityLog
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.models.agent_interface import AgentCredential, AgentDeviceAuthorization
from app.services import auth_service, auth_session_service, agent_credential_service, activity_service


@unittest.skipUnless(os.environ.get("ZHICUI_TEST_POSTGRES_URL"), "未配置专用 PostgreSQL 测试数据库")
class AuthPostgresLockingTests(unittest.TestCase):
    def setUp(self):
        url = os.environ["ZHICUI_TEST_POSTGRES_URL"]
        self.schema = "zhicui_auth_audit_" + uuid.uuid4().hex
        self.control = create_engine(url, isolation_level="AUTOCOMMIT")
        with self.control.connect() as connection:
            connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_engine(url, connect_args={"options":
            f"-csearch_path={self.schema} -clock_timeout=1500 -cstatement_timeout=5000"})
        Base.metadata.create_all(self.engine, tables=[User.__table__, UserActivityLog.__table__,
            UserAuthSession.__table__, AuthRefreshReceipt.__table__,
            AgentCredential.__table__, AgentDeviceAuthorization.__table__])
        self.factory = sessionmaker(bind=self.engine)
        self.db = self.factory()
        self.user = User(id="lock-owner", email="lock@example.test", username="lock-owner",
            hashed_password=auth_service.hash_password("test-password"), is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        with self.control.connect() as connection:
            connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        self.control.dispose()

    def independent_log(self, **kwargs):
        # 用户行仍有 FOR UPDATE 时，真实 FK INSERT 会在 1.5 秒内报锁超时。
        with self.factory() as db:
            db.add(UserActivityLog(user_id=kwargs["user_id"], action="account_login", method="POST",
                path="/api/auth/login", status_code=200))
            db.commit()

    def request(self, version=None):
        return Request({"type": "http", "headers": [] if version is None else
            [(b"x-zhicui-session-version", version.encode())], "scheme": "https",
            "server": ("example.test", 443), "path": "/api/auth/login", "client": ("127.0.0.1", 1)})

    def test_login_success_and_failure_allow_foreign_key_activity_insert(self):
        for version, password, expected in ((None, "test-password", True),
                ("2", "test-password", True), (None, "incorrect-password", False)):
            with self.subTest(version=version, success=expected):
                with patch("app.api.auth_routes.activity_service.log_activity_safely", side_effect=self.independent_log):
                    result = auth_login(LoginRequest(email="lock-owner", password=password),
                        self.request(version), Response(), self.db)
                self.assertEqual(result["success"], expected)

    def test_legacy_handoff_payload_releases_lock_before_log_insert(self):
        result = auth_session_service.login_payload(self.db, self.user, self.request(), Response())
        self.assertTrue(result["token"])
        self.independent_log(user_id="lock-owner")

    def device(self):
        _, device, code = agent_credential_service.create_device_authorization(
            self.db, client_name="隔离锁回归", client_type="cli", scopes=["account:read"],
        )
        agent_credential_service.approve_device_authorization(
            self.db, user_id=self.user.id, user_code=code, approve=True,
        )
        issued = agent_credential_service.poll_device_authorization(self.db, device_code=device)
        return device, code, issued

    def assert_error_released_before_activity(self, response, code):
        self.assertEqual(json.loads(response.body)["error"]["code"], code)
        # 保持请求 Session 存活，模拟 middleware 在依赖 finally 关闭连接前写活动日志。
        self.assertFalse(self.db.in_transaction())
        self.independent_log(user_id="lock-owner")

    def test_consumed_and_invalid_device_approval_release_user_lock_before_activity(self):
        with patch.object(settings, "AGENT_INTERFACE_ENABLED", True), \
                patch.object(agent_credential_service, "user_is_enabled", return_value=True):
            _, code, _ = self.device()
            for value, expected in ((code, "DEVICE_CODE_USED"), ("ZZZZ-ZZZZ", "DEVICE_CODE_INVALID")):
                with self.subTest(error=expected):
                    response = agent_routes.approve_device(
                        agent_routes.DeviceApproveRequest(user_code=value, approve=False),
                        self.request(), self.user, self.db,
                    )
                    self.assert_error_released_before_activity(response, expected)

    def test_consumed_poll_and_revoked_refresh_release_user_lock_before_activity(self):
        with patch.object(settings, "AGENT_INTERFACE_ENABLED", True), \
                patch.object(agent_credential_service, "user_is_enabled", return_value=True):
            device, _, issued = self.device()
            response = agent_routes.poll_device(
                agent_routes.DevicePollRequest(device_code=device), self.request(), self.db,
            )
            self.assert_error_released_before_activity(response, "DEVICE_CODE_USED")
            agent_credential_service.revoke_credential(
                self.db, user_id=self.user.id, credential_id=issued["credential"]["id"],
            )
            response = agent_routes.refresh_device(
                agent_routes.RefreshRequest(refresh_token=issued["refresh_token"], request_id="lock-regression-request"),
                self.request(), self.db,
            )
            self.assert_error_released_before_activity(response, "CREDENTIAL_REVOKED")

    def test_pat_limit_error_releases_user_lock_before_activity(self):
        with patch.object(settings, "AGENT_INTERFACE_ENABLED", True), \
                patch.object(agent_credential_service, "MAX_ACTIVE_CREDENTIALS", 0):
            response = agent_routes.create_pat(
                agent_routes.PatCreateRequest(name="隔离数量限制", scopes=["account:read"]),
                self.request(), self.user, self.db,
            )
        self.assert_error_released_before_activity(response, "CREDENTIAL_LIMIT_REACHED")

    def test_safe_activity_log_has_a_short_real_postgres_lock_wait(self):
        # 关闭连接级 lock_timeout，验证日志自身的局部超时有效；旧实现会等到 5 秒语句超时。
        log_engine = create_engine(os.environ["ZHICUI_TEST_POSTGRES_URL"], connect_args={"options":
            f"-csearch_path={self.schema} -clock_timeout=0 -cstatement_timeout=5000"})
        try:
            log_factory = sessionmaker(bind=log_engine)
            self.db.query(User).filter(User.id == "lock-owner").with_for_update().one()
            started = time.monotonic()
            with patch.object(activity_service, "SessionLocal", log_factory):
                result = activity_service.log_activity_safely(user_id="lock-owner", action="api_operation",
                    method="POST", path="/isolated-lock-test", status_code=400)
            self.assertIsNone(result)
            self.assertLess(time.monotonic() - started, 3)
            self.db.rollback()
            # 超时不能污染连接池；释放锁后，同一日志连接池仍可正常写入。
            with patch.object(activity_service, "SessionLocal", log_factory):
                result = activity_service.log_activity_safely(user_id="lock-owner", action="api_operation",
                    method="POST", path="/isolated-lock-test", status_code=400)
            self.assertIsNotNone(result)
        finally:
            self.db.rollback()
            log_engine.dispose()


if __name__ == "__main__":
    unittest.main()
