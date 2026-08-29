from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "deploy" / "backup"


def _find_usable_bash() -> str | None:
    candidates: list[Path] = []
    discovered = shutil.which("bash")
    if discovered:
        candidates.append(Path(discovered))
    git = shutil.which("git")
    if git:
        git_root = Path(git).resolve().parents[1]
        candidates.extend((git_root / "bin" / "bash.exe", git_root / "usr" / "bin" / "bash.exe"))
    candidates.extend(
        (
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        )
    )
    for candidate in dict.fromkeys(candidates):
        if not candidate.is_file():
            continue
        probe = subprocess.run(
            [str(candidate), "--version"],
            check=False,
            capture_output=True,
        )
        if probe.returncode == 0:
            return str(candidate)
    return None


class BackupOffsiteAssetTests(unittest.TestCase):
    def test_offsite_script_contract_self_test_executes(self) -> None:
        bash = _find_usable_bash()
        if bash is None:
            self.skipTest("bash is required to execute the production backup contract")
        result = subprocess.run(
            [
                bash,
                "-lc",
                "bash ./deploy/backup/postgres-offsite-replicate.sh --contract-test",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("contract self-test passed", result.stdout)

    def test_offsite_replication_is_required_and_does_not_upload_plaintext_key(self) -> None:
        script = (BACKUP / "postgres-offsite-replicate.sh").read_text(encoding="utf-8")
        env_template = (BACKUP / "backup.env.example").read_text(encoding="utf-8")
        self.assertIn('ZHICUI_OFFSITE_REQUIRED:-true', script)
        self.assertIn('ZHICUI_OFFSITE_REQUIRED=true', env_template)
        self.assertIn('ZHICUI_OFFSITE_MODE=rclone', env_template)
        self.assertIn('rclone cat', script)
        self.assertIn('StrictHostKeyChecking=yes', script)
        self.assertIn('禁止上传明文备份密钥', script)
        self.assertNotIn('copyto --config "$RCLONE_CONFIG" "$KEY_FILE"', script)
        self.assertNotIn('scp "${ssh_options[@]}" -- "$KEY_FILE"', script)

    def test_restore_verification_supports_truthful_local_mode(self) -> None:
        restore = (BACKUP / "postgres-restore-verify.sh").read_text(encoding="utf-8")
        installer = (BACKUP / "install.sh").read_text(encoding="utf-8")
        self.assertIn('postgres-offsite-replicate.sh', restore)
        self.assertIn('offsite.get("artifact") == artifact', restore)
        self.assertIn('offsite.get("sha256", "")', restore)
        self.assertIn('"offsite_verified": True', restore)
        self.assertIn('"backup_mode": "offsite" if offsite_required else "local_only"', restore)
        self.assertIn('跳过异地复制', restore)
        self.assertIn('if is_true "$OFFSITE_REQUIRED"', restore)
        self.assertIn('postgres-offsite-replicate.sh', installer)

    def test_production_gates_require_offsite_or_double_opt_in_local_mode(self) -> None:
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        preinstall = (ROOT / "deploy" / "preinstall-production-assets.sh").read_text(encoding="utf-8")
        production_env = (ROOT / "deploy" / "production.env.example").read_text(encoding="utf-8")
        self.assertIn('BACKUP_OFFSITE_REQUIRED=true', production_env)
        self.assertIn('EARLY_STAGE_LOCAL_BACKUP_ACCEPTED=false', production_env)
        self.assertIn('EARLY_STAGE_LOCAL_BACKUP_ACCEPTED=true', deploy)
        self.assertIn('p.get("backup_mode") == "local_only"', deploy)
        self.assertIn('p.get("offsite_verified") is False', deploy)
        self.assertIn('p.get("backup_mode") == "local_only"', preinstall)
        self.assertIn('p.get("offsite_verified") is False', preinstall)


if __name__ == "__main__":
    unittest.main()
