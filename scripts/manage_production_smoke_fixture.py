#!/usr/bin/env python3
"""Provision and remove the isolated production Agent smoke fixture.

The fixture belongs to one reserved, non-admin account and is removed after
every deployment gate.  It never creates users and it refuses to overwrite a
row that is not already marked as this fixture.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy.orm import Session  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.models.agent_thread import AgentThread  # noqa: E402
from app.models.note import Note  # noqa: E402
from app.models.user import User  # noqa: E402


EXPECTED_USERNAME = "zhicui_production_smoke"
FIXTURE_MARKER = "zhicui-production-agent-smoke-v1"
FIXTURE_VIDEO_ID = "internal-production-smoke-video-v1"
THREAD_TITLE_PREFIX = "[production-smoke]"
SENTINEL_TOKEN = "ZHICUI-SMOKE-94731"
FIXTURE_NAMESPACE = uuid.UUID("5b6cb405-2fe8-4e3f-8aaa-7cff84094731")
FIXTURE_TRANSCRIPT = (
    "这是知萃生产发布冒烟专用的固定视频文稿，不属于任何真实用户内容。"
    "视频中，测试员把一张标有“琥珀火车”的卡片放在桌面上。"
    f"唯一哨兵事实：琥珀火车的校验编号是 {SENTINEL_TOKEN}。"
    "除此之外，视频没有给出其他校验编号。"
)


def fixture_id_for_user(user_id: str) -> str:
    return str(uuid.uuid5(FIXTURE_NAMESPACE, str(user_id)))


def _summary_payload() -> str:
    return json.dumps(
        {
            "sections": [
                {
                    "title": "部署哨兵事实",
                    "content": f"琥珀火车的校验编号是 {SENTINEL_TOKEN}。",
                }
            ],
            "conclusion": f"固定校验编号：{SENTINEL_TOKEN}",
            "generation_status": "ready",
            "source_meta": {
                "platform": "internal",
                "source_kind": "production_smoke_fixture",
                "source_mode": "isolated_fixture",
                "internal_smoke_fixture": FIXTURE_MARKER,
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _is_owned_fixture(note: Note) -> bool:
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    source_meta = payload.get("source_meta") if isinstance(payload, dict) else None
    return (
        isinstance(source_meta, dict)
        and source_meta.get("internal_smoke_fixture") == FIXTURE_MARKER
        and note.video_id == FIXTURE_VIDEO_ID
    )


def _reserved_user(
    db: Session,
    email: str,
    *,
    required: bool,
    require_safe_role: bool,
) -> User | None:
    normalized = email.strip().lower()
    user = db.query(User).filter(User.email == normalized).first()
    if user is None:
        if required:
            raise RuntimeError("专用生产冒烟账号不存在；请先创建普通账号")
        return None
    if user.username != EXPECTED_USERNAME:
        raise RuntimeError(
            f"冒烟账号用户名必须固定为 {EXPECTED_USERNAME}，拒绝使用真实用户账号"
        )
    if require_safe_role:
        if not bool(user.is_active):
            raise RuntimeError("专用生产冒烟账号已停用")
        if bool(user.is_admin):
            raise RuntimeError("专用生产冒烟账号不得拥有管理员权限")
    return user


def _delete_smoke_threads(db: Session, user_id: str) -> int:
    threads = (
        db.query(AgentThread)
        .filter(
            AgentThread.user_id == user_id,
            AgentThread.title.like(f"{THREAD_TITLE_PREFIX}%"),
        )
        .all()
    )
    for thread in threads:
        db.delete(thread)
    return len(threads)


def ensure_fixture(db: Session, email: str) -> Note:
    user = _reserved_user(
        db,
        email,
        required=True,
        require_safe_role=True,
    )
    assert user is not None
    fixture_id = fixture_id_for_user(str(user.id))
    _delete_smoke_threads(db, str(user.id))

    candidates = (
        db.query(Note)
        .filter(
            Note.user_id == user.id,
            (Note.id == fixture_id) | (Note.video_id == FIXTURE_VIDEO_ID),
        )
        .all()
    )
    if len(candidates) > 1:
        raise RuntimeError("检测到重复冒烟资料；拒绝猜测或覆盖")
    if candidates and not _is_owned_fixture(candidates[0]):
        raise RuntimeError("固定冒烟资料标识与真实资料冲突；拒绝覆盖")

    note = candidates[0] if candidates else Note(id=fixture_id, user_id=user.id)
    note.video_id = FIXTURE_VIDEO_ID
    note.video_title = "生产冒烟固定视频：琥珀火车校验"
    note.video_url = "https://luxai.cn/internal/production-smoke-fixture"
    note.transcript_raw = FIXTURE_TRANSCRIPT
    note.ai_summary = _summary_payload()
    note.ai_initialized = True
    note.card_type = "general"
    note.seo_title = "生产冒烟固定视频"
    note.seo_slug = f"production-smoke-{fixture_id.replace('-', '')[-16:]}"
    note.seo_meta = "仅供知萃生产发布自动验证使用的隔离资料"
    note.pitfall_rating = 1
    if not candidates:
        db.add(note)
    db.commit()
    db.refresh(note)
    return note


def cleanup_fixture(db: Session, email: str) -> tuple[int, int]:
    user = _reserved_user(
        db,
        email,
        required=False,
        # Once a marked fixture exists, cleanup must still work if an
        # operator disables or changes the role of the reserved account.
        require_safe_role=False,
    )
    if user is None:
        return 0, 0
    thread_count = _delete_smoke_threads(db, str(user.id))
    notes = (
        db.query(Note)
        .filter(
            Note.user_id == user.id,
            Note.video_id == FIXTURE_VIDEO_ID,
        )
        .all()
    )
    for note in notes:
        if not _is_owned_fixture(note):
            raise RuntimeError("发现同名但未标记的真实资料；拒绝删除")
        db.delete(note)
    db.commit()
    return thread_count, len(notes)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("ensure", "cleanup"))
    parser.add_argument("--email", required=True)
    args = parser.parse_args()

    with SessionLocal() as db:
        if args.action == "ensure":
            note = ensure_fixture(db, args.email)
            # stdout is machine-readable and deliberately contains no account data.
            print(note.id)
        else:
            threads, notes = cleanup_fixture(db, args.email)
            print(json.dumps({"threads_removed": threads, "notes_removed": notes}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"生产冒烟资料管理失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from exc
