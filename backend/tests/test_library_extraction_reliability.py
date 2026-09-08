from __future__ import annotations

import gc
import threading
import unittest
import weakref
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.note import Note
from app.models.library_extraction_batch import LibraryExtractionBatch, LibraryExtractionBatchItem
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import library_extraction_service as service


class LibraryExtractionSchedulingTests(unittest.TestCase):
    def test_local_metadata_skips_sidecar_and_keeps_only_requested_items(self) -> None:
        local = [{"aweme_id": "a", "title": "本地标题"}, {"aweme_id": "unrelated"}]
        with (
            patch.object(service, "SessionLocal"),
            patch.object(service.local_douyin_library_service, "list_items", return_value=local),
            patch.object(service.douyin_binding_service, "get_or_create") as binding,
            patch.object(service.douyin_library, "list_items") as sidecar,
        ):
            result = service._prefetch_items("user", {"a"})
        self.assertEqual(result, {"a": local[0]})
        binding.assert_not_called()
        sidecar.assert_not_called()

    def test_sidecar_fills_missing_metadata_after_database_session_closes(self) -> None:
        session = MagicMock()

        def sidecar_items(*_args, **_kwargs):
            session.__exit__.assert_called_once()
            return [{"aweme_id": "a", "title": "旧标题"}, {"aweme_id": "b"}]

        with (
            patch.object(service, "SessionLocal", return_value=session),
            patch.object(service.local_douyin_library_service, "list_items", return_value=[
                {"aweme_id": "a", "title": "本地标题"},
            ]),
            patch.object(service.douyin_binding_service, "get_or_create", return_value=
                         SimpleNamespace(session_scope="s" * 32, id="binding")),
            patch.object(service.douyin_library, "list_items", side_effect=sidecar_items),
        ):
            result = service._prefetch_items("user", {"a", "b"})
        self.assertEqual(result["a"]["title"], "本地标题")
        self.assertEqual(set(result), {"a", "b"})

    def test_sidecar_failure_preserves_available_local_metadata(self) -> None:
        local = {"aweme_id": "a"}
        with (
            patch.object(service, "SessionLocal"),
            patch.object(service.local_douyin_library_service, "list_items", return_value=[local]),
            patch.object(service.douyin_binding_service, "get_or_create", return_value=
                         SimpleNamespace(session_scope="s" * 32, id="binding")),
            patch.object(service.douyin_library, "list_items", side_effect=RuntimeError("offline")),
        ):
            self.assertEqual(service._prefetch_items("user", {"a", "b"}), {"a": local})

    def test_submission_window_preserves_capacity_for_following_batches(self) -> None:
        calls: list[tuple] = []
        futures: list[Future] = []

        def submit(*args):
            calls.append(args)
            future = Future()
            futures.append(future)
            return future

        first = SimpleNamespace(id="first", user_id="u1", operation="transcript",
                                asr_concurrency=2, llm_concurrency=12)
        second = SimpleNamespace(id="second", user_id="u2", operation="transcript",
                                 asr_concurrency=1, llm_concurrency=12)
        rows = [SimpleNamespace(aweme_id=str(index)) for index in range(100)]
        with (
            patch.object(service, "_prefetch_items", return_value={}),
            patch.object(service._EXECUTOR, "submit", side_effect=submit),
        ):
            service._submit_batch(first, rows)
            self.assertEqual(len(calls), 2)
            service._submit_batch(second, [SimpleNamespace(aweme_id="other")])
            self.assertEqual(calls[2][1], "second")
            futures[0].set_result(None)
            self.assertEqual(len(calls), 4)
            self.assertEqual(calls[3][3], "2")
            # 所有已投递项逐个完成；100 项不丢失、不重复，也不一次占满队列。
            index = 1
            while index < len(futures):
                futures[index].set_result(None)
                index += 1
        self.assertEqual(len(calls), 101)
        self.assertEqual(len({args[3] for args in calls if args[1] == "first"}), 100)

    def test_per_item_lock_is_shared_while_used_and_reclaimed_when_idle(self) -> None:
        first = service._item_lock("lock-test", "video")
        second = service._item_lock("lock-test", "video")
        other_user = service._item_lock("other-user", "video")
        self.assertIs(first, second)
        self.assertIsNot(first, other_user)
        reference = weakref.ref(first)
        del first, second
        gc.collect()
        self.assertIsNone(reference())


class LibraryTranscriptCheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine, tables=[
            User.__table__, Note.__table__, VideoSourceLedger.__table__,
            LibraryExtractionBatch.__table__, LibraryExtractionBatchItem.__table__,
        ])
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            user = User(email="checkpoint@example.com", hashed_password="unused")
            db.add(user)
            db.commit()
            self.user_id = user.id
        self.item = {
            "aweme_id": "7672579366093622537", "title": "真实文案测试",
            "source_url": "https://www.douyin.com/video/7672579366093622537",
            "cover_url": "", "caption": "", "author_name": "",
            "recorded_at": "2026-09-08T00:00:00Z", "can_extract": True,
            "provider": "desktop-local", "source_mode": "collect", "source_rank": 0,
        }

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_ai_failure_retains_transcript_and_retry_does_not_repeat_asr(self) -> None:
        transcript = "这段文案来自已完成的语音识别，摘要失败不能再次收费识别。"
        with self.Session() as db:
            service.video_source_ledger_service.upsert_item(
                db, user_id=self.user_id, item=self.item,
            )
        with (
            patch.object(service, "SessionLocal", self.Session),
            patch.object(service.douyin_binding_service, "get_or_create", return_value=
                         SimpleNamespace(session_scope="s" * 32, id="binding")),
            patch.object(service.settings_service, "get_asr_config", return_value={
                "api_key": "test", "api_base_url": "https://asr.invalid", "model": "test",
            }),
            patch.object(service.video_extractor, "extract_media_url_transcript",
                         return_value=transcript) as transcribe,
            patch.object(service, "_generate_ai_result", side_effect=RuntimeError("AI 暂不可用")),
        ):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "AI 暂不可用"):
                    service.extract_library_item(
                        user_id=self.user_id, aweme_id=self.item["aweme_id"],
                        item=self.item, operation="full",
                    )
            transcribe.assert_called_once()
        with self.Session() as db:
            saved = db.query(Note).one()
            self.assertEqual(saved.transcript_raw, transcript)
            self.assertFalse(saved.ai_initialized)
            self.assertEqual(db.query(VideoSourceLedger).count(), 1)

    def test_late_transcript_keeps_note_without_restoring_removed_membership(self) -> None:
        with self.Session() as db:
            service.video_source_ledger_service.upsert_item(db, user_id=self.user_id, item=self.item)
            db.query(VideoSourceLedger).delete()
            db.commit()
        with (
            patch.object(service, "SessionLocal", self.Session),
            patch.object(service.douyin_binding_service, "get_or_create", return_value=
                         SimpleNamespace(session_scope="s" * 32, id="binding")),
            patch.object(service.settings_service, "get_asr_config", return_value={
                "api_key": "test", "api_base_url": "https://asr.invalid", "model": "test",
            }),
            patch.object(service.video_extractor, "extract_media_url_transcript", return_value="真实语音文案"),
        ):
            service.extract_library_item(user_id=self.user_id, aweme_id=self.item["aweme_id"],
                                         item=self.item, operation="transcript")
        with self.Session() as db:
            self.assertEqual(db.query(Note).one().transcript_raw, "真实语音文案")
            self.assertEqual(db.query(VideoSourceLedger).count(), 0)

    def test_cancellation_before_next_stage_prevents_another_external_call(self) -> None:
        continued = MagicMock()
        with (
            patch.object(service, "SessionLocal", self.Session),
            patch.object(service, "_submit_batch"),
        ):
            created = service.create_batch_job(
                user_id=self.user_id, aweme_ids=[self.item["aweme_id"]],
                operation="full", asr_concurrency=1, llm_concurrency=1,
            )

            def extract(**kwargs):
                kwargs["progress"]("transcribing")
                service.cancel_batch_job(created["job_id"], self.user_id)
                kwargs["progress"]("analyzing")
                continued()

            with patch.object(service, "extract_library_item", side_effect=extract):
                service._run_job_item(
                    created["job_id"], self.user_id, self.item["aweme_id"], "full",
                    threading.Semaphore(1), threading.Semaphore(1),
                )
            result = service.get_batch_job(created["job_id"], self.user_id)
        continued.assert_not_called()
        self.assertEqual(result["status"], "canceled")
        self.assertEqual(result["active"], 0)
        self.assertEqual(result["items"][0]["state"], "canceled")


if __name__ == "__main__":
    unittest.main()
