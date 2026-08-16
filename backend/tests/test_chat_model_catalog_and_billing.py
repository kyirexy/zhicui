from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import agent_routes
from app.core.database import Base
from app.models.chat_model import (
    ChatModelChargeReservation,
    ChatModelFreeUsage,
    ChatModelOffering,
)
from app.models.user import User
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.models.video_analysis import AnalysisCreditLedger, UserAnalysisAccount
from app.services import (
    chat_credit_billing_service as billing,
    chat_model_catalog_service as catalog,
    video_analysis_billing_service as credits,
)


class ChatModelCatalogAndBillingTests(unittest.TestCase):
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
            id="chat-user-a",
            email="chat-a@example.com",
            username="chat-a",
            hashed_password="test",
            is_active=True,
        )
        self.other = User(
            id="chat-user-b",
            email="chat-b@example.com",
            username="chat-b",
            hashed_password="test",
            is_active=True,
        )
        self.db.add_all([self.user, self.other])
        self.db.commit()
        self.config_patch = patch.object(
            catalog.settings_service,
            "get_llm_config",
            return_value={
                "provider": "platform",
                "model": "platform-model-v1",
                "runtime_model": "platform-model-v1",
                "api_base": "https://example.com/v1",
                "api_key": "server-secret",
            },
        )
        self.config_patch.start()

    def tearDown(self) -> None:
        self.config_patch.stop()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _offering(self, *, code: str, name: str, free: bool, points: int = 0, limit: int = 0):
        return catalog.save(
            self.db,
            offering_id=None,
            code=code,
            name=name,
            description="测试模型",
            provider_mode="platform",
            model_id=f"runtime-{code}",
            enabled=True,
            visible_to_users=True,
            is_default=False,
            is_free=free,
            free_daily_limit=limit,
            points_per_request=points,
            supports_images=True,
            supports_tools=False,
            sort_order=20,
        )

    def test_default_seed_and_user_view_do_not_expose_runtime_details(self) -> None:
        offering = catalog.ensure_default_offering(self.db)
        self.assertEqual(offering.name, "免费模型")
        self.assertEqual(offering.model_id, "platform-model-v1")
        payload = catalog.serialize_user(self.db, offering, self.user.id)
        self.assertNotIn("model_id", payload)
        self.assertNotIn("provider_mode", payload)
        self.assertNotIn("api_key", str(payload))
        self.assertEqual(payload["free_remaining_today"], 30)

    def test_admin_rejects_automatic_model_ids(self) -> None:
        for model_id in ("auto", "auto/best-free"):
            with self.subTest(model_id=model_id), self.assertRaisesRegex(ValueError, "不支持智能选择"):
                catalog.save(
                    self.db,
                    offering_id=None,
                    code=f"bad-{model_id.replace('/', '-')}",
                    name="错误模型",
                    description="",
                    provider_mode="platform",
                    model_id=model_id,
                    enabled=True,
                    visible_to_users=True,
                    is_default=False,
                    is_free=True,
                    free_daily_limit=1,
                    points_per_request=0,
                    supports_images=False,
                    supports_tools=False,
                    sort_order=10,
                )

    def test_selection_is_scoped_and_limited_to_published_offerings(self) -> None:
        default = catalog.ensure_default_offering(self.db)
        paid = self._offering(code="paid", name="收费模型", free=False, points=25)
        catalog.select_for_user(self.db, self.user.id, paid.id)
        self.assertEqual(catalog.selected_offering(self.db, self.user.id).id, paid.id)
        self.assertEqual(catalog.selected_offering(self.db, self.other.id).id, default.id)
        paid.visible_to_users = False
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "未发布或已停用"):
            catalog.select_for_user(self.db, self.other.id, paid.id)

    def test_free_quota_reserve_capture_and_retry_are_idempotent(self) -> None:
        offering = self._offering(code="free-one", name="每日一次", free=True, limit=1)
        first = billing.reserve(
            self.db, user_id=self.user.id, offering=offering, request_id="free-request"
        )
        duplicate = billing.reserve(
            self.db, user_id=self.user.id, offering=offering, request_id="free-request"
        )
        self.assertEqual(first, duplicate)
        row = self.db.query(ChatModelFreeUsage).filter_by(
            user_id=self.user.id, offering_id=offering.id
        ).one()
        self.assertEqual(row.reserved_count, 1)
        billing.capture(self.db, first)
        billing.capture(self.db, duplicate)
        self.db.refresh(row)
        self.assertEqual((row.used_count, row.reserved_count), (1, 0))
        with self.assertRaisesRegex(ValueError, "免费次数已用完"):
            billing.reserve(
                self.db, user_id=self.user.id, offering=offering, request_id="free-request-2"
            )

    def test_paid_reserve_release_and_capture_are_idempotent(self) -> None:
        offering = self._offering(code="paid-25", name="收费 25", free=False, points=25)
        credits.adjust_credits(
            self.db,
            user_id=self.user.id,
            points_delta=100,
            reason="测试发放",
            admin_user_id=self.other.id,
            idempotency_key="chat-test-grant",
            entry_type="grant",
        )
        charge = billing.reserve(
            self.db, user_id=self.user.id, offering=offering, request_id="paid-release"
        )
        billing.reserve(
            self.db, user_id=self.user.id, offering=offering, request_id="paid-release"
        )
        account = credits.get_or_create_account(self.db, self.user.id)
        self.assertEqual((account.available_points, account.reserved_points), (75, 25))
        billing.release(self.db, charge)
        billing.release(self.db, charge)
        self.db.refresh(account)
        self.assertEqual((account.available_points, account.reserved_points), (100, 0))

        captured = billing.reserve(
            self.db, user_id=self.user.id, offering=offering, request_id="paid-capture"
        )
        billing.capture(self.db, captured)
        billing.capture(self.db, captured)
        self.db.refresh(account)
        self.assertEqual((account.available_points, account.reserved_points), (75, 0))

    def test_byok_agent_request_does_not_reserve_platform_points(self) -> None:
        self.db.add(UserAIProviderConfig(
            user_id=self.user.id,
            mode="custom",
            provider_name="我的供应商",
            model="my-model",
            api_base="https://example.com/v1",
            encrypted_api_key="ENC:test",
            enabled=True,
        ))
        self.db.commit()
        self.assertIsNone(agent_routes._reserve_chat_charge(self.db, self.user.id))
        self.assertEqual(self.db.query(ChatModelChargeReservation).count(), 0)
        self.assertEqual(self.db.query(AnalysisCreditLedger).count(), 0)
        self.assertEqual(self.db.query(UserAnalysisAccount).count(), 0)


if __name__ == "__main__":
    unittest.main()
