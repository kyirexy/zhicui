#!/usr/bin/env python3
"""在已恢复的隔离 PostgreSQL 快照上重复执行两次 schema 启动阶段。

运维先把生产加密备份恢复到名称以 ``zhicui_restore_verify_`` 或
``zhicui_agent_rehearsal_`` 开头的隔离数据库，再运行本脚本。脚本拒绝生产数据库名、
不会启动后台 worker，也不会删除数据库；成功后写出不含连接串的原子 JSON 证据。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit


DATABASE_PREFIXES = ("zhicui_restore_verify_", "zhicui_agent_rehearsal_")
PRODUCTION_EVIDENCE_ROOT = Path("/var/lib/zhicui-deployments")
PRODUCTION_BACKUP_ROOT = Path("/var/backups/zhicui")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _database_name(database_url: str) -> str:
    parsed = urlsplit(database_url.replace("postgresql+psycopg2://", "postgresql://", 1))
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise ValueError("演练只接受 PostgreSQL URL")
    name = unquote(parsed.path.lstrip("/")).split("/", 1)[0]
    if not name or not name.startswith(DATABASE_PREFIXES):
        raise ValueError("数据库名不是受控的恢复快照/Agent 演练前缀")
    return name


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verified_evidence(path: Path) -> tuple[dict[str, object], str]:
    path = path.resolve(strict=True)
    sidecar = path.with_name(f"{path.name}.sha256")
    sidecar.resolve(strict=True)
    for candidate in (path, sidecar):
        info = candidate.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError(f"证据不是普通文件：{candidate.name}")
        if os.name != "nt" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError(f"证据必须 root-owned 0600：{candidate.name}")
    line = sidecar.read_text(encoding="ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json)", line)
    actual = _sha256(path)
    if not match or match.group(2) != path.name or match.group(1) != actual:
        raise ValueError("dark 证据 detached SHA-256 与真实文件不一致")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("dark 证据不是 JSON object")
    return value, actual


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            values[key] = value.strip().strip('"').strip("'")
    return values


def _run(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 180) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "命令失败").strip().splitlines()[-1]
        raise RuntimeError(detail[:500])
    return result.stdout.strip()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent schema 恢复快照双启动演练")
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, default=Path("/opt/zhicui-runtime/releases"))
    parser.add_argument("--app-env-file", type=Path, default=Path("/opt/zhicui/backend/.env"))
    parser.add_argument("--database-url-file", type=Path, required=True)
    parser.add_argument("--snapshot-file", type=Path, required=True)
    parser.add_argument("--dark-evidence-file", type=Path, required=True)
    parser.add_argument(
        "--evidence-directory",
        type=Path,
        default=PRODUCTION_EVIDENCE_ROOT,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    started_at = _now()
    try:
        runtime = args.runtime.resolve(strict=True)
        runtime_root = args.runtime_root.resolve(strict=True)
        if runtime == runtime_root or runtime_root not in runtime.parents:
            raise ValueError("runtime 不在批准的不可变 release 根目录")
        backend = runtime / "backend"
        python = runtime / ".venv" / "bin" / "python"
        verifier = runtime / "deploy" / "verify-agent-schema.py"
        for required in (backend, python, verifier):
            if not required.exists():
                raise ValueError(f"runtime 缺少 {required.relative_to(runtime)}")

        url_file = args.database_url_file.resolve(strict=True)
        if os.name != "nt" and stat.S_IMODE(url_file.stat().st_mode) & 0o077:
            raise ValueError("database URL 文件必须为 0600，不得允许 group/other 读取")
        database_url = url_file.read_text(encoding="utf-8").strip()
        database_name = _database_name(database_url)

        snapshot_file = args.snapshot_file.resolve(strict=True)
        snapshot_info = snapshot_file.lstat()
        if not stat.S_ISREG(snapshot_info.st_mode) or stat.S_ISLNK(snapshot_info.st_mode):
            raise ValueError("snapshot 不是普通文件或是符号链接")
        if os.name != "nt" and snapshot_file.parent != PRODUCTION_BACKUP_ROOT:
            raise ValueError("snapshot 必须来自受控生产备份目录")
        if not re.fullmatch(r"zhicui-[A-Za-z0-9._-]+\.dump\.enc", snapshot_file.name):
            raise ValueError("snapshot artifact 名称格式无效")
        snapshot_metadata_file = snapshot_file.with_name(f"{snapshot_file.name}.json")
        snapshot_metadata_info = snapshot_metadata_file.lstat()
        if not stat.S_ISREG(snapshot_metadata_info.st_mode) or stat.S_ISLNK(snapshot_metadata_info.st_mode):
            raise ValueError("snapshot 元数据不存在、不是普通文件或是符号链接")
        snapshot_sha256 = _sha256(snapshot_file)
        snapshot_metadata_sha256 = _sha256(snapshot_metadata_file)
        snapshot_size = snapshot_file.stat().st_size
        snapshot_metadata = json.loads(snapshot_metadata_file.read_text(encoding="utf-8"))
        if not (
            isinstance(snapshot_metadata, dict)
            and snapshot_metadata.get("artifact") == snapshot_file.name
            and str(snapshot_metadata.get("sha256") or "").lower() == snapshot_sha256
            and int(snapshot_metadata.get("size_bytes", -1)) == snapshot_size
        ):
            raise ValueError("snapshot 元数据与真实归档字节不一致")

        commit = _run(
            ["git", "-C", str(runtime), "rev-parse", "HEAD"],
            cwd=runtime,
            env=os.environ.copy(),
        )
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("runtime 不能追溯到完整 Git SHA")

        dark_path = args.dark_evidence_file.resolve(strict=True)
        if os.name != "nt" and dark_path.parent != PRODUCTION_EVIDENCE_ROOT:
            raise ValueError("dark 证据必须来自 root-owned 生产证据仓")
        dark, dark_sha256 = _verified_evidence(dark_path)
        dark_backup = dark.get("backup")
        if not (
            dark.get("schema_version") == 2
            and dark.get("operation") == "production_deployment"
            and dark.get("status") == "succeeded"
            and dark.get("agent_release_mode") == "dark"
            and dark.get("target_commit") == commit
            and isinstance(dark_backup, dict)
            and dark_backup.get("artifact") == snapshot_file.name
            and dark_backup.get("sha256") == snapshot_sha256
            and int(dark_backup.get("size_bytes", -1)) == snapshot_size
            and dark_backup.get("metadata_sha256") == snapshot_metadata_sha256
        ):
            raise ValueError("dark 证据未绑定该提交与真实 snapshot SHA-256")

        app_env_file = args.app_env_file.resolve(strict=True)
        child_env = os.environ.copy()
        child_env.update(_read_env_file(app_env_file))
        child_env.update(
            {
                "DATABASE_URL": database_url,
                "AGENT_INTERFACE_ENABLED": "false",
                "DEV_AUTH_BYPASS": "false",
                "NEXT_PUBLIC_DEV_AUTH_AUTO": "false",
            }
        )
        snapshot_probe_code = """
