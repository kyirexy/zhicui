"""「创作工坊」服务层回归:hypit CLI 封装(mock 子进程)与 LLM 创作循环。"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "video-creation-test-secret")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.video_creation import VideoCreationJob
from app.services import hypit_service, video_creation_author
from app.services.hypit_service import HypitError
from app.services.video_creation_worker import VideoCreationWorker

VALID_SVML = '<?svml using="@hypit/markup@1"?>\n<svml></svml>'


class FakeProcess:
    """communicate 一次返回的假进程;记录 terminate/kill 调用。"""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr
        self.terminated = False
        self.killed = False

    def communicate(self, timeout=None):
        return self._stdout, self._stderr

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return self.returncode


class HypitServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = patch.multiple(
            hypit_service.settings,
            HYPIT_CLI_PATH="hypit",
            HYPIT_PROJECT_ROOT=str(self.root),
        )
        self.config.start()

    def tearDown(self):
        self.config.stop()
        self.temp.cleanup()

    def test_write_project_layout(self):
        directory = hypit_service.write_project("job-1", svml_text=VALID_SVML)
        self.assertEqual(directory, self.root / "job-1")
        svml = (directory / "main.svml").read_text(encoding="utf-8")
        svrun = (directory / "render.svrun").read_text(encoding="utf-8")
        self.assertEqual(svml, VALID_SVML)
        self.assertIn('<author source="./main.svml"/>', svrun)
        self.assertIn('<target output="final.video"/>', svrun)

    def test_extract_json_tolerates_progress_lines(self):
        self.assertIsNone(hypit_service._extract_json(""))
        self.assertEqual(
            hypit_service._extract_json('{"id": 1}'),
            {"id": 1},
        )
        self.assertEqual(
            hypit_service._extract_json('step ok\n{"build": {"id": "bld_x"}}'),
            {"build": {"id": "bld_x"}},
        )

    def test_find_build_id_walks_nested_payloads(self):
        self.assertEqual(
            hypit_service._find_build_id({"id": "bld_20260101T000000000Z_TESTABCD"}),
            "bld_20260101T000000000Z_TESTABCD",
        )
        self.assertEqual(
            hypit_service._find_build_id({"result": {"build": {"buildId": "bld_x"}}}),
            "bld_x",
        )
        self.assertEqual(hypit_service._find_build_id({"message": "no id"}), "")

    def test_run_json_maps_nonzero_exit_to_user_error(self):
        process = FakeProcess(2, stdout='{"message": "unknown import @hypit/nope@1"}', stderr="")
        with patch.object(hypit_service.subprocess, "Popen", return_value=process), \
                patch.object(hypit_service.shutil, "which", return_value="/usr/bin/hypit"):
            with self.assertRaises(HypitError) as ctx:
                hypit_service.check_source(self.root)
        self.assertEqual(ctx.exception.code, "hypit_command_failed")
        self.assertIn("unknown import", ctx.exception.message)

    def test_cli_missing_fails_closed(self):
        with patch.object(hypit_service.shutil, "which", return_value=None):
            self.assertFalse(hypit_service.cli_available())
            with self.assertRaises(HypitError) as ctx:
                hypit_service.check_source(self.root)
        self.assertEqual(ctx.exception.code, "hypit_unavailable")

    def test_status_helpers(self):
        payload = {
            "work": {"state": "done", "outcome": "failed"},
            "result": {"state": "failed", "outputCount": 0},
            "failure": "endpoint quota exceeded",
        }
        self.assertEqual(hypit_service.status_result_state(payload), "failed")
        self.assertIn("quota", hypit_service.status_failure(payload))
        self.assertEqual(
            hypit_service.status_result_state({"result": {"state": "open"}}), "open"
        )
        self.assertEqual(hypit_service.status_result_state({}), "unknown")

    def test_submit_build_returns_id(self):
        process = FakeProcess(0, stdout=json.dumps({
            "id": "bld_20260101T000000000Z_TESTABCD", "outcome": "open",
        }))
        with patch.object(hypit_service.subprocess, "Popen", return_value=process), \
                patch.object(hypit_service.shutil, "which", return_value="/usr/bin/hypit"):
            build_id = hypit_service.submit_build(self.root)
        self.assertEqual(build_id, "bld_20260101T000000000Z_TESTABCD")

    def test_export_result_requires_file(self):
        destination = self.root / "out.mp4"
        process = FakeProcess(0, stdout="{}")
        with patch.object(hypit_service.subprocess, "Popen", return_value=process), \
                patch.object(hypit_service.shutil, "which", return_value="/usr/bin/hypit"):
            with self.assertRaises(HypitError):
                hypit_service.export_result(self.root, "bld_x", destination)
        # 命令成功且目标文件生成时导出成功。
        producing = FakeProcess(0, stdout="{}")

        def produce(*args, **kwargs):
            destination.write_bytes(b"mp4")
            return producing

        with patch.object(hypit_service.subprocess, "Popen", side_effect=produce), \
                patch.object(hypit_service.shutil, "which", return_value="/usr/bin/hypit"):
            exported = hypit_service.export_result(self.root, "bld_x", destination)
        self.assertEqual(exported, destination)


class VideoCreationAuthorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = patch.multiple(
            hypit_service.settings,
            HYPIT_CLI_PATH="hypit",
            HYPIT_PROJECT_ROOT=self.temp.name,
        )
        self.config.start()

    def tearDown(self):
        self.config.stop()
        self.temp.cleanup()

    def test_split_response_extracts_explanation(self):
        raw = f"{VALID_SVML}\nEXPLANATION: 用三段式讲清咖啡的来源。"
        svml, explanation = video_creation_author._split_response(raw)
        self.assertEqual(svml, VALID_SVML)
        self.assertIn("三段式", explanation)

    def test_split_response_strips_code_fence(self):
        raw = f"```svml\n{VALID_SVML}\n```\nEXPLANATION: ok"
        svml, _ = video_creation_author._split_response(raw)
        self.assertEqual(svml, VALID_SVML)

    def test_draft_returns_on_first_passing_check(self):
        with patch.object(video_creation_author, "_call_author",
                          return_value=(VALID_SVML, "ok")), \
                patch.object(hypit_service, "check_source", return_value={}):
            svml, explanation = video_creation_author.draft_svml("job-1", "咖啡科普")
        self.assertEqual(svml, VALID_SVML)
        self.assertEqual(explanation, "ok")

    def test_draft_feeds_check_error_back_to_model(self):
        responses = [(VALID_SVML, ""), (VALID_SVML, "fixed")]
        calls: list[str] = []

        def fake_call(system, user):
            calls.append(user)
            return responses[len(calls) - 1]

        def failing_then_passing(directory, **kwargs):
            if len(calls) == 1:
                raise HypitError("hypit_command_failed", "第 3 行缺少闭合标签")
            return {}

        with patch.object(video_creation_author, "_call_author", side_effect=fake_call), \
                patch.object(hypit_service, "check_source",
                             side_effect=failing_then_passing):
            svml, _ = video_creation_author.draft_svml("job-1", "咖啡科普")
        self.assertEqual(svml, VALID_SVML)
        self.assertIn("缺少闭合标签", calls[1], "预检错误必须回喂给下一轮创作")

    def test_draft_gives_up_after_max_attempts(self):
        with patch.object(video_creation_author, "_call_author",
                          return_value=(VALID_SVML, "")), \
                patch.object(hypit_service, "check_source",
                             side_effect=HypitError("hypit_command_failed", "语法错误")):
            with self.assertRaises(HypitError) as ctx:
                video_creation_author.draft_svml("job-1", "咖啡科普")
        self.assertEqual(ctx.exception.code, "svml_authoring_failed")
        self.assertIn("语法错误", ctx.exception.message)

    def test_iterate_keeps_requirement_context(self):
        captured: dict[str, str] = {}

        def fake_call(system, user):
            captured["user"] = user
            return (VALID_SVML, "改好了")

        with patch.object(video_creation_author, "_call_author", side_effect=fake_call), \
                patch.object(hypit_service, "check_source", return_value={}):
            video_creation_author.iterate_svml(
                "job-1", "<old/>", "咖啡科普", "把开头改快一点"
            )
        self.assertIn("把开头改快一点", captured["user"])
        self.assertIn("<old/>", captured["user"])


class CapacityGuardTests(unittest.TestCase):
    """产物配额守护:hypit_service.directory_size 与 worker._prune_capacity。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = patch.multiple(
            hypit_service.settings,
            HYPIT_PROJECT_ROOT=str(Path(self.temp.name)),
            HYPIT_RESULT_MAX_TOTAL_MB=1,
            HYPIT_RESULT_MIN_FREE_MB=0,
        )
        self.config.start()

        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        VideoCreationJob.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.worker = VideoCreationWorker()

    def tearDown(self):
        self.config.stop()
        self.temp.cleanup()
        self.engine.dispose()

    def test_directory_size_sums_files_recursively(self):
        root = Path(self.temp.name)
        (root / "gone").mkdir()
        self.assertEqual(hypit_service.directory_size(root / "gone" / ".." / "nope"), 0)
        target = root / "job-1"
        (target / "assets").mkdir(parents=True)
        (target / "main.svml").write_bytes(b"x" * 100)
        (target / "assets" / "clip.mp4").write_bytes(b"y" * 250)
        self.assertEqual(hypit_service.directory_size(target), 350)

    def _create_job(self, job_id: str, updated_at: datetime, **fields) -> None:
        fields.setdefault("user_id", "user-1")
        fields.setdefault("status", "completed")
        with self.Session() as db:
            db.add(VideoCreationJob(id=job_id, updated_at=updated_at, **fields))
            db.commit()

    def test_prune_deletes_oldest_terminal_jobs_first(self):
        root = Path(self.temp.name)
        # 超过 HYPIT_RESULT_MAX_TOTAL_MB=1:三个目录合计 ~2.7MiB。
        (root / "job-a").mkdir()
        (root / "job-a" / "a.mp4").write_bytes(b"a" * (1024 * 1024))
        (root / "job-b").mkdir()
        (root / "job-b" / "b.mp4").write_bytes(b"b" * (700 * 1024))
        (root / "job-keep").mkdir()
        (root / "job-keep" / "k.mp4").write_bytes(b"k" * (1024 * 1024))

        utc = timezone.utc
        self._create_job("job-a", datetime(2026, 1, 1, tzinfo=utc))
        self._create_job("job-b", datetime(2026, 1, 2, tzinfo=utc), status="cancelled")
        self._create_job("job-keep", datetime(2026, 1, 3, tzinfo=utc))

        with patch("app.services.video_creation_worker.SessionLocal", self.Session):
            self.worker._prune_capacity("job-keep")

        self.assertFalse((root / "job-a").exists(), "最旧终态 job 目录应最先被删")
        self.assertFalse((root / "job-b").exists(), "次旧终态 job 目录随后被删")
        self.assertTrue((root / "job-keep").exists(), "当前 job 目录必须保留")

    def test_prune_raises_when_nothing_can_be_freed(self):
        root = Path(self.temp.name)
        (root / "job-keep").mkdir()
        (root / "job-keep" / "k.mp4").write_bytes(b"k" * 1024)
        self._create_job("job-keep", datetime(2026, 1, 3, tzinfo=timezone.utc))

        self._create_job("job-draft", datetime(2026, 1, 2, tzinfo=timezone.utc), status="draft")
        (root / "job-draft").mkdir()
        (root / "job-draft" / "d.mp4").write_bytes(b"d" * 1024)

        # 磁盘余量要求设到天文数字,保证任何真实 free 都不满足。
        with patch.multiple(
            hypit_service.settings,
            HYPIT_RESULT_MIN_FREE_MB=10**9,
        ), patch("app.services.video_creation_worker.SessionLocal", self.Session):
            with self.assertRaises(HypitError) as ctx:
                self.worker._prune_capacity("job-keep")
        self.assertEqual(ctx.exception.code, "hypit_capacity_exceeded")
        self.assertTrue((root / "job-draft").exists(), "非终态 job 目录绝不能被删")


if __name__ == "__main__":
    unittest.main()
