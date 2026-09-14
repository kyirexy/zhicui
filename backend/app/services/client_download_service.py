"""Count official client download starts without storing visitor identity."""

from __future__ import annotations

from datetime import date, datetime, timedelta
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.client_download_daily import ClientDownloadDaily


PLATFORMS = {"android", "windows"}
DOWNLOAD_TARGETS = {
    "android": "/download/zhicui.apk",
    "windows": "/download/windows/Zhicui-Setup-latest-x64.exe",
}
_LOCAL_TIMEZONE = ZoneInfo("Asia/Shanghai")
_WINDOWS_MANIFEST_PATHS = (
    Path("/var/lib/zhicui-downloads/releases/windows/beta.json"),
    Path(__file__).resolve().parents[3] / "frontend/public/download/releases/windows/beta.json",
)


def download_target(platform: str) -> str:
    """一次下载绑定一个版本，避免可变 latest 文件在断点续传时切到另一版。"""
    if platform not in PLATFORMS:
        raise ValueError("unsupported client platform")
    fallback = DOWNLOAD_TARGETS[platform]
    if platform != "windows":
        return fallback
    for path in _WINDOWS_MANIFEST_PATHS:
        try:
            with path.open("rb") as stream:
                raw = stream.read(65537)
        except FileNotFoundError:
            continue
        except OSError:
            return fallback
        # 首选持久清单存在但不完整时，不退回 runtime 中可能过时的版本。
        try:
            if len(raw) > 65536:
                return fallback
            manifest = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return fallback
        if not isinstance(manifest, dict):
            return fallback
        version = manifest.get("version")
        size = manifest.get("size_bytes")
        if (
            manifest.get("schema_version") != 2
            or manifest.get("platform") != "windows"
            or manifest.get("channel") != "beta"
            or manifest.get("architecture") != "x64"
            or manifest.get("availability") != "available"
            or manifest.get("release_status") != "beta_download"
            or not isinstance(version, str)
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
            or not isinstance(size, int) or isinstance(size, bool) or size <= 0
            or not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("sha256", "")))
            or not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("source_commit", "")))
        ):
            return fallback
        target = f"/download/windows/Zhicui-Setup-{version}-x64.exe"
        if manifest.get("download_url") != "https://luxai.cn" + target:
            return fallback
        return target
    return fallback


def local_today() -> date:
    return datetime.now(_LOCAL_TIMEZONE).date()


def record_download(db: Session, platform: str, *, day: date | None = None) -> None:
    """Atomically increment one platform/day aggregate."""
    if platform not in PLATFORMS:
        raise ValueError("unsupported client platform")
    target_day = day or local_today()
    result = db.execute(
        update(ClientDownloadDaily)
        .where(
            ClientDownloadDaily.day == target_day,
            ClientDownloadDaily.platform == platform,
        )
        .values(count=ClientDownloadDaily.count + 1)
    )
    if result.rowcount:
        db.commit()
        return
    try:
        db.add(ClientDownloadDaily(day=target_day, platform=platform, count=1))
        db.commit()
    except IntegrityError:
        db.rollback()
        db.execute(
            update(ClientDownloadDaily)
            .where(
                ClientDownloadDaily.day == target_day,
                ClientDownloadDaily.platform == platform,
            )
            .values(count=ClientDownloadDaily.count + 1)
        )
        db.commit()


def download_stats(db: Session, *, today: date | None = None) -> dict:
    target_day = today or local_today()
    start_14 = target_day - timedelta(days=13)
    rows = (
        db.query(
            ClientDownloadDaily.day,
            ClientDownloadDaily.platform,
            func.sum(ClientDownloadDaily.count),
        )
        .group_by(ClientDownloadDaily.day, ClientDownloadDaily.platform)
        .all()
    )
    by_platform = {"android": 0, "windows": 0}
    daily_totals: dict[date, int] = {}
    total = today_total = seven_day_total = 0
    seven_day_start = target_day - timedelta(days=6)
    for row_day, platform, raw_count in rows:
        count = int(raw_count or 0)
        total += count
        if platform in by_platform:
            by_platform[platform] += count
        if row_day == target_day:
            today_total += count
        if seven_day_start <= row_day <= target_day:
            seven_day_total += count
        if start_14 <= row_day <= target_day:
            daily_totals[row_day] = daily_totals.get(row_day, 0) + count
    daily = [
        {"date": (start_14 + timedelta(days=offset)).isoformat(), "count": daily_totals.get(start_14 + timedelta(days=offset), 0)}
        for offset in range(14)
    ]
    return {
        "total": total,
        "today": today_total,
        "last_7_days": seven_day_total,
        "by_platform": by_platform,
        "daily": daily,
    }
