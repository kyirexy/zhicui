"""验证文稿关联的账号隔离、就绪条件及事务边界。"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.creator_sync import CreatorSource, CreatorSourceItem, CreatorSyncRun, CreatorSyncRunItem
from app.models.note import Note
from app.models.user import User
from app.services.creator_note_link_service import link_ready_bilibili_note


class CreatorNoteLinkServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[
            User.__table__, Note.__table__, CreatorSource.__table__,
            CreatorSyncRun.__table__, CreatorSourceItem.__table__, CreatorSyncRunItem.__table__,
        ])
        self.db = sessionmaker(bind=self.engine, autoflush=False)()
        self.user = User(email="link@example.com", hashed_password="test")
        self.other = User(email="link-other@example.com", hashed_password="test")
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.number = 0
        self.source = self.make_source()
        self.note = self.make_note()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def make_source(self, *, user=None, platform="bilibili", status="active"):
        self.number += 1
        row = CreatorSource(
            user_id=(user or self.user).id, platform=platform,
            creator_id=str(10000 + self.number), profile_url=f"https://space.bilibili.com/{10000 + self.number}",
            display_name="测试博主", status=status,
        )
        self.db.add(row)
        self.db.commit()
        return row

    def make_note(self, *, user=None, video_id="BV1234567890", transcript="已验证的视频语音文稿"):
        self.number += 1
        row = Note(
            user_id=(user or self.user).id, video_id=video_id, video_title="测试视频",
            video_url=f"https://www.bilibili.com/video/{video_id}", transcript_raw=transcript,
            ai_summary=json.dumps({"source_meta": {
                "platform": "bilibili", "speech_ready": True,
                "transcript_source": "cloud-asr", "transcript_status": "ready",
            }}),
            seo_title="测试视频", seo_slug=f"link-note-{self.number}", seo_meta="",
        )
        self.db.add(row)
        self.db.commit()
        return row

    def make_item(self, *, source=None, user=None, **values):
        row = CreatorSourceItem(
            user_id=(user or self.user).id, source_id=(source or self.source).id,
            platform=values.pop("platform", "bilibili"),
            external_id=values.pop("external_id", self.note.video_id),
            title="测试视频", **values,
        )
        self.db.add(row)
        self.db.commit()
        return row

    def link(self, note=None, user=None):
        return link_ready_bilibili_note(self.db, user_id=(user or self.user).id, note=note or self.note)

    def test_links_all_owned_catalog_occurrences_without_changing_run_counts(self):
        first = self.make_item(state="failed", error_code="bilibili_risk_control")
        second = self.make_item(source=self.make_source())
        run = CreatorSyncRun(
            user_id=self.user.id, source_id=self.source.id, platform="bilibili",
            operation="catalog_recent", status="succeeded", requested_limit=20,
            discovered_count=20, checked_count=20, processed_count=0, new_count=0,
        )
        self.db.add(run)
        self.db.commit()
        original_run = run.to_dict()
        self.assertEqual(self.link(), 2)
        self.db.commit()
        for item in (first, second):
            self.assertEqual(item.note_id, self.note.id)
            self.assertEqual(item.to_dict()["transcript_status"], "imported")
            self.assertEqual((item.state, item.error_code), ("ready", ""))
        self.assertEqual(run.to_dict(), original_run)
        self.assertEqual(self.db.query(CreatorSyncRunItem).count(), 0)
        self.assertEqual(self.db.query(Note).count(), 1)
        self.assertEqual(self.db.query(CreatorSource).count(), 2)

    def test_rejects_another_users_note(self):
        item = self.make_item()
        self.assertEqual(self.link(note=self.make_note(user=self.other)), 0)
        self.assertEqual(self.link(user=self.other), 0)
        self.assertIsNone(item.note_id)

    def test_requires_matching_item_and_source_ownership_and_platform(self):
        excluded = [
            self.make_item(user=self.other),
            self.make_item(source=self.make_source(user=self.other)),
            self.make_item(source=self.make_source(platform="douyin")),
            self.make_item(platform="douyin"),
            self.make_item(external_id="BV0000000000"),
        ]
        own = self.make_item()
        self.assertEqual(self.link(), 1)
        self.assertEqual(own.note_id, self.note.id)
        self.assertTrue(all(item.note_id is None for item in excluded))

    def test_does_not_publish_pending_caption_only_or_unverified_transcripts(self):
        item = self.make_item()
        valid_meta = json.loads(self.note.ai_summary)["source_meta"]
        cases = [
            ("", {}), (" \n", {}), ("只有简介", {"speech_ready": False}),
            ("只有简介", {"speech_ready": "true"}), ("只有简介", {"speech_ready": 1}),
            ("只有简介", {"transcript_source": "caption-only"}),
            ("准备中", {"transcript_source": "pending"}),
            ("来源未验证", {"transcript_source": ""}),
            ("无音频", {"transcript_status": "no_audio"}),
            ("失败文稿", {"transcript_status": "failed"}),
            ("无效状态", {"transcript_status": []}),
            ("其他平台", {"platform": "douyin"}),
        ]
        for transcript, overrides in cases:
            with self.subTest(transcript=transcript, overrides=overrides):
                self.note.transcript_raw = transcript
                self.note.ai_summary = json.dumps({"source_meta": {**valid_meta, **overrides}})
                self.db.commit()
                self.assertEqual(self.link(), 0)
                self.assertIsNone(item.note_id)
                self.assertEqual(item.to_dict()["transcript_status"], "untranscribed")

    def test_accepts_verified_legacy_subtitles_without_optional_status(self):
        item = self.make_item()
        self.note.ai_summary = json.dumps({"source_meta": {
            "platform": "bilibili", "speech_ready": True, "transcript_source": "bilibili-subtitle",
        }})
        self.assertEqual(self.link(), 1)
        self.assertEqual(item.note_id, self.note.id)

    def test_keeps_removed_unavailable_and_quality_blocked_catalog_rows_unchanged(self):
        variants = [
            {"state": "removed"}, {"removed_at": datetime.now(timezone.utc)},
            {"is_available": False}, {"metadata_quality": "quarantined"},
            {"transcription_blocked": True},
        ]
        items = [self.make_item(source=self.make_source(), **values) for values in variants]
        items.append(self.make_item(source=self.make_source(status="disabled")))
        before = [item.to_dict() for item in items]
        self.assertEqual(self.link(), 0)
        self.assertEqual([item.to_dict() for item in items], before)

    def test_preserves_an_existing_other_note_link_and_is_idempotent(self):
        previous = self.make_note()
        existing = self.make_item(note_id=previous.id, state="ready")
        target = self.make_item(source=self.make_source())
        self.assertEqual(self.link(), 1)
        self.db.commit()
        self.assertEqual(existing.note_id, previous.id)
        self.assertEqual(target.note_id, self.note.id)
        self.assertEqual(self.link(), 0)
        self.assertFalse(self.db.dirty)

    def test_caller_can_roll_back_transcript_and_link_together(self):
        item = self.make_item()
        self.note.transcript_raw = ""
        self.db.commit()
        self.note.transcript_raw = "本次转写完成"
        self.assertEqual(self.link(), 1)
        self.db.flush()
        self.db.rollback()
        self.assertEqual(self.note.transcript_raw, "")
        self.assertIsNone(item.note_id)
        self.assertEqual(item.state, "discovered")

    def test_missing_catalog_never_creates_source_or_item(self):
        self.assertEqual(self.link(), 0)
        self.assertEqual(self.db.query(CreatorSource).count(), 1)
        self.assertEqual(self.db.query(CreatorSourceItem).count(), 0)

    def test_rejects_malformed_metadata_and_non_bvid_identity(self):
        item = self.make_item()
        for payload in ("invalid", "[]", '{"source_meta": []}', '{"source_meta": null}'):
            with self.subTest(payload=payload):
                self.note.ai_summary = payload
                self.assertEqual(self.link(), 0)
        self.note = self.make_note(video_id="not-a-bvid")
        self.assertEqual(self.link(), 0)
        self.assertIsNone(item.note_id)

    def test_rejects_detached_note(self):
        item = self.make_item()
        self.db.expunge(self.note)
        self.assertEqual(self.link(), 0)
        self.assertIsNone(item.note_id)


if __name__ == "__main__":
    unittest.main()
