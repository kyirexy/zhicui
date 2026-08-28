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