import json
from sqlalchemy import inspect, text
from app.core.database import engine

inspector = inspect(engine)
required = {"users", "notes", "plans"}
missing = sorted(required - set(inspector.get_table_names()))
assert not missing, "恢复快照缺少基础表: " + ",".join(missing)
with engine.connect() as connection:
    counts = {
        name: connection.execute(text(f"SELECT count(*) FROM {name}")).scalar_one()
        for name in sorted(required)
    }
print(json.dumps(counts, sort_keys=True))
engine.dispose()
"""
        snapshot_probe = _run(
            [
                str(python),
                "-c",
                snapshot_probe_code,
            ],
            cwd=backend,
            env=child_env,
        )
        snapshot_counts = json.loads(snapshot_probe)

        schema_phase = (
            "from app.core.database import Base, engine; import app.main as main; "
            "Base.metadata.create_all(bind=engine); main._migrate_db(); engine.dispose()"
        )
        for _ in range(2):
            _run([str(python), "-c", schema_phase], cwd=backend, env=child_env)

        fingerprint = _run(
            [
                str(python),
                str(verifier),
                "--database-url-file",
                str(url_file),
                "--require-postgresql",
                "--output",
                "fingerprint",
            ],
            cwd=backend,
            env=child_env,
        )
        if not re.fullmatch(r"agent-schema-v1:[0-9a-f]{64}", fingerprint):
            raise RuntimeError("结构校验未返回有效版本化指纹")
        if dark.get("target_agent_schema_fingerprint") != fingerprint:
            raise RuntimeError("恢复快照结构指纹与 dark 证据不一致")

        finished_at = _now()
        payload = {
            "schema_version": 2,
            "operation": "agent_schema_restored_snapshot_rehearsal",
            "status": "succeeded",
            "started_at": started_at,
            "finished_at": finished_at,
            "target_commit": commit,
            "snapshot": {
                "artifact": snapshot_file.name,
                "sha256": snapshot_sha256,
                "size_bytes": snapshot_size,
                "metadata_sha256": snapshot_metadata_sha256,
            },
            "predecessor": {
                "name": dark_path.name,
                "sha256": dark_sha256,
            },
            "isolated_database": database_name,
            "snapshot_counts": snapshot_counts,
            "schema_startup_passes": 2,
            "agent_schema_fingerprint": fingerprint,
            "workers_started": False,
        }
        evidence_directory = args.evidence_directory.absolute()
        if os.name != "nt":
            if os.geteuid() != 0:
                raise ValueError("生产演练证据必须用 sudo 写入 root-owned 证据仓")
            if evidence_directory.resolve(strict=True) != PRODUCTION_EVIDENCE_ROOT:
                raise ValueError("演练证据必须写入固定生产证据仓")
            parent_info = evidence_directory.lstat()
            if parent_info.st_uid != 0 or stat.S_IMODE(parent_info.st_mode) != 0o700:
                raise ValueError("生产证据仓必须 root:root 0700")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        evidence = evidence_directory / f"agent-schema-rehearsal-{stamp}-{commit[:12]}.json"
        encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        evidence_sha256 = hashlib.sha256(encoded).hexdigest()
        sidecar = evidence.with_name(f"{evidence.name}.sha256")
        if evidence.exists() or sidecar.exists():
            raise ValueError("同一提交的演练证据名已存在；拒绝覆盖不可变证据")
        temporary_paths: list[Path] = []
        try:
            for destination, body in (
                (evidence, encoded),
                (sidecar, f"{evidence_sha256}  {evidence.name}\n".encode("ascii")),
            ):
                fd, raw_path = tempfile.mkstemp(
                    prefix=f".{destination.name}.tmp-", dir=evidence_directory
                )
                temporary = Path(raw_path)
                temporary_paths.append(temporary)
                try:
                    if hasattr(os, "fchmod"):
                        os.fchmod(fd, 0o600)
                except Exception:
                    os.close(fd)
                    raise
                with os.fdopen(fd, "wb", closefd=True) as handle:
                    handle.write(body)
                    handle.flush()
                    os.fsync(handle.fileno())
                if not hasattr(os, "fchmod"):
                    os.chmod(temporary, 0o600)
            os.replace(temporary_paths[1], sidecar)
            temporary_paths.pop(1)
            os.replace(temporary_paths[0], evidence)
            temporary_paths.pop(0)
            if os.name == "posix":
                directory_fd = os.open(
                    evidence_directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                )
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            for temporary in temporary_paths:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
        print(str(evidence))
        return 0
    except Exception as exc:
        print(f"Agent schema 恢复快照演练失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
