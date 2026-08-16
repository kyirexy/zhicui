"""聊天模型免费额度与萃点预留、结算、释放。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.models.chat_model import (
    ChatModelChargeReservation,
    ChatModelFreeUsage,
    ChatModelOffering,
)
from app.services import video_analysis_billing_service as credits


@dataclass(frozen=True)
class ChatCharge:
    request_id: str
    offering_id: str
    user_id: str
    kind: str
    points: int = 0


def _lock(query, db: Session):
    if db.bind is not None and db.bind.dialect.name != "sqlite":
        return query.with_for_update()
    return query


def _today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def _free_row(db: Session, user_id: str, offering_id: str) -> ChatModelFreeUsage:
    query = db.query(ChatModelFreeUsage).filter(
        ChatModelFreeUsage.user_id == user_id,
        ChatModelFreeUsage.offering_id == offering_id,
        ChatModelFreeUsage.period_date == _today(),
    )
    row = _lock(query, db).first()
    if row is None:
        row = ChatModelFreeUsage(
            user_id=user_id, offering_id=offering_id, period_date=_today()
        )
        db.add(row)
        db.flush()
    return row


def _reservation(db: Session, request_id: str, *, lock: bool = False) -> ChatModelChargeReservation | None:
    query = db.query(ChatModelChargeReservation).filter(
        ChatModelChargeReservation.request_id == request_id
    )
    return _lock(query, db).first() if lock else query.first()


def reserve(db: Session, *, user_id: str, offering: ChatModelOffering, request_id: str) -> ChatCharge:
    existing = _reservation(db, request_id, lock=True)
    if existing is not None:
        return ChatCharge(
            existing.request_id,
            existing.offering_id,
            existing.user_id,
            existing.kind,
            int(existing.points or 0),
        )

    if offering.is_free:
        row = _free_row(db, user_id, offering.id)
        limit = max(0, int(offering.free_daily_limit or 0))
        if limit and int(row.used_count or 0) + int(row.reserved_count or 0) >= limit:
            raise ValueError("今天的免费次数已用完，请明天再试或选择收费模型")
        row.reserved_count = int(row.reserved_count or 0) + 1
        db.add(ChatModelChargeReservation(
            request_id=request_id,
            user_id=user_id,
            offering_id=offering.id,
            kind="free",
            points=0,
        ))
        db.commit()
        return ChatCharge(request_id, offering.id, user_id, "free")

    points = max(0, int(offering.points_per_request or 0))
    if points == 0:
        db.add(ChatModelChargeReservation(
            request_id=request_id,
            user_id=user_id,
            offering_id=offering.id,
            kind="zero",
            points=0,
        ))
        db.commit()
        return ChatCharge(request_id, offering.id, user_id, "zero")
    key = f"chat:reserve:{request_id}"
    if credits._ledger_entry(db, key) is not None:
        db.add(ChatModelChargeReservation(
            request_id=request_id,
            user_id=user_id,
            offering_id=offering.id,
            kind="paid",
            points=points,
        ))
        db.commit()
        return ChatCharge(request_id, offering.id, user_id, "paid", points)
    account = credits.get_or_create_account(db, user_id, lock=True)
    if int(account.available_points or 0) < points:
        raise ValueError(f"萃点不足，本次需要 {points} 萃点，请选择免费模型")
    account.available_points = int(account.available_points or 0) - points
    account.reserved_points = int(account.reserved_points or 0) + points
    account.version = int(account.version or 0) + 1
    credits._append_ledger(
        db, account,
        entry_type="reserve",
        available_delta=-points,
        reserved_delta=points,
        idempotency_key=key,
        reason=f"聊天模型预留：{offering.name}",
        metadata={"scope": "chat", "points": points, "offering_id": offering.id, "request_id": request_id},
    )
    db.add(ChatModelChargeReservation(
        request_id=request_id,
        user_id=user_id,
        offering_id=offering.id,
        kind="paid",
        points=points,
    ))
    db.commit()
    return ChatCharge(request_id, offering.id, user_id, "paid", points)


def capture(db: Session, charge: ChatCharge) -> None:
    reservation = _reservation(db, charge.request_id, lock=True)
    if reservation is not None and reservation.state != "reserved":
        return
    if charge.kind == "free":
        row = _free_row(db, charge.user_id, charge.offering_id)
        if int(row.reserved_count or 0) > 0:
            row.reserved_count = int(row.reserved_count or 0) - 1
            row.used_count = int(row.used_count or 0) + 1
            if reservation is not None:
                reservation.state = "captured"
            db.commit()
        return
    if charge.kind != "paid" or charge.points <= 0:
        if reservation is not None:
            reservation.state = "captured"
            db.commit()
        return
    key = f"chat:capture:{charge.request_id}"
    if credits._ledger_entry(db, key) is not None:
        if reservation is not None:
            reservation.state = "captured"
            db.commit()
        return
    account = credits.get_or_create_account(db, charge.user_id, lock=True)
    points = min(charge.points, int(account.reserved_points or 0))
    account.reserved_points = int(account.reserved_points or 0) - points
    account.version = int(account.version or 0) + 1
    credits._append_ledger(
        db, account,
        entry_type="capture",
        available_delta=0,
        reserved_delta=-points,
        idempotency_key=key,
        reason="聊天回答结算",
        metadata={"scope": "chat", "points": points, "offering_id": charge.offering_id, "request_id": charge.request_id},
    )
    if reservation is not None:
        reservation.state = "captured"
    db.commit()


def release(db: Session, charge: ChatCharge) -> None:
    reservation = _reservation(db, charge.request_id, lock=True)
    if reservation is not None and reservation.state != "reserved":
        return
    if charge.kind == "free":
        row = _free_row(db, charge.user_id, charge.offering_id)
        if int(row.reserved_count or 0) > 0:
            row.reserved_count = int(row.reserved_count or 0) - 1
            if reservation is not None:
                reservation.state = "released"
            db.commit()
        return
    if charge.kind != "paid" or charge.points <= 0:
        if reservation is not None:
            reservation.state = "released"
            db.commit()
        return
    key = f"chat:release:{charge.request_id}"
    if credits._ledger_entry(db, key) is not None:
        if reservation is not None:
            reservation.state = "released"
            db.commit()
        return
    account = credits.get_or_create_account(db, charge.user_id, lock=True)
    points = min(charge.points, int(account.reserved_points or 0))
    account.reserved_points = int(account.reserved_points or 0) - points
    account.available_points = int(account.available_points or 0) + points
    account.version = int(account.version or 0) + 1
    credits._append_ledger(
        db, account,
        entry_type="release",
        available_delta=points,
        reserved_delta=-points,
        idempotency_key=key,
        reason="聊天回答失败，释放预留",
        metadata={"scope": "chat", "points": points, "offering_id": charge.offering_id, "request_id": charge.request_id},
    )
    if reservation is not None:
        reservation.state = "released"
    db.commit()


def account_summary(db: Session, user_id: str) -> dict:
    return credits.serialize_account(db, credits.get_or_create_account(db, user_id), ledger_limit=10)
