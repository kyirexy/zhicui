from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ReleaseReproducibilityContractTests(unittest.TestCase):
    def test_cli_stable_publish_is_tag_scoped_and_provenance_enabled(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "publish-zhicui-cli.yml"
        ).read_text(encoding="utf-8")
        release_notes = (ROOT / "cli" / "RELEASE.md").read_text(encoding="utf-8")
        for marker in (
            "'cli-v*.*.*'",
            "id-token: write",
            "environment: npm-production",
            'expected_tag="cli-v${package_version}"',
            'git merge-base --is-ancestor "${GITHUB_SHA}" origin/master',
            "npm ci --registry=https://registry.npmjs.org",
            "npm test",
            "npm pack --dry-run --json",
            "npm publish --access public --tag latest --provenance",
            "npm view @zhicui/cli dist-tags.latest",
        ):
            self.assertIn(marker, workflow)
        self.assertNotIn("workflow_dispatch:", workflow)
        self.assertEqual(
            len(re.findall(r"uses: actions/(?:checkout|setup-node)@[0-9a-f]{40}", workflow)),
            2,
        )
        self.assertIn("禁止从开发机手工发布 Stable", release_notes)

    def test_production_deploy_has_no_npm_install_fallback(self) -> None:
        script = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn("npm ci --silent", script)
        self.assertNotRegex(script, re.compile(r"\bnpm\s+install\b"))

    def test_public_release_assets_remain_nginx_readable_after_rsync(self) -> None:
        preinstall = (ROOT / "deploy" / "preinstall-production-assets.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "find /var/lib/zhicui-downloads -type d -exec chmod 0755 {} +",
            preinstall,
        )
        self.assertIn(
            "find /var/lib/zhicui-downloads -type f -exec chmod 0644 {} +",
            preinstall,
        )

    def test_smoke_evidence_does_not_chmod_an_existing_shared_directory(self) -> None:
        smoke = (ROOT / "scripts" / "smoke-production.sh").read_text(encoding="utf-8")
        self.assertIn('[[ -d "$evidence_dir" ]] || install -d -m 0700', smoke)
        self.assertNotIn('install -d -m 0700 "$(dirname "$EVIDENCE_FILE")"', smoke)

    def test_android_release_uses_explicit_detached_commit(self) -> None:
        script = (ROOT / "scripts" / "build-apk.sh").read_text(encoding="utf-8")
        for marker in (
            "RELEASE_COMMIT=<40位 Git 提交 SHA>",
            "worktree add --detach",
            "ZHICUI_RELEASE_WORKTREE_INTERNAL=1",
            "--untracked-files=all",
            "npm ci --silent",
            "source_commit: sourceCommit",
        ):
            self.assertIn(marker, script)
        self.assertRegex(script, re.compile(r"\^\[0-9a-fA-F\]\{40\}\$"))

    def test_android_beta_release_can_publish_a_strictly_newer_build(self) -> None:
        script = (ROOT / "scripts" / "build-apk.sh").read_text(encoding="utf-8")
        for marker in (
            'Beta 指定新版本时需要 RELEASE_VERSION=x.y.z',
            'Beta 指定新版本时需要 RELEASE_BUILD=正整数',
            'Beta 新 build 必须大于当前 build',
            '...current,\n  schema_version: 1,',
        ):
            self.assertIn(marker, script)

    def test_android_update_manifest_allows_exact_capacitor_origin(self) -> None:
        nginx = (ROOT / "deploy" / "nginx-windows-updates.conf").read_text(
            encoding="utf-8"
        )
        smoke = (ROOT / "scripts" / "smoke-production.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('Access-Control-Allow-Origin "https://localhost"', nginx)
        self.assertNotIn('Access-Control-Allow-Origin "*"', nginx)
        self.assertIn("Origin: https://localhost", smoke)
        self.assertIn("缺少 Capacitor https://localhost 的精确 ACAO", smoke)

    def test_windows_release_and_skip_build_are_commit_scoped(self) -> None:
        script = (ROOT / "scripts" / "release-desktop.ps1").read_text(encoding="utf-8")
        for marker in (
            "[string]$Commit",
            "'worktree', 'add', '--detach'",
            "--untracked-files=all",
            "Invoke-Checked 'npm.cmd' @('ci', '--silent')",
            "provenance.json",
            "source_commit = $resolvedCommit",
            "package_lock_sha256",
            "-SkipBuild 缓存哈希或大小与来源记录不一致",
            "ArtifactCacheRoot 必须位于 Git checkout/worktree 之外",
            "Invoke-Checked 'npm.cmd' @('run', 'prepare:cli')",
            "Invoke-Checked 'npm.cmd' @('run', 'verify:agent-integration')",
            'https://luxai.cn/download/releases/windows/$remoteChannel.json',
            "无法读取线上 Windows $remoteChannel 发行账本",
            "版本 $Version 必须高于全部已发布 Windows 版本",
        ):
            self.assertIn(marker, script)

    def test_android_stable_reuses_only_verified_immutable_cache(self) -> None:
        script = (ROOT / "scripts" / "build-apk.sh").read_text(encoding="utf-8")
        for marker in (
            "SKIP_BUILD 复用缓存只允许 Stable 发行",
            "provenance.status !== 'verified'",
            "provenance.artifact_sha256 !== actualSha",
            "provenance.verification_evidence_sha256",
            "Stable 发布必须使用 SKIP_BUILD=1 复用已完成真机验收的同一字节 APK",
            "if [[ \"$CHANNEL\" != \"stable\" || \"$SKIP_BUILD\" == \"1\" ]]",
        ):
            self.assertIn(marker, script)

    def test_agent_stable_smoke_pins_the_reviewed_capability_contract(self) -> None:
        script = (ROOT / "scripts" / "smoke-agent-interface.sh").read_text(
            encoding="utf-8"
        )
        for marker in (
            "stable_capabilities_v1.json",
            "descriptor_sha256",
            "production-stable-capability-smoke",
            "remote_mcp_tool_count",
            '"run.get", "run.events", "run.cancel"',
            "FULL_CREDENTIAL_ID",
        ):
            self.assertIn(marker, script)

    def test_agent_stable_smoke_recovers_and_confirms_pat_cleanup(self) -> None:
        script = (ROOT / "scripts" / "smoke-agent-interface.sh").read_text(
            encoding="utf-8"
        )
        for marker in (
            '"$WORK_DIR/create.response" "$WORK_DIR/create-full.response"',
            'reserved = {"production-stable-smoke", "production-stable-capability-smoke"}',
            'not credential.get("revoked_at")',
            "无法确认所有冒烟 PAT 均已吊销",
        ):
            self.assertIn(marker, script)

    def test_agent_stable_smoke_executes_runtime_and_real_ask_sentinels(self) -> None:
        agent_smoke = (ROOT / "scripts" / "smoke-agent-interface.sh").read_text(
            encoding="utf-8"
        )
        production_smoke = (ROOT / "scripts" / "smoke-production.sh").read_text(
            encoding="utf-8"
        )
        for marker in (
            "analysis.catalog/invoke",
            "automation.status/invoke",
            "models.list/invoke",
            "models.selection.get/invoke",
            "ask.turn.start/invoke",
            "ask.thread.get/invoke",
            'item.get("type") == "external.turn.answer.delta"',
        ):
            self.assertIn(marker, agent_smoke)
        for marker in (
            'SMOKE_AGENT_THREAD_ID="$THREAD_ID"',
            'SMOKE_AGENT_SOURCE_ID="$SOURCE_ID"',
            "SMOKE_REQUIRE_AGENT_RUNTIME_SENTINELS=1",
            "SMOKE_REQUIRE_AGENT_ASK_SENTINEL=1",
        ):
            self.assertIn(marker, production_smoke)


if __name__ == "__main__":
    unittest.main()
