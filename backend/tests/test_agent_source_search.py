from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.api import agent_routes
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import agent_service, ai_juicer


class AgentSourceRankingTests(unittest.TestCase):
    def test_ranked_excerpt_is_copied_from_stored_source(self) -> None:
        sources = [
            {
                "note_id": "note-fit",
                "title": "上班族饮食记录",
                "author_name": "小林",
                "ai_summary": json.dumps({"conclusion": "控制总热量"}),
                "transcript": "上班族减脂可以先稳定早餐，并记录一周饮食。",
            },
            {
                "note_id": "note-camera",
                "title": "相机入门",
                "author_name": "阿泽",
                "ai_summary": "",
                "transcript": "先理解快门、光圈和感光度。",
            },
        ]
        with patch.object(
            ai_juicer,
            "_library_research_plan",
            return_value={
                "search_queries": ["上班族减脂"],
                "planner_mode": "smart",
            },
        ):
            result = ai_juicer.rank_library_sources_for_selection(
                sources,
                "想找适合上班族减脂的视频",
            )

        self.assertEqual(result["search_mode"], "smart")
        self.assertEqual(result["matched_count"], 1)
        self.assertEqual(result["items"][0]["note_id"], "note-fit")
        self.assertIn("transcript", result["items"][0]["fields"])
        self.assertIn("上班族减脂", result["items"][0]["snippet"])

    def test_planner_failure_reports_keyword_fallback(self) -> None:
        with patch.object(
            ai_juicer,
            "_library_research_plan",
            return_value={
                "search_queries": ["相机"],
                "planner_mode": "keyword_fallback",
            },
        ):
            result = ai_juicer.rank_library_sources_for_selection(
                [{
                    "note_id": "note-camera",
                    "title": "相机入门",
                    "author_name": "",
                    "ai_summary": "",
                    "transcript": "",
                }],
                "相机教程",
            )

        self.assertEqual(result["search_mode"], "keyword_fallback")
        self.assertEqual(result["items"][0]["fields"], ["title"])

    def test_route_passes_authenticated_user_to_search_service(self) -> None:
        payload = agent_routes.SourceSearchRequest(
            query="上班族减脂",
            scope="collect",
            limit=12,
        )
        expected = {"query": payload.query, "items": [], "matched_count": 0}
        db = SimpleNamespace()
        with patch.object(
            agent_service,
            "smart_search_sources",
            return_value=expected,
        ) as search:
            response = agent_routes.search_agent_sources(
                payload,
                db=db,
                current_user=SimpleNamespace(id="user-a"),
            )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"], expected)
        search.assert_called_once_with(
            db,
            user_id="user-a",
            query="上班族减脂",
            scope="collect",
            timezone_name="Asia/Shanghai",
            limit=12,
        )


class AgentSourceSearchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[User.__table__, Note.__table__, VideoSourceLedger.__table__],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user_a = User(email="search-a@example.com", hashed_password="x")
        self.user_b = User(email="search-b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()
        self.db.add_all([
            self._note(
                self.user_a.id,
                "fit-a",
                "一周饮食复盘",
                "上班族减脂先从记录饮食和稳定早餐开始。",
            ),
            self._note(
                self.user_a.id,
                "camera-a",
                "相机入门",
                "快门光圈感光度是曝光三要素。",
            ),
            self._note(
                self.user_b.id,
                "fit-private",
                "别人的减脂方案",
                "上班族减脂的私人记录。",
            ),
        ])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def _note(user_id: str, slug: str, title: str, transcript: str) -> Note:
        return Note(
            user_id=user_id,
            video_id=slug,
            video_title=title,
            video_url=f"https://example.com/{slug}",
            transcript_raw=transcript,
            ai_summary=json.dumps({"conclusion": title}, ensure_ascii=False),
            card_type="general",
            seo_title=title,
            seo_slug=slug,
            seo_meta=title,
            pitfall_rating=1,
        )

    def test_search_is_user_scoped_and_returns_verified_match_metadata(self) -> None:
        with patch.object(
            ai_juicer,
            "_library_research_plan",
            return_value={
                "search_queries": ["上班族减脂"],
                "planner_mode": "smart",
            },
        ):
            result = agent_service.smart_search_sources(
                self.db,
                user_id=self.user_a.id,
                query="上班族减脂",
            )

        self.assertEqual(result["scanned_count"], 2)
        self.assertEqual(result["matched_count"], 1)
        self.assertEqual(len(result["items"]), 1)
        item = result["items"][0]
        self.assertEqual(item["title"], "一周饮食复盘")
        self.assertIn("transcript", item["match"]["fields"])
        self.assertNotIn("别人的减脂方案", [row["title"] for row in result["items"]])


if __name__ == "__main__":
    unittest.main()
