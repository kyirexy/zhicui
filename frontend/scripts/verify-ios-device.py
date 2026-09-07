"""核对实际真机归档，防止模拟器或缺少插件的包被当作发布产物。"""
import argparse
import hashlib
import json
import plistlib
import subprocess
from pathlib import Path


def inspect_archive(archive, version, build, architectures):
    app = Path(archive) / "Products/Applications/App.app"
    with (app / "Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
        raise ValueError("产物不是 iPhone 真机平台")
    if info.get("CFBundleIdentifier") != "com.videocapsule.app":
        raise ValueError("Bundle ID 与知萃工程不一致")
    if info.get("CFBundleShortVersionString") != version or info.get("CFBundleVersion") != build:
        raise ValueError("版本或构建号不一致")
    if not architectures or not set(architectures) <= {"arm64", "arm64e"}:
        raise ValueError("归档必须只包含 iPhone ARM64 架构")
    with (app / "PrivacyInfo.xcprivacy").open("rb") as file:
        privacy = plistlib.load(file)
    if not any(item.get("NSPrivacyAccessedAPIType") == "NSPrivacyAccessedAPICategoryFileTimestamp"
               and "C617.1" in item.get("NSPrivacyAccessedAPITypeReasons", [])
               for item in privacy.get("NSPrivacyAccessedAPITypes", [])):
        raise ValueError("文件导出用途隐私声明缺失")
    for plugin in ("CapacitorFilesystem", "CapacitorShare"):
        if not (app / "Frameworks" / f"{plugin}.framework" / plugin).is_file():
            raise ValueError(f"原生插件缺失：{plugin}")
    # 扫码 Pod 声明 static_framework，Objective-C 类随主程序链接，不生成嵌入框架。
    executable = info.get("CFBundleExecutable", "")
    if not executable or Path(executable).name != executable:
        raise ValueError("可执行文件名无效")
    if b"BarcodeScannerPlugin\x00" not in (app / executable).read_bytes():
        raise ValueError("静态扫码插件缺失")
    return {"bundle_id": info["CFBundleIdentifier"], "version": version, "build": build,
            "platform": "iPhoneOS", "architectures": architectures, "privacy_and_plugins": "pass",
            "distribution_verified": False, "notice": "仅验证归档内容，未完成签名分发或真机安装验收"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    app = args.archive / "Products/Applications/App.app"
    with (app / "Info.plist").open("rb") as file:
        executable = plistlib.load(file)["CFBundleExecutable"]
    if Path(executable).name != executable:
        raise ValueError("可执行文件名无效")
    binary = app / executable
    architectures = subprocess.check_output(["xcrun", "lipo", "-archs", str(binary)], text=True).split()
    report = inspect_archive(args.archive, args.version, args.build, architectures)
    report["executable_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("真机架构、版本、隐私清单与原生插件验证通过")
