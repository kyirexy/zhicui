from __future__ import annotations

import json
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.creator_sync import (
    CreatorCatalogQualityRun,
    CreatorCatalogQualityRunItem,
    CreatorSource,
    CreatorSourceItem,
    CreatorSyncRun,
    CreatorSyncRunItem,
)
from app.models.note import Note
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services import (
    creator_catalog_quality_service as quality_service,
    creator_catalog_quality_worker as quality_worker,
    creator_connectors,
    creator_sync_service,
    settings_service,
    yutto_catalog_client,
)
from app.services.creator_catalog_quality_migration import ensure_schema


def _note(user_id: str, *, note_id: str = "note-quality") -> Note:
    return Note(
        id=note_id,
        user_id=user_id,
        video_id="BV1Quality",
        video_title="可信的视频标题",
        video_url="https://www.bilibili.com/video/BV1Quality",
        transcript_raw="这是一段经过验证的完整文稿。" * 20,
        ai_summary=json.dumps({
            "source_meta": {
                "author_name": "可信 UP",
                "cover_url": "https://i0.hdslb.com/bfs/archive/quality.jpg",
                "caption": "公开的视频简介",
                "published_at": "2026-08-01T12:00:00Z",
            }
        }),
        card_type="general",
        seo_title="可信的视频标题",
        seo_slug=f"quality-{note_id}",
        seo_meta="可信的视频标题",
    )


class CreatorCatalogQualityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__, Note.__table__, SystemSetting.__table__,
                CreatorSource.__table__, CreatorSyncRun.__table__,
                CreatorSourceItem.__table__, CreatorSyncRunItem.__table__,
                CreatorCatalogQualityRun.__table__,
                CreatorCatalogQualityRunItem.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.admin = User(
            email="quality-admin@example.com", hashed_password="x", is_admin=True,
        )
        self.owner = User(email="quality-owner@example.com", hashed_password="x")
        self.db.add_all([self.admin, self.owner])
        self.db.commit()
        self.source = CreatorSource(
            user_id=self.owner.id,
            platform="bilibili",
            creator_id="123456",
            profile_url="https://space.bilibili.com/123456/video",
            display_name="可信 UP",
        )
        self.db.add(self.source)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _item(self, external_id: str, **values) -> CreatorSourceItem:
        item = CreatorSourceItem(
            user_id=self.owner.id,
            source_id=self.source.id,
            platform="bilibili",
            external_id=external_id,
            source_url=f"https://www.bilibili.com/video/{external_id}",
            **values,
        )
        self.db.add(item)
        self.db.commit()
        return item

    def test_preview_is_read_only_and_excludes_tombstones(self) -> None:
        live = self._item("BV1Live", title="B站作品 BV1Live")
        tombstone = self._item(
            "BV1Removed",
            title="B站作品 BV1Removed",
            state="removed",
            is_available=False,
            removed_at=datetime.now(timezone.utc),
        )
        before = (live.metadata_quality, tombstone.metadata_quality)
        result = quality_service.preview(self.db, platform="bilibili")
        self.assertTrue(result["read_only"])
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["affected"], 1)
        self.assertEqual(result["by_issue"]["placeholder_title"], 1)
        self.assertEqual((live.metadata_quality, tombstone.metadata_quality), before)

    def test_idempotent_backfill_uses_local_metadata_and_honors_cooldown(self) -> None:
        note = _note(self.owner.id)
        self.db.add(note)
        self.db.commit()
        item = self._item("BV1Quality", title="B站作品 BV1Quality", note_id=note.id)
        run, reused = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="backfill",
            idempotency_key="quality-backfill-001",
            platform="bilibili",
            batch_size=1,
            cooldown_seconds=60,
        )
        same, same_reused = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="backfill",
            idempotency_key="quality-backfill-001",
            platform="bilibili",
            batch_size=1,
            cooldown_seconds=60,
        )
        self.assertFalse(reused)
        self.assertTrue(same_reused)
        self.assertEqual(same.id, run.id)

        with patch.object(quality_service, "SessionLocal", self.Session):
            first = quality_service.process_batch(run.id)
            held = quality_service.process_batch(run.id)
        self.assertEqual(first["status"], "queued")
        self.assertEqual(held["scanned_count"], 1)
        self.assertEqual(
            self.db.query(CreatorCatalogQualityRunItem).filter_by(run_id=run.id).count(),
            1,
        )
        self.db.expire_all()
        stored = self.db.query(CreatorSourceItem).filter_by(id=item.id).one()
        self.assertEqual(stored.title, "可信的视频标题")
        self.assertEqual(stored.author_name, "可信 UP")
        self.assertEqual(stored.description, "公开的视频简介")
        self.assertEqual(stored.metadata_quality, "complete")
        self.assertFalse(stored.transcription_blocked)

        persisted_run = self.db.query(CreatorCatalogQualityRun).filter_by(id=run.id).one()
        persisted_run.next_batch_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.db.commit()
        with patch.object(quality_service, "SessionLocal", self.Session):
            finished = quality_service.process_batch(run.id)
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["summary"]["network_requests"], 0)

    def test_quarantine_blocks_placeholder_without_restoring_tombstone(self) -> None:
        item = self._item("BV1Unsafe", title="B站作品 BV1Unsafe")
        tombstone = self._item(
            "BV1Tomb",
            title="B站作品 BV1Tomb",
            state="removed",
            is_available=False,
            removed_at=datetime.now(timezone.utc),
        )
        run, _ = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="quarantine",
            idempotency_key="quality-quarantine-001",
            platform="bilibili",
            batch_size=20,
            cooldown_seconds=0,
        )
        with patch.object(quality_service, "SessionLocal", self.Session):
            result = quality_service.process_batch(run.id)
        self.assertEqual(result["status"], "completed")
        self.db.expire_all()
        stored = self.db.query(CreatorSourceItem).filter_by(id=item.id).one()
        removed = self.db.query(CreatorSourceItem).filter_by(id=tombstone.id).one()
        self.assertEqual(stored.metadata_quality, "quarantined")
        self.assertTrue(stored.transcription_blocked)
        self.assertFalse(stored.to_dict()["can_transcribe"])
        self.assertEqual(stored.to_dict()["transcript_status"], "needs_action")
        self.assertEqual(removed.state, "removed")
        self.assertFalse(removed.is_available)

    def test_cancelled_run_does_not_modify_items(self) -> None:
        item = self._item("BV1Cancel", title="B站作品 BV1Cancel")
        run, _ = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="quarantine",
            idempotency_key="quality-cancel-001",
            batch_size=20,
            cooldown_seconds=0,
        )
        quality_service.request_cancel(self.db, run.id)
        with patch.object(quality_service, "SessionLocal", self.Session):
            result = quality_service.process_batch(run.id)
        self.assertEqual(result["status"], "cancelled")
        self.db.expire_all()
        self.assertEqual(
            self.db.query(CreatorSourceItem).filter_by(id=item.id).one().metadata_quality,
            "unknown",
        )

    def test_expired_lease_resumes_after_restart_without_duplicates(self) -> None:
        self._item("BV1LeaseOne", title="B站作品 BV1LeaseOne")
        self._item("BV1LeaseTwo", title="B站作品 BV1LeaseTwo")
        run, _ = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="quarantine",
            idempotency_key="quality-restart-lease-001",
            batch_size=1,
            cooldown_seconds=0,
        )
        run.status = "running"
        run.lease_token = "abandoned-worker"
        run.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.db.commit()
        with patch.object(quality_service, "SessionLocal", self.Session):
            self.assertIn(run.id, quality_service.due_run_ids())
            first = quality_service.process_batch(run.id)
            second = quality_service.process_batch(run.id)
            duplicate = quality_service.process_batch(run.id)
        self.assertEqual(first["status"], "queued")
        self.assertEqual(second["status"], "queued")
        self.assertEqual(duplicate["status"], "completed")
        self.assertEqual(
            self.db.query(CreatorCatalogQualityRunItem).filter_by(run_id=run.id).count(),
            2,
        )

    def test_runner_continues_all_due_batches_without_request_lifetime(self) -> None:
        self._item("BV1RunnerOne", title="B站作品 BV1RunnerOne")
        self._item("BV1RunnerTwo", title="B站作品 BV1RunnerTwo")
        run, _ = quality_service.create_run(
            self.db,
            requested_by_id=self.admin.id,
            mode="quarantine",
            idempotency_key="quality-runner-resume-001",
            batch_size=1,
            cooldown_seconds=0,
        )
        runner = quality_worker.CreatorCatalogQualityRunner()
        try:
            with (
                patch.object(quality_service, "SessionLocal", self.Session),
                patch.object(quality_worker, "_SCAN_INTERVAL_SECONDS", 0.01),
            ):
                runner.start()
                runner.submit(run.id)
                deadline = time.monotonic() + 2.0
                status = "queued"
                while time.monotonic() < deadline:
                    check = self.Session()
                    try:
                        status = check.query(CreatorCatalogQualityRun).filter_by(
                            id=run.id,
                        ).one().status
                    finally:
                        check.close()
                    if status == "completed":
                        break
                    time.sleep(0.01)
            self.assertEqual(status, "completed")
            self.assertEqual(
                self.db.query(CreatorCatalogQualityRunItem).filter_by(run_id=run.id).count(),
                2,
            )
        finally:
            runner.stop()

    def test_selected_transcription_rejects_untrusted_placeholder(self) -> None:
        item = self._item(
            "BV1Blocked",
            title="B站作品 BV1Blocked",
            metadata_quality="needs_action",
            transcription_blocked=True,
            needs_enrichment=True,
        )
        settings_service.set_setting(
            self.db, settings_service.CREATOR_SYNC_ENABLED_KEY, "true",
        )
        settings_service.set_setting(
            self.db, settings_service.CREATOR_SYNC_HEALTH_KEYS["bilibili"], "true",
        )
        with self.assertRaises(creator_sync_service.CreatorSyncError) as raised:
            creator_sync_service.create_run(
                self.db,
                user_id=self.owner.id,
                source_id=self.source.id,
                operation="selected_transcript",
                item_ids=[item.id],
            )
        self.assertEqual(raised.exception.code, "selection_needs_enrichment")


