from __future__ import annotations

import io
import json
import unittest
import wave

from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.api import routes
from app.main import _migrate_knowledge_entries
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.plan import Plan
from app.models.user import User
from app.services import knowledge_service, platform_library_service


class CuratedKnowledgeServiceTests(unittest.TestCase):
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
                KnowledgeEntry.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user_a = User(email="curated-a@example.com", hashed_password="x")
        self.user_b = User(email="curated-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _add_note(
        self,
        suffix: str,
        summary: dict | str | None,
        *,
        user: User | None = None,
        title: str | None = None,
        ai_initialized: bool = True,
    ) -> Note:
        owner = user or self.user_a
        encoded = json.dumps(summary, ensure_ascii=False) if isinstance(summary, dict) else summary
        note = Note(
            user_id=owner.id,
            video_id=f"video-{suffix}",
            video_title=title or f"视频 {suffix}",
            video_url=f"https://example.com/{suffix}",
            transcript_raw=f"原始文稿 {suffix}",
            ai_summary=encoded,
            ai_initialized=ai_initialized,
            card_type="general",
            seo_title=title or f"视频 {suffix}",
            seo_slug=f"curated-{owner.id}-{suffix}",
            seo_meta=suffix,
            pitfall_rating=3,
        )
        self.db.add(note)
        self.db.commit()
        self.db.refresh(note)
        return note

    def test_inbox_only_contains_meaningful_ai_outcomes(self) -> None:
        insight = self._add_note("insight", {"key_insight": "真正的核心洞察"})
        items = self._add_note("items", {
            "sections": [{"title": "步骤", "items": ["执行第一步"]}],
        })
        self._add_note("transcript-only", {
            "source_meta": {"author_name": "只有来源元数据"},
        })
        self._add_note("malformed", "{not-json")
        self._add_note("scalar-sections", {
            "sections": ["不是结构化 section", 42, None],
        })
        self._add_note("section-beyond-limit", {
            "sections": ([{"title": "空", "content": ""}] * 24)
            + [{"title": "太靠后", "content": "不应形成幽灵总数"}],
        })
        self._add_note("item-beyond-limit", {
            "sections": [{
                "title": "列表",
                "items": ([""] * 50) + ["不应形成幽灵总数"],
            }],
        })
        self._add_note("blank", {
            "conclusion": " \t\n ",
            "sections": [
                {"title": "空正文", "content": "   "},
                {"title": "空列表", "items": ["  ", "\t\n", ""]},
            ],
        })
        fallback = self._add_note("fallback", {
            "generation_status": "fallback",
            "key_insight": "AI 暂时无法生成结构化卡片",
            "sections": [{"title": "原始内容摘要", "content": "只是文稿切片"}],
        })
        legacy_fallback = self._add_note("legacy-fallback", {
            "key_insight": "AI 暂时无法生成结构化卡片，但视频原文已保留。",
            "sections": [{"title": "原始内容摘要", "content": "只是文稿切片"}],
        })
        self._add_note("not-initialized", {
            "conclusion": "尚未真正初始化",
        }, ai_initialized=False)

        result = knowledge_service.list_knowledge(
            self.db, self.user_a.id, view="inbox"
        )

        self.assertEqual(result["total"], 2)
        self.assertEqual({item["id"] for item in result["items"]}, {insight.id, items.id})
        items_candidate = next(item for item in result["items"] if item["id"] == items.id)
        self.assertIn("执行第一步", items_candidate["content"])
        self.assertEqual(
            knowledge_service.get_candidate_item(self.db, self.user_a.id, items.id)["status"],
            "inbox",
        )
        fallback_detail = knowledge_service.get_candidate_item(
            self.db, self.user_a.id, fallback.id,
        )
        self.assertEqual(fallback_detail["status"], "source-only")
        self.assertEqual(fallback_detail["sections"], [])
        self.assertNotIn("只是文稿切片", fallback_detail["content"])
        self.assertEqual(
            knowledge_service.get_candidate_item(
                self.db, self.user_a.id, legacy_fallback.id,
            )["status"],
            "source-only",
        )

    def test_postgresql_candidate_predicate_has_balanced_grouping(self) -> None:
        class PostgreSQLDialect:
            name = "postgresql"

        class PostgreSQLBind:
            dialect = PostgreSQLDialect()

        class PostgreSQLSession:
            @staticmethod
            def get_bind() -> PostgreSQLBind:
                return PostgreSQLBind()

        sql = str(knowledge_service._candidate_eligibility_sql(PostgreSQLSession()))
        depth = 0
        in_string = False
        index = 0
        while index < len(sql):
            character = sql[index]
            if character == "'":
                if in_string and index + 1 < len(sql) and sql[index + 1] == "'":
                    index += 2
                    continue
                in_string = not in_string
            elif not in_string and character == "(":
                depth += 1
            elif not in_string and character == ")":
                depth -= 1
                self.assertGreaterEqual(depth, 0, sql)
            index += 1

        self.assertFalse(in_string, sql)
        self.assertEqual(depth, 0, sql)
        self.assertIn("IS JSON", sql)
        self.assertIn("ELSE FALSE END", sql)

    def test_asr_connection_probe_is_a_valid_wav(self) -> None:
        payload = routes._asr_probe_wav()

        with wave.open(io.BytesIO(payload), "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertEqual(audio.getframerate(), 16_000)
            self.assertEqual(audio.getnframes(), 4_000)

    def test_views_search_counts_and_pagination_are_database_scoped(self) -> None:
        for index in range(5):
            knowledge_service.create_entry(
                self.db,
                self.user_a.id,
                title=f"分页知识 {index}",
                summary=f"摘要 {index}",
                content=f"正文 {index}",
                source_label="手工来源",
            )
        for index in range(3):
            self._add_note(f"page-{index}", {
                "conclusion": f"候选结论 {index}",
                "source_meta": {
                    "author_name": "目标作者" if index == 1 else "其他作者",
                    "platform": "douyin",
                },
            }, title=f"候选视频 {index}")
        knowledge_service.create_entry(
            self.db,
            self.user_b.id,
            title="其他用户分页知识",
            content="不得出现在用户 A 的结果中",
        )

        pages = knowledge_service.list_knowledge(
            self.db, self.user_a.id, view="pages", page=2, per_page=2
        )
        inbox_search = knowledge_service.list_knowledge(
            self.db, self.user_a.id, view="inbox", search="目标作者"
        )

        self.assertEqual(pages["view"], "pages")
        self.assertEqual(pages["total"], 5)
        self.assertEqual(pages["total_pages"], 3)
        self.assertEqual(len(pages["items"]), 2)
        self.assertEqual(pages["counts"], {"pages": 5, "inbox": 3})
        self.assertTrue(all(item["kind"] == "page" for item in pages["items"]))
        self.assertEqual(inbox_search["total"], 1)
        self.assertEqual(inbox_search["counts"], {"pages": 0, "inbox": 1})
        self.assertEqual(inbox_search["items"][0]["author_name"], "目标作者")

    def test_save_candidate_is_idempotent_owned_and_removes_it_from_inbox(self) -> None:
        note = self._add_note("save", {
            "key_insight": "保存后成为摘要",
            "sections": [{"title": "判断", "content": "可编辑的知识正文"}],
            "conclusion": "最后的结论",
            "source_meta": {
                "author_name": "作者甲",
                "platform": "douyin",
                "cover_url": "https://example.com/cover.jpg",
            },
        }, title="值得沉淀的视频")

        first = knowledge_service.save_candidate(self.db, self.user_a.id, note.id)
        second = knowledge_service.save_candidate(self.db, self.user_a.id, note.id)
        item = knowledge_service.get_entry_item(self.db, self.user_a.id, first.id)

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            self.db.query(KnowledgeEntry).filter_by(
                user_id=self.user_a.id, source_note_id=note.id
            ).count(),
            1,
        )
        self.assertIsNotNone(item)
        assert item is not None
        self.assertEqual(item["kind"], "page")
        self.assertEqual(item["origin"], "video")
        self.assertEqual(item["status"], "canonical")
        self.assertEqual(item["source_note_id"], note.id)
        self.assertEqual(item["source_count"], 1)
        self.assertIn("## 判断", item["content"])
        self.assertEqual(item["cover_url"], "https://example.com/cover.jpg")
        self.assertEqual(
            knowledge_service.list_knowledge(
                self.db, self.user_a.id, view="inbox"
            )["total"],
            0,
        )
        with self.assertRaises(LookupError):
            knowledge_service.save_candidate(self.db, self.user_b.id, note.id)
        self.assertIsNone(
            knowledge_service.get_entry(self.db, self.user_b.id, first.id)
        )

    def test_manual_crud_keeps_server_controlled_page_identity(self) -> None:
        entry = knowledge_service.create_entry(
            self.db,
            self.user_a.id,
            title=" 手写知识页 ",
            summary=" 一句话摘要 ",
            content=" 正文内容 ",
            source_label=" 个人判断 ",
        )
        updated = knowledge_service.update_entry(
            self.db, entry, summary="更新摘要", content="更新正文"
        )
        item = knowledge_service.get_entry_item(self.db, self.user_a.id, entry.id)

        self.assertEqual(updated.origin, "manual")
        self.assertEqual(updated.status, "canonical")
        self.assertEqual(item["summary"], "更新摘要")
        self.assertEqual(item["kind"], "page")
        self.assertEqual(item["source_count"], 0)
        self.assertIsNone(knowledge_service.get_entry_item(
            self.db, self.user_b.id, entry.id
        ))
        with self.assertRaisesRegex(ValueError, "正文不能为空"):
            knowledge_service.update_entry(self.db, entry, content="   ")

    def test_route_contract_lists_and_saves_without_cross_user_disclosure(self) -> None:
        note = self._add_note("route", {
            "conclusion": "路由候选结论",
            "sections": [{"title": "路由要点", "content": "可保存正文"}],
        })

        listed = routes.list_personal_knowledge(
            view="inbox",
            page=1,
            per_page=20,
            q="",
            db=self.db,
            current_user=self.user_a,
        )
        first = routes.save_knowledge_candidate(
            note.id, db=self.db, current_user=self.user_a
        )
        second = routes.save_knowledge_candidate(
            note.id, db=self.db, current_user=self.user_a
        )

        self.assertTrue(listed["success"])
        self.assertEqual(listed["data"]["view"], "inbox")
        self.assertEqual(listed["data"]["items"][0]["kind"], "candidate")
        detail = routes.get_knowledge_candidate(
            note.id, db=self.db, current_user=self.user_a,
        )
        self.assertEqual(detail["data"]["status"], "inbox")
        self.assertEqual(first["data"]["id"], second["data"]["id"])
        self.assertEqual(first["data"]["source_note_id"], note.id)
        with self.assertRaises(HTTPException) as raised:
            routes.save_knowledge_candidate(
                note.id, db=self.db, current_user=self.user_b
            )
        self.assertEqual(raised.exception.status_code, 404)

    def test_source_workspace_accepts_any_owned_note_but_keeps_user_scope(self) -> None:
        note = self._add_note("source-workspace", {
            "conclusion": "可以从知识页返回来源",
            "source_meta": {
                "source_kind": "douyin-library",
                "source_mode": "collect",
                "platform": "douyin",
            },
        })

        workspace = platform_library_service.get_workspace(
            self.db, user_id=self.user_a.id, note_id=note.id,
        )

        self.assertIsNotNone(workspace)
        assert workspace is not None
        self.assertEqual(workspace["note"]["id"], note.id)
        self.assertEqual(workspace["item"]["source_mode"], "collect")
        self.assertEqual(workspace["media_storage"]["provider"], "douyin-library")
        self.assertIsNone(platform_library_service.get_workspace(
            self.db, user_id=self.user_b.id, note_id=note.id,
        ))


