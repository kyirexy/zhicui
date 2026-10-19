"""活动日志锁等待与请求上下文清理的回归测试。"""

import asyncio
import os
import threading
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI

os.environ.setdefault("JWT_SECRET", "activity-logging-safety-test-secret-only")

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request
from starlette.responses import Response

from app.core.request_context import (
    get_current_request_path,
    get_current_user_id,
    reset_request_context,
    set_request_context,
)
from app.models.user import User
from app.models.user_activity_log import UserActivityLog
from app.services import activity_service


class ActivityLoggingSafetyTests(unittest.TestCase):
    def test_postgres_applies_local_limits_to_insert_and_refresh_transactions(self):
        db = MagicMock()
        db.__enter__.return_value = db
        db.get_bind.return_value.dialect.name = "postgresql"
        callbacks = []
        entry = object()

        def register(session, name, callback):
            self.assertIs(session, db)
            self.assertEqual(name, "after_begin")
            callbacks.append(callback)

        def insert(session, **kwargs):
            self.assertIs(session, db)
            self.assertEqual(kwargs, {"user_id": "owner"})
            self.assertEqual(len(callbacks), 1)
            # 写入和提交后的 refresh 分属两个事务，都需要事务级限时。
            for _ in range(2):
                connection = MagicMock()
                callbacks[0](db, object(), connection)
                self.assertEqual(
                    [call.args[0] for call in connection.exec_driver_sql.call_args_list],
                    ["SET LOCAL lock_timeout = '1000ms'",
                     "SET LOCAL statement_timeout = '5000ms'"],
                )
            return entry

        with patch.object(activity_service, "SessionLocal", return_value=db), \
                patch.object(activity_service.event, "listen", side_effect=register), \
                patch.object(activity_service, "log_activity", side_effect=insert):
            self.assertIs(activity_service.log_activity_safely(user_id="owner"), entry)
        db.__exit__.assert_called_once_with(None, None, None)

    def test_log_timeout_is_suppressed_and_session_closes(self):
        db = MagicMock()
        db.__enter__.return_value = db
        db.get_bind.return_value.dialect.name = "postgresql"
        failure = RuntimeError("模拟数据库锁等待超时")
        with patch.object(activity_service, "SessionLocal", return_value=db), \
                patch.object(activity_service.event, "listen"), \
                patch.object(activity_service, "log_activity", side_effect=failure):
            self.assertIsNone(activity_service.log_activity_safely(user_id="owner"))
        self.assertIs(db.__exit__.call_args.args[1], failure)

    def test_sqlite_keeps_writing_without_postgres_settings(self):
        engine = create_engine("sqlite://")
        User.__table__.create(engine)
        UserActivityLog.__table__.create(engine)
        statements = []
        event.listen(engine, "before_cursor_execute", lambda conn, cursor, statement,
                     parameters, context, executemany: statements.append(statement))
        sessions = sessionmaker(bind=engine)
        try:
            with patch.object(activity_service, "SessionLocal", sessions):
                entry = activity_service.log_activity_safely(
                    user_id=None, action="api_operation", method="POST",
                    path="/api/test?private=excluded", status_code=403,
                )
            self.assertIsNotNone(entry)
            with sessions() as db:
                row = db.query(UserActivityLog).one()
                self.assertEqual((row.path, row.status_code), ("/api/test", 403))
            self.assertFalse(any("SET LOCAL" in sql for sql in statements))
        finally:
            engine.dispose()


class RequestObservabilitySafetyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from app import main

        self.main = main
        self.middleware = next(
            middleware.kwargs["dispatch"]
            for middleware in main.app.user_middleware
            if getattr(middleware.kwargs.get("dispatch"), "__name__", "")
            == "request_observability"
        )
        self.request = Request({
            "type": "http", "method": "POST", "scheme": "http",
            "path": "/api/agent-interface/v1/device/approve", "query_string": b"",
            "headers": [(b"authorization", b"Bearer test-only")],
            "server": ("testserver", 80), "client": ("127.0.0.1", 1234),
        })
        self.context_tokens = set_request_context("outer-owner", "/outer")
        self.decode = patch.object(main.auth_service, "decode_access_token",
                                   return_value={"sub": "request-owner"})
        self.decode.start()

    def tearDown(self):
        self.decode.stop()
        reset_request_context(self.context_tokens)

    def assert_context_restored(self):
        self.assertEqual(get_current_user_id(), "outer-owner")
        self.assertEqual(get_current_request_path(), "/outer")

    async def successful_request(self, request):
        self.assertEqual(get_current_user_id(), "request-owner")
        return Response(status_code=403)

    async def test_waiting_log_does_not_block_event_loop_and_preserves_attribution(self):
        loop = asyncio.get_running_loop()
        event_loop_thread = threading.get_ident()
        logger_started = asyncio.Event()
        loop_advanced = threading.Event()
        observed = {}

        def waiting_log(**kwargs):
            observed["thread"] = threading.get_ident()
            observed["user"] = get_current_user_id()
            observed["status"] = kwargs["status_code"]
            loop.call_soon_threadsafe(logger_started.set)
            observed["loop_advanced"] = loop_advanced.wait(timeout=2)

        async def advance_loop():
            await logger_started.wait()
            loop_advanced.set()

        progress = asyncio.create_task(advance_loop())
        try:
            with patch.object(activity_service, "log_activity_safely", side_effect=waiting_log):
                response = await self.middleware(self.request, self.successful_request)
            await progress
        finally:
            loop_advanced.set()
            if not progress.done():
                progress.cancel()
        self.assertEqual(response.status_code, 403)
        self.assertNotEqual(observed["thread"], event_loop_thread)
        self.assertTrue(observed["loop_advanced"])
        self.assertEqual((observed["user"], observed["status"]), ("request-owner", 403))
        self.assert_context_restored()

    async def test_request_failure_logs_500_and_restores_context(self):
        async def failing_request(request):
            raise ValueError("模拟请求失败")

        with patch.object(activity_service, "log_activity_safely") as logger:
            with self.assertRaisesRegex(ValueError, "模拟请求失败"):
                await self.middleware(self.request, failing_request)
        self.assertEqual(logger.call_args.kwargs["status_code"], 500)
        self.assert_context_restored()

    async def test_health_request_serves_while_activity_write_waits(self):
        app = FastAPI()
        app.middleware("http")(self.middleware)

        @app.post("/api/test-change")
        async def change():
            return {"success": True}

        @app.get("/api/health")
        async def health():
            return {"status": "ok"}

        loop = asyncio.get_running_loop()
        logger_started = asyncio.Event()
        health_completed = threading.Event()
        observed = []

        def waiting_log(**kwargs):
            loop.call_soon_threadsafe(logger_started.set)
            observed.append(health_completed.wait(timeout=2))

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://testserver") as client:
            with patch.object(activity_service, "log_activity_safely", side_effect=waiting_log):
                change_request = asyncio.create_task(client.post(
                    "/api/test-change", headers={"Authorization": "Bearer test-only"},
                ))
                try:
                    await asyncio.wait_for(logger_started.wait(), timeout=3)
                    health_response = await asyncio.wait_for(client.get("/api/health"), timeout=1)
                    health_completed.set()
                    change_response = await asyncio.wait_for(change_request, timeout=3)
                finally:
                    health_completed.set()
                    if not change_request.done():
                        change_request.cancel()
        self.assertEqual(health_response.json(), {"status": "ok"})
        self.assertEqual(change_response.status_code, 200)
        self.assertEqual(observed, [True])
        self.assert_context_restored()

    async def test_logging_failure_still_restores_context(self):
        with patch.object(activity_service, "log_activity_safely",
                          side_effect=RuntimeError("模拟日志失败")):
            with self.assertRaisesRegex(RuntimeError, "模拟日志失败"):
                await self.middleware(self.request, self.successful_request)
        self.assert_context_restored()

    async def test_cancellation_during_logging_still_restores_context(self):
        with patch.object(self.main, "run_in_threadpool",
                          AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await self.middleware(self.request, self.successful_request)
        self.assert_context_restored()


if __name__ == "__main__":
    unittest.main()
