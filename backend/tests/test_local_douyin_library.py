from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.douyin_local_library_item import DouyinLocalLibraryItem
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import (
    douyin_library,
    library_extraction_service,
    local_douyin_library_service,
)


class LocalDouyinLibraryTests(unittest.TestCase):
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
                Plan.__table__,
                DouyinLocalLibraryItem.__table__,
                VideoSourceLedger.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Session()
        self.user_a = User(email="local-a@example.com", hashed_password="x")
        self.user_b = User(email="local-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def item(video_id: str = "7672579366093622537", **updates) -> dict:
        value = {
            "video_id": video_id,
            "source_url": f"https://www.douyin.com/video/{video_id}",
            "title": "测试作品",
            "caption": "这是一段用于测试的作品发布文案",
            "author_name": "测试作者",
            "cover_url": "https://p3.douyinpic.com/example.jpg",
            "published_at": "2026-08-27T08:00:00Z",
            "duration_seconds": 23,
            "source_rank": 0,
        }
        value.update(updates)
        return value

    def test_ingest_is_idempotent_and_user_scoped(self) -> None:
        first = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item()],
        )
        second = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(title="更新后的标题")],
        )
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_b.id,
            source_mode="collect",
            items=[self.item(title="另一个用户的标题")],
        )

        self.assertEqual(first["created"], 1)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["reused"], 1)
        a_items = local_douyin_library_service.list_items(
            self.db, user_id=self.user_a.id, source_mode="like",
        )
        b_items = local_douyin_library_service.list_items(
            self.db, user_id=self.user_b.id, source_mode="collect",
        )
        self.assertEqual(a_items[0]["title"], "更新后的标题")
        self.assertEqual(b_items[0]["title"], "另一个用户的标题")
        self.assertEqual(a_items[0]["provider"], "desktop-local")

    def test_sensitive_and_noncanonical_fields_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "不得包含"):
            local_douyin_library_service.ingest_items(
                self.db,
                user_id=self.user_a.id,
                source_mode="like",
                items=[self.item(cookie="sessionid=secret")],
            )
        with self.assertRaises(ValueError):
            local_douyin_library_service.ingest_items(
                self.db,
                user_id=self.user_a.id,
                source_mode="like",
                items=[self.item(source_url="https://example.com/video/7672579366093622537")],
            )

    def test_repeated_page_text_is_not_saved_as_multiple_video_captions(self) -> None:
        repeated = "热门：这是页面级推荐文字，不属于列表中的任何一条作品，不能重复写入资料库"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[
                self.item(
                    video_id=f"76725793660936225{index}",
                    title=repeated,
                    caption=repeated,
                    author_name="",
                    cover_url="",
                    published_at="",
                    duration_seconds=0,
                    source_rank=index,
                )
                for index in range(3)
            ],
        )
        items = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )
        self.assertEqual(items, [])
        stored = self.db.execute(
            select(DouyinLocalLibraryItem).where(
                DouyinLocalLibraryItem.user_id == self.user_a.id,
            )
        ).scalars().all()
        self.assertEqual(len(stored), 3)
        self.assertTrue(all(not item.available for item in stored))

        recovered_id = "767257936609362250"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(video_id=recovered_id, source_rank=0)],
        )
        recovered = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )
        self.assertEqual([item["id"] for item in recovered], [recovered_id])
        self.assertEqual(recovered[0]["title"], "测试作品")

    def test_title_only_dom_snapshot_is_quarantined_until_metadata_recovers(self) -> None:
        video_id = "7672579366093622511"
        first = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(
                video_id=video_id,
                title="真实但只有 DOM 能看到的作品标题",
                caption="真实但只有 DOM 能看到的作品标题",
                author_name="",
                cover_url="",
                published_at="",
                duration_seconds=0,
            )],
        )

        self.assertEqual(first["ready"], 0)
        self.assertEqual(first["quarantined"], 1)
        self.assertEqual(local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        ), [])

        recovered = local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[self.item(video_id=video_id)],
        )
        items = local_douyin_library_service.list_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
        )

        self.assertEqual(recovered["ready"], 1)
        self.assertEqual(recovered["quarantined"], 0)
        self.assertEqual([item["id"] for item in items], [video_id])
        self.assertEqual(items[0]["author_name"], "测试作者")
        self.assertEqual(items[0]["cover_url"], "https://p3.douyinpic.com/example.jpg")

    def test_lower_quality_retry_cannot_regress_complete_snapshot(self) -> None:
        video_id = "7672579366093622512"
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="collect",
            items=[self.item(video_id=video_id)],
        )
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="collect",
            items=[self.item(
                video_id=video_id,
                title="DOM 兜底标题",
                caption="DOM 兜底标题",
                author_name="",
                cover_url="",
                published_at="",
                duration_seconds=0,
            )],
        )

        item = local_douyin_library_service.get_item(
            self.db,
            user_id=self.user_a.id,
            video_id=video_id,
        )
        self.assertIsNotNone(item)
        self.assertEqual(item["title"], "测试作品")
        self.assertEqual(item["caption"], "这是一段用于测试的作品发布文案")
        self.assertEqual(item["author_name"], "测试作者")
        self.assertEqual(item["cover_url"], "https://p3.douyinpic.com/example.jpg")

    def test_local_item_uses_bound_sidecar_for_transcript_extraction(self) -> None:
        item = self.item()
        session_scope = "s" * 32
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="post",
            items=[item],
        )
        self.db.close()
        with (
            patch.object(library_extraction_service, "SessionLocal", self.Session),
            patch.object(
                library_extraction_service.douyin_binding_service,
                "get_or_create",
                return_value=SimpleNamespace(id="binding", session_scope=session_scope),
            ),
            patch.object(
                library_extraction_service.douyin_library,
                "get_item",
                side_effect=douyin_library.DouyinLibraryError("sidecar blocked"),
            ),
            patch.object(
                library_extraction_service.settings_service,
                "get_asr_config",
                return_value={"api_key": "key", "api_base_url": "https://asr.example", "model": "asr"},
            ),
            patch.object(
                library_extraction_service.video_extractor,
                "parse_video_info",
            ) as parse_video,
            patch.object(
                library_extraction_service.video_extractor,
                "extract_media_url_transcript",
                return_value="这是从视频语音提取出的完整文案",
            ) as transcribe,
        ):
            result = library_extraction_service.extract_library_item(
                user_id=self.user_a.id,
                aweme_id=item["video_id"],
                operation="transcript",
            )

        parse_video.assert_not_called()
        self.assertEqual(
            transcribe.call_args.args[0],
            library_extraction_service.douyin_library.companion_media_url(
                item["video_id"]
            ),
        )
        self.assertEqual(
            transcribe.call_args.kwargs["request_headers"],
            library_extraction_service.douyin_library.companion_headers(session_scope),
        )
        self.assertEqual(result["transcript_raw"], "这是从视频语音提取出的完整文案")

    def test_ephemeral_media_is_used_without_public_page_resolution(self) -> None:
        item = self.item(video_id="7672579366093622538")
        local_douyin_library_service.ingest_items(
            self.db,
            user_id=self.user_a.id,
            source_mode="like",
            items=[item],
        )
        self.db.close()
        with (
            patch.object(library_extraction_service, "SessionLocal", self.Session),
            patch.object(
                library_extraction_service.douyin_binding_service,
                "get_or_create",
                return_value=SimpleNamespace(id="binding", session_scope="scope"),
            ),
            patch.object(
                library_extraction_service.douyin_library,
                "get_item",
                side_effect=douyin_library.DouyinLibraryError("sidecar blocked"),
            ),
            patch.object(
                library_extraction_service.settings_service,
                "get_asr_config",
                return_value={"api_key": "key", "api_base_url": "https://asr.example", "model": "asr"},
            ),
            patch.object(
                library_extraction_service.video_extractor,
                "parse_video_info",
            ) as parse_video,
            patch.object(
                library_extraction_service.video_extractor,
                "extract_media_url_transcript",
                return_value="使用桌面端临时媒体地址提取的完整文案",
            ) as transcribe,
        ):
            result = library_extraction_service.extract_library_item(
                user_id=self.user_a.id,
                aweme_id=item["video_id"],
                operation="transcript",
                ephemeral_media_url=(
                    "https://v3-web.douyinvod.com/video.mp4?token=temporary"
                ),
            )

        parse_video.assert_not_called()
        self.assertEqual(
            transcribe.call_args.args[0],
            "https://v3-web.douyinvod.com/video.mp4?token=temporary",
        )
        self.assertEqual(result["transcript_raw"], "使用桌面端临时媒体地址提取的完整文案")
        self.assertNotIn("temporary", str(result))

    def test_ephemeral_media_rejects_untrusted_hosts(self) -> None:
        with self.assertRaisesRegex(ValueError, "受信任"):
            library_extraction_service.normalize_ephemeral_media_url(
                "https://example.com/video.mp4"
            )


if __name__ == "__main__":
    unittest.main()
