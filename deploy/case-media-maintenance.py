#!/usr/bin/env python3
"""案例媒体的生产预检与加密快照；仅操作固定目录，不接收用户路径。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

MEDIA = Path("/var/lib/zhicui-case-media")
BACKUPS = Path("/var/backups/zhicui-case-media")
KEY = Path("/etc/zhicui/backup.key")
LATEST = BACKUPS / "latest.json"
MIB = 1024 * 1024
RESERVE = 512 * MIB
LIMIT = 1024 * MIB
BUILD_RESERVE = 2560 * MIB


def digest_file(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def checked_directory(path: Path, uid: int) -> None:
    stat = path.lstat()
    if path.is_symlink() or not path.is_dir() or stat.st_uid != uid or stat.st_mode & 0o077:
        raise RuntimeError(f"{path} 必须是固定路径、正确所有者的 0700 目录")


def media_inventory() -> dict[str, dict[str, int | str]]:
    result = {}
    for path in sorted(MEDIA.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("案例媒体目录不能包含符号链接")
        if path.is_dir():
            continue
        # 上传中的临时文件还没有数据库引用，不收入公开媒体快照。
        if any(part.startswith(".") for part in path.relative_to(MEDIA).parts):
            continue
        if not path.is_file():
            raise RuntimeError("案例媒体目录包含非常规文件")
        result["media/" + path.relative_to(MEDIA).as_posix()] = {
            "size": path.stat().st_size, "sha256": digest_file(path)
        }
    return result


def preflight(*, build: bool = False) -> dict:
    import pwd
    checked_directory(MEDIA, pwd.getpwnam("ubuntu").pw_uid)
    checked_directory(BACKUPS, 0)
    for command in ("ffmpeg", "ffprobe", "openssl", "pg_dump", "pg_restore", "runuser", "psql"):
        if not shutil.which(command):
            raise RuntimeError(f"案例媒体缺少依赖：{command}")
    if not KEY.is_file() or KEY.is_symlink() or KEY.stat().st_mode & 0o007:
        raise RuntimeError("既有备份加密密钥缺失或权限不安全")
    size = sum(p.stat().st_size for p in MEDIA.rglob("*") if p.is_file() and not p.is_symlink())
    free = shutil.disk_usage(MEDIA).free
    required = max(BUILD_RESERVE if build else RESERVE, size + RESERVE)
    if size > LIMIT:
        raise RuntimeError("案例媒体超过 1 GiB 存储额度，请先整理媒体")
    if free < required:
        raise RuntimeError(f"存储不足：剩余 {free // MIB} MiB，至少需要 {required // MIB} MiB；请审核可再生旧构建或扩容")
    return {"ok": True, "media_bytes": size, "free_bytes": free, "required_free_bytes": required}


def openssl_args(decrypt: bool = False) -> list[str]:
    return ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
            *( ["-d"] if decrypt else ["-salt"] ), "-pass", f"file:{KEY}"]


def verify_archive(path: Path, manifest: dict) -> None:
    seen = {}
    with path.open("rb") as source:
        process = subprocess.Popen(openssl_args(True), stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|gz") as archive:
                for member in archive:
                    if not member.isfile() or member.name not in manifest or member.name in seen:
                        raise RuntimeError("解密快照条目与清单不一致")
                    handle = archive.extractfile(member)
                    seen[member.name] = {"size": member.size, "sha256": hashlib.file_digest(handle, "sha256").hexdigest()}
            # 读完加密尾部，让 openssl 的填充校验完成。
            process.stdout.read()
            if process.wait(timeout=30) != 0 or seen != manifest:
                raise RuntimeError("媒体快照解密或逐文件 SHA-256 校验失败")
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def verify_latest() -> dict:
    checked_directory(BACKUPS, 0)
    data = json.loads(LATEST.read_text(encoding="utf-8"))
    name = data.get("artifact", "")
    if not re.fullmatch(r"case-media-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.tar\.gz\.enc", name):
        raise RuntimeError("媒体快照文件名不合法")
    path = BACKUPS / name
    if path.is_symlink() or path.stat().st_mode & 0o077 or digest_file(path) != data["sha256"]:
        raise RuntimeError("媒体快照权限或密文 SHA-256 校验失败")
    verify_archive(path, data["files"])
    return {"ok": True, "artifact": name, "sha256": data["sha256"], "files": len(data["files"]),
            "archive_verified": True, "backup_mode": "local_only"}


def snapshot() -> dict:
    import fcntl
    preflight()
    with (BACKUPS / ".backup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # 与所有案例写操作共用锁。先导出表，再打包媒体；替换/删除须等待快照完成。
        # 安装脚本提前建立 ubuntu 拥有的锁文件；此处不改变其所有者。
        with (MEDIA / ".upload.lock").open("rb") as media_lock:
            fcntl.flock(media_lock, fcntl.LOCK_EX)
            with tempfile.TemporaryDirectory(prefix=".database-", dir=BACKUPS) as temporary_dir:
                table_exists = subprocess.run(
                    ["runuser", "-u", "postgres", "--", "psql", "-XAt", "--dbname=zhicui", "-c",
                     "SELECT to_regclass('public.showcase_cases') IS NOT NULL"],
                    check=True, capture_output=True, text=True, timeout=30,
                ).stdout.strip() == "t"
                source_files = {name: MEDIA / name.removeprefix("media/") for name in media_inventory()}
                if table_exists:
                    dump = Path(temporary_dir) / "showcase_cases.dump"
                    with dump.open("wb") as output:
                        subprocess.run(["runuser", "-u", "postgres", "--", "pg_dump", "--format=custom",
                                        "--no-owner", "--no-privileges", "--table=public.showcase_cases", "--dbname=zhicui"],
                                       stdout=output, stderr=subprocess.PIPE, check=True, timeout=120)
                    subprocess.run(["pg_restore", "--list", str(dump)], check=True, stdout=subprocess.DEVNULL, timeout=30)
                    source_files["database/showcase_cases.dump"] = dump
                manifest = {name: {"size": path.stat().st_size, "sha256": digest_file(path)} for name, path in source_files.items()}
                return write_snapshot(source_files, manifest, table_exists)


def write_snapshot(source_files: dict[str, Path], manifest: dict, table_exists: bool) -> dict:
    fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"case-media-{stamp}-{fingerprint[:12]}.tar.gz.enc"
    destination = BACKUPS / name
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".snapshot-", dir=BACKUPS, delete=False) as output:
            temporary = Path(output.name)
            process = subprocess.Popen(openssl_args(), stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL)
            try:
                with tarfile.open(fileobj=process.stdin, mode="w|gz") as archive:
                    for relative, source in source_files.items():
                        archive.add(source, arcname=relative, recursive=False)
                process.stdin.close()
                if process.wait(timeout=30) != 0:
                    raise RuntimeError("媒体快照加密失败")
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
        verify_archive(temporary, manifest)
        checksum = digest_file(temporary)
        os.replace(temporary, destination)
        temporary = None
        data = {"schema_version": 1, "artifact": name, "sha256": checksum,
                "completed_at": datetime.now(timezone.utc).isoformat(), "manifest_sha256": fingerprint,
                "files": manifest, "case_table_included": table_exists,
                "archive_verified": True, "table_archive_list_verified": table_exists,
                "backup_mode": "local_only"}
        status = BACKUPS / ".latest.tmp"
        status.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(status, LATEST)
        # 仅清理此脚本自己的加密快照，保留最新两份；从不清理业务媒体。
        archives = sorted(BACKUPS.glob("case-media-*.tar.gz.enc"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old_path in archives[2:]:
            if re.fullmatch(r"case-media-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.tar\.gz\.enc", old_path.name) and not old_path.is_symlink():
                old_path.unlink()
        return verify_latest()
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if os.geteuid() != 0:
            raise RuntimeError("案例媒体维护须由受限 root helper 执行")
        action = sys.argv[1:] or ["preflight"]
        if action == ["preflight"]:
            result = preflight(build=True)
        elif action == ["backup"]:
            result = snapshot()
        elif action == ["verify"]:
            result = verify_latest()
        else:
            raise RuntimeError("仅支持 preflight / backup / verify")
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"案例媒体维护失败：{exc}", file=sys.stderr)
        sys.exit(1)
