#!/usr/bin/env python3
"""验证新密钥 → CLI/MCP 接入 → 新进程复用 → 撤销；只使用临时账号和数据库。"""
from __future__ import annotations

from collections import Counter
from contextlib import ExitStack
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    if not node or not (root / "cli/dist/index.js").is_file():
        raise RuntimeError("请先构建 CLI，并确保 Node 可用")
    with ExitStack() as stack:
        directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="zhicui-agent-key-test-")))
        listener = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        os.environ.update({
            "DATABASE_URL": f"sqlite:///{(directory / 'test.db').as_posix()}",
            "JWT_SECRET": secrets.token_hex(32),
            "AGENT_TOKEN_PEPPER": secrets.token_hex(32),
            "AGENT_INTERFACE_ENABLED": "true",
            "AGENT_INTERFACE_PROFILE": "core",
            "AGENT_INTERFACE_USER_ALLOWLIST": "",
            "AGENT_INTERFACE_ACTION_ALLOWLIST": "",
            "PUBLIC_APP_URL": base_url,
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        })
        sys.path.insert(0, str(root / "backend"))
        import httpx
        import uvicorn
        from fastapi import FastAPI
        from app import main as registered_models  # noqa: F401
        from app.api.auth_routes import router as auth_router
        from app.api.agent_interface_routes import router, mcp_router
        from app.core.database import Base, SessionLocal, engine
        from app.models.note import Note
        from app.models.user import User
        from app.services.auth_service import hash_password

        stack.callback(engine.dispose)
        Base.metadata.create_all(engine)
        password = secrets.token_urlsafe(32)
        with SessionLocal() as db:
            user = User(email="agent-key@example.invalid", username="agent_key_test",
                        hashed_password=hash_password(password), is_active=True, is_admin=False)
            db.add(user)
            db.flush()
            note = Note(user_id=user.id, video_id="agent-key-fixture", video_title="密钥接入测试资料",
                        video_url="https://example.invalid/agent-key-test", transcript_raw="只属于测试账号的文稿。",
                        ai_summary="{}", seo_title="密钥接入测试资料", seo_slug="agent-key-test",
                        seo_meta="临时测试账号专用资料")
            db.add(note)
            db.commit()
            note_id = note.id

        requests = Counter()
        app = FastAPI()

        @app.middleware("http")
        async def count_requests(request, call_next):
            requests[request.url.path] += 1
            return await call_next(request)

        app.include_router(auth_router)
        app.include_router(router)
        app.include_router(mcp_router)
        server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
        worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 15
            while not server.started and worker.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not server.started:
                raise RuntimeError("临时服务未启动")
            api = stack.enter_context(httpx.Client(base_url=base_url, timeout=20))
            login = api.post("/api/auth/login", json={"email": "agent-key@example.invalid", "password": password})
            assert login.status_code == 200, "测试账号登录失败"
            login_data = login.json()["data"]
            browser_token = login_data.get("access_token") or login_data.get("token")
            assert browser_token, "登录响应缺少凭证"
            browser_headers = {"Authorization": f"Bearer {browser_token}"}
            prefix = "/api/agent-interface/v1"
            response = api.post(f"{prefix}/credentials/agent-key", json={}, headers=browser_headers)
            assert response.status_code == 200, "一键创建密钥失败"
            created = response.json()["data"]
            token = created["token"]
            private_values = [token, browser_token]
            credential = created["credential"]
            assert credential["client_type"] == "agent_key"
            assert credential["expiry_policy"] == "sliding_inactivity"
            assert credential["inactivity_days"] == 365
            assert {"library:read", "library:write"}.issubset(credential["scopes"])
            listed = api.get(f"{prefix}/credentials", headers=browser_headers)
            assert token not in listed.text, "列表泄漏完整密钥"

            env = {**os.environ,
                   "ZHICUI_CLI_DEV": "1", "ZHICUI_PROFILE": "default", "ZHICUI_API_URL": base_url,
                   "ZHICUI_CONFIG_HOME": str(directory / "cli"),
                   "ZHICUI_CREDENTIALS_FILE": str(directory / "test-credential.json"),
                   "ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS": "1",
                   "ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR": str(directory / "missing-bridge.json"),
                   "ZHICUI_CODEX_COMMAND": node,
                   "ZHICUI_CODEX_COMMAND_ARGS": json.dumps([str(root / "cli/test/fake-agent-client.mjs"), "codex"]),
                   "ZHICUI_CODEX_CONFIG": str(directory / "codex/config.toml"),
                   "ZHICUI_CODEX_SKILLS_DIR": str(directory / "codex-skills"),
                   "FAKE_CODEX_STATE": str(directory / "codex-state.json")}

            def cli(*args: str, stdin: str = "", succeeds: bool = True) -> dict:
                result = subprocess.run([node, str(root / "cli/dist/index.js"), *args, "--json", "--timeout", "20s"],
                                        cwd=root / "cli", env=env, input=stdin, text=True, encoding="utf-8",
                                        capture_output=True, timeout=40)
                output = result.stdout + result.stderr
                assert all(value not in output for value in private_values), "CLI 输出泄漏密钥"
                assert (result.returncode == 0) == succeeds, f"CLI 步骤失败：{' '.join(args)}"
                return json.loads(result.stdout)

            connected = cli("connect", "--pat-stdin", "--non-interactive", stdin=token)
            assert connected["ready"] is True and connected["mcp_healthy"] is True
            reused = cli("connect", "--non-interactive")
            assert reused["ready"] is True
            assert reused["setup"]["codex"]["changed"] is False, "重复连接重写了配置"
            saved_note = cli("library", "get", note_id)
            assert saved_note["status"] == "succeeded"
            assert note_id in json.dumps(saved_note), "密钥未读取到同账号资料"
            assert sum(count for path, count in requests.items() if "/auth/device" in path) == 0, "密钥接入误发设备授权"
            state = json.loads((directory / "codex-state.json").read_text(encoding="utf-8"))
            assert state["add_count"] == 1, "新进程复用时重复安装连接"
            assert token not in (directory / "codex/config.toml").read_text(encoding="utf-8"), "配置文件泄漏密钥"

            revoked = api.post(f"{prefix}/credentials/{credential['id']}/revoke", headers=browser_headers)
            assert revoked.status_code == 200
            failed = cli("library", "get", note_id, succeeds=False)
            assert failed["error"]["code"] == "CREDENTIAL_REVOKED", "撤销后仍可读取资料"
            assert sum(count for path, count in requests.items() if "/auth/device" in path) == 0

            # 服务只发布部分功能时，刚生成的合法密钥仍应一次连接成功。
            from app.core.config import settings
            settings.AGENT_INTERFACE_ACTION_ALLOWLIST = "account.me"
            limited = api.post(f"{prefix}/credentials/agent-key", json={}, headers=browser_headers)
            assert limited.status_code == 200
            limited_key = limited.json()["data"]
            private_values.append(limited_key["token"])
            assert limited_key["credential"]["scopes"] == ["account:read"]
            public = api.get(f"{prefix}/capabilities").json()["data"]
            assert public["daily_agent_scopes"] == ["account:read"]
            assert cli("connect", "--pat-stdin", "--non-interactive", stdin=limited_key["token"])["ready"] is True
            assert cli("connect", "--non-interactive")["ready"] is True
            assert cli("run", "account.me")["status"] == "succeeded"
            assert sum(count for path, count in requests.items() if "/auth/device" in path) == 0
            print(json.dumps({"status": "passed", "checks": ["create_daily_key", "sliding_expiry_metadata",
                              "connect_from_stdin", "real_mcp_health", "new_process_reuses_key",
                              "same_account_library", "no_device_authorization", "no_secret_in_output_or_config",
                              "revoke_immediate", "reduced_rollout_key_connects"]}, ensure_ascii=False))
            return 0
        finally:
            server.should_exit = True
            worker.join(timeout=15)
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
