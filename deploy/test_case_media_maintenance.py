"""媒体快照的真实加密/解密回归验证；不触碰生产路径或数据库。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("case_media", Path(__file__).with_name("case-media-maintenance.py"))
case_media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(case_media)


class MediaSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.backups = self.root / "backups"
        self.backups.mkdir(mode=0o700)
        self.key = self.root / "key"
        self.key.write_bytes(os.urandom(64))
        executable = shutil.which("openssl")
        if not executable and Path("D:/Apps/Git/usr/bin/openssl.exe").is_file():
            executable = "D:/Apps/Git/usr/bin/openssl.exe"
        if not executable:
            self.skipTest("需要 openssl 验证真实加密归档")
        self.original_args = case_media.openssl_args
        patches = [patch.object(case_media, "BACKUPS", self.backups),
                   patch.object(case_media, "LATEST", self.backups / "latest.json"),
                   patch.object(case_media, "KEY", self.key),
                   patch.object(case_media, "checked_directory"),
                   patch.object(case_media, "openssl_args", lambda decrypt=False: [executable, *self.original_args(decrypt)[1:]])]
        for entry in patches:
            entry.start()
            self.addCleanup(entry.stop)
        # Windows 没有 POSIX mode；验证密文与归档路径仍走真实实现。
        if os.name == "nt":
            self.old_verify = case_media.verify_latest
            self.verify_patch = patch.object(case_media, "verify_latest", self.verify_latest_portable)
            self.verify_patch.start()
            self.addCleanup(self.verify_patch.stop)

    def verify_latest_portable(self):
        data = json.loads(case_media.LATEST.read_text(encoding="utf-8"))
        archive = self.backups / data["artifact"]
        if case_media.digest_file(archive) != data["sha256"]:
            raise RuntimeError("密文 SHA-256 校验失败")
        case_media.verify_archive(archive, data["files"])
        return {"ok": True}

    def write(self, content=b"real-media-test-bytes"):
        source = self.root / "media.gif"
        source.write_bytes(content)
        manifest = {"media/media.gif": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}
        case_media.write_snapshot({"media/media.gif": source}, manifest, True)
        data = json.loads(case_media.LATEST.read_text(encoding="utf-8"))
        return self.backups / data["artifact"], manifest

    def test_roundtrip_and_manifest(self):
        archive, manifest = self.write()
        self.assertTrue(archive.read_bytes().startswith(b"Salted__"))
        case_media.verify_archive(archive, manifest)

    def test_empty_first_install_snapshot(self):
        case_media.write_snapshot({}, {}, False)
        data = json.loads(case_media.LATEST.read_text(encoding="utf-8"))
        self.assertFalse(data["case_table_included"])
        case_media.verify_archive(self.backups / data["artifact"], {})

    def test_tampered_ciphertext_rejected(self):
        archive, _ = self.write()
        content = bytearray(archive.read_bytes())
        content[len(content) // 2] ^= 1
        archive.write_bytes(content)
        with self.assertRaises(RuntimeError):
            case_media.verify_latest()

    def test_wrong_file_manifest_rejected(self):
        archive, _ = self.write()
        with self.assertRaises(RuntimeError):
            case_media.verify_archive(archive, {})

    def test_retention_only_own_archives(self):
        unrelated = self.backups / "user-document.txt"
        unrelated.write_text("保留")
        for number in range(3):
            self.write(str(number).encode())
        self.assertEqual(len(list(self.backups.glob("case-media-*.tar.gz.enc"))), 2)
        self.assertTrue(unrelated.exists())


if __name__ == "__main__":
    unittest.main()