class ConnectorReadinessQualityTests(unittest.TestCase):
    def test_missing_yutto_service_can_never_be_healthy(self) -> None:
        with patch.object(
            creator_connectors.yutto_catalog_client,
            "health",
            return_value={
                "enabled": False,
                "healthy": True,
                "version": "2.2.0",
            },
        ):
            result = creator_connectors.catalog_health("bilibili")
        self.assertFalse(result["healthy"])
        self.assertFalse(result["supports_catalog_all"])
        self.assertEqual(result["status"], "disabled")

    def test_health_requires_full_yutto_protocol_capability_set(self) -> None:
        class FakeSocket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def send(self, message):
                payload = json.loads(message)
                if payload["method"] == "server.authenticate":
                    result = {"authenticated": True}
                else:
                    result = {
                        "version": "2.2.0",
                        "protocol_version": 1,
                        "capabilities": ["resolve.start"],
                    }
                self.message = json.dumps({"id": payload["id"], "result": result})

            async def recv(self):
                return self.message

        with (
            patch.object(yutto_catalog_client, "_enabled", return_value=True),
            patch.object(yutto_catalog_client, "_read_token", return_value="token"),
            patch.object(yutto_catalog_client, "_websocket_connect", lambda *a, **k: FakeSocket()),
        ):
            result = yutto_catalog_client.health()
        self.assertFalse(result["healthy"])

    def test_catalog_gate_fails_closed_without_probe_contract(self) -> None:
        db = unittest.mock.Mock()
        source = unittest.mock.Mock(platform="bilibili")
        with (
            patch.object(
                creator_sync_service,
                "_feature_config",
                return_value={
                    "platforms": {"bilibili": True},
                    "catalog_platforms": {"bilibili": True},
                },
            ),
            patch.object(
                creator_sync_service.creator_connectors,
                "catalog_health",
                return_value={"healthy": True, "supports_catalog_all": True},
            ),
            self.assertRaises(creator_sync_service.CreatorSyncError),
        ):
            creator_sync_service._require_catalog_health(db, source, {})

    def test_quality_column_migration_is_idempotent(self) -> None:
        engine = create_engine("sqlite://")
        try:
            with engine.begin() as connection:
                connection.exec_driver_sql(
                    "CREATE TABLE creator_source_items ("
                    "id VARCHAR(48) PRIMARY KEY, source_id VARCHAR(48) NOT NULL)"
                )
                connection.exec_driver_sql(
                    "CREATE TABLE creator_catalog_quality_runs ("
                    "id VARCHAR(48) PRIMARY KEY, status VARCHAR(24) NOT NULL)"
                )
            ensure_schema(engine)
            ensure_schema(engine)
            columns = {
                column["name"] for column in inspect(engine).get_columns("creator_source_items")
            }
            self.assertTrue(
                {
                    "metadata_quality", "quality_issues_json", "needs_enrichment",
                    "transcription_blocked", "quality_checked_at", "quarantined_at",
                }.issubset(columns)
            )
            run_columns = {
                column["name"]
                for column in inspect(engine).get_columns("creator_catalog_quality_runs")
            }
            self.assertTrue({"lease_token", "lease_expires_at"}.issubset(run_columns))
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
