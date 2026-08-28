from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "deploy" / "backup"


class BackupOffsiteAssetTests(unittest.TestCase):
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

    def test_restore_verification_requires_matching_offsite_status(self) -> None:
        restore = (BACKUP / "postgres-restore-verify.sh").read_text(encoding="utf-8")
        installer = (BACKUP / "install.sh").read_text(encoding="utf-8")
        self.assertIn('postgres-offsite-replicate.sh', restore)
        self.assertIn('offsite.get("artifact") == artifact', restore)
        self.assertIn('offsite.get("sha256", "")', restore)
        self.assertIn('"offsite_verified": True', restore)
        self.assertIn('postgres-offsite-replicate.sh', installer)

    def test_production_gates_require_offsite_readback(self) -> None:
        deploy = (ROOT / "deploy" / "deploy.sh").read_text(encoding="utf-8")
        preinstall = (ROOT / "deploy" / "preinstall-production-assets.sh").read_text(encoding="utf-8")
        production_env = (ROOT / "deploy" / "production.env.example").read_text(encoding="utf-8")
        self.assertIn('BACKUP_OFFSITE_REQUIRED=true', production_env)
        self.assertIn('BACKUP_OFFSITE_REQUIRED 必须为 true', deploy)
        self.assertIn('p.get("offsite_verified") is not True', deploy)
        self.assertIn('p.get("offsite_verified") is True', preinstall)
        self.assertIn('p.get("recovery_material_verified") is True', preinstall)


if __name__ == "__main__":
    unittest.main()
