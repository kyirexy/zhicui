from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ReleaseReproducibilityContractTests(unittest.TestCase):
    def test_production_deploy_has_no_npm_install_fallback(self) -> None:
        script = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn("npm ci --silent", script)
        self.assertNotRegex(script, re.compile(r"\bnpm\s+install\b"))

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
        ):
            self.assertIn(marker, script)


if __name__ == "__main__":
    unittest.main()
