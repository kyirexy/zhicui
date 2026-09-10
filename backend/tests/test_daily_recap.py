from __future__ import annotations

import json
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.daily_recap_routes import router
from app.core.auth import get_current_user
from app.core.database import Base, get_db
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.library_sync import LibrarySyncRun
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import daily_recap_service as recap
from app.services import note_service, platform_library_service, video_source_ledger_service


class _RecapFixture(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[
            User.__table__, Note.__table__, DouyinLocalLibraryItem.__table__,
            LibraryHiddenItem.__table__, LibrarySyncRun.__table__, VideoSourceLedger.__table__,
        ])
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.owner = User(id="owner", email="recap-owner@example.com", hashed_password="x")
        self.other = User(id="other", email="recap-other@example.com", hashed_password="x")
        self.db.add_all([self.owner, self.other])
        self.db.commit()
        self.reference = datetime(2026, 9, 10, 4, tzinfo=timezone.utc)
        self.stamp = datetime(2026, 9, 9, 4, tzinfo=timezone.utc)
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def daily(self, **kwargs):
        return recap.get_daily_recap(self.db, user_id="owner", reference_at=self.reference, **kwargs)

    def add(self, video_id="7000000000000000001", *, user_id="owner", modes=("collect",), stamp=None, ready=False):
        stamp = stamp or self.stamp
        if video_id.isdigit():
            snapshot = self.db.scalar(select(DouyinLocalLibraryItem).where(
                DouyinLocalLibraryItem.user_id == user_id, DouyinLocalLibraryItem.video_id == video_id,
            ))
            if snapshot is None:
                self.db.add(DouyinLocalLibraryItem(
                    user_id=user_id, video_id=video_id, title="样例视频", source_url=f"https://www.douyin.com/video/{video_id}",
                    cover_url="https://p3.douyinpic.com/example.jpg", author_name="样例作者",
                    published_at="2025-01-01T00:00:00Z", first_seen_at=stamp, last_seen_at=stamp,
                ))
        note = None
        if ready or video_id.startswith("BV"):
            note = note_service.create_transcript_note(
                self.db, user_id=user_id, video_info={"video_id": video_id, "title": "已有资料"},
                transcript="仅用于离线测试的完整文案" if ready else "",
                source_meta={
                    "platform": "bilibili" if video_id.startswith("BV") else "douyin", "source_mode": modes[0],
                    "source_kind": "platform-import" if video_id.startswith("BV") else "douyin-library",
                    "author_name": "样例作者", "cover_url": "https://i0.hdslb.com/example.jpg",
                    "transcript_source": "manual-subtitle" if ready else "caption-only", "speech_ready": ready,
                },
            )
        for mode in modes:
            self.db.add(VideoSourceLedger(
                user_id=user_id, video_id=video_id, note_id=note.id if note else None,
                source_mode=mode, source_rank=0, first_seen_at=stamp, last_seen_at=stamp, source_synced_at=stamp,
            ))
        self.db.commit()
        return note

    def add_run(self, *, video_ids, stamp=None, snapshot=None, platform="douyin", mode="collect", user_id="owner", status="succeeded"):
        token = uuid.uuid4().hex
        self.db.add(LibrarySyncRun(
            user_id=user_id, platform=platform, source_mode=mode,
            source_synced_at=snapshot or stamp or self.stamp,
            requested_count=len(video_ids), accepted=len(video_ids), coverage="limited", order_reliable=True,
            request_fingerprint=token * 2, idempotency_key=token * 2, status=status,
            video_ids_json=json.dumps(video_ids), started_at=stamp or self.stamp,
            finished_at=(stamp or self.stamp) + timedelta(seconds=10),
        ))
        self.db.commit()


