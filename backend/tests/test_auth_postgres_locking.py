"""可选 PostgreSQL 回归：在随机隔离 schema 验证真实外键锁，不接触业务表。

设置 ZHICUI_TEST_POSTGRES_URL 后运行 unittest；未设置时跳过。
调用方应提供专用测试数据库，账号需有 CREATE SCHEMA 权限。
"""
from __future__ import annotations

import os
import unittest
import uuid
from unittest.mock import patch

from fastapi import Request, Response
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.api.auth_routes import auth_login, LoginRequest
from app.core.database import Base
from app.models.user import User
from app.models.user_activity_log import UserActivityLog
from app.models.auth_session import UserAuthSession, AuthRefreshReceipt
from app.services import auth_service, auth_session_service


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
            UserAuthSession.__table__, AuthRefreshReceipt.__table__])
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


if __name__ == "__main__":
    unittest.main()
