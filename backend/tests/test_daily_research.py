"""每日研究协议、来源窗口和投递幂等回归；全部上游均使用替身。"""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "daily-research-test-secret-no-production")

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_automation import AgentAutomation, AgentAutomationRun
from app.models.agent_thread import AgentThread
from app.models.daily_research import DailyResearchBatch, DailyResearchDevice, DailyResearchRecipient
from app.models.chat_model import ChatModelOffering, ChatModelFreeUsage, ChatModelChargeReservation
from app.models.library_hidden_item import LibraryHiddenItem
from app.models.note import Note
from app.models.user import User
from app.models.video_source_ledger import VideoSourceLedger
from app.services import automation_service, daily_research_service as service


class DailyResearchTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(email="daily-owner@example.com", username="daily-owner", hashed_password="unused", is_active=True)
        self.other = User(email="daily-other@example.com", username="daily-other", hashed_password="unused", is_active=True)
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.no_mail = patch("app.services.email_delivery.send_digest", return_value={"status": "sent", "error": ""})
        self.mail = self.no_mail.start()
        self.no_asr = patch("app.services.agent_video_link_service.transcribe_note", side_effect=RuntimeError("mock no ASR"))
        self.asr = self.no_asr.start()

    def tearDown(self):
        self.no_mail.stop()
        self.no_asr.stop()
        self.db.close()
        self.engine.dispose()

    def rule(self, **changes):
        return service.save_subscription(self.db, user=self.user, payload=changes)

    def claim(self, rule=None, device="device-a"):
        rule = rule or self.rule()
        run = service.enqueue_manual(self.db, self.user.id, rule.id)
        claimed = service.claim_desktop(self.db, user_id=self.user.id, device_id=device, capabilities_version=1)
        return rule, run, {"run_id": claimed["run_id"], "device_id": device, "lease_token": claimed["lease_token"]}

    def complete(self, identity, *, sources=None):
        return service.desktop_complete(self.db, user_id=self.user.id, payload={**identity, "coverage": "complete", "sources": sources or [
            {"platform": "douyin", "source_mode": mode, "coverage": "complete", "read": 0, "saved": 0, "failed": 0}
            for mode in ("like", "collect")]})

    def note(self, suffix, *, modes=("like",), stamp=None, ready=True, likes=None, user_id=None):
        user_id = user_id or self.user.id
        video_id = str(1000000000000000000 + suffix)
        note = Note(user_id=user_id, video_id=video_id, video_title=f"视频 {suffix}", video_url=f"https://www.douyin.com/video/{video_id}",
            transcript_raw="可核实的完整原文及开头句子。" if ready else "", ai_summary=service.dump({"source_meta": {"caption": "公开标题摘要", "engagement": {"likes": likes} if likes is not None else {}}}),
            seo_title=f"视频 {suffix}", seo_slug=f"{user_id}-{suffix}", seo_meta="测试")
        self.db.add(note)
        self.db.flush()
        for mode in modes:
            self.db.add(VideoSourceLedger(user_id=user_id, video_id=video_id, note_id=note.id, source_mode=mode,
                first_seen_at=stamp or service.now(), last_seen_at=stamp or service.now(), source_synced_at=stamp or service.now()))
        self.db.commit()
        return note

    def test_default_subscription_and_user_isolation(self):
        rule = self.rule()
        self.assertEqual((rule.schedule_time, rule.timezone, rule.report_kind), ("15:00", "Asia/Shanghai", "daily_research"))
        self.assertEqual(service.config(rule)["sync_limit"], 500)
        with self.assertRaises(service.DailyResearchError):
            service.owned_subscription(self.db, self.other.id, rule.id)
        with self.assertRaises(service.DailyResearchError):
            self.rule(platforms=["bilibili"])

    def test_offline_waiting_does_not_occupy_research_workers_or_duplicate_days(self):
        rule = self.rule()
        rule.next_run_at = service.now() - timedelta(days=4)
        self.db.commit()
        self.assertEqual(automation_service.claim_due_runs(self.db, daily_only=True), [])
        run = service.list_runs(self.db, self.user.id)[0]
        self.assertEqual(run.status, "queued")
        self.assertEqual(service.poll(self.db), [])
        self.assertEqual(run.status, "waiting_for_desktop")
        rule.next_run_at = service.now() - timedelta(days=1)
        self.db.commit()
        automation_service.claim_due_runs(self.db, daily_only=True)
        self.assertEqual(len(service.list_runs(self.db, self.user.id)), 1)
        self.assertGreater(service.aware(rule.next_run_at), service.now())

    def test_core_claim_filter_does_not_schedule_legacy_digest(self):
        rule = automation_service.create_automation(self.db, user=self.user)
        rule.next_run_at = service.now() - timedelta(days=1)
        self.db.commit()
        self.assertEqual(automation_service.claim_due_runs(self.db, daily_only=True), [])
        self.assertEqual(self.db.query(AgentAutomationRun).count(), 0)

    def test_same_device_resumes_other_device_cannot_claim(self):
        _, run, identity = self.claim()
        same = service.claim_desktop(self.db, user_id=self.user.id, device_id="device-a", capabilities_version=1)
        self.assertEqual(same["lease_token"], identity["lease_token"])
        self.assertIsNone(service.claim_desktop(self.db, user_id=self.user.id, device_id="device-b", capabilities_version=1))
        state = run.state
        run.state_json = service.dump({**state, "lease_until": service.iso(service.now() - timedelta(seconds=1))})
        self.db.commit()
        takeover = service.claim_desktop(self.db, user_id=self.user.id, device_id="device-b", capabilities_version=1)
        self.assertNotEqual(takeover["lease_token"], identity["lease_token"])
        with self.assertRaises(service.DailyResearchError):
            service.check_desktop(self.db, user_id=self.user.id, **identity)

    def test_account_switch_revokes_old_device_lease(self):
        _, _, identity = self.claim()
        service.claim_desktop(self.db, user_id=self.other.id, device_id="device-a", capabilities_version=1)
        with self.assertRaises(service.DailyResearchError):
            service.check_desktop(self.db, user_id=self.user.id, **identity)

    def test_subscription_update_cancels_old_collector(self):
        rule, run, identity = self.claim()
        service.save_subscription(self.db, user=self.user, subscription_id=rule.id, payload={"instruction": "研究新的主题"})
        self.assertEqual(run.status, "cancelled")
        with self.assertRaises(service.DailyResearchError):
            service.desktop_progress(self.db, user_id=self.user.id, payload={**identity, "stage": "syncing"})

    def test_batch_replay_and_mutated_content_are_safe(self):
        _, _, identity = self.claim()
        payload = {**identity, "batch_id": "batch-0", "platform": "douyin", "source_mode": "like",
            "items": [{"video_id": "123456789", "title": "测试"}], "source_rank_offset": 0, "coverage": "complete", "order_reliable": True}
        with patch("app.services.agent_activity_service.record_snapshot", return_value={"accepted": 1, "created": 1, "reused": 0, "skipped": 0, "failed": 0, "items": [{"video_id": "123456789"}]}) as record:
            first = service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
            second = service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
            self.assertEqual(first, second)
            self.assertEqual(record.call_count, 1)
            with self.assertRaises(service.DailyResearchError):
                service.desktop_batch(self.db, user_id=self.user.id, payload={**payload, "items": [{"video_id": "123456780", "title": "其他内容"}]})

    def test_real_metadata_registration_reuses_note_without_agent_profile(self):
        _, _, identity = self.claim()
        payload = {**identity, "batch_id": "real-batch", "platform": "douyin", "source_mode": "like",
            "items": [{"video_id": "123456789", "title": "公开作品", "engagement": {"likes": 123}}],
            "source_rank_offset": 0, "coverage": "limited", "order_reliable": True}
        with patch("app.services.agent_activity_service._active", side_effect=AssertionError("产品接口不得依赖Agent开关")):
            saved = service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
            replay = service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
        self.assertEqual((saved["accepted"], saved["created"], saved["failed"]), (1, 1, 0))
        self.assertEqual(saved, replay)
        self.assertEqual(self.db.query(Note).filter_by(user_id=self.user.id, video_id="123456789").count(), 1)
        self.assertEqual(self.db.query(VideoSourceLedger).filter_by(user_id=self.user.id, video_id="123456789").count(), 1)
        self.asr.assert_not_called()
        self.mail.assert_not_called()

    def test_daily_router_requires_jwt_and_queue_returns_before_work(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.api.daily_research_routes import router
        from app.core.auth import get_current_user
        from app.core.database import get_db
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: self.db
        client = TestClient(app)
        self.assertEqual(client.get("/api/daily-research/status").status_code, 401)
        app.dependency_overrides[get_current_user] = lambda: self.user
        created = client.post("/api/daily-research/subscriptions", json={})
        self.assertEqual(created.status_code, 200, created.text)
        rule_id = created.json()["data"]["id"]
        response = client.post(f"/api/daily-research/subscriptions/{rule_id}/run", json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["status"], "queued")
        self.asr.assert_not_called()
        self.mail.assert_not_called()

    def test_calendar_window_includes_today_sync_and_handles_dst(self):
        for zone, instant, expected in (
            ("Asia/Shanghai", datetime(2026, 10, 13, 7, 12, tzinfo=timezone.utc), datetime(2026, 10, 11, 16, tzinfo=timezone.utc)),
            ("America/New_York", datetime(2026, 3, 9, 19, 12, tzinfo=timezone.utc), datetime(2026, 3, 8, 5, tzinfo=timezone.utc)),
        ):
            with self.subTest(zone=zone):
                rule = self.rule(timezone=zone)
                _, run, identity = self.claim(rule)
                with patch.object(service, "now", return_value=instant):
                    # 租约同样使用本次测试的时间，避免测试时钟误触发过期。
                    run.state_json = service.dump({**run.state, "lease_until": service.iso(instant + timedelta(minutes=10))})
                    self.db.commit()
                    self.complete(identity)
                self.assertEqual(datetime.fromisoformat(run.state["window_start"]), expected)
                self.assertEqual(datetime.fromisoformat(run.state["window_end"]), instant)
                run.status = "completed"
                self.db.commit()

    def test_window_dedup_hidden_user_and_like_ranking(self):
        rule, run, identity = self.claim()
        current = service.now()
        dual = self.note(1, modes=("like", "collect"), likes=10)
        top = self.note(2, likes=100)
        self.note(3, stamp=current - timedelta(days=4), likes=99999)
        hidden = self.note(4, likes=9999)
        self.db.add(LibraryHiddenItem(user_id=self.user.id, aweme_id=hidden.video_id))
        self.note(5, user_id=self.other.id, likes=99999)
        self.note(6, likes=0)
        self.note(7)
        self.db.commit()
        self.complete(identity)
        selected = service.snapshot_sources(self.db, run, rule)
        self.assertEqual(len(selected), 4)
        self.assertEqual(selected[0]["video_id"], top.video_id)
        self.assertEqual(set(selected[1]["modes"]), {"like", "collect"})
        self.assertEqual(selected[-2]["engagement"]["likes"], 0)
        self.assertEqual(selected[-1]["engagement"], {})

    def test_all_failed_sync_does_not_research(self):
        _, run, identity = self.claim()
        self.complete(identity, sources=[{"platform": "douyin", "source_mode": mode, "coverage": "partial",
            "read": 0, "failed": 0, "error": "平台需要验证"} for mode in ("like", "collect")])
        self.assertEqual(run.status, "failed")
        self.assertEqual(service.poll(self.db), [])
        self.mail.assert_not_called()

    def test_no_new_sources_neither_charges_nor_emails(self):
        _, run, identity = self.claim()
        self.complete(identity)
        with patch.object(service, "_reserve_report_charge") as reserve:
            result = service.execute_research(self.db, run_id=run.id)
            self.assertEqual(result.status, "completed")
            reserve.assert_not_called()
        self.mail.assert_not_called()

    def test_report_capture_and_email_are_idempotent(self):
        rule, run, identity = self.claim(self.rule(recipient_email="recipient@example.com"))
        self.note(1)
        self.db.add(DailyResearchRecipient(user_id=self.user.id, email=rule.recipient_email, verified_at=service.now()))
        self.db.commit()
        self.complete(identity)
        thread = AgentThread(user_id=self.user.id, title="每日研究", scope_type="selected", scope_label="测试", source_ids_json="[]")
        self.db.add(thread)
        self.db.commit()
        charge = SimpleNamespace(request_id="test")
        with patch.object(service, "_reserve_report_charge", return_value=charge), \
             patch("app.services.agent_service.create_thread_from_notes", return_value=thread), \
             patch("app.services.agent_service.ask_thread", return_value=(None, SimpleNamespace(content="已引用完整原文的研究。"))), \
             patch("app.services.chat_credit_billing_service.capture") as capture, \
             patch("app.services.email_delivery.is_configured", return_value=True):
            first = service.execute_research(self.db, run_id=run.id)
            second = service.execute_research(self.db, run_id=run.id)
            self.assertEqual(first.status, "completed")
            self.assertEqual(second.delivery_status, "sent")
            self.assertEqual(capture.call_count, 1)
            self.assertEqual(self.mail.call_count, 1)
            self.assertEqual(self.mail.call_args.kwargs["body"], first.result_text)
            self.assertIn("daily-research?run=", self.mail.call_args.kwargs["report_url"])

    def test_quota_failure_does_not_start_asr_or_email(self):
        _, run, identity = self.claim()
        self.note(1, ready=False)
        self.complete(identity)
        with patch.object(service, "_reserve_report_charge", side_effect=ValueError("额度不足")):
            result = service.execute_research(self.db, run_id=run.id)
        self.assertEqual(result.status, "failed")
        self.asr.assert_not_called()
        self.mail.assert_not_called()

    def test_stale_delivery_is_unknown_and_never_retried(self):
        _, run, identity = self.claim()
        self.complete(identity)
        run.status, run.delivery_status = "researching", "delivering"
        run.heartbeat_at = service.now() - timedelta(minutes=11)
        self.db.commit()
        self.assertEqual(service.poll(self.db), [])
        self.assertEqual(run.delivery_status, "unknown")
        service.execute_research(self.db, run_id=run.id)
        self.mail.assert_not_called()

    def test_arbitrary_recipient_code_hash_rate_limit_and_attempts(self):
        with patch("app.services.email_delivery.is_configured", return_value=True), \
             patch("app.services.email_delivery.send_daily_research_verification", return_value={"status": "sent"}) as mail, \
             patch("secrets.randbelow", return_value=123456):
            service.send_recipient_code(self.db, user_id=self.user.id, email="report@example.com")
            row = self.db.query(DailyResearchRecipient).one()
            self.assertNotIn("123456", row.code_hash)
            with self.assertRaises(service.DailyResearchError):
                service.send_recipient_code(self.db, user_id=self.user.id, email="other@example.com")
            with self.assertRaises(service.DailyResearchError):
                service.confirm_recipient_code(self.db, user_id=self.other.id, email="report@example.com", code="123456")
            verified = service.confirm_recipient_code(self.db, user_id=self.user.id, email="report@example.com", code="123456")
            self.assertTrue(verified["verified"])
            self.assertIsNone(row.code_hash)
            self.assertEqual(mail.call_count, 1)

    def test_unconfigured_verification_does_not_claim_email_sent(self):
        with patch("app.services.email_delivery.is_configured", return_value=False), \
             patch("app.services.email_delivery.send_daily_research_verification") as mail:
            result = service.send_recipient_code(self.db, user_id=self.user.id, email="report@example.com")
            self.assertEqual(result["status"], "not_configured")
            self.assertFalse(result["verified"])
            mail.assert_not_called()

    def test_legacy_manual_preview_finishes_and_cannot_reexecute(self):
        rule = automation_service.create_automation(self.db, user=self.user)
        run = automation_service.create_manual_run(self.db, automation=rule)
        note = self.note(1)
        thread = AgentThread(user_id=self.user.id, title="摘要", scope_type="selected", scope_label="测试", source_ids_json="[]")
        self.db.add(thread)
        self.db.commit()
        with patch("app.services.agent_service.resolve_source_snapshot", return_value=([note], 1, False, "昨天")), \
             patch("app.services.agent_service.create_thread_from_notes", return_value=thread), \
             patch("app.services.agent_service.ask_thread", return_value=(None, SimpleNamespace(content="摘要", result={}))) as ask:
            result = automation_service.execute_run(self.db, run_id=run.id, deliver=False)
            self.assertEqual(result.status, "completed")
            automation_service.execute_run(self.db, run_id=run.id, deliver=False)
            self.assertEqual(ask.call_count, 1)

    def test_legacy_api_cannot_find_new_product_subscription(self):
        rule = self.rule()
        self.assertEqual(automation_service.list_automations(self.db, self.user.id), [])
        self.assertIsNone(automation_service.get_automation(self.db, rule.id, self.user.id))

    def test_partial_failure_count_cannot_cover_unsubmitted_items_twice(self):
        _, run, identity = self.claim()
        sources = [{"platform": "douyin", "source_mode": mode, "coverage": "partial", "read": 100,
            "saved": 0, "failed": 50, "error": "有一部分未能保存"} for mode in ("like", "collect")]
        with self.assertRaises(service.DailyResearchError):
            self.complete(identity, sources=sources)
        self.assertEqual(run.status, "syncing")

    def test_late_batch_failure_does_not_overwrite_completed_receipt(self):
        _, run, identity = self.claim()
        payload = {**identity, "batch_id": "late-batch", "platform": "douyin", "source_mode": "like",
            "items": [{"video_id": "123456789", "title": "测试"}], "source_rank_offset": 0, "coverage": "complete", "order_reliable": True}
        def replaced(*args, **kwargs):
            receipt = self.db.query(DailyResearchBatch).filter_by(run_id=run.id, batch_id="late-batch").one()
            receipt.status = "completed"
            receipt.updated_at = service.now() + timedelta(seconds=1)
            receipt.result_json = service.dump({"accepted": 1, "batch_id": "late-batch"})
            self.db.commit()
            raise RuntimeError("旧设备迟到的失败")
        with patch("app.services.agent_activity_service.record_snapshot", side_effect=replaced):
            with self.assertRaises(RuntimeError):
                service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
        receipt = self.db.query(DailyResearchBatch).one()
        self.assertEqual(receipt.status, "completed")
        self.assertEqual(service.load(receipt.result_json)["accepted"], 1)

    def test_same_device_old_batch_attempt_stops_before_next_item(self):
        _, run, identity = self.claim()
        payload = {**identity, "batch_id": "attempt-batch", "platform": "douyin", "source_mode": "like",
            "items": [{"video_id": "123456789", "title": "测试"}], "source_rank_offset": 0, "coverage": "complete", "order_reliable": True}
        def new_attempt(*args, **kwargs):
            receipt = self.db.query(DailyResearchBatch).filter_by(run_id=run.id).one()
            receipt.updated_at = service.now() + timedelta(seconds=1)
            self.db.commit()
            kwargs["check_active"]()
        with patch("app.services.agent_activity_service.record_snapshot", side_effect=new_attempt):
            with self.assertRaises(service.DailyResearchError):
                service.desktop_batch(self.db, user_id=self.user.id, payload=payload)
        receipt = self.db.query(DailyResearchBatch).one()
        self.assertEqual(receipt.status, "processing")

    def test_poll_stale_snapshot_cannot_erase_new_desktop_lease(self):
        rule = self.rule()
        run = service.enqueue_manual(self.db, self.user.id, rule.id)
        new_state = service.dump({"stage": "syncing", "desktop_token": "new-token"})
        def concurrent_claim(db, ignored_run):
            with sessionmaker(bind=self.engine)() as other_db:
                other_db.query(AgentAutomationRun).filter_by(id=run.id).update({
                    AgentAutomationRun.status: "syncing", AgentAutomationRun.state_json: new_state}, synchronize_session=False)
                other_db.commit()
            return rule
        with patch.object(service, "_rule_valid", side_effect=concurrent_claim):
            service.poll(self.db)
        self.db.refresh(run)
        self.assertEqual((run.status, run.state["desktop_token"]), ("syncing", "new-token"))

    def test_late_progress_cannot_reopen_preparing_run(self):
        _, run, identity = self.claim()
        def finish_in_other_session(*args, **kwargs):
            with sessionmaker(bind=self.engine)() as other_db:
                other_db.query(AgentAutomationRun).filter_by(id=run.id).update({
                    AgentAutomationRun.status: "preparing", AgentAutomationRun.state_json: service.dump({"stage": "preparing"})}, synchronize_session=False)
                other_db.commit()
        with patch.object(service, "_touch_device", side_effect=finish_in_other_session):
            with self.assertRaises(service.DailyResearchError):
                service.desktop_progress(self.db, user_id=self.user.id, payload={**identity, "stage": "syncing"})
        self.db.refresh(run)
        self.assertEqual(run.status, "preparing")

    def test_crash_recovery_settles_original_day_free_reservation_once(self):
        offering = ChatModelOffering(code="daily-test", name="测试模型", model_id="test", is_free=True)
        self.db.add(offering)
        self.db.commit()
        yesterday = service.now() - timedelta(days=1)
        day = yesterday.astimezone(automation_service._timezone("Asia/Shanghai")).date()
        usage = ChatModelFreeUsage(user_id=self.user.id, offering_id=offering.id, period_date=day, reserved_count=2)
        self.db.add(usage)
        runs = []
        for completed in (False, True):
            rule = self.rule()
            run = service.enqueue_manual(self.db, self.user.id, rule.id)
            run.status = "researching"
            run.state_json = service.dump({"model_completed": completed})
            run.heartbeat_at = yesterday
            self.db.add(ChatModelChargeReservation(request_id=f"daily-research:{run.id}", user_id=self.user.id,
                offering_id=offering.id, kind="free", created_at=yesterday))
            runs.append(run)
        self.db.commit()
        service.poll(self.db)
        service.poll(self.db)
        self.db.refresh(usage)
        self.assertEqual((usage.reserved_count, usage.used_count), (0, 1))
        states = [self.db.get(ChatModelChargeReservation, f"daily-research:{run.id}").state for run in runs]
        self.assertEqual(states, ["released", "captured"])

    def test_two_sessions_with_cached_reservation_cannot_release_another_runs_quota(self):
        from app.services.chat_credit_billing_service import ChatCharge
        offering = ChatModelOffering(code="concurrent-test", name="并发测试", model_id="test", is_free=True)
        self.db.add(offering)
        self.db.commit()
        stamp = service.now()
        day = stamp.astimezone(automation_service._timezone("Asia/Shanghai")).date()
        usage = ChatModelFreeUsage(user_id=self.user.id, offering_id=offering.id, period_date=day, reserved_count=2)
        reservation = ChatModelChargeReservation(request_id="concurrent-reservation", user_id=self.user.id,
            offering_id=offering.id, kind="free", created_at=stamp)
        self.db.add_all([usage, reservation])
        self.db.commit()
        charge = ChatCharge(reservation.request_id, offering.id, self.user.id, "free")
        with sessionmaker(bind=self.engine)() as second:
            cached = second.get(ChatModelChargeReservation, reservation.request_id)
            cached_usage = second.get(ChatModelFreeUsage, usage.id)
            self.assertEqual(cached.state, "reserved")
            service._settle_charge(self.db, charge, completed=False)
            service._settle_charge(second, charge, completed=False)
            second.refresh(cached_usage)
            self.assertEqual(cached_usage.reserved_count, 1)


if __name__ == "__main__":
    unittest.main()
