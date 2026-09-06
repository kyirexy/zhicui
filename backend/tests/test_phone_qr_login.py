"""电脑授权手机：真实路由、并发领取、权限与凭据边界。"""
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "phone-qr-test-secret-0123456789abcdef")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from app.api.phone_login_routes import router
from app.core.database import Base, get_db
from app.core.security_headers import SecurityHeadersMiddleware
from app.models.phone_login_session import PhoneLoginSession
from app.models.user import User
from app.services.auth_service import create_access_token, decode_access_token
from app.services import phone_login_service as service


@pytest.fixture
def env(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'phone.db'}", connect_args={"check_same_thread": False, "timeout": 30})
    @event.listens_for(engine, "connect")
    def wal(conn, _):
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
    Base.metadata.create_all(engine, tables=[User.__table__, PhoneLoginSession.__table__])
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    with sessions() as db:
        users = [User(email=f"phone{i}@example.com", username=f"phone{i}", hashed_password="unused", is_active=True, is_admin=False) for i in range(2)]
        db.add_all(users); db.commit()
        ids = [u.id for u in users]
        tokens = [create_access_token(u.id, u.email) for u in users]
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(router)
    def database():
        with sessions() as db: yield db
    app.dependency_overrides[get_db] = database
    with patch("app.api.phone_login_routes.activity_service.log_activity_safely"), TestClient(app) as client:
        yield client, sessions, ids, [{"Authorization": f"Bearer {t}"} for t in tokens], app
    engine.dispose()


BASE = "/api/auth/phone-login/sessions"


def setup_claim(env):
    client, _, _, headers, _ = env
    response = client.post(BASE, headers=headers[0])
    assert response.status_code == 200
    data = response.json()["data"]
    secret = data["qr_url"].split(".")[-1]
    claim_secret = secrets.token_urlsafe(32)
    body = {"scan_secret": secret, "claim_secret": claim_secret, "client_type": "android"}
    claimed = client.post(f'{BASE}/{data["session_id"]}/claim', json=body).json()["data"]
    return data, body, claimed


def approve(env, data, claimed):
    return env[0].post(f'{BASE}/{data["session_id"]}/decision', headers=env[3][0],
        json={"decision": "approve", "verification_code": claimed["verification_code"]})


def test_full_flow_and_replay(env):
    client, sessions, ids, _, _ = env
    data, body, claimed = setup_claim(env)
    assert claimed["status"] == "scanned"
    path = f'{BASE}/{data["session_id"]}/token'
    assert client.post(path, json={"claim_secret": body["scan_secret"]}).status_code == 404
    assert client.post(path, json={"claim_secret": body["claim_secret"]}).json()["data"]["status"] == "scanned"
    assert approve(env, data, claimed).json()["data"]["status"] == "approved"
    response = client.post(path, json={"claim_secret": body["claim_secret"]})
    assert "no-store" in response.headers["cache-control"]
    auth = response.json()["data"]
    assert auth["status"] == "success"
    assert decode_access_token(auth["token"])["sub"] == ids[0]
    assert decode_access_token(auth["token"])["jti"] == data['session_id']
    assert auth["user"]["is_admin"] is False
    assert "token" not in client.post(path, json={"claim_secret": body["claim_secret"]}).json()["data"]
    with sessions() as db:
        row = db.get(PhoneLoginSession, data["session_id"])
        assert row.scan_hash != body["scan_secret"] and row.claim_hash != body["claim_secret"]


def test_creator_auth_ownership_and_code(env):
    client, _, _, headers, _ = env
    assert client.post(BASE).status_code == 401
    data, _, claimed = setup_claim(env)
    path = f'{BASE}/{data["session_id"]}'
    assert client.post(path + '/status', headers=headers[1]).status_code == 404
    for decision in ('approve', 'cancel'):
        assert client.post(path + '/decision', headers=headers[1], json={"decision": decision}).status_code == 404
    assert client.post(path + '/decision', headers=headers[0], json={"decision": "approve", "verification_code": "wrong"}).status_code == 409
    assert approve(env, data, claimed).status_code == 200


def test_claim_retry_and_second_phone_denied(env):
    data, body, _ = setup_claim(env)
    path = f'{BASE}/{data["session_id"]}/claim'
    assert env[0].post(path, json=body).status_code == 200
    assert env[0].post(path, json={**body, "claim_secret": secrets.token_urlsafe(32)}).status_code == 404


@pytest.mark.parametrize('state', ['expired', 'cancelled', 'disabled'])
def test_terminal_or_disabled_does_not_issue_token(env, state):
    client, sessions, ids, headers, _ = env
    data, body, claimed = setup_claim(env)
    approve(env, data, claimed)
    if state == 'cancelled':
        client.post(f'{BASE}/{data["session_id"]}/decision', headers=headers[0], json={"decision": "cancel"})
    else:
        with sessions() as db:
            if state == 'expired': db.get(PhoneLoginSession, data["session_id"]).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            else: db.get(User, ids[0]).is_active = False
            db.commit()
    result = client.post(f'{BASE}/{data["session_id"]}/token', json={"claim_secret": body["claim_secret"]}).json()["data"]
    assert "token" not in result
    assert result['status'] in ('expired', 'cancelled', 'account_unavailable')


def test_concurrent_consume_only_once(env):
    data, body, claimed = setup_claim(env)
    approve(env, data, claimed)
    def take(_):
        with env[1]() as db:
            result, user = service.consume(db, data['session_id'], body['claim_secret'])
            return result['status'], user is not None
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(take, range(2)))
    assert sum(issued for _, issued in results) == 1


def test_concurrent_claim_only_first_phone(env):
    data = env[0].post(BASE, headers=env[3][0]).json()['data']
    def bind(_):
        with env[1]() as db:
            return service.claim(db, data['session_id'], data['qr_url'].split('.')[-1], secrets.token_urlsafe(32), 'ios')
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(bind, range(2)))
    assert sum(result is not None for result in results) == 1


def test_normal_user_cannot_call_real_admin_endpoint(env):
    from app.api.routes import router as product_router
    env[4].include_router(product_router)
    response = env[0].get('/api/admin/stats', headers=env[3][0])
    assert response.status_code == 403
