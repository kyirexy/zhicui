from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "agent-action-gap-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "agent-action-gap-pepper-123456789")

from app.core.database import Base
from app.models.creator_sync import (
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
)
from app.models.note import Note
from app.models.user import User
from app.services import product_action_handlers
from app.services.product_action_registry import registry
from app.services.product_action_run_service import ProductActionError, _validate_input


class StarterAndCreatorActionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                Note.__table__,
                CreatorSource.__table__,
                CreatorSyncRun.__table__,
                CreatorSourceItem.__table__,
                CreatorSyncRunItem.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(
            email="starter-owner@example.com",
            username="starter-owner",
            hashed_password="not-used",
            is_active=True,
            is_admin=False,
        )
        self.other = User(
            email="starter-other@example.com",
            username="starter-other",
            hashed_password="not-used",
            is_active=True,
            is_admin=False,
        )
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.ctx = SimpleNamespace(db=self.db, user=self.user)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def _note(user_id: str, suffix: str) -> Note:
        return Note(
            user_id=user_id,
            video_id=f"video-{suffix}",
            video_title=f"视频 {suffix}",
            video_url=f"https://example.com/{suffix}",
            transcript_raw=f"这是 {suffix} 的完整文稿。",
            ai_summary="{}",
            card_type="general",
            seo_title=f"视频 {suffix}",
            seo_slug=f"video-{suffix}",
            seo_meta=f"视频 {suffix}",
            pitfall_rating=3,
        )

    def test_registry_contracts_are_read_only_and_schema_bounded(self) -> None:
        starter = registry.get("ask.starter_questions")
        self.assertIsNotNone(starter)
        assert starter is not None
        self.assertEqual(starter.handler_name, "ask_starter_questions")
        self.assertEqual(starter.scopes, ("ask:read",))
        self.assertEqual([risk.value for risk in starter.risk], ["read"])
        self.assertEqual(starter.rate_limit_per_minute, 12)
        self.assertNotIn("billable", [risk.value for risk in starter.risk])
        self.assertEqual(
            set(starter.input_schema["properties"]),
            {"source_scope", "source_ids", "timezone"},
        )
        valid_starter = {
            "source_scope": "selected",
            "source_ids": ["note-1"],
            "timezone": "Asia/Shanghai",
        }
        self.assertEqual(
            _validate_input(dict(starter.input_schema), valid_starter),
            valid_starter,
        )
        for invalid in (
            {"source_scope": "everything"},
            {"source_ids": ["note"] * 101},
            {"timezone": "x" * 65},
            {"source_scope": "all_ready", "unexpected": True},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ProductActionError):
                _validate_input(dict(starter.input_schema), invalid)

        items = registry.get("creator.sync.items.list")
        self.assertIsNotNone(items)
        assert items is not None
        self.assertEqual(items.handler_name, "creator_sync_items_list")
        self.assertEqual(items.scopes, ("creator:read",))
        self.assertEqual([risk.value for risk in items.risk], ["read"])
        valid_items = {
            "run_id": "creator-run-1",
            "page": 2,
            "per_page": 50,
            "status": "failed",
        }
        self.assertEqual(
            _validate_input(dict(items.input_schema), valid_items), valid_items
        )
        for invalid in (
            {},
            {"run_id": "creator-run-1", "status": "partial"},
            {"run_id": "creator-run-1", "per_page": 51},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ProductActionError):
                _validate_input(dict(items.input_schema), invalid)

    def test_starter_questions_return_user_owned_sources_only(self) -> None:
        own_note = self._note(self.user.id, "own")
        foreign_note = self._note(self.other.id, "foreign")
        self.db.add_all([own_note, foreign_note])
        self.db.commit()

        with patch(
            "app.services.ai_juicer.suggest_library_questions",
            return_value=["这条视频最重要的结论是什么？"],
        ) as suggest:
            result = product_action_handlers.ask_starter_questions(
                self.ctx,
                {
                    "source_scope": "selected",
                    "source_ids": [own_note.id],
                    "timezone": "Asia/Shanghai",
                },
            )
        self.assertEqual(result["source_count"], 1)
        self.assertEqual(result["source_scope"], "selected")
        self.assertEqual(result["questions"], ["这条视频最重要的结论是什么？"])
        self.assertEqual(suggest.call_args.args[0][0]["note_id"], own_note.id)

        with self.assertRaises(product_action_handlers.ActionHandlerError) as denied:
            product_action_handlers.ask_starter_questions(
                self.ctx,
                {
                    "source_scope": "selected",
                    "source_ids": [foreign_note.id],
                    "timezone": "Asia/Shanghai",
                },
            )
        self.assertEqual(denied.exception.code, "INVALID_INPUT")

    def test_creator_sync_items_include_failures_without_cross_user_access(self) -> None:
        own_source = CreatorSource(
            user_id=self.user.id,
            platform="bilibili",
            creator_id="creator-own",
            profile_url="https://space.bilibili.com/1",
            display_name="自己的博主",
        )
        foreign_source = CreatorSource(
            user_id=self.other.id,
            platform="bilibili",
            creator_id="creator-foreign",
            profile_url="https://space.bilibili.com/2",
            display_name="其他用户的博主",
        )
        self.db.add_all([own_source, foreign_source])
        self.db.flush()
        own_run = CreatorSyncRun(
            user_id=self.user.id,
            source_id=own_source.id,
            platform="bilibili",
            status="partial",
            operation="recent_transcript",
            requested_limit=20,
        )
        foreign_run = CreatorSyncRun(
            user_id=self.other.id,
            source_id=foreign_source.id,
            platform="bilibili",
            status="partial",
            operation="recent_transcript",
            requested_limit=20,
        )
        self.db.add_all([own_run, foreign_run])
        self.db.flush()
        own_source_item = CreatorSourceItem(
            user_id=self.user.id,
            source_id=own_source.id,
            platform="bilibili",
            external_id="BV-own",
            title="自己的作品",
        )
        foreign_source_item = CreatorSourceItem(
            user_id=self.other.id,
            source_id=foreign_source.id,
            platform="bilibili",
            external_id="BV-foreign",
            title="其他用户的作品",
        )
        self.db.add_all([own_source_item, foreign_source_item])
        self.db.flush()
        self.db.add_all([
            CreatorSyncRunItem(
                run_id=own_run.id,
                user_id=self.user.id,
                source_id=own_source.id,
                source_item_id=own_source_item.id,
                external_id="BV-own",
                ordinal=1,
                state="failed",
                error_code="ASR_503",
                error_message="云端 ASR 暂时不可用",
            ),
            CreatorSyncRunItem(
                run_id=foreign_run.id,
                user_id=self.other.id,
                source_id=foreign_source.id,
                source_item_id=foreign_source_item.id,
                external_id="BV-foreign",
                ordinal=1,
                state="failed",
                error_code="FOREIGN_FAILURE",
                error_message="不应泄露",
            ),
        ])
        self.db.commit()

        result = product_action_handlers.creator_sync_items_list(
            self.ctx,
            {"run_id": own_run.id, "status": "failed", "page": 1, "per_page": 50},
        )
        self.assertEqual(result["total"], 1)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["external_id"], "BV-own")
        self.assertEqual(result["items"][0]["error_code"], "ASR_503")
        self.assertEqual(
            result["items"][0]["error_message"], "云端 ASR 暂时不可用"
        )

        with self.assertRaises(product_action_handlers.ActionHandlerError) as denied:
            product_action_handlers.creator_sync_items_list(
                self.ctx,
                {"run_id": foreign_run.id, "status": "all"},
            )
        self.assertEqual(denied.exception.code, "RESOURCE_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
