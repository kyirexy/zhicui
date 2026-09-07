import importlib.util
import plistlib
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_ios_device", Path(__file__).with_name("verify-ios-device.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeviceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Products/Applications/App.app"
        self.app.mkdir(parents=True)
        self.info = {"CFBundleSupportedPlatforms": ["iPhoneOS"], "CFBundleIdentifier": "com.videocapsule.app",
                     "CFBundleShortVersionString": "1.1.10", "CFBundleVersion": "12", "CFBundleExecutable": "App"}
        (self.app / "App").write_bytes(b"fixture\x00BarcodeScannerPlugin\x00")
        self.write_info()
        (self.app / "PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps({"NSPrivacyAccessedAPITypes": [{
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
            "NSPrivacyAccessedAPITypeReasons": ["C617.1"]}]}))
        for plugin in ("CapacitorFilesystem", "CapacitorShare"):
            file = self.app / "Frameworks" / f"{plugin}.framework" / plugin
            file.parent.mkdir(parents=True)
            file.write_bytes(b"test fixture")

    def write_info(self):
        (self.app / "Info.plist").write_bytes(plistlib.dumps(self.info))

    def check(self, architectures=None):
        return module.inspect_archive(self.root, "1.1.10", "12", ["arm64"] if architectures is None else architectures)

    def test_valid_archive_does_not_claim_distribution(self):
        self.assertFalse(self.check()["distribution_verified"])

    def test_missing_static_scanner_blocks_release(self):
        (self.app / "App").write_bytes(b"fixture")
        with self.assertRaisesRegex(ValueError, "静态扫码插件缺失"): self.check()

    def test_reject_simulator_wrong_version_and_architecture(self):
        for key, value in (("CFBundleSupportedPlatforms", ["iPhoneSimulator"]),
                           ("CFBundleIdentifier", "other.app"), ("CFBundleVersion", "11")):
            original = self.info[key]
            self.info[key] = value
            self.write_info()
            with self.assertRaises(ValueError): self.check()
            self.info[key] = original
        self.write_info()
        for architectures in ([], ["x86_64"], ["arm64", "x86_64"]):
            with self.assertRaises(ValueError): self.check(architectures)

    def test_missing_plugin_or_privacy_blocks_release(self):
        plugin = self.app / "Frameworks/CapacitorShare.framework/CapacitorShare"
        plugin.unlink()
        with self.assertRaisesRegex(ValueError, "插件缺失"): self.check()
        plugin.write_bytes(b"fixture")
        (self.app / "PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps({}))
        with self.assertRaisesRegex(ValueError, "隐私声明缺失"): self.check()
