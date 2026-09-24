"""首页操作只改变本人偏好或知识库，不修改同步来源和视频资料。"""

import json
import unittest
import uuid
from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.home_video_routes import router
from app.core.auth import get_current_user
from app.core.database import Base, get_db
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.creator_sync import CreatorSource, CreatorSourceItem, CreatorSyncRun
from app.models.home_video_preference import HomeVideoPreference
from app.models.knowledge_entry import KnowledgeEntry
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import home_video_service as service
from app.services import knowledge_service


class HomeVideoActionsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        event.listen(self.engine, "connect", lambda connection, _: connection.execute("PRAGMA foreign_keys=ON"))
        Base.metadata.create_all(self.engine, tables=[User.__table__, Note.__table__, KnowledgeEntry.__table__,
            HomeVideoPreference.__table__, LibraryHiddenItem.__table__, DouyinLocalLibraryItem.__table__, VideoSourceLedger.__table__,
            CreatorSource.__table__, CreatorSyncRun.__table__, CreatorSourceItem.__table__])
        self.db = sessionmaker(bind=self.engine, expire_on_commit=False)()
        self.owner = User(id="owner", email="home-owner@example.invalid", hashed_password="x")
        self.other = User(id="other", email="home-other@example.invalid", hashed_password="x")
        self.db.add_all([self.owner, self.other]); self.db.commit()
        self.video_id = "7000000000000000001"
        self.db.add(DouyinLocalLibraryItem(user_id="owner", video_id=self.video_id, title="已有收藏视频",
            source_url=f"https://www.douyin.com/video/{self.video_id}", author_name="例子作者"))
        self.db.add(VideoSourceLedger(user_id="owner", video_id=self.video_id, source_mode="collect", source_rank=0))
        self.db.commit()
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[get_current_user] = lambda: self.owner
        app.dependency_overrides[get_db] = lambda: self.db
        self.app = app; self.client = TestClient(app)

    def tearDown(self):
        self.client.close(); self.db.close(); self.engine.dispose()

    def key(self, **values):
        return {"platform": "douyin", "video_id": self.video_id, **values}

    def note(self, *, user_id="owner", platform="bilibili", video_id="BV1234567890", ready=False):
        meta = {"source_meta": {"platform": platform, "author_name": "测试作者"}}
        if ready:
            meta["sections"] = [{"title": "真实要点", "content": "已有摘要正文"}]
        row = Note(user_id=user_id, video_id=video_id, video_title="已有视频资料", video_url=f"https://www.{platform}.com/video/{video_id}",
            transcript_raw="已有文稿，内容保持不变", ai_initialized=ready, ai_summary=json.dumps(meta),
            seo_title="已有视频", seo_slug=str(uuid.uuid4()), seo_meta="视频资料")
        self.db.add(row); self.db.commit(); return row

    def test_hide_persists_across_sessions_without_changing_source(self):
        snapshot = self.db.query(DouyinLocalLibraryItem).one()
        before = snapshot.updated_at, snapshot.title
        ledger = self.db.query(VideoSourceLedger).one()
        ledger_before = ledger.source_rank, ledger.first_seen_at, ledger.last_seen_at
        result = self.client.patch("/api/home/video-preferences", json=self.key(hidden=True))
        self.assertEqual(result.status_code, 200); self.assertTrue(result.json()["data"]["hidden"])
        self.assertEqual(result.headers["cache-control"], "private, no-store")
        fresh = sessionmaker(bind=self.engine)()
        try:
            self.assertTrue(service.list_preferences(fresh, "owner")[0]["hidden"])
            self.assertEqual(service.list_preferences(fresh, "other"), [])
        finally:
            fresh.close()
        self.assertEqual(self.db.query(DouyinLocalLibraryItem).count(), 1)
        self.assertEqual((snapshot.updated_at, snapshot.title), before)
        self.assertEqual((ledger.source_rank, ledger.first_seen_at, ledger.last_seen_at), ledger_before)

    def test_repeat_hide_and_restore_is_idempotent(self):
        for _ in range(3):
            self.client.patch("/api/home/video-preferences", json=self.key(hidden=True)).raise_for_status()
        self.assertEqual(self.db.query(HomeVideoPreference).count(), 1)
        result = self.client.patch("/api/home/video-preferences", json=self.key(hidden=False))
        self.assertFalse(result.json()["data"]["hidden"])

    def test_cannot_hide_or_save_another_users_video(self):
        self.app.dependency_overrides[get_current_user] = lambda: self.other
        self.assertEqual(self.client.patch("/api/home/video-preferences", json=self.key(hidden=True)).status_code, 404)
        self.assertEqual(self.client.post("/api/home/knowledge", json=self.key()).status_code, 404)
        self.assertEqual(self.db.query(HomeVideoPreference).count(), 0)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 0)

    def test_auth_required_for_every_action(self):
        self.app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.get("/api/home/video-preferences").status_code, 401)
        self.assertEqual(self.client.patch("/api/home/video-preferences", json=self.key(hidden=True)).status_code, 401)
        self.assertEqual(self.client.post("/api/home/knowledge", json=self.key()).status_code, 401)

    def test_unknown_video_does_not_create_preferences(self):
        result = self.client.patch("/api/home/video-preferences", json=self.key(video_id="7000000000000999999", hidden=True))
        self.assertEqual(result.status_code, 404)
        self.assertEqual(self.db.query(HomeVideoPreference).count(), 0)

    def test_invalid_identifiers_and_non_boolean_are_rejected(self):
        for body in [self.key(video_id="../1", hidden=True), self.key(platform="unknown", hidden=True), self.key(hidden="false")]:
            self.assertEqual(self.client.patch("/api/home/video-preferences", json=body).status_code, 422)

    def test_snapshot_without_transcript_can_be_saved_as_real_bookmark(self):
        response = self.client.post("/api/home/knowledge", json=self.key())
        self.assertEqual(response.status_code, 200)
        result = response.json()["data"]
        self.assertTrue(result["created"])
        self.assertIn(self.video_id, result["entry"]["content"])
        self.assertEqual(result["entry"]["title"], "已有收藏视频")
        self.assertEqual(result["entry"]["summary"], "已收藏的视频资料")
        self.assertEqual(self.db.query(Note).count(), 0)
        self.assertEqual(self.db.query(VideoSourceLedger).one().source_rank, 0)

    def test_repeat_save_reuses_entry_and_preserves_user_edits(self):
        first = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        entry = self.db.query(KnowledgeEntry).one(); entry.content = "用户整理后的正文"; self.db.commit()
        second = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.assertFalse(second["created"]); self.assertEqual(second["entry"]["id"], first["entry"]["id"])
        self.assertEqual(second["entry"]["content"], "用户整理后的正文")
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)

    def test_hide_and_save_do_not_cancel_each_other(self):
        service.set_hidden(self.db, "owner", "douyin", self.video_id, True)
        saved = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.assertTrue(saved["preference"]["hidden"])
        visible = service.set_hidden(self.db, "owner", "douyin", self.video_id, False)
        self.assertEqual(visible["knowledge_entry_id"], saved["entry"]["id"])

    def test_bilibili_note_without_ai_uses_existing_transcript(self):
        row = self.note()
        result = service.save_to_knowledge(self.db, "owner", "bilibili", row.video_id)
        self.assertEqual(result["entry"]["source_note_id"], row.id)
        self.assertIn(row.transcript_raw, result["entry"]["content"])
        self.assertFalse(row.ai_initialized)

    def test_ai_candidate_and_home_save_share_same_entry(self):
        row = self.note(ready=True)
        existing = knowledge_service.save_candidate(self.db, "owner", row.id)
        result = service.save_to_knowledge(self.db, "owner", "bilibili", row.video_id)
        self.assertFalse(result["created"]); self.assertEqual(result["entry"]["id"], existing.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)

    def test_home_save_uses_meaningful_ai_when_available(self):
        row = self.note(ready=True)
        result = service.save_to_knowledge(self.db, "owner", "bilibili", row.video_id)
        self.assertIn("已有摘要正文", result["entry"]["content"])

    def test_multiple_notes_prefer_real_summary_over_older_transcript(self):
        old = self.note()
        ready = self.note(ready=True)
        ready.created_at = old.created_at + timedelta(seconds=1)
        self.db.commit()
        result = service.save_to_knowledge(self.db, "owner", "bilibili", old.video_id)
        self.assertIn("已有摘要正文", result["entry"]["content"])
        self.assertEqual(result["entry"]["source_note_id"], ready.id)

    def test_multiple_notes_prefer_existing_transcript_over_empty_newer_note(self):
        transcript = self.note()
        empty = self.note()
        empty.transcript_raw = ""
        empty.created_at = transcript.created_at + timedelta(seconds=1)
        self.db.commit()
        result = service.save_to_knowledge(self.db, "owner", "bilibili", transcript.video_id)
        self.assertIn(transcript.transcript_raw, result["entry"]["content"])
        self.assertEqual(result["entry"]["source_note_id"], transcript.id)

    def test_existing_entry_from_any_matching_note_is_reused_without_rewriting_edits(self):
        old = self.note()
        ready = self.note(ready=True)
        ready.created_at = old.created_at + timedelta(seconds=1)
        # 模拟新版入口出现前已保存的知识页，尚无首页偏好关联。
        existing = KnowledgeEntry(user_id="owner", title="用户标题", content="用户编辑正文",
            source_note_id=ready.id, source_label="原来源", origin="video")
        self.db.add(existing); self.db.commit()
        result = service.save_to_knowledge(self.db, "owner", "bilibili", old.video_id)
        self.assertFalse(result["created"])
        self.assertEqual(result["entry"]["id"], existing.id)
        self.assertEqual(result["entry"]["content"], "用户编辑正文")
        self.assertEqual(result["entry"]["source_note_id"], ready.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)

    def test_bookmark_later_gains_real_source_without_replacing_user_content(self):
        first = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        entry = self.db.query(KnowledgeEntry).one()
        entry.title = "我的笔记"; entry.content = "用户已编辑"; self.db.commit()
        note = self.note(platform="douyin", video_id=self.video_id, ready=True)
        result = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.assertFalse(result["created"])
        self.assertEqual(result["entry"]["id"], first["entry"]["id"])
        self.assertEqual(result["entry"]["content"], "用户已编辑")
        self.assertEqual(result["entry"]["title"], "我的笔记")
        self.assertEqual(result["entry"]["source_note_id"], note.id)
        self.assertEqual(self.db.query(KnowledgeEntry).one().source_note_id, note.id)
        self.assertEqual(knowledge_service.save_candidate(self.db, "owner", note.id).id, entry.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)

    def test_candidate_directly_after_bookmark_reuses_it_without_another_home_click(self):
        first = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        entry = self.db.query(KnowledgeEntry).one()
        entry.content = "用户已整理的链接说明"; self.db.commit()
        note = self.note(platform="douyin", video_id=self.video_id, ready=True)
        saved = knowledge_service.save_candidate(self.db, "owner", note.id)
        self.assertEqual(saved.id, first["entry"]["id"])
        self.assertEqual(saved.content, "用户已整理的链接说明")
        self.assertEqual(saved.source_note_id, note.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)

    def test_two_meaningful_candidates_for_same_video_share_one_entry(self):
        old = self.note(ready=True)
        first = knowledge_service.save_candidate(self.db, "owner", old.id)
        first.content = "不覆盖第一份整理"; self.db.commit()
        newer = self.note(ready=True)
        second = knowledge_service.save_candidate(self.db, "owner", newer.id)
        result = service.save_to_knowledge(self.db, "owner", "bilibili", old.video_id)
        self.assertEqual(second.id, first.id)
        self.assertEqual(result["entry"]["source_note_id"], old.id)
        self.assertEqual(result["entry"]["content"], "不覆盖第一份整理")
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)
        inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
        self.assertEqual(inbox["items"], [])
        self.assertEqual(inbox["total"], 0)
        self.assertEqual(inbox["counts"], {"pages": 1, "inbox": 0})

    def test_deleted_entry_restores_all_meaningful_notes_for_same_video_to_inbox(self):
        first = self.note(ready=True)
        second = self.note(ready=True)
        entry = knowledge_service.save_candidate(self.db, "owner", first.id)
        self.assertEqual(knowledge_service.list_knowledge(self.db, "owner", view="inbox")["total"], 0)
        knowledge_service.delete_entry(self.db, entry)
        self.db.expire_all()
        inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
        self.assertEqual(inbox["total"], 2)
        self.assertEqual({item["id"] for item in inbox["items"]}, {first.id, second.id})
        self.assertIsNone(self.db.query(HomeVideoPreference).one().knowledge_entry_id)

    def test_saved_video_inbox_filter_is_scoped_to_both_platform_and_owner(self):
        saved_note = self.note(platform="douyin", video_id=self.video_id, ready=True)
        saved = knowledge_service.save_candidate(self.db, "owner", saved_note.id)
        other_platform = self.note(platform="bilibili", video_id=self.video_id, ready=True)
        other_owner = self.note(user_id="other", platform="douyin", video_id=self.video_id, ready=True)
        own_inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
        other_inbox = knowledge_service.list_knowledge(self.db, "other", view="inbox")
        self.assertEqual([item["id"] for item in own_inbox["items"]], [other_platform.id])
        self.assertEqual([item["id"] for item in other_inbox["items"]], [other_owner.id])
        self.assertEqual(saved.source_note_id, saved_note.id)

    def test_home_hidden_only_does_not_mark_note_saved_in_knowledge(self):
        note = self.note(platform="douyin", video_id=self.video_id, ready=True)
        service.set_hidden(self.db, "owner", "douyin", self.video_id, True)
        inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
        self.assertEqual(inbox["total"], 1)
        self.assertEqual(inbox["items"][0]["id"], note.id)

    def test_foreign_or_noncanonical_preference_link_cannot_hide_owned_inbox(self):
        note = self.note(ready=True)
        other = self.note(user_id="other", ready=True)
        foreign = knowledge_service.save_candidate(self.db, "other", other.id)
        preference = HomeVideoPreference(user_id="owner", platform="bilibili", video_id=note.video_id,
            knowledge_entry_id=foreign.id)
        self.db.add(preference); self.db.commit()
        self.assertEqual(knowledge_service.list_knowledge(self.db, "owner", view="inbox")["total"], 1)
        local_draft = KnowledgeEntry(user_id="owner", title="未入库页", content="仍未保存",
            source_label="测试", status="draft")
        self.db.add(local_draft); self.db.flush()
        preference.knowledge_entry_id = local_draft.id; self.db.commit()
        self.assertEqual(knowledge_service.list_knowledge(self.db, "owner", view="inbox")["total"], 1)
        self.assertIsNone(local_draft.source_note_id)

    def test_legacy_source_urls_use_actual_authority_not_query_or_lookalike_domain(self):
        original = self.note(ready=True)
        saved = knowledge_service.save_candidate(self.db, "owner", original.id)
        remaining = set()
        for url, is_saved_platform in [
            ("https://www.bilibili.com/video/shared", True),
            ("https://space.bilibili.com/video/shared", True),
            ("https://www.bilibili.com:443/video/shared", True),
            ("HTTPS://WWW.BILIBILI.COM/video/shared", True),
            ("https://b23.tv/shared", True),
            ("https://www.douyin.com/video/shared", False),
            ("https://bilibili.com.example.invalid/video/shared", False),
            ("https://example.invalid/?next=https://www.bilibili.com/video/shared", False),
            ("https://www.bilibili.com@evil.invalid/video/shared", False),
            ("https://bilibili.com:password@evil.invalid/video/shared", False),
        ]:
            with self.subTest(url=url):
                note = self.note(ready=True)
                note.ai_summary = json.dumps({"key_insight": "真实的旧资料摘要"})
                note.video_url = url
                self.db.commit()
                if not is_saved_platform:
                    remaining.add(note.id)
                inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
                self.assertEqual({item["id"] for item in inbox["items"]}, remaining)
                self.assertEqual(inbox["total"], len(remaining))
        self.assertEqual(saved.source_note_id, original.id)

    def test_explicit_platform_wins_over_conflicting_url_for_inbox_filter(self):
        original = self.note(ready=True)
        knowledge_service.save_candidate(self.db, "owner", original.id)
        other_platform = self.note(platform="douyin", video_id=original.video_id, ready=True)
        other_platform.video_url = original.video_url
        self.db.commit()
        inbox = knowledge_service.list_knowledge(self.db, "owner", view="inbox")
        self.assertEqual([item["id"] for item in inbox["items"]], [other_platform.id])

    def test_existing_bookmark_does_not_make_unready_candidate_eligible(self):
        service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        note = self.note(platform="douyin", video_id=self.video_id, ready=False)
        with self.assertRaisesRegex(ValueError, "没有可整理的 AI 摘要"):
            knowledge_service.save_candidate(self.db, "owner", note.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 1)
        self.assertIsNone(self.db.query(KnowledgeEntry).one().source_note_id)

    def test_same_video_other_owner_knowledge_entry_is_never_reused(self):
        other = self.note(user_id="other", ready=True)
        other_entry = knowledge_service.save_candidate(self.db, "other", other.id)
        own = self.note(ready=True)
        result = service.save_to_knowledge(self.db, "owner", "bilibili", own.video_id)
        self.assertNotEqual(result["entry"]["id"], other_entry.id)
        self.assertEqual(result["entry"]["source_note_id"], own.id)
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 2)

    def test_deleted_source_can_rebind_to_new_owned_note_without_replacing_page(self):
        old = self.note(ready=True)
        first = service.save_to_knowledge(self.db, "owner", "bilibili", old.video_id)
        entry = self.db.query(KnowledgeEntry).one(); entry.content = "我的整理"
        self.db.delete(old); self.db.commit(); self.db.expire_all()
        newer = self.note(ready=True)
        result = service.save_to_knowledge(self.db, "owner", "bilibili", newer.video_id)
        self.assertEqual(result["entry"]["id"], first["entry"]["id"])
        self.assertEqual(result["entry"]["source_note_id"], newer.id)
        self.assertEqual(result["entry"]["content"], "我的整理")

    def test_legacy_duplicate_does_not_merge_user_pages_or_report_false_source(self):
        first = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        note = self.note(platform="douyin", video_id=self.video_id, ready=True)
        # 旧版本可能已有两页；修复只防止新重复，不能擅自删除或覆盖任一用户正文。
        legacy = KnowledgeEntry(user_id="owner", title="另一份整理", content="另一份用户正文",
            source_note_id=note.id, source_label="原来源", origin="video")
        self.db.add(legacy); self.db.commit()
        result = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.assertEqual(result["entry"]["id"], first["entry"]["id"])
        self.assertIsNone(result["entry"]["source_note_id"])
        self.assertIsNone(self.db.query(KnowledgeEntry).filter_by(id=first["entry"]["id"]).one().source_note_id)
        self.assertEqual(self.db.query(KnowledgeEntry).filter_by(id=legacy.id).one().content, "另一份用户正文")
        self.assertEqual(self.db.query(KnowledgeEntry).count(), 2)

    def test_privacy_export_includes_only_owned_home_preferences(self):
        from app.services.privacy_account_service import _EXPORT_GROUPS, _safe_table_rows
        service.set_hidden(self.db, "owner", "douyin", self.video_id, True)
        self.assertIn("home_video_preferences", _EXPORT_GROUPS["video_library"])
        own = _safe_table_rows(self.db, "home_video_preferences", "owner")
        self.assertEqual(len(own), 1)
        self.assertTrue(own[0]["hidden"])
        self.assertNotIn("user_id", own[0])
        self.assertEqual(_safe_table_rows(self.db, "home_video_preferences", "other"), [])

    def test_account_cleanup_removes_home_preferences_in_dependency_order_only_for_owner(self):
        from app.services.privacy_account_service import _delete_user_related_rows
        service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        service.set_hidden(self.db, "owner", "douyin", self.video_id, True)
        other_note = self.note(user_id="other", ready=True)
        other_entry = service.save_to_knowledge(self.db, "other", "bilibili", other_note.video_id)
        deleted = _delete_user_related_rows(self.db, "owner")
        self.db.commit(); self.db.expire_all()
        self.assertEqual(deleted["home_video_preferences"], 1)
        self.assertEqual(service.list_preferences(self.db, "owner"), [])
        self.assertEqual(len(service.list_preferences(self.db, "other")), 1)
        self.assertEqual(self.db.query(KnowledgeEntry).one().id, other_entry["entry"]["id"])

    def test_deleted_knowledge_entry_can_be_saved_again(self):
        first = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.db.delete(self.db.query(KnowledgeEntry).one()); self.db.commit(); self.db.expire_all()
        second = service.save_to_knowledge(self.db, "owner", "douyin", self.video_id)
        self.assertTrue(second["created"]); self.assertNotEqual(first["entry"]["id"], second["entry"]["id"])

    def test_source_deleted_can_still_restore_personal_visibility(self):
        service.set_hidden(self.db, "owner", "douyin", self.video_id, True)
        self.db.query(VideoSourceLedger).delete(); self.db.query(DouyinLocalLibraryItem).delete(); self.db.commit()
        self.assertFalse(service.set_hidden(self.db, "owner", "douyin", self.video_id, False)["hidden"])

    def test_list_is_private_no_store(self):
        result = self.client.get("/api/home/video-preferences")
        self.assertEqual(result.status_code, 200); self.assertEqual(result.json()["data"], {"items": []})
        self.assertEqual(result.headers["vary"], "Authorization")


if __name__ == "__main__":
    unittest.main()
