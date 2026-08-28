from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "deploy" / "yutto-sidecar"


class YuttoDeployAssetTests(unittest.TestCase):
    def test_pinned_isolated_sidecar_assets_are_complete(self) -> None:
        required = {
            "install.sh", "preflight.py", "health_check.py",
            "zhicui-yutto-sidecar.service", "SOURCE-NOTICE.md", "README.md",
            "zhicui-catalog-fields.patch",
        }
        self.assertTrue(required.issubset({path.name for path in ASSETS.iterdir()}))
        installer = (ASSETS / "install.sh").read_text(encoding="utf-8")
        notice = (ASSETS / "SOURCE-NOTICE.md").read_text(encoding="utf-8")
        self.assertIn('UPSTREAM_VERSION="2.2.0"', installer)
        self.assertIn("ba90a95bd89e416059ee5559b52197531d5d8998", installer)
        self.assertIn("GNU General Public License v3.0", notice)
        self.assertIn("corresponding source", notice)
        self.assertNotIn("pip install yutto==", installer)

    def test_service_is_loopback_authenticated_and_preflighted(self) -> None:
        unit = (ASSETS / "zhicui-yutto-sidecar.service").read_text(encoding="utf-8")
        self.assertIn("--host 127.0.0.1", unit)
        self.assertIn("--token-file /opt/yutto-sidecar/server.token", unit)
        self.assertIn("ExecStartPre=", unit)
        self.assertIn("preflight.py", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("ReadWritePaths=/opt/yutto-sidecar/tmp", unit)
        self.assertNotIn("download.start", unit)

    def test_health_probe_requires_full_metadata_protocol(self) -> None:
        probe = (ASSETS / "health_check.py").read_text(encoding="utf-8")
        for capability in (
            "resolve.start", "task.subscribe", "task.get", "task.cancel",
        ):
            self.assertIn(capability, probe)
        self.assertNotIn("download.start", probe)


if __name__ == "__main__":
    unittest.main()
