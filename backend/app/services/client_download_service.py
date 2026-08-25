"""Count official client download starts without storing visitor identity."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.client_download_daily import ClientDownloadDaily


PLATFORMS = {"android", "windows"}
DOWNLOAD_TARGETS = {
    "android": "/download/zhicui.apk",
    "windows": "/download/Zhicui-Setup-1.0.3-x64.exe",
}
_LOCAL_TIMEZONE = ZoneInfo("Asia/Shanghai")


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
