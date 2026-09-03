from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_interface import AgentCredential, ProductActionEvent, ProductActionRun
from app.models.library_extraction_batch import (
    LibraryExtractionBatch,
    LibraryExtractionBatchItem,
)
from app.models.note import Note
from app.models.user import User
from app.services import library_extraction_service, product_action_run_service


class LibraryExtractionPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__, Note.__table__, LibraryExtractionBatch.__table__,
                LibraryExtractionBatchItem.__table__, AgentCredential.__table__,
                ProductActionRun.__table__,
                ProductActionEvent.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            user = User(
                email="batch@example.com", username="batch",
                hashed_password="unused", is_active=True, is_admin=False,
            )
            other = User(
                email="other-batch@example.com", username="other-batch",
                hashed_password="unused", is_active=True, is_admin=False,
            )
            db.add_all([user, other])
            db.commit()
            db.refresh(user)
            db.refresh(other)
            self.user_id = user.id
            self.other_id = other.id

        self.session_patch = patch.object(library_extraction_service, "SessionLocal", self.Session)
        self.session_patch.start()

    def tearDown(self) -> None:
        self.session_patch.stop()
        self.engine.dispose()

    def test_batch_survives_process_memory_and_is_user_scoped(self) -> None:
        with patch.object(library_extraction_service, "_submit_batch") as submit:
            created = library_extraction_service.create_batch_job(
                user_id=self.user_id,
                aweme_ids=["video-a", "video-b", "video-a"],
                operation="transcript",
                asr_concurrency=2,
                llm_concurrency=1,
                ephemeral_media_sources={
                    "video-a": "https://example.invalid/must-not-persist",
                },
            )
        self.assertTrue(created["durable"])
        self.assertEqual(created["total"], 2)
        self.assertEqual(created["database_stores_media"], False)
        self.assertEqual(submit.call_count, 1)
        job_id = created["job_id"]

        loaded = library_extraction_service.get_batch_job(job_id, self.user_id)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["job_id"], job_id)
        self.assertIsNone(library_extraction_service.get_batch_job(job_id, self.other_id))
        with self.Session() as db:
            self.assertEqual(db.query(LibraryExtractionBatch).count(), 1)
            self.assertEqual(db.query(LibraryExtractionBatchItem).count(), 2)
            persisted = " ".join(
                str(value)
                for row in db.query(LibraryExtractionBatchItem).all()
                for value in vars(row).values()
            )
            self.assertNotIn("example.invalid", persisted)

    def test_restart_resumes_persisted_nonterminal_items(self) -> None:
        with patch.object(library_extraction_service, "_submit_batch"):
            created = library_extraction_service.create_batch_job(
                user_id=self.user_id,
                aweme_ids=["resume-a", "resume-b"],
                operation="transcript",
                asr_concurrency=1,
                llm_concurrency=1,
            )
        with self.Session() as db:
            first = db.query(LibraryExtractionBatchItem).filter(
                LibraryExtractionBatchItem.batch_id == created["job_id"],
                LibraryExtractionBatchItem.aweme_id == "resume-a",
            ).one()
            first.state = "transcribing"
            db.commit()

        with patch.object(library_extraction_service, "_submit_batch") as submit:
            resumed = library_extraction_service.resume_pending_jobs()
        self.assertEqual(resumed, 2)
        self.assertEqual(submit.call_count, 1)
        with self.Session() as db:
            states = {
                row.state for row in db.query(LibraryExtractionBatchItem).filter(
                    LibraryExtractionBatchItem.batch_id == created["job_id"],
                ).all()
            }
            self.assertEqual(states, {"queued"})

    def test_cancel_is_persistent_and_idempotent(self) -> None:
        with patch.object(library_extraction_service, "_submit_batch"):
            created = library_extraction_service.create_batch_job(
                user_id=self.user_id,
                aweme_ids=["cancel-a"],
                operation="transcript",
                asr_concurrency=1,
                llm_concurrency=1,
            )
        first = library_extraction_service.cancel_batch_job(created["job_id"], self.user_id)
        second = library_extraction_service.cancel_batch_job(created["job_id"], self.user_id)
        self.assertEqual(first["status"], "canceled")
        self.assertEqual(second["status"], "canceled")
        self.assertTrue(second["cancellation_requested"])
        self.assertIsNone(
            library_extraction_service.cancel_batch_job(created["job_id"], self.other_id)
        )

    def test_completed_batch_projects_to_one_terminal_product_run_event(self) -> None:
        with patch.object(library_extraction_service, "_submit_batch"):
            created = library_extraction_service.create_batch_job(
                user_id=self.user_id,
                aweme_ids=["project-a"],
                operation="transcript",
                asr_concurrency=1,
                llm_concurrency=1,
            )
        with self.Session() as db:
            batch = db.query(LibraryExtractionBatch).filter(
                LibraryExtractionBatch.id == created["job_id"],
            ).one()
            item = db.query(LibraryExtractionBatchItem).filter(
                LibraryExtractionBatchItem.batch_id == batch.id,
            ).one()
            item.state = "done"
            item.transcript_chars = 321
            batch.status = "success"
            run = ProductActionRun(
                request_id="batch-projection",
                user_id=self.user_id,
                credential_id=None,
                action_id="library.transcript.batch",
                action_version="1.0.0",
                run_type="long_task",
                execution_location="cloud",
                status="running",
                input_json='{"aweme_ids":["project-a"]}',
                input_hash="a" * 64,
                external_type="library_transcript_batch",
                external_id=batch.id,
            )
            db.add(run)
            db.commit()
            db.refresh(run)

            product_action_run_service.reconcile_external_run(db, run)
            product_action_run_service.reconcile_external_run(db, run)

            db.refresh(run)
            self.assertEqual(run.status, "succeeded")
            events = db.query(ProductActionEvent).filter(
                ProductActionEvent.run_id == run.id,
            ).order_by(ProductActionEvent.sequence.asc()).all()
            self.assertEqual(sum(bool(event.terminal) for event in events), 1)
            self.assertEqual(events[-1].event_type, "run.succeeded")


if __name__ == "__main__":
    unittest.main()