class DailyRecapTests(_RecapFixture):
    def test_local_midnight_boundaries_and_default_yesterday(self):
        _, start, end = recap.day_window(reference_at=self.reference)
        self.assertEqual(start, datetime(2026, 9, 8, 16, tzinfo=timezone.utc))
        self.assertEqual(end - start, timedelta(days=1))
        self.add("7000000000000000001", stamp=start)
        self.add("7000000000000000002", stamp=start - timedelta(microseconds=1))
        self.add("7000000000000000003", stamp=end - timedelta(microseconds=1))
        self.add("7000000000000000004", stamp=end)
        result = self.daily()
        self.assertEqual(result["date"], "2026-09-09")
        self.assertEqual({item["video_id"] for item in result["items"]}, {"7000000000000000001", "7000000000000000003"})

    def test_dst_windows_do_not_assume_twenty_four_hours(self):
        for day, hours in [(date(2026, 3, 8), 23), (date(2026, 11, 1), 25)]:
            _, start, end = recap.day_window(target_date=day, timezone_name="America/New_York", reference_at=datetime(2026, 12, 1, tzinfo=timezone.utc))
            self.assertEqual(end - start, timedelta(hours=hours))

    def test_bad_timezone_and_future_date_are_rejected(self):
        for kwargs in [{"timezone_name": "../UTC"}, {"timezone_name": "Mars/Unknown"}, {"target_date": date(2027, 1, 1)}, {"limit": 101}, {"limit": True}]:
            with self.assertRaises(ValueError):
                self.daily(**kwargs)

    def test_repeat_sync_ai_edit_and_video_publication_do_not_move_first_discovery(self):
        self.add(stamp=self.stamp - timedelta(days=3), ready=True)
        video_source_ledger_service.upsert_source(
            self.db, user_id="owner", video_id="7000000000000000001", source_mode="collect",
            observed_at=self.stamp, source_synced_at=self.stamp, source_rank=0,
        )
        note = self.db.scalar(select(Note))
        note.updated_at = self.stamp
        note.ai_initialized = True
        self.db.scalar(select(DouyinLocalLibraryItem)).published_at = "2026-09-09T04:00:00Z"
        self.db.commit()
        self.assertEqual(self.daily()["total"], 0)

    def test_source_memberships_are_filtered_before_deduplicating_video(self):
        self.add(modes=("collect", "like"), ready=True)
        self.add("7000000000000000002", modes=("like",), stamp=self.stamp - timedelta(days=1))
        self.add("7000000000000000002", modes=("collect",))
        self.add("7000000000000000003", modes=("post",))
        result = self.daily()
        self.assertEqual((result["total"], result["collect_count"], result["like_count"]), (2, 2, 1))
        self.assertEqual(len(result["ready_note_ids"]), 1)
        self.assertEqual(result["ready_count"], 1)
        self.assertEqual(result["pending_count"], 1)

    def test_users_and_hidden_records_are_isolated(self):
        self.add(ready=True)
        self.add("7000000000000000002", ready=True)
        self.add("7000000000000000003", ready=True)
        self.add("7000000000000000004", user_id="other", ready=True)
        self.db.add_all([
            LibraryHiddenItem(user_id="owner", aweme_id="7000000000000000001", hide_mode="permanent"),
            LibraryHiddenItem(user_id="owner", aweme_id="7000000000000000002", hide_mode="temporary"),
            LibraryHiddenItem(user_id="other", aweme_id="7000000000000000003", hide_mode="permanent"),
        ])
        self.db.commit()
        result = self.daily()
        self.assertEqual([item["video_id"] for item in result["items"]], ["7000000000000000003"])
        self.assertEqual(result["total"], 1)

    def test_unavailable_or_quarantined_metadata_is_not_resurrected(self):
        self.add()
        self.add("7000000000000000002")
        rows = self.db.scalars(select(DouyinLocalLibraryItem).order_by(DouyinLocalLibraryItem.id)).all()
        rows[0].available = False
        rows[1].author_name = ""
        self.db.commit()
        self.assertEqual(self.daily()["total"], 0)

    def test_initial_snapshot_pages_are_labelled_without_claiming_action_date(self):
        first, second, later = ["7000000000000000001", "7000000000000000002", "7000000000000000003"]
        for value in (first, second, later):
            self.add(value)
        self.add_run(video_ids=[first], status="failed", stamp=self.stamp - timedelta(days=1))
        self.add_run(video_ids=[first])
        self.add_run(video_ids=[second], stamp=self.stamp + timedelta(minutes=1), snapshot=self.stamp)
        self.add_run(video_ids=[later], stamp=self.stamp + timedelta(minutes=2))
        result = self.daily()
        self.assertEqual(result["initial_import_count"], 2)
        self.assertEqual(result["time_basis"], "first_discovered")
        self.assertIn("首次历史导入", result["message"])
        self.assertNotIn("昨天点赞了", result["message"])

    def test_legacy_initial_import_uncertainty_is_explicit(self):
        self.add()
        result = self.daily()
        self.assertEqual(result["initial_import_unknown_count"], 1)
        self.assertFalse(result["items"][0]["initial_import_known"])
        self.assertEqual(result["initial_import_count"], 0)

    def test_partial_retry_finish_time_does_not_reassign_discovery_or_initial_snapshot(self):
        self.add()
        self.add_run(video_ids=["7000000000000000001"], status="partial")
        row = self.db.scalar(select(LibrarySyncRun))
        row.started_at = self.reference + timedelta(days=1)
        row.finished_at = row.started_at + timedelta(seconds=10)
        self.db.commit()
        result = self.daily()
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["initial_import_count"], 1)
        self.assertEqual(result["items"][0]["first_seen_at"], recap._iso(self.stamp))

    def test_bilibili_uses_ledger_and_old_notes_without_membership_time_are_excluded(self):
        self.add("BV1RECAP01", ready=True)
        note_service.create_transcript_note(
            self.db, user_id="owner", video_info={"video_id": "BV1OLD000", "title": "旧资料"},
            transcript="已有旧文案", source_meta={"platform": "bilibili", "source_mode": "collect", "first_seen_at": self.stamp.isoformat()},
        )
        result = self.daily()
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["platform"], "bilibili")
        self.assertTrue(result["items"][0]["transcript_ready"])

    def test_repeated_get_is_read_only_and_does_not_leak_transcript(self):
        self.add(ready=True)
        writes = []
        def capture(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().split(None, 1)[0].upper() in {"INSERT", "UPDATE", "DELETE"}:
                writes.append(statement)
        event.listen(self.engine, "before_cursor_execute", capture)
        try:
            first = self.daily()
            self.assertEqual(first, self.daily())
        finally:
            event.remove(self.engine, "before_cursor_execute", capture)
        self.assertEqual(writes, [])
        self.assertNotIn("仅用于离线测试的完整文案", json.dumps(first, ensure_ascii=False))

    def test_pagination_preserves_totals_and_exposes_truncation(self):
        for index in range(4):
            self.add(str(7000000000000000010 + index), ready=True)
        result = self.daily(limit=2)
        self.assertEqual((result["total"], result["ready_count"]), (4, 4))
        self.assertEqual(len(result["ready_note_ids"]), 2)
        self.assertEqual(len(result["preview"]), 2)
        self.assertTrue(result["has_more"])

    def test_http_auth_validation_and_no_store(self):
        self.assertEqual(self.client.get("/api/library/daily-recap").status_code, 401)
        self.app.dependency_overrides[get_current_user] = lambda: self.owner
        self.add()
        response = self.client.get("/api/library/daily-recap?date=2026-09-09")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["vary"], "Authorization")
        self.assertEqual(response.json()["data"]["total"], 1)
        for query in ["timezone=bad/zone", "date=garbage", "limit=101", "limit=0"]:
            self.assertEqual(self.client.get(f"/api/library/daily-recap?{query}").status_code, 422)
        self.app.dependency_overrides[get_current_user] = lambda: self.other
        self.assertEqual(self.client.get("/api/library/daily-recap?date=2026-09-09").json()["data"]["total"], 0)


