from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.agent_thread import AgentMessage, AgentThread
from app.models.chat_model import ChatModelFreeUsage, ChatModelOffering
from app.models.knowledge_entry import KnowledgeEntry
from app.models.note import Note
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.models.user_ai_provider_config import UserAIProviderConfig
from app.models.user_custom_chat_model import UserCustomChatModel
from app.services import (
    agent_service,
    chat_model_catalog_service,
    knowledge_service,
    omniroute_workspace_service,
    user_ai_provider_service,
)
from app.api import agent_routes, routes
from fastapi import HTTPException


class PersonalKnowledgeServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                User.__table__,
                Note.__table__,
                KnowledgeEntry.__table__,
                UserAIProviderConfig.__table__,
                UserCustomChatModel.__table__,
                ChatModelOffering.__table__,
                ChatModelFreeUsage.__table__,
                SystemSetting.__table__,
            ],
        )
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user_a = User(email="a@example.com", hashed_password="x")
        self.user_b = User(email="b@example.com", hashed_password="x")
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_entry_crud_is_scoped_to_owner(self) -> None:
        entry = knowledge_service.create_entry(
            self.db,
            self.user_a.id,
            title="我的判断",
            content="这是只属于用户 A 的长期理解。",
        )
        self.assertIsNotNone(
            knowledge_service.get_entry(self.db, self.user_a.id, entry.id)
        )
        self.assertIsNone(
            knowledge_service.get_entry(self.db, self.user_b.id, entry.id)
        )
        with self.assertRaises(ValueError):
            knowledge_service.create_entry(
                self.db,
                self.user_a.id,
                title=" ",
                content="正文",
            )

    def test_pages_and_inbox_search_are_separate(self) -> None:
        knowledge_service.create_entry(
            self.db,
            self.user_a.id,
            title="复利思维",
            content="长期积累会形成复利。",
        )
        self.db.add(Note(
            user_id=self.user_a.id,
            video_id="video-1",
            video_title="复利学习方法",
            video_url="https://example.com/video",
            transcript_raw="每天练习形成复利。",
            ai_summary=(
                '{"conclusion":"保持积累","sections":[{"title":"练习","content":"每天进行"}],'
                '"source_meta":{"cover_url":"https://example.com/cover.jpg",'
                '"author_name":"知识作者","platform":"douyin"}}'
            ),
            card_type="general",
            seo_title="复利学习方法",
            seo_slug="compound-learning",
            seo_meta="复利",
            pitfall_rating=3,
        ))
        self.db.commit()

        pages = knowledge_service.list_knowledge(
            self.db,
            self.user_a.id,
            view="pages",
            search="复利",
        )
        inbox = knowledge_service.list_knowledge(
            self.db,
            self.user_a.id,
            view="inbox",
            search="复利",
        )

        self.assertEqual(pages["total"], 1)
        self.assertEqual(pages["items"][0]["kind"], "page")
        self.assertEqual(inbox["total"], 1)
        candidate = inbox["items"][0]
        self.assertEqual(candidate["kind"], "candidate")
        self.assertEqual(candidate["cover_url"], "https://example.com/cover.jpg")
        self.assertEqual(candidate["author_name"], "知识作者")
        self.assertEqual(candidate["platform"], "douyin")
        self.assertEqual(candidate["section_count"], 1)
        self.assertTrue(candidate["transcript_ready"])

    def test_omniroute_mode_is_not_a_user_selectable_mode(self) -> None:
        with (
            patch.object(
                user_ai_provider_service.settings_service,
                "encrypt_value",
                side_effect=lambda value: f"ENC:{value[::-1]}",
            ),
            patch.object(
                user_ai_provider_service.settings_service,
                "decrypt_value",
                side_effect=lambda value: value[4:][::-1],
            ),
        ):
            saved = user_ai_provider_service.save(
                self.db,
                self.user_a.id,
                mode="custom",
                provider_name="My Provider",
                model="my-model",
                api_base="https://example.com/v1",
                api_key="secret-key-1234",
            )
            row = self.db.query(UserAIProviderConfig).filter_by(user_id=self.user_a.id).one()
            self.assertNotIn("secret-key-1234", row.encrypted_api_key)
            self.assertTrue(saved["api_key_set"])
            other = user_ai_provider_service.serialize(self.db, self.user_b.id)
            self.assertEqual(other["mode"], "platform")
            self.assertTrue(other["enabled"])
            self.assertFalse(other["api_key_set"])

    def test_custom_provider_promotes_to_selectable_custom_model(self) -> None:
        with (
            patch.object(
                user_ai_provider_service.settings_service,
                "encrypt_value",
                side_effect=lambda value: f"ENC:{value[::-1]}",
            ),
            patch.object(
                user_ai_provider_service.settings_service,
                "decrypt_value",
                side_effect=lambda value: value[4:][::-1],
            ),
        ):
            user_ai_provider_service.save(
                self.db,
                self.user_a.id,
                mode="custom",
                provider_name="My Provider",
                model="my-model",
                api_base="https://example.com/v1",
                api_key="secret-key-1234",
            )
            models = user_ai_provider_service.list_custom_models(self.db, self.user_a.id)
            self.assertEqual(len(models["items"]), 1)
            self.assertEqual(models["selected_id"], models["items"][0]["id"])
            self.assertEqual(models["items"][0]["model"], "my-model")

            user_ai_provider_service.select_platform(self.db, self.user_a.id)
            listing = user_ai_provider_service.list_custom_models(self.db, self.user_a.id)
            self.assertIsNone(listing["selected_id"])
            self.assertFalse(listing["items"][0]["is_selected"])

    def test_effective_config_prefers_selected_enabled_custom_model(self) -> None:
        with (
            patch.object(
                user_ai_provider_service.settings_service,
                "encrypt_value",
                side_effect=lambda value: f"ENC:{value[::-1]}",
            ),
            patch.object(
                user_ai_provider_service.settings_service,
                "decrypt_value",
                side_effect=lambda value: value[4:][::-1],
            ),
        ):
            created = user_ai_provider_service.create_custom_model(
                self.db,
                self.user_a.id,
                name="DeepSeek",
                provider_name="DeepSeek",
                model="deepseek-chat",
                api_base="https://example.com/v1",
                api_key="secret-key-4321",
                select=True,
            )
            self.assertTrue(created["is_selected"])
            cfg = user_ai_provider_service.effective_config(self.db, self.user_a.id)
            self.assertEqual(cfg["model"], "deepseek-chat")
            self.assertEqual(cfg["runtime_model"], "openai/deepseek-chat")
            self.assertEqual(cfg["api_key"], "secret-key-4321")
            self.assertTrue(user_ai_provider_service.uses_custom_provider(self.db, self.user_a.id))
            public = user_ai_provider_service.serialize(self.db, self.user_a.id)
            self.assertEqual(public["mode"], "custom")
            self.assertEqual(public["selected_custom_model_id"], created["id"])
            self.assertNotIn("secret-key-4321", str(public))

    def test_custom_model_crud_switch_and_selected_delete_falls_back_to_platform(self) -> None:
        with (
            patch.object(
                user_ai_provider_service.settings_service,
                "encrypt_value",
                side_effect=lambda value: f"ENC:{value[::-1]}",
            ),
            patch.object(
                user_ai_provider_service.settings_service,
                "decrypt_value",
                side_effect=lambda value: value[4:][::-1],
            ),
            patch.object(
                user_ai_provider_service.settings_service,
                "get_llm_config",
                return_value={
                    "provider": "platform",
                    "model": "platform-default",
                    "runtime_model": "platform-default",
                    "api_base": "",
                    "api_key": "platform-secret",
                },
            ),
        ):
            first = user_ai_provider_service.create_custom_model(
                self.db,
                self.user_a.id,
                name="First",
                provider_name="OpenAI Compatible",
                model="first-model",
                api_base="https://first.example.com/v1",
                api_key="first-secret",
                select=True,
            )
            second = user_ai_provider_service.create_custom_model(
                self.db,
                self.user_a.id,
                name="Second",
                provider_name="OpenAI Compatible",
                model="second-model",
                api_base="https://second.example.com/v1",
                api_key="second-secret",
            )
            updated = user_ai_provider_service.update_custom_model(
                self.db,
                self.user_a.id,
                second["id"],
                name="Second Updated",
                model="second-model-v2",
            )
            self.assertEqual(updated["name"], "Second Updated")
            self.assertEqual(updated["model"], "second-model-v2")

            selected = user_ai_provider_service.select_custom_model(
                self.db, self.user_a.id, second["id"]
            )
            self.assertEqual(selected["selected_id"], second["id"])
            self.assertFalse(user_ai_provider_service.get_custom_model(
                self.db, self.user_a.id, first["id"]
            )["is_selected"])
            self.assertEqual(
                user_ai_provider_service.effective_config(self.db, self.user_a.id)["model"],
                "second-model-v2",
            )
            with patch(
                "litellm.completion",
                return_value=SimpleNamespace(
                    choices=[SimpleNamespace(message=SimpleNamespace(
                        content="OK",
                        reasoning_content="",
                        tool_calls=None,
                    ))]
                ),
            ):
                tested = routes._test_custom_model_config(
                    self.db, self.user_a.id, second["id"]
                )
            self.assertTrue(tested["success"])
            self.assertTrue(tested["data"]["connected"])

            deleted = user_ai_provider_service.delete_custom_model(
                self.db, self.user_a.id, second["id"]
            )
            self.assertEqual(deleted, {"deleted": True, "selection_reset": True})
            listing = user_ai_provider_service.list_custom_models(self.db, self.user_a.id)
            self.assertIsNone(listing["selected_id"])
            self.assertEqual([item["id"] for item in listing["items"]], [first["id"]])
            self.assertEqual(
                user_ai_provider_service.effective_config(self.db, self.user_a.id)["model"],
                "platform-default",
            )

    def test_omniroute_mode_is_not_a_user_selectable_mode(self) -> None:
        with self.assertRaisesRegex(ValueError, "模式无效"):
            user_ai_provider_service.save(
                self.db,
                self.user_a.id,
                mode="omniroute",
                provider_name="",
                model="auto/best-free",
                api_base="",
                api_key="",
            )

    def test_published_platform_model_selection_is_scoped_per_user(self) -> None:
        with patch.object(user_ai_provider_service.settings_service, "get_llm_config", return_value={
                "provider": "platform",
                "model": "base-model",
                "runtime_model": "base-model",
                "api_base": "",
                "api_key": "platform-secret",
            }):
            default = chat_model_catalog_service.ensure_default_offering(self.db)
            selected = chat_model_catalog_service.save(
                self.db, offering_id=None, code="published-model", name="发布模型",
                description="", provider_mode="platform", model_id="explicit-model-v2",
                enabled=True, visible_to_users=True, is_default=False, is_free=True,
                free_daily_limit=10, points_per_request=0, supports_images=False,
                supports_tools=False, sort_order=20,
            )
            chat_model_catalog_service.select_for_user(self.db, self.user_a.id, selected.id)
            effective_a = user_ai_provider_service.effective_config(self.db, self.user_a.id)
            effective_b = user_ai_provider_service.effective_config(self.db, self.user_b.id)

        self.assertEqual(effective_a["model"], "explicit-model-v2")
        self.assertEqual(effective_a["offering_id"], selected.id)
        self.assertEqual(effective_b["offering_id"], default.id)

    def test_workspace_redacts_secret_and_survives_partial_upstream_failure(self) -> None:
        def fake_fetch(_base: str, path: str, api_key: str) -> dict:
            self.assertEqual(api_key, "workspace-secret")
            if path == "/api/health/ping":
                return {"status": "ok", "latencyMs": 3}
            if path == "/models":
                return {"data": [{
                    "id": "openrouter/deepseek-r1:free",
                    "name": "DeepSeek R1 Free",
                    "owned_by": "openrouter",
                    "free": True,
                    "context_length": 128000,
                }]}
            if path.startswith("/api/free-tier/summary"):
                return {
                    "steadyRecurringTokens": 123456,
                    "remaining": 120000,
                    "catalogUpdatedAt": "2026-08-03",
                }
            if path.startswith("/api/free-provider-rankings"):
                return {"rankings": []}
            if path == "/api/combos/auto":
                return {"combos": [{"id": "auto/best-free", "name": "Best Free"}]}
            raise ValueError("optional endpoint unavailable")

        omniroute_workspace_service.clear_cache()
        with (
            patch.object(user_ai_provider_service.settings, "OMNIROUTE_API_BASE", "http://127.0.0.1:20128/v1"),
            patch.object(user_ai_provider_service.settings, "OMNIROUTE_API_KEY", "workspace-secret"),
            patch.object(omniroute_workspace_service, "_fetch_json", side_effect=fake_fetch),
        ):
            workspace = omniroute_workspace_service.get_workspace(refresh=True)

        self.assertTrue(workspace["status"]["online"])
        self.assertTrue(workspace["status"]["partial"])
        self.assertEqual(workspace["models"][0]["id"], "openrouter/deepseek-r1:free")
        self.assertTrue(workspace["models"][0]["free"])
        self.assertEqual(workspace["routes"][0]["id"], "auto/best-free")
        self.assertNotIn("workspace-secret", str(workspace))

    def test_legacy_omniroute_row_falls_back_to_explicit_platform_default(self) -> None:
        with patch.object(user_ai_provider_service.settings_service, "get_llm_config", return_value={
                "provider": "platform",
                "model": "base-model",
                "runtime_model": "base-model",
                "api_base": "",
                "api_key": "platform-secret",
            }):
            default = chat_model_catalog_service.ensure_default_offering(self.db)
            row = UserAIProviderConfig(
                user_id=self.user_a.id,
                mode="omniroute",
                provider_name="OmniRoute",
                model="auto",
                enabled=True,
            )
            self.db.add(row)
            self.db.commit()
            effective = user_ai_provider_service.effective_config(self.db, self.user_a.id)
            public = user_ai_provider_service.serialize(self.db, self.user_a.id)

        self.assertEqual(effective["provider"], "platform")
        self.assertEqual(effective["api_key"], "platform-secret")
        self.assertEqual(effective["offering_id"], default.id)
        self.assertEqual(public["mode"], "platform")
        self.assertNotIn("omniroute", public)


