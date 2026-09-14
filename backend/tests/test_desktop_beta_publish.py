"""执行 release-desktop.ps1 中的真实 Beta 远端 Bash，只使用本机临时文件。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class DesktopBetaPublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.name == "nt":
            git = shutil.which("git")
            cls.bash = str(Path(git).resolve().parents[1] / "bin/bash.exe") if git else None
        else:
            cls.bash = shutil.which("bash")
        if not cls.bash or not Path(cls.bash).is_file():
            raise unittest.SkipTest("需要 Bash（Windows 使用 Git Bash）")
        source = (ROOT / "scripts/release-desktop.ps1").read_text(encoding="utf-8")
        cls.body = re.search(r'(?ms)^\s*\$remoteCommand = @"\n(.*?)^"@', source).group(1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zhicui-beta-publish-")
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.feed = self.root / "feed"
        self.manifests = self.root / "manifests"
        self.staging = self.root / "staging"
        for path in (self.feed, self.manifests, self.staging):
            path.mkdir()
        self.exe = "Zhicui-Setup-1.2.3-x64.exe"
        self.blockmap = self.exe + ".blockmap"
        self.payload = {self.exe: b"isolated installer payload", self.blockmap: b"isolated blockmap",
                        "beta.yml": b"version: 1.2.3\n", "beta.json": b'{"version":"1.2.3"}\n'}
        for name, value in self.payload.items():
            (self.staging / name).write_bytes(value)
        (self.manifests / "beta.json").write_bytes(b"old manifest")
        (self.feed / "beta.yml").write_bytes(b"old feed")

    def tearDown(self):
        self.temp.cleanup()

    def run_publish(self, *, inject: str = ""):
        digest = lambda name: hashlib.sha256(self.payload[name]).hexdigest()
        variables = {
            "remoteFeedDir": self.feed.as_posix(), "remoteManifestDir": self.manifests.as_posix(),
            "remoteStagingDir": self.staging.as_posix(), "exeName": self.exe,
            "blockmapName": self.blockmap, "sha256": digest(self.exe),
            "blockmapSha256": digest(self.blockmap), "feedSha256": digest("beta.yml"),
            "manifestSha256": digest("beta.json"), "generatedFeedName": "beta.yml",
            "channelManifestName": "beta.json", "channelName": "beta", "feedFileName": "beta.yml",
            "releaseNonce": "isolatedfixture", "Version": "1.2.3",
        }
        # PowerShell here-string 中 `$ 是远端 Bash 的字面量美元符号。
        body = self.body.replace("`$", "__REMOTE_DOLLAR__")
        body = re.sub(r"\$([A-Za-z][A-Za-z0-9_]*)", lambda match: variables[match[1]], body)
        body = body.replace("__REMOTE_DOLLAR__", "$")
        wrapper = r'''
sudo() {
  # 所有系统边界只在临时路径执行；禁止直接 install 到不可变公开文件名。
  if [[ "$1" == install ]]; then
    destination="${@: -1}"
    if [[ "$destination" == "$FIXTURE_FEED/$FIXTURE_EXE" || "$destination" == "$FIXTURE_FEED/$FIXTURE_EXE.blockmap" ]]; then
      echo 'non-atomic payload install' >&2; return 92
    fi
    if [[ "$FIXTURE_INJECT" == 'interrupt-install' && "$destination" == "$FIXTURE_FEED/.$FIXTURE_EXE.tmp-isolatedfixture" ]]; then
      printf 'partial payload' > "$destination"; return 93
    fi
  fi
  if [[ "$1" == mv && "$2" == -Tn && "$FIXTURE_INJECT" == race ]]; then
    printf 'concurrent different installer' > "$FIXTURE_FEED/$FIXTURE_EXE"
  fi
  "$@"
}
'''
        env = os.environ.copy()
        env.update(FIXTURE_FEED=self.feed.as_posix(), FIXTURE_EXE=self.exe, FIXTURE_INJECT=inject)
        return subprocess.run([self.bash, "--noprofile", "--norc", "-s"], input=wrapper + body,
                              text=True, encoding="utf-8", capture_output=True, env=env,
                              cwd=self.root, timeout=20)

    def assert_pointers_unchanged(self):
        self.assertEqual((self.manifests / "beta.json").read_bytes(), b"old manifest")
        self.assertEqual((self.feed / "beta.yml").read_bytes(), b"old feed")

    def test_payload_is_complete_before_any_new_pointer_is_published(self):
        result = self.run_publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.feed / self.exe).read_bytes(), self.payload[self.exe])
        self.assertEqual((self.feed / self.blockmap).read_bytes(), self.payload[self.blockmap])
        self.assertEqual((self.manifests / "beta.json").read_bytes(), self.payload["beta.json"])
        self.assertEqual((self.feed / "beta.yml").read_bytes(), self.payload["beta.yml"])

    def test_same_payload_can_republish_without_rewriting_versioned_bytes(self):
        for name in (self.exe, self.blockmap):
            (self.feed / name).write_bytes(self.payload[name])
        before = {name: (self.feed / name).stat().st_mtime_ns for name in (self.exe, self.blockmap)}
        result = self.run_publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {name: (self.feed / name).stat().st_mtime_ns for name in before})

    def test_existing_version_with_different_installer_cannot_be_overwritten(self):
        (self.feed / self.exe).write_bytes(b"existing different installer")
        result = self.run_publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.feed / self.exe).read_bytes(), b"existing different installer")
        self.assert_pointers_unchanged()

    def test_existing_version_with_different_blockmap_cannot_promote(self):
        (self.feed / self.blockmap).write_bytes(b"existing different blockmap")
        result = self.run_publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.feed / self.blockmap).read_bytes(), b"existing different blockmap")
        self.assert_pointers_unchanged()

    def test_corrupt_staging_payload_cannot_publish(self):
        (self.staging / self.exe).write_bytes(b"bad download")
        result = self.run_publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.feed / self.exe).exists())
        self.assert_pointers_unchanged()

    def test_interrupted_copy_never_exposes_partial_versioned_installer(self):
        result = self.run_publish(inject="interrupt-install")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.feed / self.exe).exists())
        self.assert_pointers_unchanged()

    def test_concurrent_publication_does_not_replace_winning_payload(self):
        result = self.run_publish(inject="race")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.feed / self.exe).read_bytes(), b"concurrent different installer")
        self.assert_pointers_unchanged()


if __name__ == "__main__":
    unittest.main()