class BilibiliDiscoveryTests(_RecapFixture):
    @staticmethod
    def metadata(mode="collect", stamp="2026-09-09T04:00:00Z", rank=0, reliable=True):
        return platform_library_service._with_source_order({
            "platform": "bilibili", "source_kind": "platform-import",
            "source_url": "https://www.bilibili.com/video/BV1RECAP01",
            "author_name": "样例UP", "cover_url": "https://i0.hdslb.com/example.jpg",
            "transcript_source": "manual-subtitle", "speech_ready": True,
        }, source_mode=mode, rank=rank, synced_at=stamp, reliable=reliable, coverage="limited")

    def save(self, **kwargs):
        return platform_library_service._save_or_refresh(
            self.db, user_id="owner", platform="bilibili",
            info={"video_id": "BV1RECAP01", "title": "样例教程"},
            transcript="完整样例文案", source_meta=self.metadata(**kwargs),
        )

    def test_new_source_and_repeat_preserve_server_first_seen(self):
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.stamp):
            note, reused = self.save()
        self.assertFalse(reused)
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.reference):
            self.save(stamp="2026-09-09T05:00:00Z")
        self.db.expire_all()
        row = self.db.scalar(select(VideoSourceLedger))
        self.assertEqual(recap._aware(row.first_seen_at), self.stamp)
        self.assertEqual(row.note_id, note.id)
        self.assertEqual(self.daily()["total"], 1)

    def test_collect_and_like_get_independent_first_discovery_dates(self):
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.stamp - timedelta(days=1)):
            self.save(mode="like", stamp="2026-09-08T04:00:00Z")
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.stamp):
            self.save(mode="collect")
        result = self.daily()
        self.assertEqual((result["total"], result["collect_count"], result["like_count"]), (1, 1, 0))

    def test_duplicate_and_unreliable_sync_keep_ledger_at_effective_source_rank(self):
        self.save(rank=3)
        self.save(rank=9)
        self.db.expire_all()
        row = self.db.scalar(select(VideoSourceLedger))
        self.assertEqual(row.source_rank, 3)
        previous_snapshot = row.source_synced_at
        self.save(rank=50, reliable=False, stamp="2026-09-09T05:00:00Z")
        self.db.expire_all()
        self.assertEqual(row.source_rank, 3)
        self.assertEqual(row.source_synced_at, previous_snapshot)

    def test_known_legacy_mode_does_not_invent_first_discovery_on_repeat(self):
        self.save()
        self.db.query(VideoSourceLedger).delete()
        self.db.commit()
        self.save(stamp="2026-09-09T05:00:00Z")
        self.assertEqual(self.db.query(VideoSourceLedger).count(), 0)

    def test_new_note_and_discovery_roll_back_together(self):
        with patch.object(video_source_ledger_service, "upsert_source", side_effect=RuntimeError("离线故障")):
            with self.assertRaisesRegex(RuntimeError, "离线故障"):
                self.save()
        self.db.rollback()
        self.assertEqual(self.db.query(Note).count(), 0)
        self.assertEqual(self.db.query(VideoSourceLedger).count(), 0)

    def test_existing_note_and_new_mode_roll_back_together(self):
        note, _ = self.save()
        before = note.ai_summary
        with patch.object(video_source_ledger_service, "upsert_source", side_effect=RuntimeError("离线故障")):
            with self.assertRaisesRegex(RuntimeError, "离线故障"):
                self.save(mode="like")
        self.db.rollback()
        self.db.refresh(note)
        self.assertEqual(note.ai_summary, before)
        self.assertEqual([row.source_mode for row in self.db.scalars(select(VideoSourceLedger))], ["collect"])

    def test_plain_import_refills_text_without_changing_source_order(self):
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.stamp):
            note, _ = self.save(mode="collect")
            self.save(mode="like", stamp="2026-09-09T04:01:00Z")
        before = json.loads(note.ai_summary)["source_meta"]
        ledgers_before = [row.to_dict() for row in self.db.scalars(select(VideoSourceLedger).order_by(VideoSourceLedger.id))]
        note.transcript_raw = "旧简介"
        payload = json.loads(note.ai_summary)
        payload["source_meta"]["speech_ready"] = False
        payload["source_meta"]["transcript_source"] = "caption-only"
        note.ai_summary = json.dumps(payload)
        self.db.commit()
        with patch.object(platform_library_service, "_extract_bilibili", return_value=(
            {"video_id": note.video_id, "title": "已补全的教程"}, "新的完整文案", self.metadata(),
        )):
            result = platform_library_service.import_one(
                self.db, user_id="owner", value="https://www.bilibili.com/video/BV1RECAP01",
            )
        self.assertEqual(result["status"], "reused")
        self.db.refresh(note)
        after = json.loads(note.ai_summary)["source_meta"]
        for key in (*platform_library_service._ORDER_MAP_FIELDS, *platform_library_service._ORDER_SCALAR_FIELDS, "source_mode", "source_modes", "first_seen_at"):
            self.assertEqual(after.get(key), before.get(key), key)
        self.assertEqual(note.transcript_raw, "新的完整文案")
        self.assertEqual(ledgers_before, [row.to_dict() for row in self.db.scalars(select(VideoSourceLedger).order_by(VideoSourceLedger.id))])

    def test_caption_only_bilibili_is_pending_and_can_be_refilled(self):
        with patch.object(video_source_ledger_service, "_utcnow", return_value=self.stamp):
            note, _ = self.save()
        payload = json.loads(note.ai_summary)
        payload["source_meta"]["speech_ready"] = False
        payload["source_meta"]["transcript_source"] = "caption-only"
        note.ai_summary = json.dumps(payload)
        self.db.commit()
        item = self.daily()["items"][0]
        self.assertFalse(item["transcript_ready"])
        self.assertTrue(item["needs_extraction"])
        self.assertTrue(item["can_extract"])


if __name__ == "__main__":
    unittest.main()
