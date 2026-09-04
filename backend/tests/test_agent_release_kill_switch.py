from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"


class AgentReleaseKillSwitchContractTests(unittest.TestCase):
    def test_systemd_loads_root_kill_switch_after_shared_environment(self) -> None:
        service = (DEPLOY / "videocapsule-backend.service").read_text(encoding="utf-8")
        shared = "EnvironmentFile=/opt/zhicui/backend/.env"
        kill_switch = "EnvironmentFile=/etc/zhicui/agent-interface.env"
        self.assertIn(shared, service)
        self.assertIn(kill_switch, service)
        self.assertLess(service.index(shared), service.index(kill_switch))

    def test_kill_switch_helper_is_fixed_atomic_and_fail_closed(self) -> None:
        helper = (DEPLOY / "agent-interface-kill-switch.sh").read_text(encoding="utf-8")
        for marker in (
            'STATE_FILE="$STATE_DIR/agent-interface.env"',
            "AGENT_INTERFACE_ENABLED=false",
            "AGENT_INTERFACE_ENABLED=true",
            "dark|stable",
            "verify-dark",
            "verify-stable",
            "chown root:root",
            "chmod 0600",
            "mv -fT --",
            "拒绝覆盖非普通状态文件",
        ):
            self.assertIn(marker, helper)
        self.assertNotIn("eval ", helper)
        self.assertNotRegex(helper, re.compile(r"(?m)^[^#\n]*backend/\.env"))

    def test_preinstall_defaults_invalid_or_missing_state_to_dark(self) -> None:
        preinstall = (DEPLOY / "preinstall-production-assets.sh").read_text(
            encoding="utf-8"
        )
        setup = (DEPLOY / "setup.sh").read_text(encoding="utf-8")
        for script in (preinstall, setup):
            self.assertIn("agent-interface-kill-switch.sh verify", script)
            self.assertIn("agent-interface-kill-switch.sh dark", script)
        self.assertIn(
            'deploy/agent-interface-kill-switch.sh deploy/jenkins-videocapsule.sudoers',
            preinstall,
        )

    def test_shared_production_env_cannot_authorize_interface(self) -> None:
        template = (DEPLOY / "production.env.example").read_text(encoding="utf-8")
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        self.assertNotRegex(template, re.compile(r"(?m)^\s*AGENT_INTERFACE_ENABLED="))
        self.assertIn('if "AGENT_INTERFACE_ENABLED" in values:', deploy)
        self.assertIn("禁止写入共享 backend/.env", deploy)

    def test_deploy_defaults_dark_and_preserves_automation_gates(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn('AGENT_RELEASE_MODE="${AGENT_RELEASE_MODE:-dark}"', deploy)
        self.assertIn('values.get("AGENT_AUTOMATION_ENABLED", "").lower() != "true"', deploy)
        self.assertIn("AGENT_AUTOMATION_POLL_SECONDS", deploy)
        self.assertIn("5 <= automation_poll_seconds <= 300", deploy)

    def test_backup_validation_failure_is_not_swallowed_by_heredoc(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn(
            'python3 - "$BACKUP_STATUS_FILE" "$BACKEND_ENV" <<\'PY\' || err '
            "'备份状态文件无效，保持当前版本'",
            deploy,
        )
        self.assertNotIn("<<'PY' ||\n  err '备份状态文件无效", deploy)

    def test_previous_runtime_trust_is_scoped_to_the_validated_path(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn('git -c safe.directory="$PREVIOUS_RUNTIME"', deploy)
        self.assertNotIn("safe.directory=*", deploy)

    def test_locked_dependencies_use_explicit_resilient_https_index(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        setup = (DEPLOY / "setup.sh").read_text(encoding="utf-8")
        for script in (deploy, setup):
            self.assertIn("https://pypi.tuna.tsinghua.edu.cn/simple", script)
            self.assertIn('--index-url "$PYPI_INDEX_URL"', script)
            self.assertIn('--timeout "$PIP_NETWORK_TIMEOUT"', script)
            self.assertIn('--retries "$PIP_NETWORK_RETRIES"', script)
            self.assertIn("--require-hashes", script)
            self.assertIn("--disable-pip-version-check --no-input", script)

    def test_stable_is_activated_only_after_runtime_switch(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        switch_marker = 'atomic_runtime_switch "$RELEASE_DIR"'
        activation_marker = 'set_agent_kill_switch "$AGENT_RELEASE_MODE"'
        restart_marker = "sudo systemctl restart videocapsule-backend"
        switch_block = deploy.index("log '原子切换 runtime 并启动目标版本'")
        switch_at = deploy.index(switch_marker, switch_block)
        activation_at = deploy.index(activation_marker, switch_at)
        restart_at = deploy.index(restart_marker, activation_at)
        self.assertLess(switch_at, activation_at)
        self.assertLess(activation_at, restart_at)

    def test_every_failed_transaction_forces_dark_before_runtime_rollback(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        rollback_start = deploy.index("rollback_runtime()")
        rollback_end = deploy.index("write_evidence()", rollback_start)
        rollback = deploy[rollback_start:rollback_end]
        self.assertLess(
            rollback.index("set_agent_kill_switch dark"),
            rollback.index('atomic_runtime_switch "$PREVIOUS_RUNTIME"'),
        )
        on_exit_start = deploy.index("on_exit()")
        on_exit_end = deploy.index("trap on_exit EXIT", on_exit_start)
        on_exit = deploy[on_exit_start:on_exit_end]
        self.assertIn("force_agent_fail_closed", on_exit)
        self.assertIn("agent_kill_switch_rollback", deploy)
        self.assertIn("probe_agent_interface absent-or-disabled", rollback)

    def test_runtime_gates_verify_both_modes_and_schema(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        for marker in (
            "probe_agent_interface disabled",
            "probe_agent_interface enabled",
            "verify_agent_schema \"$PREVIOUS_RUNTIME\"",
            "verify_agent_schema \"$RELEASE_DIR\"",
            "agent_kill_switch_preflight",
            "agent_kill_switch_target",
            "agent_kill_switch_final",
            "INTERFACE_DISABLED",
        ):
            self.assertIn(marker, deploy)

    def test_stable_promotes_only_the_same_commit_that_ran_dark(self) -> None:
        deploy = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn(
            '[[ "$PREVIOUS_RUNTIME_COMMIT" == "$TARGET_COMMIT" ]]', deploy
        )
        self.assertIn("Stable 只允许晋级当前已完成 dark 验收的同一 Git 提交", deploy)
        self.assertIn("agent_same_commit_promotion", deploy)

    def test_jenkins_requires_an_audited_mode_and_bound_smoke_credentials(self) -> None:
        jenkins = (ROOT / "Jenkinsfile").read_text(encoding="utf-8")
        for marker in (
            "name: 'AGENT_RELEASE_MODE'",
            "choices: ['dark', 'stable']",
            "credentialsId: 'zhicui-production-smoke-email'",
            "credentialsId: 'zhicui-production-smoke-password-file'",
            'AGENT_RELEASE_MODE="$AGENT_RELEASE_MODE"',
            'SMOKE_LOGIN_EMAIL="$SMOKE_LOGIN_EMAIL"',
            'SMOKE_PASSWORD_FILE="$SMOKE_PASSWORD_FILE"',
            "SMOKE_REQUIRE_AGENT_INTERFACE=${params.AGENT_RELEASE_MODE == 'stable' ? '1' : '0'}",
        ):
            self.assertIn(marker, jenkins)
        self.assertNotIn("bash /opt/zhicui/deploy/deploy.sh", jenkins)
        self.assertIn('test -f "$WORKSPACE/deploy/deploy.sh"', jenkins)
        self.assertIn('bash "$WORKSPACE/deploy/deploy.sh"', jenkins)

    def test_jenkins_has_only_fixed_helper_commands(self) -> None:
        sudoers = (DEPLOY / "jenkins-videocapsule.sudoers").read_text(encoding="utf-8")
        helper = "/usr/local/lib/zhicui-deploy/agent-interface-kill-switch.sh"
        for action in ("dark", "stable", "verify-dark", "verify-stable"):
            self.assertIn(f"{helper} {action}", sudoers)
        self.assertNotIn(f"{helper} *", sudoers)


if __name__ == "__main__":
    unittest.main()