class KnowledgeMigrationTests(unittest.TestCase):
    def test_sqlite_additive_migration_is_repeatable_and_backfills_legacy_rows(self) -> None:
        engine = create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE notes (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL)"
            ))
            conn.execute(text(
                "CREATE TABLE knowledge_entries ("
                "id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, "
                "title VARCHAR(256) NOT NULL, content TEXT NOT NULL, "
                "source_label VARCHAR(256) NOT NULL DEFAULT '', "
                "created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL)"
            ))
            conn.execute(text(
                "INSERT INTO knowledge_entries "
                "(id,user_id,title,content,source_label,created_at,updated_at) "
                "VALUES ('entry-1','user-1','旧知识','旧正文','',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
            ))

        with engine.begin() as conn:
            _migrate_knowledge_entries(conn, inspect(engine), "sqlite")
        with engine.begin() as conn:
            _migrate_knowledge_entries(conn, inspect(engine), "sqlite")

        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("knowledge_entries")}
        indexes = {index["name"]: index for index in inspector.get_indexes("knowledge_entries")}
        with engine.connect() as conn:
            row = conn.execute(text(
                "SELECT summary,status,origin,source_note_id FROM knowledge_entries"
            )).mappings().one()

        with engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO notes (id,user_id) VALUES ('note-1','user-1')"
            ))
            conn.execute(text(
                "UPDATE knowledge_entries SET source_note_id='note-1' WHERE id='entry-1'"
            ))
            conn.execute(text("DELETE FROM notes WHERE id='note-1'"))
            source_after_delete = conn.execute(text(
                "SELECT source_note_id FROM knowledge_entries WHERE id='entry-1'"
            )).scalar_one()

        self.assertTrue({"summary", "status", "origin", "source_note_id"} <= columns)
        self.assertEqual(row["summary"], "")
        self.assertEqual(row["status"], "canonical")
        self.assertEqual(row["origin"], "manual")
        self.assertIsNone(row["source_note_id"])
        self.assertIsNone(source_after_delete)
        self.assertIn("ix_knowledge_entries_user_status_updated", indexes)
        self.assertTrue(indexes["ux_knowledge_entries_user_source_note"]["unique"])
        engine.dispose()

    def test_postgresql_branch_adds_idempotent_foreign_key_guard(self) -> None:
        class FakeInspector:
            @staticmethod
            def has_table(name: str) -> bool:
                return name in {"knowledge_entries", "notes"}

            @staticmethod
            def get_columns(_name: str) -> list[dict[str, str]]:
                return [
                    {"name": "id"},
                    {"name": "user_id"},
                    {"name": "title"},
                    {"name": "content"},
                    {"name": "source_label"},
                    {"name": "created_at"},
                    {"name": "updated_at"},
                ]

        class RecordingConnection:
            def __init__(self) -> None:
                self.statements: list[str] = []

            def execute(self, statement) -> None:
                self.statements.append(str(statement))

        connection = RecordingConnection()
        _migrate_knowledge_entries(connection, FakeInspector(), "postgresql")
        sql = "\n".join(connection.statements)

        self.assertIn("ADD COLUMN summary", sql)
        self.assertIn("ADD COLUMN source_note_id", sql)
        self.assertIn("CREATE UNIQUE INDEX IF NOT EXISTS", sql)
        self.assertIn("pg_constraint", sql)
        self.assertIn("ON DELETE SET NULL", sql)


if __name__ == "__main__":
    unittest.main()
