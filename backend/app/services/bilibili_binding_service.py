"""用户本人扫码授权，禁止接受外部 Cookie 或回退到共用账号。"""
from datetime import datetime, timedelta, timezone
import json
import uuid
from urllib.parse import urlparse
from cryptography.fernet import Fernet, InvalidToken
import requests
from sqlalchemy.exc import IntegrityError
from app.core.config import settings
from app.models.bilibili_account_binding import BilibiliAccountBinding

COOKIE_NAMES = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"}


class BilibiliBindingError(ValueError):
    def __init__(self, code, message, status_code=409):
        super().__init__(message)
        self.code, self.status_code = code, status_code


def now():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def cipher():
    try:
        return Fernet(settings.ENCRYPTION_KEY.encode())
    except (ValueError, AttributeError):
        raise BilibiliBindingError("binding_unavailable", "平台授权加密配置尚未就绪", 503) from None


def seal(value):
    return cipher().encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()


def unseal(value):
    try:
        return json.loads(cipher().decrypt(value.encode()))
    except (InvalidToken, ValueError, TypeError):
        raise BilibiliBindingError("bilibili_login_required", "B站授权不可用，请重新绑定") from None


def session(cookies=None):
    client = requests.Session()
    client.trust_env = False
    client.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
    for key, value in (cookies or {}).items():
        if key in COOKIE_NAMES:
            client.cookies.set(key, value, domain=".bilibili.com", path="/")
    return client


def api(client, url, params=None):
    # 只有实现内固定的官方 HTTPS API 可以收到当前用户的会话。
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"passport.bilibili.com", "api.bilibili.com"} or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise BilibiliBindingError("invalid_upstream_url", "平台请求地址无效")
    try:
        response = client.get(url, params=params, timeout=(5, 12), allow_redirects=False)
        if response.status_code in {403, 412, 429}:
            raise BilibiliBindingError("bilibili_risk_control", "B站暂时限制请求，请在官方平台完成验证后再试")
        if response.status_code != 200:
            raise BilibiliBindingError("bilibili_unavailable", "B站暂时无法连接", 502)
        value = response.json()
    except (requests.RequestException, ValueError) as exc:
        if isinstance(exc, BilibiliBindingError):
            raise
        raise BilibiliBindingError("bilibili_unavailable", "B站暂时无法连接", 502) from None
    if not isinstance(value, dict):
        raise BilibiliBindingError("invalid_upstream_response", "B站返回格式异常", 502)
    if value.get("code") in {-352, -401, -412, -799}:
        raise BilibiliBindingError("bilibili_risk_control", "B站暂时限制请求，请在官方平台完成验证后再试")
    if value.get("code") == -101:
        raise BilibiliBindingError("bilibili_login_required", "B站登录已失效，请重新绑定")
    if value.get("code") != 0 or not isinstance(value.get("data"), dict):
        raise BilibiliBindingError("invalid_upstream_response", "B站未返回有效结果", 502)
    return value["data"]


def get(db, user_id, *, lock=False, create=False):
    if create and db.get(BilibiliAccountBinding, user_id) is None:
        db.add(BilibiliAccountBinding(user_id=user_id))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    query = db.query(BilibiliAccountBinding).filter_by(user_id=user_id).populate_existing()
    return (query.with_for_update() if lock else query).first()


def public(row):
    if row is None:
        return {"platform": "bilibili", "status": "disconnected", "connected": False}
    connected = row.status == "connected" and bool(row.credential_encrypted) and bool(row.credential_expires_at and aware(row.credential_expires_at) > now())
    state = row.status
    if row.status == "connected" and not connected:
        state = "expired"
    if row.status == "pending" and (not row.challenge_expires_at or aware(row.challenge_expires_at) <= now()):
        state = "expired"
    result = {"platform": "bilibili", "status": state, "connected": connected,
              "platform_user_id": row.platform_user_id if connected else "",
              "display_name": row.display_name if connected else ""}
    if row.session_id:
        result["session_id"] = row.session_id
    return result


