#!/usr/bin/env python3
"""用真实临时 SQLite/FastAPI 服务验证 CLI smoke，绝不连接已有数据库。"""
from __future__ import annotations

import os
import argparse
from contextlib import ExitStack
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', choices=['core', 'full', 'both'], default='both')
    profile = parser.parse_args().profile
    if profile == 'both':
        for selected in ('core', 'full'):
            child_env = dict(os.environ)
            if child_env.get('SMOKE_REPORT_FILE'):
                report = Path(child_env['SMOKE_REPORT_FILE'])
                child_env['SMOKE_REPORT_FILE'] = str(report.with_stem(f'{report.stem}-{selected}'))
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--profile', selected], env=child_env)
            if completed.returncode:
                return completed.returncode
        return 0
    with ExitStack() as stack:
        temporary = stack.enter_context(tempfile.TemporaryDirectory(prefix="zhicui-cli-local-smoke-"))
        password = secrets.token_urlsafe(32)
        listener = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        os.environ.update({
            "DATABASE_URL": f"sqlite:///{Path(temporary) / 'smoke.db'}",
            "JWT_SECRET": secrets.token_hex(32),
            "AGENT_TOKEN_PEPPER": secrets.token_hex(32),
            "AGENT_INTERFACE_ENABLED": "true",
            "AGENT_INTERFACE_PROFILE": profile,
            "AGENT_INTERFACE_USER_ALLOWLIST": "",
            "AGENT_INTERFACE_ACTION_ALLOWLIST": "",
            "PUBLIC_APP_URL": base_url,
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        })
        sys.path.insert(0, str(root / "backend"))
        from fastapi import FastAPI
        import uvicorn
        # 注册完整模型映射；不运行正式 app 的启动事件、worker 或迁移。
        from app import main as registered_models  # noqa: F401
        from app.api.auth_routes import router as auth_router
        from app.api.agent_interface_routes import router, mcp_router
        from app.core.database import Base, SessionLocal, engine
        from app.models.note import Note
        from app.models.user import User
        from app.services.auth_service import create_access_token, hash_password
        stack.callback(engine.dispose)

        Base.metadata.create_all(engine)
        with SessionLocal() as db:
            user = User(
                email="cli-smoke@example.invalid",
                username="zhicui_production_smoke",
                hashed_password=hash_password(password),
                is_active=True,
                is_admin=False,
            )
            db.add(user)
            db.flush()
            note = Note(
                user_id=user.id,
                video_id="cli-local-fixture",
                video_title="CLI 本地测试资料",
                video_url="https://luxai.cn/internal/cli-local-fixture",
                transcript_raw="这是一条独立于真实用户的本地 CLI 测试文稿。琥珀火车编号是 ZHICUI-SMOKE-94731。",
                ai_summary="{}",
                seo_title="CLI 本地测试资料",
                seo_slug="cli-local-smoke-fixture",
                seo_meta="独立普通测试账号专用资料",
            )
            db.add(note)
            db.commit()
            user_id, source_id = user.id, note.id
        app = FastAPI()
        app.include_router(auth_router)
        app.include_router(router)
        app.include_router(mcp_router)
        server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
        worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and worker.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not server.started:
                raise RuntimeError("临时 CLI 验证服务未启动")
            if profile == 'core':
                from app.agent_interface.profiles import CORE_SCOPE_IDS
                from app.services.agent_credential_service import issue_pat, revoke_credential
                browser_path = Path(temporary) / 'local-browser.token'
                pat_path = Path(temporary) / 'local-pat.token'
                browser_path.write_text(create_access_token(user_id, 'cli-smoke@example.invalid'), encoding='utf-8')
                with SessionLocal() as db:
                    credential, token = issue_pat(db, user_id=user_id, name='local-core-boundary-smoke', scopes=list(CORE_SCOPE_IDS), expires_in_days=1)
                    credential_id = credential.id
                pat_path.write_text(token, encoding='utf-8')
                try:
                    boundary = subprocess.run(
                        [sys.executable, str(root / 'scripts/smoke-agent-core.py'), base_url, str(browser_path), str(pat_path), source_id, str(uuid.uuid4())],
                        capture_output=True, text=True, encoding='utf-8', timeout=90,
                        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
                    )
                    print(boundary.stdout, end='')
                    if boundary.returncode:
                        print(boundary.stderr, end='')
                        return boundary.returncode
                finally:
                    with SessionLocal() as db:
                        revoke_credential(db, user_id=user_id, credential_id=credential_id)
            result = subprocess.run(
                ["node", str(root / "scripts/smoke-agent-cli.mjs"), "--password-stdin"],
                input=password,
                text=True,
                encoding="utf-8",
                capture_output=True,
                timeout=180,
                env={**os.environ, "SMOKE_BASE_URL": base_url, "SMOKE_LOGIN_EMAIL": "cli-smoke@example.invalid", "SMOKE_AGENT_PROFILE": profile},
            )
            # smoke 仅输出白名单汇总；不转发后台、子进程 stderr 或异常对象。
            print(result.stdout, end="")
            return result.returncode
        finally:
            server.should_exit = True
            worker.join(timeout=15)
            listener.close()
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