class AgentFailureLoggingTests(unittest.TestCase):
    def test_route_logs_original_exception_with_safe_model_metadata(self) -> None:
        original = RuntimeError("model returned empty content")
        fake_session = unittest.mock.MagicMock()
        fake_session.__enter__.return_value = unittest.mock.MagicMock()
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
        user = SimpleNamespace(id="user-1")

        with (
            patch.object(agent_routes.agent_service, "get_thread", return_value=SimpleNamespace(id="thread-1")),
            patch.object(agent_routes.agent_service, "ask_thread", side_effect=original),
            patch.object(agent_routes, "SessionLocal", return_value=fake_session),
            patch.object(
                agent_routes.user_ai_provider_service,
                "effective_config",
                return_value={"provider": "custom", "model": "model-x"},
            ),
            patch.object(agent_routes.error_log_service, "record_exception_safely") as log_mock,
        ):
            with self.assertRaises(HTTPException):
                agent_routes.send_agent_message(
                    "thread-1",
                    agent_routes.ThreadMessageRequest(content="hello"),
                    request,
                    db=unittest.mock.MagicMock(),
                    current_user=user,
                )

        self.assertIs(log_mock.call_args.args[0], original)
        self.assertEqual(log_mock.call_args.kwargs["metadata"]["model"], "model-x")
        self.assertNotIn("api_key", log_mock.call_args.kwargs["metadata"])

    def test_provider_diagnostics_failure_does_not_mask_original_exception(self) -> None:
        original = RuntimeError("model returned empty content")
        fake_session = unittest.mock.MagicMock()
        fake_session.__enter__.return_value = unittest.mock.MagicMock()
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
        user = SimpleNamespace(id="user-1")

        with (
            patch.object(agent_routes.agent_service, "get_thread", return_value=SimpleNamespace(id="thread-1")),
            patch.object(agent_routes.agent_service, "ask_thread", side_effect=original),
            patch.object(agent_routes, "SessionLocal", return_value=fake_session),
            patch.object(
                agent_routes.user_ai_provider_service,
                "effective_config",
                side_effect=RuntimeError("diagnostics unavailable"),
            ),
            patch.object(agent_routes.error_log_service, "record_exception_safely") as log_mock,
        ):
            with self.assertRaises(HTTPException) as raised:
                agent_routes.send_agent_message(
                    "thread-1",
                    agent_routes.ThreadMessageRequest(content="hello"),
                    request,
                    db=unittest.mock.MagicMock(),
                    current_user=user,
                )

        self.assertEqual(raised.exception.status_code, 502)
        self.assertIs(log_mock.call_args.args[0], original)
        self.assertEqual(
            log_mock.call_args.kwargs["metadata"],
            {"operation": "agent_ask"},
        )