def login_start(db, user_id):
    cipher()  # 缺少加密配置时不向平台申请二维码。
    row = get(db, user_id, lock=True, create=True)
    if public(row)["connected"]:
        db.commit()
        return public(row)
    if row.status == "pending" and row.challenge_expires_at and aware(row.challenge_expires_at) > now():
        challenge = unseal(row.challenge_encrypted)
    else:
        with session() as client:
            challenge = api(client, "https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        url = str(challenge.get("url") or "")
        parsed = urlparse(url)
        key = str(challenge.get("qrcode_key") or "")
        if parsed.scheme != "https" or parsed.hostname not in {"passport.bilibili.com", "www.bilibili.com", "account.bilibili.com"} or parsed.username or parsed.password or parsed.port not in (None, 443) or not key or len(key) > 128:
            raise BilibiliBindingError("invalid_upstream_response", "B站二维码生成失败", 502)
        row.session_id = uuid.uuid4().hex
        row.challenge_encrypted = seal({"url": url, "qrcode_key": key})
        row.challenge_expires_at = now() + timedelta(seconds=180)
        row.next_poll_at = now() + timedelta(seconds=3)
        row.status = "pending"
        row.updated_at = now()
    db.commit()
    return {**public(row), "qr_url": challenge["url"], "expires_at": aware(row.challenge_expires_at).isoformat(), "poll_interval_seconds": 3,
            "login_path": "/connections/bilibili"}


def login_poll(db, user_id, session_id):
    row = get(db, user_id, lock=True)
    if row is None or not session_id or row.session_id != session_id:
        raise BilibiliBindingError("binding_session_not_found", "授权会话不存在或已取消", 404)
    if row.status != "pending" or not row.challenge_expires_at or aware(row.challenge_expires_at) <= now():
        result = public(row)
        db.commit()
        return result
    if row.next_poll_at and aware(row.next_poll_at) > now():
        result = {**public(row), "poll_interval_seconds": 3}
        db.commit()
        return result
    key = unseal(row.challenge_encrypted)["qrcode_key"]
    row.next_poll_at = now() + timedelta(seconds=3)
    try:
        with session() as client:
            data = api(client, "https://passport.bilibili.com/x/passport-login/web/qrcode/poll", {"qrcode_key": key})
            code = data.get("code")
            if code == 0:
                cookies = {c.name: c.value for c in client.cookies if c.name in COOKIE_NAMES and c.domain.lstrip(".") in {"bilibili.com", "passport.bilibili.com"}}
                if not cookies.get("SESSDATA"):
                    raise BilibiliBindingError("invalid_upstream_response", "未收到有效平台授权，请重新扫码")
                identity = api(client, "https://api.bilibili.com/x/web-interface/nav")
                mid = str(identity.get("mid") or "")
                if not identity.get("isLogin") or not mid.isdigit() or cookies.get("DedeUserID", mid) != mid:
                    raise BilibiliBindingError("bilibili_login_required", "B站未确认授权身份，请重新扫码")
                row.credential_encrypted = seal(cookies)
                expiries = [c.expires for c in client.cookies if c.name == "SESSDATA" and c.expires]
                row.credential_expires_at = min(now() + timedelta(days=30), datetime.fromtimestamp(min(expiries), timezone.utc)) if expiries else now() + timedelta(days=7)
                row.platform_user_id, row.display_name = mid, str(identity.get("uname") or "B站用户")[:160]
                row.generation, row.status = uuid.uuid4().hex, "connected"
                row.challenge_encrypted = ""
            elif code == 86038:
                row.status, row.challenge_encrypted = "expired", ""
            elif code not in {86101, 86090}:
                raise BilibiliBindingError("bilibili_login_failed", "B站授权未完成，请重新发起")
    except BilibiliBindingError:
        # 平台拒绝也消耗轮询间隔，避免失败重试放大风控。
        db.commit()
        raise
    row.updated_at = now()
    db.commit()
    return {**public(row), "scan_confirmed": code == 86090, "poll_interval_seconds": 3}


def disconnect(db, user_id):
    row = get(db, user_id, lock=True)
    if row:
        row.generation = uuid.uuid4().hex
        row.status = "disconnected"
        row.credential_encrypted = row.challenge_encrypted = row.session_id = ""
        row.platform_user_id = row.display_name = ""
        row.credential_expires_at = row.challenge_expires_at = row.next_poll_at = None
        row.updated_at = now()
        db.commit()
    return public(row)


def require_binding(db, user_id, generation=None):
    row = get(db, user_id)
    if not public(row)["connected"] or (generation is not None and row.generation != generation):
        raise BilibiliBindingError("bilibili_login_required", "请先绑定自己的 B站账号：打开 /connections/bilibili，或执行 zhicui platform bind bilibili")
    return row


def invalidate(db, user_id, generation):
    row = get(db, user_id, lock=True)
    if row and row.generation == generation:
        row.status, row.credential_encrypted = "expired", ""
        row.updated_at = now()
        db.commit()
