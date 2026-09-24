"""执行真实部署 Bash 分支；仅替换 sudo/curl 等系统边界，不访问生产。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "deploy.sh"


def _bash_path() -> str | None:
    # Windows 的 system32/bash.exe 是 WSL 启动器；优先使用 Git 自带 Bash。
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            candidate = Path(git).resolve().parents[1] / "bin" / "bash.exe"
            if candidate.is_file():
                return str(candidate)
        return None
    return shutil.which("bash")


class DeployDarkPreflightExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bash = _bash_path()
        if not cls.bash:
            raise unittest.SkipTest("需要 Bash（Windows 使用 Git Bash）")
        cls.source = SCRIPT.read_text(encoding="utf-8")
        names = (
            "set_agent_kill_switch",
            "wait_backend_health",
            "probe_agent_interface",
            "agent_runtime_is_verified_dark",
            "force_agent_fail_closed",
        )
        functions = []
        for name in names:
            match = re.search(rf"(?ms)^{name}\(\) \{{\n.*?^\}}\n", cls.source)
            if match is None:
                raise AssertionError(f"真实部署函数缺失：{name}")
            functions.append(match.group(0))
        cls.functions = "\n".join(functions)
        # 只截取真实 kill-switch 分支；后续 schema gate 同时支持 core/stable，
        # 不再用旧版 stable 专属条件作为结束标记。
        preflight = re.search(
            r'(?ms)^if \[\[ "\$AGENT_RELEASE_MODE" == dark \]\]; then\n.*?^fi\n',
            cls.source,
        )
        if preflight is None:
            raise AssertionError("真实 Agent kill-switch preflight 分支缺失")
        cls.preflight = preflight.group(0)

    def run_fixture(self, *, cleanup: bool = False, **overrides: str):
        defaults = {
            "MODE": "dark",
            "VERIFY": "0",
            "HEALTH": "0",
            "CAP_STATUS": "503",
            "CAP_BODY": json.dumps({"error": {"code": "INTERFACE_DISABLED"}}),
            "CAP_RC": "0",
            "WRITE": "0",
            "RESTART": "0",
            "POST_VERIFY": "0",
            "POST_HEALTH": "0",
            "POST_CAP_STATUS": "503",
            "POST_CAP_BODY": json.dumps({"error": {"code": "INTERFACE_DISABLED"}}),
            "POST_CAP_RC": "0",
        }
        defaults.update(overrides)
        with tempfile.TemporaryDirectory(prefix="zhicui-dark-preflight-") as directory:
            trace = Path(directory) / "trace.txt"
            # 跟踪仅写在临时目录；网络、权限修改和服务操作全部由函数替身接住。
            fixture = r'''
set -Eeuo pipefail
AGENT_KILL_SWITCH_HELPER='/fixture/agent-kill-switch'
AGENT_RELEASE_MODE="$FIXTURE_MODE"
AGENT_CAPABILITY_PROFILE=full
[[ "$AGENT_RELEASE_MODE" != core ]] || AGENT_CAPABILITY_PROFILE=core
RESTARTED=0
WRITTEN=0
event() { printf '%s\n' "$*" >> "$FIXTURE_TRACE"; }
log() { event "log:$*"; }
err() { event "error:$*"; exit 1; }
record_gate() { event "gate:$1:$2:$3"; }
sleep() { :; }
python3() { "$FIXTURE_PYTHON" "$@"; }
sudo() {
  [[ "${1:-}" != '-n' ]] || shift
  if [[ "$1" == "$AGENT_KILL_SWITCH_HELPER" ]]; then
    case "$2" in
      verify-dark)
        event verify-dark
        if [[ "$WRITTEN" == 1 || "$RESTARTED" == 1 ]]; then
          return "$FIXTURE_POST_VERIFY"
        fi
        return "$FIXTURE_VERIFY" ;;
      dark)
        event write-dark
        [[ "$FIXTURE_WRITE" == 0 ]] || return "$FIXTURE_WRITE"
        WRITTEN=1 ;;
      *) event "unexpected-sudo:$*"; return 99 ;;
    esac
  elif [[ "$*" == 'systemctl restart videocapsule-backend' ]]; then
    event restart-backend
    [[ "$FIXTURE_RESTART" == 0 ]] || return "$FIXTURE_RESTART"
    RESTARTED=1
  else
    event "unexpected-sudo:$*"; return 99
  fi
}
curl() {
  local output='' url='' prefix='FIXTURE_' status_var body_var rc_var
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -o) output="$2"; shift 2 ;;
      -w|--max-time) shift 2 ;;
      http://*) url="$1"; shift ;;
      *) shift ;;
    esac
  done
  [[ "$RESTARTED" == 0 ]] || prefix='FIXTURE_POST_'
  if [[ "$url" == 'http://127.0.0.1:8000/api/health' ]]; then
    event health
    rc_var="${prefix}HEALTH"
    return "${!rc_var}"
  elif [[ "$url" == 'http://127.0.0.1:8000/api/agent-interface/v1/capabilities' ]]; then
    event capabilities
    status_var="${prefix}CAP_STATUS"; body_var="${prefix}CAP_BODY"; rc_var="${prefix}CAP_RC"
    printf '%s' "${!body_var}" > "$output"
    printf '%s' "${!status_var}"
    return "${!rc_var}"
  else
    event unexpected-network
    return 99
  fi
}
'''
            invocation = self.preflight
            if cleanup:
                invocation = "if force_agent_fail_closed; then exit 0; else exit 1; fi"
            fixture += "\n" + self.functions + "\n" + invocation + "\n"
            env = os.environ.copy()
            env.update({f"FIXTURE_{key}": value for key, value in defaults.items()})
            env["FIXTURE_TRACE"] = trace.as_posix()
            env["FIXTURE_PYTHON"] = Path(sys.executable).as_posix()
            result = subprocess.run(
                [self.bash, "--noprofile", "--norc", "-s"],
                input=fixture,
                text=True,
                encoding="utf-8",
                capture_output=True,
                env=env,
                timeout=30,
            )
            events = trace.read_text(encoding="utf-8").splitlines() if trace.exists() else []
            self.assertFalse(any(item.startswith("unexpected-") for item in events), events)
            return result, events

    def assert_repaired(self, **overrides: str) -> list[str]:
        result, events = self.run_fixture(**overrides)
        self.assertEqual(result.returncode, 0, result.stderr + repr(events))
        self.assertEqual(events.count("write-dark"), 1, events)
        self.assertEqual(events.count("restart-backend"), 1, events)
        self.assertLess(events.index("write-dark"), events.index("restart-backend"))
        self.assertTrue(any(item.startswith("gate:agent_kill_switch_preflight:pass:") for item in events))
        return events

    def test_verified_dark_healthy_runtime_keeps_active_requests_untouched(self):
        result, events = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[:3], ["verify-dark", "health", "capabilities"])
        self.assertNotIn("write-dark", events)
        self.assertNotIn("restart-backend", events)
        self.assertTrue(any("无需前置重启" in event for event in events))

    def test_enabled_runtime_is_disabled_and_restarted(self):
        self.assert_repaired(CAP_STATUS="200", CAP_BODY='{"data":{"feature_enabled":true}}')

    def test_unverified_or_unreadable_root_file_requires_repair(self):
        self.assert_repaired(VERIFY="1")

    def test_unhealthy_runtime_requires_repair(self):
        self.assert_repaired(HEALTH="22")

    def test_absent_old_route_is_not_enough_to_skip_restart(self):
        self.assert_repaired(CAP_STATUS="404", CAP_BODY='{"detail":"Not Found"}', POST_CAP_STATUS="404", POST_CAP_BODY='{"detail":"Not Found"}')

    def test_transport_failure_requires_repair(self):
        self.assert_repaired(CAP_RC="28", CAP_STATUS="000", CAP_BODY="")

    def test_malformed_capabilities_requires_repair(self):
        self.assert_repaired(CAP_BODY="invalid-json")

    def test_unrelated_service_unavailable_is_not_dark_evidence(self):
        self.assert_repaired(CAP_BODY='{"error":{"code":"UPSTREAM_ERROR"}}')

    def test_failed_dark_write_cannot_be_masked_by_successful_verify(self):
        result, events = self.run_fixture(HEALTH="22", WRITE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events.count("write-dark"), 1)
        self.assertEqual(events.count("verify-dark"), 1)
        self.assertNotIn("restart-backend", events)

    def test_failed_write_verification_blocks_preflight(self):
        result, events = self.run_fixture(VERIFY="1", POST_VERIFY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("restart-backend", events)

    def test_failed_restart_blocks_preflight(self):
        result, events = self.run_fixture(VERIFY="1", RESTART="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events.count("restart-backend"), 1)
        self.assertFalse(any(event.startswith("gate:") for event in events))

    def test_health_failure_after_restart_cannot_pass_gate(self):
        result, events = self.run_fixture(VERIFY="1", POST_HEALTH="22")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events.count("health"), 20)
        self.assertFalse(any(event.startswith("gate:") for event in events))

    def test_still_enabled_after_restart_cannot_pass_gate(self):
        result, events = self.run_fixture(VERIFY="1", POST_CAP_STATUS="200", POST_CAP_BODY='{"data":{"feature_enabled":true}}')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(event.startswith("gate:") for event in events))

    def test_build_failure_cleanup_preserves_verified_dark_runtime(self):
        result, events = self.run_fixture(cleanup=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("write-dark", events)
        self.assertNotIn("restart-backend", events)

    def test_build_failure_cleanup_closes_drifted_runtime(self):
        result, events = self.run_fixture(cleanup=True, CAP_STATUS="200", CAP_BODY='{"data":{"feature_enabled":true}}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.count("restart-backend"), 1)
        self.assertEqual(events.count("write-dark"), 1)

    def test_cleanup_cannot_report_success_if_repair_remains_enabled(self):
        result, events = self.run_fixture(cleanup=True, VERIFY="1", POST_CAP_STATUS="200", POST_CAP_BODY='{"data":{"feature_enabled":true}}')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events.count("restart-backend"), 1)

    def test_core_and_stable_preflight_require_verified_disabled_runtime(self):
        for mode in ("core", "stable"):
            with self.subTest(mode=mode, runtime="verified-disabled"):
                result, events = self.run_fixture(MODE=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events[:2], ["verify-dark", "capabilities"])
                self.assertNotIn("write-dark", events)
                self.assertNotIn("restart-backend", events)
                self.assertTrue(any(event.startswith("gate:agent_kill_switch_preflight:pass:") for event in events))
            for runtime, overrides in (
                ("unverified", {"VERIFY": "1"}),
                ("absent", {"CAP_STATUS": "404", "CAP_BODY": "{}"}),
                ("enabled", {"CAP_STATUS": "200", "CAP_BODY": '{"data":{"feature_enabled":true}}'}),
            ):
                with self.subTest(mode=mode, runtime=runtime):
                    result, events = self.run_fixture(MODE=mode, **overrides)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(any(event.startswith("gate:") for event in events))
                    self.assertNotIn("write-dark", events)
                    self.assertNotIn("restart-backend", events)


if __name__ == "__main__":
    unittest.main()