class AgentMessageRouteContractTests(unittest.TestCase):
    def test_frontend_message_payload_matches_request_model(self) -> None:
        body = agent_routes.ThreadMessageRequest(
            **{
                "content": "请整理为行动方案",
                "research_mode": "deep",
                "output_style": "action_plan",
                "custom_instruction": "",
                "web_scope": "video_only",
            }
        )

        self.assertEqual(body.content, "请整理为行动方案")
        self.assertEqual(body.research_mode, "deep")
        self.assertEqual(body.output_style, "action_plan")
        self.assertEqual(body.custom_instruction, "")
        self.assertEqual(body.web_scope, "video_only")

    def test_busy_thread_is_a_conflict_instead_of_validation_error(self) -> None:
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
        user = SimpleNamespace(id="user-1")
        conflict = agent_routes.agent_service.AgentThreadConflictError(
            "这个任务正在回答上一条问题，请稍候"
        )

        with (
            patch.object(agent_routes.agent_service, "get_thread", return_value=SimpleNamespace(id="thread-1")),
            patch.object(agent_routes.agent_service, "ask_thread", side_effect=conflict),
        ):
            with self.assertRaises(HTTPException) as raised:
                agent_routes.send_agent_message(
                    "thread-1",
                    agent_routes.ThreadMessageRequest(content="再生成一份总结"),
                    request,
                    db=unittest.mock.MagicMock(),
                    current_user=user,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, str(conflict))
        self.assertEqual(raised.exception.headers, {"Retry-After": "3"})

    def test_other_value_errors_remain_validation_errors(self) -> None:
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
        user = SimpleNamespace(id="user-1")

        with (
            patch.object(agent_routes.agent_service, "get_thread", return_value=SimpleNamespace(id="thread-1")),
            patch.object(
                agent_routes.agent_service,
                "ask_thread",
                side_effect=ValueError("问题不能为空"),
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                agent_routes.send_agent_message(
                    "thread-1",
                    agent_routes.ThreadMessageRequest(content="hello"),
                    request,
                    db=unittest.mock.MagicMock(),
                    current_user=user,
                )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.detail, "问题不能为空")


class AgentThreadConflictServiceTests(unittest.TestCase):
    def test_running_thread_raises_typed_conflict_before_llm_call(self) -> None:
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(
            engine,
            tables=[User.__table__, AgentThread.__table__, AgentMessage.__table__],
        )
        Session = sessionmaker(bind=engine)
        db = Session()
        try:
            user = User(email="busy@example.com", hashed_password="x")
            db.add(user)
            db.flush()
            thread = AgentThread(
                user_id=user.id,
                title="忙碌任务",
                scope_type="selected",
                scope_label="手动选择",
                source_ids_json="[]",
                status="running",
            )
            db.add(thread)
            db.commit()

            with self.assertRaises(agent_service.AgentThreadConflictError):
                agent_service.ask_thread(
                    db,
                    thread=thread,
                    content="再生成一份总结",
                )
        finally:
            db.close()
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
