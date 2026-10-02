"""手动同步清单的归属、时间和无转写路径回归。"""
from datetime import datetime, timedelta, timezone
import unittest
import uuid
from unittest.mock import patch

from sqlalchemy import select
from tests import test_agent_interface_v1 as fixtures
from app.core.config import settings
from app.core.database import Base
from app.models.agent_interface import ProductActionRun
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.library_sync import LibrarySyncRun
from app.models.media_extraction_outcome import MediaExtractionOutcome
from app.models.note import Note
from app.models.video_source_ledger import VideoSourceLedger
from app.services import agent_activity_service as activity, daily_recap_service, local_douyin_library_service, platform_library_service
from app.services.product_action_registry import registry
from app.services.product_action_run_service import ActionContext, ProductActionError, _validate_input


class AgentActivityTests(unittest.TestCase):
    def setUp(self):
        fixtures.AgentInterfaceV1Tests.setUp(self)
        Base.metadata.create_all(self.engine, tables=[
            DouyinLocalLibraryItem.__table__, LibrarySyncRun.__table__,
            MediaExtractionOutcome.__table__, VideoSourceLedger.__table__,
        ])
        self.settings = patch.multiple(settings, AGENT_INTERFACE_ENABLED=True,
            AGENT_INTERFACE_PROFILE="core", AGENT_INTERFACE_ACTION_ALLOWLIST="")
        self.settings.start()

    def tearDown(self):
        self.settings.stop()
        fixtures.AgentInterfaceV1Tests.tearDown(self)

    def context(self, user=None, stamp=None):
        user = user or self.user
        run = ProductActionRun(request_id=uuid.uuid4().hex, user_id=user.id,
            action_id="library.activity.record", run_type="long_task", execution_location="cloud",
            status="running", input_hash="0" * 64,
            created_at=stamp or datetime.now(timezone.utc))
        self.db.add(run); self.db.commit()
        return ActionContext(db=self.db, user=user, credential=None, run=run, request_id=run.request_id)

    def payload(self, mode="like", video_id="7659724478275947822"):
        return {"platform": "douyin", "mode": mode, "items": [{"video_id": video_id, "title": "真实作品标题", "author_name": "作者"}]}

    def test_metadata_only_reuses_note_and_preserves_first_seen(self):
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        with patch.object(activity.agent_video_link_service, "_public_info", side_effect=AssertionError("不应联网")):
            first = activity.record_snapshot(self.context(stamp=yesterday), self.payload())
            second = activity.record_snapshot(self.context(), self.payload())
        self.assertEqual(first["created"], 1)
        self.assertEqual(second["reused"], 1)
        self.assertEqual(first["items"][0]["first_seen_at"], second["items"][0]["first_seen_at"])
        self.assertFalse(second["transcribed"])
        self.assertEqual(self.db.query(Note).count(), 1)
        self.assertEqual(self.db.query(Note).first().transcript_raw, "")
        today = activity.get_recap(self.db, user_id=self.user.id, payload={"day": "today", "mode": "like"})
        old = activity.get_recap(self.db, user_id=self.user.id, payload={"day": "yesterday", "mode": "like"})
        self.assertEqual(today["total"], 0)
        self.assertEqual(old["total"], 1)
        self.assertEqual(old["pending_count"], 1)
        self.assertNotIn("cover_url", old["items"][0])

    def test_mode_platform_and_user_are_isolated(self):
        activity.record_snapshot(self.context(), self.payload("collect"))
        activity.record_snapshot(self.context(self.other), self.payload("like"))
        bili = {"platform": "bilibili", "mode": "like", "items": [{"video_id": "BV1234567890", "title": "B站作品"}]}
        activity.record_snapshot(self.context(), bili)
        data = activity.get_recap(self.db, user_id=self.user.id, payload={"day": "today", "mode": "like"})
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["items"][0]["platform"], "bilibili")
        only_douyin = activity.get_recap(self.db, user_id=self.user.id,
            payload={"day": "today", "mode": "like", "platform": "douyin"})
        self.assertEqual(only_douyin["total"], 0)
        self.assertEqual(self.db.query(Note).count(), 3)

    def test_hidden_item_stays_hidden(self):
        from app.models.library_hidden_item import LibraryHiddenItem
        self.db.add(LibraryHiddenItem(user_id=self.user.id, aweme_id="7659724478275947822"))
        self.db.commit()
        saved = activity.record_snapshot(self.context(), self.payload())
        self.assertEqual(saved["skipped"], 1)
        self.assertEqual(self.db.query(Note).count(), 0)

    def test_cli_douyin_snapshot_is_visible_in_home_catalog_without_transcription(self):
        saved = activity.record_snapshot(self.context(), self.payload())
        items = local_douyin_library_service.list_items(self.db, user_id=self.user.id, source_mode="like")
        self.assertEqual([item["aweme_id"] for item in items], saved["video_ids"])
        self.assertEqual(items[0]["provider"], "agent-sync")
        self.assertIsNone(items[0]["source_rank"])
        self.assertEqual(items[0]["cover_url"], "")
        self.assertEqual(local_douyin_library_service.list_items(self.db, user_id=self.user.id, source_mode="collect"), [])
        self.assertEqual(local_douyin_library_service.list_items(self.db, user_id=self.other.id, source_mode="like"), [])
        detail = local_douyin_library_service.get_item(self.db, user_id=self.user.id, video_id=saved["video_ids"][0])
        self.assertEqual(detail["title"], "真实作品标题")
        self.assertEqual(self.db.query(Note).first().transcript_raw, "")

    def test_bilibili_agent_catalog_retains_both_memberships_without_fake_ready_status(self):
        payload = {"platform": "bilibili", "mode": "like", "items": [{"video_id": "BV1234567890", "title": "B站作品"}]}
        first = activity.record_snapshot(self.context(), payload)
        activity.record_snapshot(self.context(), {**payload, "mode": "collect"})
        for mode in ("like", "collect"):
            notes = platform_library_service.list_notes(self.db, user_id=self.user.id, platform="bilibili", source_mode=mode)
            self.assertEqual([note.id for note in notes], [first["items"][0]["note_id"]])
            item = platform_library_service.serialize_item(notes[0], include_note=False)
            self.assertCountEqual(item["source_modes"], ["like", "collect"])
            self.assertFalse(item["speech_ready"])
            self.assertEqual(item["transcript_chars"], 0)
        self.assertEqual(platform_library_service.list_notes(self.db, user_id=self.other.id, platform="bilibili"), [])

    def test_cloud_sync_progress_is_observable_before_completion(self):
        progress = []
        original = activity.library_sync_service.update_run_progress
        def record(db, sync, result):
            original(db, sync, result)
            progress.append(activity.library_sync_service.list_runs(db, user_id=self.user.id)[0])
        payload = self.payload()
        payload["items"].append({"video_id": "7659724478275947999", "title": "第二条"})
        with patch.object(activity.library_sync_service, "update_run_progress", side_effect=record):
            activity.record_snapshot(self.context(), payload)
        self.assertEqual([item["accepted"] for item in progress], [1, 2])
        self.assertTrue(all(item["status"] == "running" for item in progress))
        self.assertEqual(progress[0]["pending_count"], 1)
        self.assertEqual(activity.library_sync_service.list_runs(self.db, user_id=self.user.id)[0]["status"], "succeeded")

    def test_platform_refusal_stops_remaining_metadata_requests(self):
        payload = {"platform": "bilibili", "mode": "like", "items": [{"video_id": "BV1234567890"}, {"video_id": "BV1234567891"}]}
        error = activity.agent_video_link_service.VideoLinkError("PLATFORM_AUTH_REQUIRED", "需要平台授权")
        with patch.object(activity.agent_video_link_service, "_public_info", side_effect=error) as parse:
            saved = activity.record_snapshot(self.context(), payload)
        self.assertEqual(saved["failed"], 2)
        self.assertEqual(parse.call_count, 1)
        self.assertEqual(self.db.query(Note).count(), 0)

    def test_cancel_and_disabled_account_stop_before_writes(self):
        ctx = self.context()
        ctx.run.cancellation_requested = True
        self.db.commit()
        with self.assertRaises(ProductActionError):
            activity.record_snapshot(ctx, self.payload())
        ctx = self.context()
        self.user.is_active = False; self.db.commit()
        with self.assertRaises(ProductActionError):
            activity.record_snapshot(ctx, self.payload())
        self.assertEqual(self.db.query(Note).count(), 0)

    def test_schema_rejects_backdating_media_and_foreign_identity(self):
        definition = registry.get("library.activity.record").input_schema
        for field, value in [("user_id", "other"), ("source_synced_at", "2020-01-01"), ("cookie", "secret")]:
            with self.subTest(field=field), self.assertRaises(ProductActionError):
                _validate_input(definition, {**self.payload(), field: value})
        payload = self.payload()
        payload["items"][0]["download_url"] = "https://evil.test/media"
        with self.assertRaises(ProductActionError):
            _validate_input(definition, payload)
        with self.assertRaises(ValueError):
            activity.record_snapshot(self.context(), self.payload(video_id="BV1234567890"))


if __name__ == "__main__":
    unittest.main()
