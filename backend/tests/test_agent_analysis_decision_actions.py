from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("JWT_SECRET", "agent-analysis-decision-test-secret-123456789")
os.environ.setdefault("AGENT_TOKEN_PEPPER", "agent-analysis-decision-pepper-123456789")

from app.agent_interface.contracts import IdempotencyStrategy, RiskLevel, RunType
from app.core.database import Base
from app.models.agent_interface import (
    AgentCredential,
    ProductActionAudit,
    ProductActionConfirmation,
    ProductActionEvent,
    ProductActionIdempotency,
    ProductActionRateWindow,
    ProductActionRun,
)
from app.models.user import User
from app.services import product_action_handlers
from app.services.agent_credential_service import AgentPrincipal
from app.services.product_action_registry import registry
from app.services.product_action_run_service import (
    ProductActionError,
    _validate_input,
    invoke,
)


ACTION_IDS = (
    "ask.analysis.approve",
    "ask.analysis.text_only",
    "ask.analysis.cancel",
    "ask.analysis.reprepare",
)


class AgentAnalysisDecisionActionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _foreign_keys(connection, _record) -> None:
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                AgentCredential.__table__,
                ProductActionRun.__table__,
                ProductActionEvent.__table__,
                ProductActionIdempotency.__table__,
                ProductActionConfirmation.__table__,
                ProductActionAudit.__table__,
                ProductActionRateWindow.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(
            id="analysis-action-user",
            email="analysis-action@example.com",
            username="analysis-action",
            hashed_password="not-used",
            is_active=True,
        )
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _principal(self) -> AgentPrincipal:
        return AgentPrincipal(
            user=self.user,
            credential=None,
            scopes=frozenset({"ask:run", "analysis:run"}),
            auth_type="browser",
        )

    def test_registry_exposes_four_separate_reviewed_decisions(self) -> None:
        for action_id in ACTION_IDS:
            definition = registry.get(action_id)
            self.assertIsNotNone(definition, action_id)
            assert definition is not None
            self.assertTrue(definition.available)
            self.assertEqual(
                set(definition.scopes), {"ask:run", "analysis:run"}
            )
            self.assertEqual(
                definition.idempotency, IdempotencyStrategy.REQUIRED
            )
            self.assertEqual(
                set(definition.input_schema.get("required") or []),
                {"thread_id", "run_id"},
            )
            with self.assertRaises(ProductActionError):
                _validate_input(
                    dict(definition.input_schema),
                    {
                        "thread_id": "thread-1",
                        "run_id": "run-1",
                        # Arbitrary legacy decisions are deliberately not a
                        # public Action input.
                        "action": "approve",
                    },
                )

        approve = registry.get("ask.analysis.approve")
        assert approve is not None
        self.assertTrue(approve.confirmation_required)
        self.assertEqual(approve.run_type, RunType.LONG_TASK)
        self.assertEqual(
            set(approve.risk), {RiskLevel.WRITE, RiskLevel.BILLABLE}
        )
        reprepare = registry.get("ask.analysis.reprepare")
        assert reprepare is not None
        self.assertEqual(reprepare.run_type, RunType.LONG_TASK)
        self.assertFalse(reprepare.confirmation_required)

    def test_billable_approve_never_executes_before_user_confirmation(self) -> None:
        with patch.object(
            product_action_handlers.agent_service,
            "decide_agent_video_analysis",
        ) as decide, self.assertRaises(ProductActionError) as caught:
            invoke(
                self.db,
                principal=self._principal(),
                action_id="ask.analysis.approve",
                raw_input={"thread_id": "thread-1", "run_id": "analysis-1"},
                request_id="approval-gate",
                idempotency_key="approval-gate-key",
                confirmation_id=None,
            )
        self.assertEqual(caught.exception.code, "CONFIRMATION_REQUIRED")
        decide.assert_not_called()
        confirmation = self.db.query(ProductActionConfirmation).one()
        self.assertEqual(confirmation.action_id, "ask.analysis.approve")
        self.assertEqual(self.db.query(ProductActionRun).count(), 0)

    def test_handlers_map_all_branches_and_keep_thread_run_linkage(self) -> None:
        cases = (
            (
                product_action_handlers.ask_analysis_approve,
                "approve",
                "running_analysis",
                "analysis-approved",
                {},
            ),
            (
                product_action_handlers.ask_analysis_text_only,
                "text_only",
                "ready",
                None,
                {},
            ),
            (
                product_action_handlers.ask_analysis_cancel,
                "cancel",
                "ready",
                None,
                {},
            ),
            (
                product_action_handlers.ask_analysis_reprepare,
                "reprepare",
                "awaiting_approval",
                "analysis-reprepared",
                {"offering_id": "offering-next", "use_byok": True},
            ),
        )
        for handler, decision, expected_status, external_id, extra in cases:
            with self.subTest(decision=decision):
                db = MagicMock()
                thread = SimpleNamespace(id="thread-1", status="awaiting_approval")
                public_run = SimpleNamespace(
                    id=f"public-{decision}",
                    idempotency_key=f"decision-{decision}",
                    external_type=None,
                    external_id=None,
                )
                ctx = SimpleNamespace(
                    db=db,
                    user=SimpleNamespace(id="owner-1"),
                    run=public_run,
                )

                def decide(_db, **kwargs):
                    self.assertIs(kwargs["thread"], thread)
                    thread.status = expected_status
                    result = {
                        "terminal": {
                            "approve": "analysis_started",
                            "text_only": "done",
                            "cancel": "cancelled",
                            "reprepare": "approval_required",
                        }[decision],
                        "thread": {"id": thread.id, "status": thread.status},
                        "user_message": {},
                        "assistant_message": {},
                        "video_analysis": {
                            "run": {
                                "id": external_id or "analysis-original",
                                "status": (
                                    "prepared"
                                    if decision == "reprepare"
                                    else "running"
                                    if decision == "approve"
                                    else "cancelled"
                                ),
                            }
                        },
                    }
                    return result

                with patch.object(
                    product_action_handlers.agent_service,
                    "get_thread",
                    return_value=thread,
                ) as get_thread, patch.object(
                    product_action_handlers.agent_service,
                    "decide_agent_video_analysis",
                    side_effect=decide,
                ) as decide_mock:
                    result = handler(
                        ctx,
                        {
                            "thread_id": "thread-1",
                            "run_id": "analysis-original",
                            **extra,
                        },
                    )

                get_thread.assert_called_once_with(db, "thread-1", "owner-1")
                call = decide_mock.call_args.kwargs
                self.assertEqual(call["user_id"], "owner-1")
                self.assertEqual(call["run_id"], "analysis-original")
                self.assertEqual(call["action"], decision)
                self.assertEqual(
                    call["idempotency_key"], f"decision-{decision}"
                )
                self.assertEqual(
                    call["offering_id"],
                    "offering-next" if decision == "reprepare" else None,
                )
                self.assertEqual(
                    call["use_byok"], decision == "reprepare"
                )
                self.assertEqual(result["thread"]["status"], expected_status)
                if external_id:
                    self.assertEqual(public_run.external_type, "video_analysis")
                    self.assertEqual(public_run.external_id, external_id)
                    self.assertEqual(
                        result["resume"]["run_id"], public_run.id
                    )
                    db.commit.assert_called_once()
                else:
                    self.assertIsNone(public_run.external_type)
                    self.assertIsNone(public_run.external_id)
                    db.commit.assert_not_called()

    def test_handler_never_resolves_another_users_thread(self) -> None:
        ctx = SimpleNamespace(
            db=MagicMock(),
            user=SimpleNamespace(id="owner-1"),
            run=SimpleNamespace(id="public-run", idempotency_key="key"),
        )
        with patch.object(
            product_action_handlers.agent_service,
            "get_thread",
            return_value=None,
        ) as get_thread, patch.object(
            product_action_handlers.agent_service,
            "decide_agent_video_analysis",
        ) as decide, self.assertRaises(
            product_action_handlers.ActionHandlerError
        ) as caught:
            product_action_handlers.ask_analysis_cancel(
                ctx,
                {"thread_id": "foreign-thread", "run_id": "foreign-run"},
            )
        self.assertEqual(caught.exception.code, "RESOURCE_NOT_FOUND")
        get_thread.assert_called_once_with(ctx.db, "foreign-thread", "owner-1")
        decide.assert_not_called()


if __name__ == "__main__":
    unittest.main()
