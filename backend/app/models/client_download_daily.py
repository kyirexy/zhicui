"""Privacy-preserving daily aggregates for official client downloads."""

from datetime import date

from sqlalchemy import CheckConstraint, Date, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ClientDownloadDaily(Base):
    __tablename__ = "client_download_daily"
    __table_args__ = (
        UniqueConstraint("day", "platform", name="ux_client_download_day_platform"),
        CheckConstraint("count >= 0", name="ck_client_download_count_nonnegative"),
        Index("ix_client_download_day", "day"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
