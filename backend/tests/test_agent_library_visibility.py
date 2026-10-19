"""验证 Agent 资料库包含未生成卡片的导入资料，并保持账号隔离。"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone

from tests import test_agent_interface_routes as route_fixture
from app.models.note import Note
from app.models.user import User
from app.services import note_service
from app.services.agent_credential_service import issue_pat


class AgentLibraryVisibilityTests(unittest.TestCase):
    def setUp(self):
        route_fixture.AgentInterfaceRouteTests.setUp(self)
        self.client.__enter__()
        with self.Session() as db:
            other = User(email="other-library@example.com", hashed_password="test")
            db.add(other)
            db.flush()
            self.ids = {}
            for index, (label, owner, initialized, transcript) in enumerate([
                ("卡片", self.user_id, True, "卡片文稿"),
                ("已转写", self.user_id, False, "资料库语音正文，不应在列表返回"),
                ("待转写", self.user_id, False, ""),
                ("其他账号", other.id, False, "其他用户正文"),
            ]):
                row = Note(
                    user_id=owner, video_id=f"BV{index:010d}", video_title=f"可见性测试-{label}",
                    video_url=f"https://www.bilibili.com/video/BV{index:010d}",
                    ai_initialized=initialized, transcript_raw=transcript,
                    ai_summary=json.dumps({"source_meta": {
                        "platform": "bilibili", "source_kind": "agent-link-import",
                        "speech_ready": bool(transcript),
                        "transcript_source": "cloud-asr" if transcript else "pending",
                    }}),
                    seo_title=label, seo_slug=f"visibility-{index}", seo_meta="",
                    created_at=datetime.now(timezone.utc) + timedelta(seconds=index),
                )
                db.add(row)
                db.flush()
                self.ids[label] = row.id
            db.commit()
            _, token = issue_pat(db, user_id=self.user_id, name="资料库只读验收",
                                 scopes=["library:read"], expires_in_days=1)
            self.headers = {"Authorization": f"Bearer {token}"}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        route_fixture.AgentInterfaceRouteTests.tearDown(self)

    def listing(self, **payload):
        response = self.client.post("/api/agent-interface/v1/actions/library.list/invoke",
                                    headers=self.headers, json={"input": payload})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]["result"]

    def test_agent_list_contains_pending_and_ready_without_cross_user_or_full_text(self):
        result = self.listing(page=1, per_page=100)
        self.assertEqual(result["total"], 3)
        items = {row["id"]: row for row in result["items"]}
        self.assertEqual(set(items), {self.ids[k] for k in ("卡片", "已转写", "待转写")})
        ready = items[self.ids["已转写"]]
        self.assertFalse(ready["ai_initialized"])
        self.assertTrue(ready["speech_ready"])
        self.assertEqual(ready["transcript_chars"], len("资料库语音正文，不应在列表返回"))
        self.assertFalse(items[self.ids["待转写"]]["speech_ready"])
        self.assertEqual(items[self.ids["待转写"]]["transcript_chars"], 0)
        self.assertTrue(all(row["transcript_raw"] == "" for row in items.values()))

    def test_agent_pagination_and_title_search_include_uninitialized_notes(self):
        first = self.listing(page=1, per_page=2)
        second = self.listing(page=2, per_page=2)
        self.assertEqual((first["total"], second["total"]), (3, 3))
        self.assertEqual([row["id"] for row in first["items"]],
                         [self.ids["待转写"], self.ids["已转写"]])
        self.assertEqual([row["id"] for row in second["items"]], [self.ids["卡片"]])
        found = self.listing(search="已转写")
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["items"][0]["id"], self.ids["已转写"])

    def test_card_list_still_excludes_uninitialized_notes_by_default(self):
        with self.Session() as db:
            rows, total = note_service.list_notes(db, user_id=self.user_id)
            self.assertEqual(total, 1)
            self.assertEqual([row.id for row in rows], [self.ids["卡片"]])


if __name__ == "__main__":
    unittest.main()
