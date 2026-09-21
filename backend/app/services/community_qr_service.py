"""Storage and validation for the public community WeChat QR image.

The image is kept in the existing ``system_settings`` table so replacing it
does not require a frontend rebuild or a writable frontend directory.  It is
base64 encoded in one setting row; the public endpoint decodes it only when a
visitor requests the image.
"""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timedelta, timezone
from io import BytesIO

from fastapi import HTTPException
from PIL import Image
from sqlalchemy.orm import Session

from app.models.system_setting import SystemSetting
from app.services import settings_service

QR_DATA_KEY = "community_qr_data"
QR_MEDIA_TYPE_KEY = "community_qr_media_type"
QR_FILENAME_KEY = "community_qr_filename"
QR_EXPIRES_AT_KEY = "community_qr_expires_at"
# QR images are small; keeping this bounded also keeps the DB-backed settings
# snapshot cheap to load on every request.
MAX_BYTES = 512 * 1024
MAX_DIMENSION = 4096
ALLOWED_MEDIA_TYPES = {"image/png", "image/jpeg", "image/webp"}


def _parse_expiry(value: str | None) -> str | None:
    """Normalize an optional ISO timestamp and reject ambiguous values."""
    text = (value or "").strip()
    if not text:
        return None
    try:
        # The admin control is a Chinese local calendar date. Treat a date-only
        # value as the start of that day in Asia/Shanghai rather than UTC.
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            text = f"{text}T00:00:00+08:00"
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(400, "二维码有效期必须是有效的日期时间") from exc
    if parsed.tzinfo is None:
        # 管理端使用北京时间的日期输入；不要把 00:00 误解成 UTC。
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
    return parsed.astimezone(timezone.utc).isoformat()


def _setting(db: Session, key: str, default: str = "") -> str:
    return settings_service.get_setting(db, key, default)


def info(db: Session) -> dict[str, str | bool | None]:
    """Return public metadata without exposing the image bytes."""
    data = _setting(db, QR_DATA_KEY)
    return {
        "available": bool(data),
        "url": "/api/community/qr" if data else None,
        "media_type": _setting(db, QR_MEDIA_TYPE_KEY) or None,
        "filename": _setting(db, QR_FILENAME_KEY, "知萃交流群二维码.png") or "知萃交流群二维码.png",
        "expires_at": _setting(db, QR_EXPIRES_AT_KEY) or None,
    }


def image_bytes(db: Session) -> tuple[bytes, str, str] | None:
    """Decode the stored image for the public file response."""
    encoded = _setting(db, QR_DATA_KEY)
    if not encoded:
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return None
    if not raw or len(raw) > MAX_BYTES:
        return None
    return raw, _setting(db, QR_MEDIA_TYPE_KEY, "image/png"), _setting(db, QR_FILENAME_KEY, "知萃交流群二维码.png")


def save(db: Session, raw: bytes, filename: str, declared_type: str | None, expires_at: str | None) -> dict[str, str | bool | None]:
    """Validate and replace the configured community QR image in one commit."""
    normalized_expiry = _parse_expiry(expires_at)
    if not raw or len(raw) > MAX_BYTES:
        raise HTTPException(413, "二维码文件不能超过 512 KB")
    try:
        with Image.open(BytesIO(raw)) as image:
            image.verify()
        with Image.open(BytesIO(raw)) as image:
            width, height = image.size
            image_format = (image.format or "").upper()
    except Exception as exc:
        raise HTTPException(400, "请上传有效的 PNG、JPG 或 WebP 图片") from exc
    if width < 64 or height < 64 or width > MAX_DIMENSION or height > MAX_DIMENSION:
        raise HTTPException(400, "二维码图片尺寸需在 64 到 4096 像素之间")
    media_type = {
        "PNG": "image/png",
        "JPEG": "image/jpeg",
        "WEBP": "image/webp",
    }.get(image_format)
    if media_type is None or (declared_type and declared_type not in ALLOWED_MEDIA_TYPES):
        raise HTTPException(400, "请上传有效的 PNG、JPG 或 WebP 图片")
    safe_name = (filename or "知萃交流群二维码.png").strip()[:120] or "知萃交流群二维码.png"
    # Preserve only a harmless display name; it is never used as a filesystem path
    # or interpolated into a response header without this filtering.
    safe_name = "".join(char for char in safe_name if char.isalnum() or char in "._-") or "知萃交流群二维码.png"
    values = {
        QR_DATA_KEY: base64.b64encode(raw).decode("ascii"),
        QR_MEDIA_TYPE_KEY: media_type,
        QR_FILENAME_KEY: safe_name,
        QR_EXPIRES_AT_KEY: normalized_expiry or "",
    }
    rows = {
        row.key: row
        for row in db.query(SystemSetting).filter(SystemSetting.key.in_(values)).all()
    }
    for key, value in values.items():
        row = rows.get(key)
        if row is None:
            db.add(SystemSetting(key=key, value=value))
        else:
            row.value = value
    db.commit()
    settings_service.invalidate_config_caches()
    return info(db)
