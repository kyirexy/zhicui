from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_HELPER = ROOT / "deploy" / "release-evidence-store.py"


def _load_helper():
    spec = importlib.util.spec_from_file_location(
        "release_evidence_store_test", EVIDENCE_HELPER
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 release evidence helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseEvidenceIntegrityTests(unittest.TestCase):
    COMMIT = "a" * 40
    FINGERPRINT = "agent-schema-v1:" + "b" * 64

    def setUp(self) -> None:
        self.helper = _load_helper()
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.evidence_root = root / "evidence"
        self.backup_root = root / "backups"
        self.state_root = root / "state"
        for directory in (self.evidence_root, self.backup_root, self.state_root):
            directory.mkdir()
        self.evidence_root.chmod(0o700)
        self.helper.EVIDENCE_ROOT = self.evidence_root
        self.helper.BACKUP_ROOT = self.backup_root
        self.helper.BACKUP_STATUS_FILE = self.state_root / "latest.json"
        self.artifact = "zhicui-integrity.dump.enc"
        archive = self.backup_root / self.artifact
        archive.write_bytes(b"real encrypted backup bytes")
        self.backup_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        metadata = {
            "schema_version": 1,
            "artifact": self.artifact,
            "sha256": self.backup_sha,
            "size_bytes": archive.stat().st_size,
            "completed_at": "2026-09-03T00:00:00Z",
        }
        metadata_path = archive.with_name(f"{archive.name}.json")
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        self.backup_metadata_sha = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
        status = {
            "schema_version": 1,
            "status": "ok",
            "artifact": self.artifact,
            "sha256": self.backup_sha,
            "size_bytes": archive.stat().st_size,
            "checksum_verified": True,
            "restore_verified": True,
        }
        self.helper.BACKUP_STATUS_FILE.write_text(json.dumps(status), encoding="utf-8")
        self.backup = self.helper._verify_latest_backup()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def _gates() -> list[dict[str, str]]:
        return [
            {"name": name, "status": "pass"}
            for name in (
                "production_env",
                "agent_kill_switch_preflight",
                "agent_schema_preflight",
                "predeploy_backup",
                "agent_same_commit_promotion",
                "production_assets",
                "release_manifests",
                "backend_import",
                "frontend_build",
                "readiness",
                "agent_schema_target",
                "agent_kill_switch_target",
                "smoke_fixture",
                "production_smoke",
                "smoke_fixture_cleanup",
                "agent_kill_switch_final",
                "deployment",
                "agent_schema_rehearsal",
            )
        ]

    def _store_smoke(
        self, deploy_id: str, started_at: str, finished_at: str
    ) -> dict[str, str]:
        payload = {
            "schema_version": 2,
            "operation": "production_smoke",
            "status": "passed",
            "deployment_id": deploy_id,
            "target_commit": self.COMMIT,
            "base_url": "https://luxai.cn",
            "started_at": started_at,
            "finished_at": finished_at,
        }
        with mock.patch.object(self.helper, "_runtime_commit", return_value=self.COMMIT):
            return self.helper._store_smoke(payload)

    def _store_dark_chain(self) -> tuple[dict[str, str], dict[str, str]]:
        smoke = self._store_smoke(
            "dark-1", "2026-09-03T00:01:00Z", "2026-09-03T00:02:00Z"
        )
        dark_payload = {
            "schema_version": 2,
            "operation": "production_deployment",
            "deployment_id": "dark-1",
            "status": "succeeded",
            "started_at": "2026-09-03T00:00:00Z",
            "finished_at": "2026-09-03T00:03:00Z",
            "target_commit": self.COMMIT,
            "agent_release_mode": "dark",
            "previous_agent_schema_fingerprint": None,
            "target_agent_schema_fingerprint": self.FINGERPRINT,
            "backup": self.backup,
            "smoke_evidence": smoke,
            "gates": self._gates(),
        }
        with mock.patch.object(self.helper, "_runtime_commit", return_value=self.COMMIT):
            dark = self.helper._store_deployment(dark_payload)
        rehearsal_name = "agent-schema-rehearsal-20260903T000400Z-aaaaaaaaaaaa.json"
        rehearsal_payload = {
            "schema_version": 2,
            "operation": "agent_schema_restored_snapshot_rehearsal",
            "status": "succeeded",
            "started_at": "2026-09-03T00:04:00Z",
            "finished_at": "2026-09-03T00:05:00Z",
            "target_commit": self.COMMIT,
            "snapshot": {
                key: self.backup[key]
                for key in ("artifact", "sha256", "size_bytes", "metadata_sha256")
            },
            "predecessor": dark,
            "isolated_database": "zhicui_agent_rehearsal_integrity",
            "snapshot_counts": {"users": 1, "notes": 2, "plans": 3},
            "schema_startup_passes": 2,
            "agent_schema_fingerprint": self.FINGERPRINT,
            "workers_started": False,
        }
        rehearsal_name, rehearsal_sha = self.helper._atomic_store(
            rehearsal_name, rehearsal_payload
        )
        return dark, {"name": rehearsal_name, "sha256": rehearsal_sha}

    def test_stable_chain_binds_real_backup_commit_and_predecessor_hashes(self) -> None:
        dark, rehearsal = self._store_dark_chain()
        smoke = self._store_smoke(
            "stable-1", "2026-09-03T00:07:00Z", "2026-09-03T00:08:00Z"
        )
        stable_payload = {
            "schema_version": 2,
            "operation": "production_deployment",
            "deployment_id": "stable-1",
            "status": "succeeded",
            "started_at": "2026-09-03T00:06:00Z",
            "finished_at": "2026-09-03T00:09:00Z",
            "target_commit": self.COMMIT,
            "agent_release_mode": "stable",
            "previous_agent_schema_fingerprint": self.FINGERPRINT,
            "target_agent_schema_fingerprint": self.FINGERPRINT,
            "backup": self.backup,
            "smoke_evidence": smoke,
            "dark_evidence": dark,
            "rehearsal_evidence": rehearsal,
            "gates": self._gates(),
        }
        with mock.patch.object(self.helper, "_runtime_commit", return_value=self.COMMIT):
            stored = self.helper._store_deployment(stable_payload)
        self.assertRegex(stored["sha256"], r"^[0-9a-f]{64}$")
        loaded, loaded_sha = self.helper._load_verified(stored["name"], stored["sha256"])
        self.assertEqual(loaded_sha, stored["sha256"])
        self.assertEqual(loaded["dark_evidence"], dark)
        self.assertEqual(loaded["rehearsal_evidence"], rehearsal)

    def test_tampering_sealed_json_is_detected(self) -> None:
        dark, _ = self._store_dark_chain()
        path = self.evidence_root / dark["name"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(self.helper.EvidenceError, "实际 SHA-256 不匹配"):
            self.helper._load_verified(dark["name"], dark["sha256"])

    def test_fake_backup_hash_and_wrong_runtime_commit_fail_closed(self) -> None:
        fake = dict(self.backup)
        fake["sha256"] = "0" * 64
        with self.assertRaisesRegex(self.helper.EvidenceError, "真实字节"):
            self.helper._verify_backup(fake)
        payload = {
            "schema_version": 2,
            "operation": "production_smoke",
            "status": "passed",
            "deployment_id": "wrong-runtime",
            "target_commit": self.COMMIT,
            "base_url": "https://luxai.cn",
            "started_at": "2026-09-03T01:00:00Z",
            "finished_at": "2026-09-03T01:01:00Z",
        }
        with mock.patch.object(self.helper, "_runtime_commit", return_value="c" * 40):
            with self.assertRaisesRegex(self.helper.EvidenceError, "真实 runtime"):
                self.helper._store_smoke(payload)

    def test_rehearsal_with_wrong_dark_hash_reference_is_rejected(self) -> None:
        dark, rehearsal = self._store_dark_chain()
        payload, _ = self.helper._load_verified(rehearsal["name"], rehearsal["sha256"])
        bad_payload = dict(payload)
        bad_payload["predecessor"] = {"name": dark["name"], "sha256": "0" * 64}
        bad_name = "agent-schema-rehearsal-20260903T000600Z-aaaaaaaaaaaa.json"
        bad_name, bad_sha = self.helper._atomic_store(bad_name, bad_payload)
        request = {
            "expected_commit": self.COMMIT,
            "expected_fingerprint": self.FINGERPRINT,
            "dark_evidence_name": dark["name"],
            "dark_evidence_sha256": dark["sha256"],
            "rehearsal_evidence_name": bad_name,
            "rehearsal_evidence_sha256": bad_sha,
        }
        with self.assertRaisesRegex(self.helper.EvidenceError, "前序证据"):
            self.helper._verify_rehearsal(request)

    def test_release_scripts_require_root_evidence_and_public_https_readback(self) -> None:
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        desktop = (ROOT / "scripts" / "release-desktop.ps1").read_text(
            encoding="utf-8"
        )
        for marker in (
            'RELEASE_EVIDENCE_HELPER="/usr/local/lib/zhicui-deploy/release-evidence-store.py"',
            'sudo -n "$RELEASE_EVIDENCE_HELPER" verify-dark',
            'sudo -n "$RELEASE_EVIDENCE_HELPER" verify-rehearsal',
            'sudo -n "$RELEASE_EVIDENCE_HELPER" store-smoke',
            'sudo -n "$RELEASE_EVIDENCE_HELPER" store-deployment',
        ):
            self.assertIn(marker, deploy)
        for marker in (
            "Invoke-StrictPublicDownload",
            "$handler.AllowAutoRedirect = $false",
            "Invoke-StrictPublicDownload -Uri $publicManifestUrl",
            "Invoke-StrictPublicDownload -Uri $publicInstallerUrl",
            "Invoke-StrictPublicDownload -Uri $publicBlockmapUrl",
            "(Get-FileHash -LiteralPath $downloadedManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestSha256",
            "[string]$publicManifest.source_commit -ne $resolvedCommit",
            "(Get-FileHash -LiteralPath $downloadedInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256",
            "(Get-FileHash -LiteralPath $downloadedBlockmap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $blockmapSha256",
            "$stableRollbackPrepared = $true",
            "$rollbackStableCommand",
        ):
            self.assertIn(marker, desktop)


if __name__ == "__main__":
    unittest.main()
