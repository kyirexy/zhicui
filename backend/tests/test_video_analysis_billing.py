from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_thread import AgentThread  # noqa: F401 - register FK target
from app.models.note import Note
from app.models.system_setting import SystemSetting  # noqa: F401 - register table
from app.models.user import User
from app.models.video_analysis import AnalysisCreditLedger, VideoAnalysisItem
from app.services import (
    note_service,
    video_analysis_billing_service as billing,
    video_analysis_catalog_service as catalog,
    video_analysis_service as analysis,
)


class VideoAnalysisBillingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Session()
        self.user = User(
            id="u-analysis-user",
            email="analysis@example.com",
            username="analysis-user",
            hashed_password="test",
            is_active=True,
        )
        self.admin = User(
            id="u-analysis-admin",
            email="analysis-admin@example.com",
            username="analysis-admin",
            hashed_password="test",
            is_active=True,
            is_admin=True,
        )
        self.note = Note(
            id="00000000-0000-0000-0000-000000000001",
            user_id=self.user.id,
            video_id="douyin-video-1",
            video_title="演示视频",
            video_url="https://www.douyin.com/video/123456",
            transcript_raw="这是一份稳定的测试文稿。",
            ai_summary=json.dumps(
                {
                    "source_meta": {
                        "platform": "douyin",
                        "media_type": "video",
                        "duration_ms": 120_000,
                        "media_version": "v1",
                    },
                    "sections": [{"title": "原摘要", "content": "保留"}],
                },
                ensure_ascii=False,
            ),
            card_type="general",
            seo_title="演示视频",
            seo_slug="video-analysis-test-note",
            seo_meta="演示视频",
        )
        self.db.add_all([self.user, self.admin, self.note])
        self.db.commit()
        catalog.save_runtime_settings(
            self.db,
            enabled=True,
            quote_ttl_seconds=300,
            run_points_limit=100_000,
            user_daily_points_limit=100_000,
        )
        self.offering = catalog.create_offering(
            self.db,
            code="paid-local",
            name="标准本地解析",
            method="local_scene",
            recommended=True,
            triggers=["manual", "batch", "agent"],
            limits={
                "max_duration_seconds": 3600,
                "max_frames": 8,
                "max_provider_calls": 0,
                "timeout_seconds": 180,
            },
            pricing={
                "base_points": 100,
                "per_minute_points": 10,
                "per_frame_points": 1,
                "per_media_unit_points": 0,
                "min_points": 0,
                "max_points": 1_000,
            },
        )
        self.version = catalog.publish_offering(
            self.db,
            self.offering,
            admin_user_id=self.admin.id,
        )
        billing.adjust_credits(
            self.db,
            user_id=self.user.id,
            points_delta=1_000,
            reason="测试发放",
            admin_user_id=self.admin.id,
            idempotency_key="test-analysis-grant",
            entry_type="grant",
        )

    def tearDown(self) -> None:
        analysis.register_duration_probe(None)
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _prepare(self, *, trigger: str = "manual") -> dict:
        return analysis.prepare_run(
            self.db,
            user_id=self.user.id,
            note_ids=[self.note.id],
            offering_id=self.offering.id,
            trigger=trigger,
        )

    def _confirm(self, prepared: dict, key: str = "confirm-analysis-test") -> dict:
        return analysis.confirm_run(
            self.db,
            user_id=self.user.id,
            run_id=prepared["run"]["id"],
            idempotency_key=key,
        )

    def test_prepare_and_confirm_are_idempotent_and_settle_actual_usage(self) -> None:
        first = self._prepare()
        duplicate = self._prepare()
        self.assertEqual(first["run"]["id"], duplicate["run"]["id"])
        self.assertEqual(first["quote"]["max_points"], 128)

        confirmed = self._confirm(first, "confirm-tab-one")
        confirmed_again = self._confirm(first, "confirm-tab-two")
        self.assertEqual(confirmed["run"]["id"], confirmed_again["run"]["id"])
        item_id = confirmed["items"][0]["id"]
        reserve_rows = self.db.query(AnalysisCreditLedger).filter(
            AnalysisCreditLedger.entry_type == "reserve"
        ).all()
        self.assertEqual(len(reserve_rows), 1)

        item = self.db.query(VideoAnalysisItem).filter_by(id=item_id).one()
        actual = billing.calculate_actual_charge(
            self.db,
            item,
            result_usage={
                "billable_duration_ms": 120_000,
                "frame_count": 4,
                "provider_units": 0,
            },
        )
        self.assertEqual(actual["points"], 124)
        analysis.complete_item(
            self.db,
            item_id,
            result_payload={
                "schema_version": 1,
                "method": "local_scene",
                "duration_ms": 120_000,
                "scene_count": 3,
                "frame_count": 4,
                "chapters": [],
                "scenes": [],
                "visual_observations": [],
            },
            status="succeeded",
            scene_count=3,
            frame_count=4,
            duration_ms=120_000,
            actual_points=actual["points"],
            result_usage={"frame_count": 4},
        )
        account = billing.get_or_create_account(self.db, self.user.id)
        self.assertEqual(account.available_points, 876)
        self.assertEqual(account.reserved_points, 0)
        kinds = [
            row.entry_type
            for row in self.db.query(AnalysisCreditLedger)
            .filter(AnalysisCreditLedger.item_id == item_id)
            .order_by(AnalysisCreditLedger.id.asc())
            .all()
        ]
        self.assertEqual(kinds, ["reserve", "capture", "release"])

        # complete_item updates Note.updated_at through ai_summary.  The cache
        # key must remain stable and the next request must cost zero.
        cached = self._prepare()
        self.assertEqual(cached["items"][0]["status"], "cached")
        self.assertEqual(cached["quote"]["max_points"], 0)
        self.assertEqual(
            self.db.query(AnalysisCreditLedger)
            .filter(AnalysisCreditLedger.entry_type == "reserve")
            .count(),
            1,
        )

        note_service.update_note_ai(
            self.db,
            self.note,
            {
                "sections": [{"title": "新摘要", "content": "文本内容"}],
                "card_type": "general",
                "pitfall_rating": 1,
            },
        )
        refreshed_summary = json.loads(self.note.ai_summary)
        self.assertEqual(
            refreshed_summary["detailed_video_analysis"]["analysis_id"],
            item.analysis_id,
        )
        self.assertEqual(refreshed_summary["sections"][0]["title"], "新摘要")
        self.assertEqual(
            len(
                [
                    section
                    for section in refreshed_summary["sections"]
                    if section.get("source") == "detailed_video_analysis"
                ]
            ),
            1,
        )

    def test_published_price_change_does_not_invalidate_existing_quote(self) -> None:
        prepared = self._prepare()
        original_version_id = prepared["run"]["offering_version_id"]
        catalog.update_offering(
            self.db,
            self.offering,
            pricing={"base_points": 900, "max_points": 1_000},
        )
        next_version = catalog.publish_offering(
            self.db,
            self.offering,
            admin_user_id=self.admin.id,
        )
        self.assertNotEqual(original_version_id, next_version.id)

        confirmed = self._confirm(prepared)
        self.assertEqual(confirmed["run"]["offering_version_id"], original_version_id)
        self.assertEqual(confirmed["items"][0]["quoted_points"], 128)

    def test_failure_and_stale_recovery_release_the_full_reservation(self) -> None:
        failed_prepared = self._prepare()
        failed = self._confirm(failed_prepared, "confirm-failure")
        failed_item_id = failed["items"][0]["id"]
        analysis.fail_item(
            self.db,
            failed_item_id,
            error_code="media_download_failed",
            error_detail="安全失败",
        )
        account = billing.get_or_create_account(self.db, self.user.id)
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))

        stale_prepared = self._prepare()
        stale = self._confirm(stale_prepared, "confirm-stale")
        stale_item = self.db.query(VideoAnalysisItem).filter_by(
            id=stale["items"][0]["id"]
        ).one()
        stale_item.status = "running"
        stale_item.attempt_count = 3
        stale_item.claimed_at = datetime.now(timezone.utc) - timedelta(hours=2)
        stale_item.heartbeat_at = stale_item.claimed_at
        self.db.commit()
        recovered = analysis.requeue_or_release_stale_items(self.db)
        self.assertEqual(recovered["failed"], 1)
        self.db.refresh(account)
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))

    def test_reauthorization_can_be_cancelled_without_frozen_balance(self) -> None:
        prepared = self._prepare()
        confirmed = self._confirm(prepared, "confirm-reauthorize")
        item = self.db.query(VideoAnalysisItem).filter_by(
            id=confirmed["items"][0]["id"]
        ).one()
        item.status = "reauthorization_required"
        run = analysis.get_run(
            self.db,
            user_id=self.user.id,
            run_id=confirmed["run"]["id"],
        )
        run.status = "reauthorization_required"
        self.db.commit()

        cancelled = analysis.cancel_run(
            self.db,
            user_id=self.user.id,
            run_id=run.id,
        )
        self.assertEqual(cancelled["run"]["status"], "cancelled")
        account = billing.get_or_create_account(self.db, self.user.id)
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))

    def test_release_is_idempotent_with_a_stale_session_identity(self) -> None:
        prepared = self._prepare()
        confirmed = self._confirm(prepared, "confirm-release-race")
        item_id = confirmed["items"][0]["id"]
        other_db = self.Session()
        try:
            stale_item = other_db.query(VideoAnalysisItem).filter_by(id=item_id).one()
            item = self.db.query(VideoAnalysisItem).filter_by(id=item_id).one()
            billing.release_item(self.db, item, reason="第一次释放")
            item.status = "cancelled"
            self.db.commit()

            # 第二个 Session 在第一次提交前已经把 Item 放进 identity map。
            # 行锁后的强制刷新必须阻止重复返还余额。
            billing.release_item(other_db, stale_item, reason="并发重复释放")
            other_db.commit()
        finally:
            other_db.close()

        account = billing.get_or_create_account(self.db, self.user.id)
        self.db.refresh(account)
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))
        self.assertEqual(
            self.db.query(AnalysisCreditLedger)
            .filter(
                AnalysisCreditLedger.idempotency_key
                == f"video-analysis:release:{item_id}"
            )
            .count(),
            1,
        )

    def test_provider_units_zero_falls_back_to_successful_call_count(self) -> None:
        prepared = self._prepare()
        confirmed = self._confirm(prepared, "confirm-media-units")
        item = self.db.query(VideoAnalysisItem).filter_by(
            id=confirmed["items"][0]["id"]
        ).one()
        snapshot = json.loads(item.pricing_snapshot_json)
        snapshot.update(
            {
                "base_points": 0,
                "per_minute_points": 0,
                "per_frame_points": 0,
                "per_media_unit_points": 7,
            }
        )
        snapshot["limits"]["max_provider_calls"] = 2
        item.pricing_snapshot_json = json.dumps(snapshot, ensure_ascii=False)
        self.db.flush()

        actual = billing.calculate_actual_charge(
            self.db,
            item,
            result_usage={"provider_units": 0, "calls": 1, "model_calls": 1},
        )
        self.assertEqual(actual["points"], 7)

    def test_free_visual_offering_downgrades_when_provider_is_disabled(self) -> None:
        provider = catalog.create_provider(
            self.db,
            code="free-image-provider",
            name="Free image provider",
            driver="openai_compatible",
            default_model="free-vision-model",
            api_base="https://vision.example.com/v1",
            enabled=True,
            capabilities={"supports_images": True},
            cost={"cost_class": "no_cost"},
        )
        provider.health_status = "healthy"
        self.db.commit()
        offering = catalog.create_offering(
            self.db,
            code="free-visual-fallback",
            name="Free visual fallback",
            method="scene_frames_vlm",
            provider_id=provider.id,
            model="free-vision-model",
            triggers=["manual", "batch", "agent"],
            limits={
                "max_duration_seconds": 3600,
                "max_frames": 8,
                "max_provider_calls": 1,
                "timeout_seconds": 180,
            },
            pricing={
                "base_points": 0,
                "per_minute_points": 0,
                "per_frame_points": 0,
                "per_media_unit_points": 0,
                "min_points": 0,
                "max_points": 0,
            },
            fallback={"mode": "local_scene"},
        )
        version = catalog.publish_offering(
            self.db,
            offering,
            admin_user_id=self.admin.id,
        )
        catalog.disable_provider(self.db, provider)

        resolved = catalog.resolve_runtime_provider(
            self.db,
            SimpleNamespace(
                offering_version_id=version.id,
                use_byok=False,
                user_id=self.user.id,
            ),
        )

        self.assertEqual(resolved["driver"], "local_scene")
        self.assertEqual(resolved["degraded_reason"], "provider_disabled")

    def test_failure_cost_is_mapped_persisted_and_admin_visible(self) -> None:
        prepared = self._prepare()
        confirmed = self._confirm(prepared, "confirm-failure-cost")
        item_id = confirmed["items"][0]["id"]
        analysis.complete_item(
            self.db,
            item_id,
            result_payload={
                "schema_version": 1,
                "method": "scene_frames_vlm",
                "duration_ms": 120_000,
                "scene_count": 2,
                "frame_count": 2,
                "chapters": [],
                "scenes": [],
                "visual_observations": [],
                "quality": {"visual_batches": 0, "failed_visual_batches": 1},
            },
            status="partial",
            scene_count=2,
            frame_count=2,
            duration_ms=120_000,
            actual_points=0,
            platform_cost_micros=17,
            result_usage={
                "calls": 1,
                "platform_cost_micros": 17,
                "failure_cost_micros": 17,
            },
        )
        self.db.expire_all()
        reloaded = self.db.query(VideoAnalysisItem).filter_by(id=item_id).one()
        self.assertEqual(reloaded.failure_cost_micros, 17)

        from app.api.video_analysis_routes import admin_usage

        usage = admin_usage(db=self.db, current_user=self.admin)["data"]
        self.assertEqual(usage["failure_cost_micros"], 17)

    def test_confirm_before_commit_callback_is_atomic(self) -> None:
        prepared = self._prepare()
        observed_statuses: list[str] = []

        def reject_after_queue(_run, items) -> None:
            observed_statuses.extend(item.status for item in items)
            raise RuntimeError("test rollback")

        with self.assertRaisesRegex(RuntimeError, "test rollback"):
            analysis.confirm_run(
                self.db,
                user_id=self.user.id,
                run_id=prepared["run"]["id"],
                idempotency_key="confirm-callback-rollback",
                before_commit=reject_after_queue,
            )

        self.assertEqual(observed_statuses, ["queued"])
        run = analysis.get_run(
            self.db,
            user_id=self.user.id,
            run_id=prepared["run"]["id"],
        )
        item = self.db.query(VideoAnalysisItem).filter_by(run_id=run.id).one()
        account = billing.get_or_create_account(self.db, self.user.id)
        self.assertEqual(run.status, "prepared")
        self.assertEqual(item.status, "prepared")
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))
        self.assertEqual(
            self.db.query(AnalysisCreditLedger)
            .filter(AnalysisCreditLedger.entry_type == "reserve")
            .count(),
            0,
        )

    def test_abandoned_reauthorization_is_released_by_recovery(self) -> None:
        prepared = self._prepare()
        confirmed = self._confirm(prepared, "confirm-reauth-expiry")
        item_id = confirmed["items"][0]["id"]
        item = analysis.fail_item(
            self.db,
            item_id,
            error_code="reauthorization_required",
            error_detail="需要重新报价",
            verified_duration_ms=180_000,
        )
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        self.db.query(VideoAnalysisItem).filter(VideoAnalysisItem.id == item.id).update(
            {VideoAnalysisItem.updated_at: old},
            synchronize_session=False,
        )
        self.db.commit()

        recovered = analysis.requeue_or_release_stale_items(self.db)

        self.assertEqual(recovered["reauthorization_released"], 1)
        self.db.refresh(item)
        self.assertEqual(item.status, "cancelled")
        account = billing.get_or_create_account(self.db, self.user.id)
        self.assertEqual((account.available_points, account.reserved_points), (1_000, 0))


if __name__ == "__main__":
    unittest.main()
