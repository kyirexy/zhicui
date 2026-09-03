from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

os.environ.setdefault("JWT_SECRET", "auth-jwt-compatibility-test-secret-123456789")

from app.services import auth_service


def _base64url(payload: bytes) -> str:
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _legacy_hs256_token(payload: dict[str, object]) -> str:
    """不用旧依赖，按标准格式构造 python-jose 既有 HS256 Token。"""
    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = _base64url(
        json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    encoded_payload = _base64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(
        auth_service.SECRET_KEY.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    return f"{encoded_header}.{encoded_payload}.{_base64url(signature)}"


class AuthJwtCompatibilityTests(unittest.TestCase):
    def test_access_token_keeps_hs256_identity_and_thirty_day_expiry(self) -> None:
        before = datetime.now(timezone.utc)
        token = auth_service.create_access_token("user-123", "user@example.com")
        payload = auth_service.decode_access_token(token)

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["sub"], "user-123")
        self.assertEqual(payload["email"], "user@example.com")
        expires_at = datetime.fromtimestamp(float(payload["exp"]), timezone.utc)
        expected = before + timedelta(days=auth_service.ACCESS_TOKEN_EXPIRE_DAYS)
        self.assertLess(abs((expires_at - expected).total_seconds()), 5)

    def test_existing_python_jose_style_token_remains_valid(self) -> None:
        token = _legacy_hs256_token(
            {
                "sub": "legacy-user",
                "email": "legacy@example.com",
                "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
            }
        )

        payload = auth_service.decode_access_token(token)

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["sub"], "legacy-user")
        self.assertEqual(payload["email"], "legacy@example.com")

    def test_expired_tampered_and_unsigned_tokens_keep_returning_none(self) -> None:
        expired = _legacy_hs256_token(
            {
                "sub": "legacy-user",
                "email": "legacy@example.com",
                "exp": int((datetime.now(timezone.utc) - timedelta(seconds=1)).timestamp()),
            }
        )
        valid = auth_service.create_access_token("user-123", "user@example.com")
        header, payload, _signature = valid.split(".")
        tampered = f"{header}.{payload}.{_base64url(b'invalid-signature')}"
        unsigned_header = _base64url(b'{"alg":"none","typ":"JWT"}')
        unsigned = f"{unsigned_header}.{payload}."

        self.assertIsNone(auth_service.decode_access_token(expired))
        self.assertIsNone(auth_service.decode_access_token(tampered))
        self.assertIsNone(auth_service.decode_access_token(unsigned))
        self.assertIsNone(auth_service.decode_access_token("not-a-jwt"))

    def test_email_verification_token_keeps_purpose_and_nonce_contract(self) -> None:
        user = SimpleNamespace(id="user-verify", email="verify@example.com")
        token = auth_service.create_email_verification_token(user, "nonce-123")

        payload = auth_service.decode_email_verification_token(token)

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(payload["sub"], "user-verify")
        self.assertEqual(payload["email"], "verify@example.com")
        self.assertEqual(payload["purpose"], "verify_email")
        self.assertEqual(payload["nonce"], "nonce-123")

    def test_email_verification_rejects_wrong_purpose_missing_nonce_and_expiry(self) -> None:
        future_expiry = int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())
        wrong_purpose = _legacy_hs256_token(
            {
                "sub": "user-verify",
                "purpose": "access",
                "nonce": "nonce-123",
                "exp": future_expiry,
            }
        )
        missing_nonce = _legacy_hs256_token(
            {
                "sub": "user-verify",
                "purpose": "verify_email",
                "exp": future_expiry,
            }
        )
        expired = _legacy_hs256_token(
            {
                "sub": "user-verify",
                "purpose": "verify_email",
                "nonce": "nonce-123",
                "exp": int((datetime.now(timezone.utc) - timedelta(seconds=1)).timestamp()),
            }
        )

        self.assertIsNone(auth_service.decode_email_verification_token(wrong_purpose))
        self.assertIsNone(auth_service.decode_email_verification_token(missing_nonce))
        self.assertIsNone(auth_service.decode_email_verification_token(expired))


if __name__ == "__main__":
    unittest.main()
