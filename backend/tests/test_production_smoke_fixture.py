from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.agent_thread import AgentThread
from app.models.note import Note
from app.models.user import User


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "manage_production_smoke_fixture.py"
SPEC = importlib.util.spec_from_file_location("production_smoke_fixture", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class ProductionSmokeFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        User.__table__.create(self.engine)
        Note.__table__.create(self.engine)
        AgentThread.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(
            id="u-production-smoke",
            email="production-smoke@example.test",
            username=fixture.EXPECTED_USERNAME,
            hashed_password="not-used-by-this-test",
            is_active=True,
            is_admin=False,
        )
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_ensure_is_idempotent_and_cleanup_removes_only_fixture(self) -> None:
        first = fixture.ensure_fixture(self.db, self.user.email)
        second = fixture.ensure_fixture(self.db, self.user.email)

        self.assertEqual(first.id, second.id)
        self.assertEqual(self.db.query(Note).count(), 1)
        self.assertIn(fixture.SENTINEL_TOKEN, second.transcript_raw)
        marker = json.loads(second.ai_summary)["source_meta"]["internal_smoke_fixture"]
        self.assertEqual(marker, fixture.FIXTURE_MARKER)

        self.db.add(AgentThread(
            user_id=self.user.id,
            title=f"{fixture.THREAD_TITLE_PREFIX} stale",
            scope_type="selected",
            scope_label="手选视频",
            source_ids_json=json.dumps([second.id]),
            source_available_count=1,
            source_selected_count=1,
        ))
        self.db.commit()

        threads, notes = fixture.cleanup_fixture(self.db, self.user.email)
        self.assertEqual((threads, notes), (1, 1))
        self.assertEqual(self.db.query(Note).count(), 0)
        self.assertEqual(self.db.query(AgentThread).count(), 0)
        self.assertEqual(fixture.cleanup_fixture(self.db, self.user.email), (0, 0))

    def test_refuses_admin_or_non_reserved_account(self) -> None:
        self.user.is_admin = True
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, "管理员"):
            fixture.ensure_fixture(self.db, self.user.email)

        self.user.is_admin = False
        self.user.username = "real-user"
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, "拒绝使用真实用户"):
            fixture.ensure_fixture(self.db, self.user.email)

    def test_refuses_to_overwrite_unmarked_note(self) -> None:
        note_id = fixture.fixture_id_for_user(self.user.id)
        self.db.add(Note(
            id=note_id,
            user_id=self.user.id,
            video_id=fixture.FIXTURE_VIDEO_ID,
            video_title="真实资料",
            video_url="https://example.test/video",
            transcript_raw="真实内容",
            ai_summary="{}",
            card_type="general",
            seo_title="真实资料",
            seo_slug="real-content-collision",
            seo_meta="真实资料",
            pitfall_rating=1,
        ))
        self.db.commit()

        with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
            fixture.ensure_fixture(self.db, self.user.email)
        self.assertEqual(self.db.query(Note).one().video_title, "真实资料")

    def test_release_gate_requires_selected_source_sentinel_and_citation(self) -> None:
        smoke = (ROOT / "scripts" / "smoke-production.sh").read_text(encoding="utf-8")
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn('"source_scope": "selected"', smoke)
        self.assertIn('data.get("source_ids") != [expected]', smoke)
        self.assertIn('sentinel not in answer or sentinel not in streamed_answer', smoke)
        self.assertIn('item.get("note_id") or item.get("source_id")', smoke)
        self.assertIn("manage_production_smoke_fixture.py\" ensure", deploy)
        self.assertIn("manage_production_smoke_fixture.py\" cleanup", deploy)


if __name__ == "__main__":
    unittest.main()
