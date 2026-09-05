from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.creator_sync import (
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
)
from app.models.note import Note
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services import creator_connectors, creator_sync_service, settings_service


class CreatorProfileValidationTests(unittest.TestCase):
    def test_canonical_profiles_and_ids_are_normalized(self) -> None:
        self.assertEqual(
            creator_connectors.normalize_profile_ref(
                "bilibili", "https://space.bilibili.com/12345/video"
            )["creator_id"],
            "12345",
        )
        self.assertEqual(
            creator_connectors.normalize_profile_ref(
                "douyin", "MS4wLjABAAAAexample_1234"
            )["profile_url"],
            "https://www.douyin.com/user/MS4wLjABAAAAexample_1234",
        )
        self.assertEqual(
            creator_connectors.normalize_profile_ref(
                "xiaohongshu", "https://www.xiaohongshu.com/user/profile/abcdef123456"
            )["creator_id"],
            "abcdef123456",
        )

    def test_non_official_hosts_and_credentials_are_rejected(self) -> None:
        for value in (
            "http://127.0.0.1/user/123456789012",
            "https://www.douyin.com.evil.test/user/123456789012",
            "https://name:password@www.douyin.com/user/123456789012",
        ):
            with self.subTest(value=value):
                with self.assertRaises(creator_connectors.CreatorConnectorError) as raised:
                    creator_connectors.normalize_profile_ref("douyin", value)
                self.assertIn(raised.exception.code, {"ssrf_rejected", "invalid_profile"})

    def test_official_short_link_is_followed_with_bounded_redirects(self) -> None:
        response = SimpleNamespace(
            status_code=302,
            headers={"location": "https://www.douyin.com/user/MS4wLjABAAAAexample_1234"},
        )
        final = SimpleNamespace(status_code=200, headers={})
        session = SimpleNamespace(get=unittest.mock.Mock(side_effect=[response, final]), close=lambda: None)
        with (
            patch.object(creator_connectors.requests, "Session", return_value=session),
            patch.object(creator_connectors, "_assert_public_host"),
        ):
            result = creator_connectors.normalize_profile_ref(
                "douyin", "https://v.douyin.com/short-code/"
            )
        self.assertEqual(result["creator_id"], "MS4wLjABAAAAexample_1234")
        self.assertEqual(session.get.call_count, 2)


class CreatorSyncServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                Note.__table__,
                SystemSetting.__table__,
                CreatorSource.__table__,
                CreatorSourceItem.__table__,
                CreatorSyncRun.__table__,
                CreatorSyncRunItem.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(email="creator@example.com", hashed_password="x")
        self.other_user = User(email="creator-other@example.com", hashed_password="x")
        self.db.add_all([self.user, self.other_user])
        self.db.commit()
        settings_service.set_setting(
            self.db, settings_service.CREATOR_SYNC_ENABLED_KEY, "true"
        )
        settings_service.set_setting(
            self.db,
            settings_service.CREATOR_SYNC_HEALTH_KEYS["bilibili"],
            "true",
        )

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def preview() -> dict[str, str]:
        return {
            "platform": "bilibili",
            "creator_id": "12345",
            "profile_url": "https://space.bilibili.com/12345/video",
            "display_name": "测试 UP",
            "avatar_url": "https://i.example/avatar.jpg",
        }

    def test_duplicate_save_and_active_run_are_idempotent(self) -> None:
        with patch.object(
            creator_connectors, "resolve_creator", return_value=self.preview()
        ):
            first, first_reused = creator_sync_service.save_source(
                self.db,
                user_id=self.user.id,
                platform="bilibili",
                profile_ref="12345",
            )
            second, second_reused = creator_sync_service.save_source(
                self.db,
                user_id=self.user.id,
                platform="bilibili",
                profile_ref="12345",
            )
        self.assertFalse(first_reused)
        self.assertTrue(second_reused)
        self.assertEqual(first.id, second.id)

        run, reused = creator_sync_service.create_run(
            self.db, user_id=self.user.id, source_id=first.id, limit=50
        )
        same_run, second_reused = creator_sync_service.create_run(
            self.db, user_id=self.user.id, source_id=first.id, limit=100
        )
        self.assertFalse(reused)
        self.assertTrue(second_reused)
        self.assertEqual(run.id, same_run.id)
        self.assertEqual(same_run.requested_limit, 50)

    def test_sources_are_user_scoped(self) -> None:
        source = CreatorSource(user_id=self.user.id, **self.preview())
        self.db.add(source)
        self.db.commit()
        self.assertEqual(len(creator_sync_service.list_sources(self.db, user_id=self.user.id)), 1)
        self.assertEqual(len(creator_sync_service.list_sources(self.db, user_id=self.other_user.id)), 0)
        self.assertFalse(creator_sync_service.disable_source(
            self.db, user_id=self.other_user.id, source_id=source.id
        ))

    def test_source_list_only_returns_user_owned_ready_note_ids(self) -> None:
        source = CreatorSource(user_id=self.user.id, **self.preview())
        other_source = CreatorSource(
            user_id=self.other_user.id,
            platform="bilibili",
            creator_id="67890",
            profile_url="https://space.bilibili.com/67890/video",
            display_name="其他 UP",
            avatar_url="",
        )
        self.db.add_all([source, other_source])
        self.db.flush()
        ready_note = Note(
            user_id=self.user.id,
            video_id="BV1READY",
            video_title="已就绪视频",
            video_url="https://www.bilibili.com/video/BV1READY",
            transcript_raw="完整文稿",
            seo_title="已就绪视频",
            seo_slug="ready-video",
            seo_meta="已就绪视频",
        )
        empty_note = Note(
            user_id=self.user.id,
            video_id="BV1EMPTY",
            video_title="无文稿视频",
            video_url="https://www.bilibili.com/video/BV1EMPTY",
            transcript_raw="",
            seo_title="无文稿视频",
            seo_slug="empty-video",
            seo_meta="无文稿视频",
        )
        foreign_note = Note(
            user_id=self.other_user.id,
            video_id="BV1FOREIGN",
            video_title="其他用户视频",
            video_url="https://www.bilibili.com/video/BV1FOREIGN",
            transcript_raw="其他用户完整文稿",
            seo_title="其他用户视频",
            seo_slug="foreign-video",
            seo_meta="其他用户视频",
        )
        self.db.add_all([ready_note, empty_note, foreign_note])
        self.db.flush()
        self.db.add_all([
            CreatorSourceItem(
                user_id=self.user.id,
                source_id=source.id,
                note_id=ready_note.id,
                platform="bilibili",
                external_id="BV1READY",
                state="ready",
            ),
            CreatorSourceItem(
                user_id=self.user.id,
                source_id=source.id,
                note_id=empty_note.id,
                platform="bilibili",
                external_id="BV1EMPTY",
                state="ready",
            ),
            CreatorSourceItem(
                user_id=self.other_user.id,
                source_id=other_source.id,
                note_id=foreign_note.id,
                platform="bilibili",
                external_id="BV1FOREIGN",
                state="ready",
            ),
        ])
        self.db.commit()

        result = creator_sync_service.list_sources(self.db, user_id=self.user.id)

        self.assertEqual(result[0]["ready_note_ids"], [ready_note.id])
        self.assertEqual(result[0]["transcript_count"], 1)

    def test_removed_work_is_skipped_without_import(self) -> None:
        source = CreatorSource(user_id=self.user.id, **self.preview())
        self.db.add(source)
        self.db.commit()
        item = CreatorSourceItem(
            user_id=self.user.id,
            source_id=source.id,
            platform="bilibili",
            external_id="BV1REMOVED",
            source_url="https://www.bilibili.com/video/BV1REMOVED",
            state="removed",
            removed_at=datetime.now(timezone.utc),
        )
        run = CreatorSyncRun(
            user_id=self.user.id,
            source_id=source.id,
            platform="bilibili",
            requested_limit=20,
        )
        self.db.add_all([item, run])
        self.db.commit()
        config = {
            "enabled": True,
            "platforms": {"douyin": True, "bilibili": True, "xiaohongshu": False},
            "concurrency": {"douyin": 1, "bilibili": 2, "xiaohongshu": 1},
            "xhs_cookie": "super-secret-cookie",
        }
        work = {
            "external_id": "BV1REMOVED",
            "source_url": "https://www.bilibili.com/video/BV1REMOVED",
            "media_type": "video",
        }
        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=config),
            patch.object(creator_connectors, "discover_works", return_value=[work]),
            patch.object(creator_sync_service, "_import_work") as import_work,
        ):
            creator_sync_service.process_run(run.id)

        self.db.expire_all()
        finished = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        self.assertEqual(finished.status, "succeeded")
        self.assertEqual(finished.skipped_count, 1)
        import_work.assert_not_called()
        serialized = str(finished.to_dict()).lower()
        self.assertNotIn("super-secret-cookie", serialized)
        self.assertNotIn("bilibili.com/video", serialized)

    def test_cancel_and_stale_recovery(self) -> None:
        source = CreatorSource(user_id=self.user.id, **self.preview())
        self.db.add(source)
        self.db.commit()
        queued = CreatorSyncRun(
            user_id=self.user.id,
            source_id=source.id,
            platform="bilibili",
            requested_limit=20,
        )
        stale = CreatorSyncRun(
            user_id=self.user.id,
            source_id=source.id,
            platform="bilibili",
            requested_limit=50,
            status="transcribing",
            lease_until=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        self.db.add(queued)
        self.db.commit()
        cancelled = creator_sync_service.request_cancel(
            self.db, user_id=self.user.id, run_id=queued.id
        )
        self.assertEqual(cancelled.status, "cancelled")
        self.db.add(stale)
        self.db.commit()
        with patch.object(creator_sync_service, "SessionLocal", self.Session):
            recovered = creator_sync_service.recover_incomplete_runs()
        self.assertIn(stale.id, recovered)
        self.db.expire_all()
        self.assertEqual(self.db.query(CreatorSyncRun).filter_by(id=stale.id).one().status, "queued")

    def test_one_failed_work_produces_partial_without_losing_success(self) -> None:
        source = CreatorSource(user_id=self.user.id, **self.preview())
        self.db.add(source)
        self.db.commit()
        run = CreatorSyncRun(
            user_id=self.user.id,
            source_id=source.id,
            platform="bilibili",
            requested_limit=20,
        )
        self.db.add(run)
        self.db.commit()
        config = {
            "enabled": True,
            "platforms": {"douyin": True, "bilibili": True, "xiaohongshu": False},
            "concurrency": {"douyin": 1, "bilibili": 2, "xiaohongshu": 1},
            "xhs_cookie": "",
        }
        works = [
            {"external_id": "BV1OK", "source_url": "https://www.bilibili.com/video/BV1OK"},
            {"external_id": "BV1FAIL", "source_url": "https://www.bilibili.com/video/BV1FAIL"},
        ]
        with (
            patch.object(creator_sync_service, "SessionLocal", self.Session),
            patch.object(creator_sync_service, "_feature_config", return_value=config),
            patch.object(creator_connectors, "discover_works", return_value=works),
            patch.object(
                creator_sync_service,
                "_import_work",
                side_effect=[("imported", "note-success"), RuntimeError("signed-url=secret")],
            ),
        ):
            creator_sync_service.process_run(run.id)
        self.db.expire_all()
        finished = self.db.query(CreatorSyncRun).filter_by(id=run.id).one()
        self.assertEqual(finished.status, "partial")
        self.assertEqual(finished.new_count, 1)
        self.assertEqual(finished.failed_count, 1)
        self.assertNotIn("signed-url", str(finished.to_dict()).lower())


if __name__ == "__main__":
    unittest.main()
