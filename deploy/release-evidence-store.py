#!/usr/bin/env python3
"""Root-owned Stable release evidence store and verifier.

The deployment user may submit evidence through the fixed sudo commands below,
but it cannot read or rewrite the evidence directory.  Every stored JSON object
is canonicalized, atomically installed as mode 0600 and accompanied by a
detached SHA-256 file.  Stable verification re-hashes every referenced file and
the encrypted PostgreSQL archive instead of trusting JSON labels.
"""

from __future__ import annotations

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
from typing import Any


EVIDENCE_ROOT = Path("/var/lib/zhicui-deployments")
BACKUP_ROOT = Path("/var/backups/zhicui")
BACKUP_STATUS_FILE = Path("/var/lib/zhicui-backups/latest.json")
RUNTIME_RELEASE_ROOT = Path("/opt/zhicui-runtime/releases")
RUNTIME_CURRENT = Path("/opt/zhicui-runtime/current")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
FINGERPRINT_RE = re.compile(r"agent-schema-v1:[0-9a-f]{64}")
SAFE_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json")
BACKUP_NAME_RE = re.compile(r"zhicui-[A-Za-z0-9._-]+\.dump\.enc")
REHEARSAL_NAME_RE = re.compile(
    r"agent-schema-rehearsal-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.json"
)


class EvidenceError(RuntimeError):
    pass


def _timestamp(value: object, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{label} 不是有效时间") from exc
    if parsed.tzinfo is None:
        raise EvidenceError(f"{label} 必须包含时区")
    return parsed.astimezone(timezone.utc)


def _runtime_commit() -> str:
    if not RUNTIME_CURRENT.is_symlink():
        raise EvidenceError("runtime/current 不是受控符号链接")
    runtime = RUNTIME_CURRENT.resolve(strict=True)
    release_root = RUNTIME_RELEASE_ROOT.resolve(strict=True)
    if runtime == release_root or release_root not in runtime.parents or not runtime.is_dir():
        raise EvidenceError("runtime/current 指向批准 release 根目录之外")
    try:
        result = subprocess.run(
            [
                "/usr/bin/git",
                "-c",
                "safe.directory=*",
                "-C",
                str(runtime),
                "rev-parse",
                "--verify",
                "HEAD^{commit}",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
            env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EvidenceError(f"无法读取当前 runtime Git 提交：{exc}") from exc
    commit = result.stdout.strip().lower()
    if result.returncode != 0 or not COMMIT_RE.fullmatch(commit):
        raise EvidenceError("当前 runtime 不能追溯到完整 Git 提交")
    return commit


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"证据不可读：{path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise EvidenceError(f"证据不是 JSON object：{path.name}")
    return value


def _stdin_json() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"stdin JSON 无效：{exc}") from exc
    if not isinstance(value, dict):
        raise EvidenceError("stdin 必须是 JSON object")
    return value


def _assert_root_dir(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise EvidenceError(f"证据目录不是普通目录：{path}")
    if os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
        raise EvidenceError(f"证据目录必须 root:root 0700：{path}")


def _assert_root_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise EvidenceError(f"证据不是普通文件：{path.name}")
    if os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
        raise EvidenceError(f"证据必须 root-owned 0600：{path.name}")


def _safe_evidence_path(name: str) -> Path:
    if not SAFE_NAME_RE.fullmatch(name):
        raise EvidenceError("证据文件名格式无效")
    path = EVIDENCE_ROOT / name
    if path.parent != EVIDENCE_ROOT:
        raise EvidenceError("证据路径越界")
    return path


def _sidecar_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.sha256")


def _load_verified(name: str, expected_sha256: str | None = None) -> tuple[dict[str, Any], str]:
    path = _safe_evidence_path(name)
    sidecar = _sidecar_path(path)
    _assert_root_file(path)
    _assert_root_file(sidecar)
    line = sidecar.read_text(encoding="ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json)", line)
    if not match or match.group(2) != path.name:
        raise EvidenceError(f"证据 SHA-256 sidecar 无效：{path.name}")
    actual = _sha256(path)
    if actual != match.group(1):
        raise EvidenceError(f"证据实际 SHA-256 不匹配：{path.name}")
    if expected_sha256 is not None and actual != expected_sha256:
        raise EvidenceError(f"证据与前序 SHA-256 引用不匹配：{path.name}")
    return _read_json(path), actual


def _atomic_store(name: str, payload: dict[str, Any], *, replace: bool = False) -> tuple[str, str]:
    _assert_root_dir(EVIDENCE_ROOT)
    target = _safe_evidence_path(name)
    sidecar = _sidecar_path(target)
    if not replace and (target.exists() or sidecar.exists()):
        raise EvidenceError(f"拒绝覆盖既有不可变证据：{name}")
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    temporary_paths: list[Path] = []
    try:
        for destination, body in (
            (target, encoded),
            (sidecar, f"{digest}  {name}\n".encode("ascii")),
        ):
            fd, raw_path = tempfile.mkstemp(prefix=f".{destination.name}.tmp-", dir=EVIDENCE_ROOT)
            temp = Path(raw_path)
            temporary_paths.append(temp)
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
                os.chmod(temp, 0o600)
        # The JSON is the commit point.  A reader can never observe a new JSON
        # without its matching sidecar already present.
        os.replace(temporary_paths[1], sidecar)
        temporary_paths.pop(1)
        os.replace(temporary_paths[0], target)
        temporary_paths.pop(0)
        if os.name == "posix":
            directory_fd = os.open(EVIDENCE_ROOT, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
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
    return name, digest


def _safe_backup_path(artifact: str) -> Path:
    if not BACKUP_NAME_RE.fullmatch(artifact):
        raise EvidenceError("备份归档名格式无效")
    path = BACKUP_ROOT / artifact
    if path.parent != BACKUP_ROOT:
        raise EvidenceError("备份路径越界")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise EvidenceError("备份归档不存在、不是普通文件或是符号链接")
    return path


def _verify_backup(reference: dict[str, Any]) -> dict[str, Any]:
    artifact = str(reference.get("artifact") or "")
    expected_sha = str(reference.get("sha256") or "").lower()
    expected_metadata_sha = str(reference.get("metadata_sha256") or "").lower()
    try:
        expected_size = int(reference.get("size_bytes"))
    except (TypeError, ValueError) as exc:
        raise EvidenceError("备份 size_bytes 无效") from exc
    if not SHA256_RE.fullmatch(expected_sha) or not SHA256_RE.fullmatch(expected_metadata_sha):
        raise EvidenceError("备份或元数据 SHA-256 无效")
    archive = _safe_backup_path(artifact)
    metadata_path = archive.with_name(f"{archive.name}.json")
    metadata_info = metadata_path.lstat()
    if not stat.S_ISREG(metadata_info.st_mode) or stat.S_ISLNK(metadata_info.st_mode):
        raise EvidenceError("备份元数据不存在、不是普通文件或是符号链接")
    actual_sha = _sha256(archive)
    actual_size = archive.stat().st_size
    actual_metadata_sha = _sha256(metadata_path)
    if (actual_sha, actual_size, actual_metadata_sha) != (
        expected_sha,
        expected_size,
        expected_metadata_sha,
    ):
        raise EvidenceError("备份真实字节、大小或元数据 SHA-256 与证据不一致")
    metadata = _read_json(metadata_path)
    if (
        metadata.get("artifact") != artifact
        or str(metadata.get("sha256") or "").lower() != actual_sha
        or int(metadata.get("size_bytes", -1)) != actual_size
    ):
        raise EvidenceError("备份元数据内容与真实归档不一致")
    return {
        "artifact": artifact,
        "sha256": actual_sha,
        "size_bytes": actual_size,
        "metadata_sha256": actual_metadata_sha,
    }


def _gate_map(payload: dict[str, Any]) -> dict[str, str]:
    return {
        str(item.get("name")): str(item.get("status"))
        for item in payload.get("gates", [])
        if isinstance(item, dict)
    }


def _validate_smoke(
    payload: dict[str, Any], *, deploy_id: str, commit: str
) -> tuple[datetime, datetime]:
    if not (
        payload.get("schema_version") == 2
        and payload.get("operation") == "production_smoke"
        and payload.get("status") == "passed"
        and payload.get("deployment_id") == deploy_id
        and payload.get("target_commit") == commit
        and payload.get("base_url") == "https://luxai.cn"
    ):
        raise EvidenceError("公网 smoke 证据未绑定部署、提交或正式域名")
    started = _timestamp(payload.get("started_at"), "smoke started_at")
    finished = _timestamp(payload.get("finished_at"), "smoke finished_at")
    if finished < started:
        raise EvidenceError("smoke 完成时间早于开始时间")
    return started, finished


def _validate_deployment(payload: dict[str, Any], *, successful_only: bool) -> None:
    deploy_id = str(payload.get("deployment_id") or "")
    commit = str(payload.get("target_commit") or "")
    mode = str(payload.get("agent_release_mode") or "")
    if payload.get("schema_version") != 2 or payload.get("operation") != "production_deployment":
        raise EvidenceError("部署证据 schema/operation 无效")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", deploy_id):
        raise EvidenceError("部署 evidence id 无效")
    started = _timestamp(payload.get("started_at"), "deployment started_at")
    finished = _timestamp(payload.get("finished_at"), "deployment finished_at")
    if finished < started:
        raise EvidenceError("部署完成时间早于开始时间")
    if payload.get("status") != "succeeded":
        if successful_only:
            raise EvidenceError("部署证据不是成功状态")
        return
    if mode not in {"dark", "stable"} or not COMMIT_RE.fullmatch(commit):
        raise EvidenceError("成功部署缺少固定模式或完整提交")
    if not FINGERPRINT_RE.fullmatch(str(payload.get("target_agent_schema_fingerprint") or "")):
        raise EvidenceError("成功部署缺少真实版本化 Agent schema 指纹")
    _verify_backup(payload.get("backup") if isinstance(payload.get("backup"), dict) else {})
    smoke_ref = payload.get("smoke_evidence")
    if not isinstance(smoke_ref, dict):
        raise EvidenceError("成功部署缺少 smoke 证据引用")
    smoke_name = str(smoke_ref.get("name") or "")
    smoke_sha = str(smoke_ref.get("sha256") or "")
    if not SHA256_RE.fullmatch(smoke_sha):
        raise EvidenceError("smoke 证据 SHA-256 无效")
    smoke, _ = _load_verified(smoke_name, smoke_sha)
    smoke_started, smoke_finished = _validate_smoke(smoke, deploy_id=deploy_id, commit=commit)
    if smoke_started < started or smoke_finished > finished:
        raise EvidenceError("smoke 时间不在本次部署证据窗口内")
    required = {
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
    }
    if mode == "stable":
        required.add("agent_schema_rehearsal")
    gates = _gate_map(payload)
    if not all(gates.get(name) == "pass" for name in required):
        raise EvidenceError("部署证据缺少成功的 Stable 必需门禁")
    if mode == "stable":
        dark_ref = payload.get("dark_evidence")
        rehearsal_ref = payload.get("rehearsal_evidence")
        for field, reference in (("dark_evidence", dark_ref), ("rehearsal_evidence", rehearsal_ref)):
            if not isinstance(reference, dict) or not SHA256_RE.fullmatch(str(reference.get("sha256") or "")):
                raise EvidenceError(f"Stable 部署缺少 {field} 哈希引用")
        assert isinstance(dark_ref, dict) and isinstance(rehearsal_ref, dict)
        dark_name = str(dark_ref.get("name") or "")
        dark_sha = str(dark_ref.get("sha256") or "")
        dark, _ = _load_verified(dark_name, dark_sha)
        _validate_deployment(dark, successful_only=True)
        if not (
            dark.get("agent_release_mode") == "dark"
            and dark.get("target_commit") == commit
            and dark.get("target_agent_schema_fingerprint")
            == payload.get("previous_agent_schema_fingerprint")
            == payload.get("target_agent_schema_fingerprint")
        ):
            raise EvidenceError("Stable 的 dark 前序证据未绑定同一提交与结构指纹")
        rehearsal_result = _verify_rehearsal(
            {
                "expected_commit": commit,
                "expected_fingerprint": str(payload.get("target_agent_schema_fingerprint") or ""),
                "dark_evidence_name": dark_name,
                "dark_evidence_sha256": dark_sha,
                "rehearsal_evidence_name": str(rehearsal_ref.get("name") or ""),
                "rehearsal_evidence_sha256": str(rehearsal_ref.get("sha256") or ""),
            }
        )
        if rehearsal_result != {
            "name": str(rehearsal_ref.get("name") or ""),
            "sha256": str(rehearsal_ref.get("sha256") or ""),
        }:
            raise EvidenceError("Stable 的 rehearsal 前序证据名称或 SHA-256 不一致")
        rehearsal, _ = _load_verified(rehearsal_result["name"], rehearsal_result["sha256"])
        if _timestamp(rehearsal.get("finished_at"), "rehearsal finished_at") > started:
            raise EvidenceError("Stable 部署开始早于恢复快照演练完成")


def _verify_latest_backup() -> dict[str, Any]:
    status_info = BACKUP_STATUS_FILE.lstat()
    if not stat.S_ISREG(status_info.st_mode) or stat.S_ISLNK(status_info.st_mode):
        raise EvidenceError("最新备份状态不是普通文件或是符号链接")
    if os.name == "posix" and stat.S_IMODE(status_info.st_mode) & 0o022:
        raise EvidenceError("最新备份状态不得由 group/other 写入")
    status = _read_json(BACKUP_STATUS_FILE)
    if not (
        status.get("schema_version") == 1
        and status.get("status") == "ok"
        and status.get("checksum_verified") is True
        and status.get("restore_verified") is True
    ):
        raise EvidenceError("最新备份状态未完成校验与隔离恢复")
    archive = _safe_backup_path(str(status.get("artifact") or ""))
    metadata_path = archive.with_name(f"{archive.name}.json")
    reference = {
        "artifact": archive.name,
        "sha256": _sha256(archive),
        "size_bytes": archive.stat().st_size,
        "metadata_sha256": _sha256(metadata_path),
        "status_evidence_sha256": _sha256(BACKUP_STATUS_FILE),
    }
    if (
        str(status.get("sha256") or "").lower() != reference["sha256"]
        or int(status.get("size_bytes", -1)) != reference["size_bytes"]
    ):
        raise EvidenceError("最新备份状态字符串与真实归档字节不一致")
    _verify_backup(reference)
    return reference


def _find_dark(request: dict[str, Any]) -> dict[str, Any]:
    expected_commit = str(request.get("expected_commit") or "")
    expected_fingerprint = str(request.get("expected_fingerprint") or "")
    if not COMMIT_RE.fullmatch(expected_commit) or not FINGERPRINT_RE.fullmatch(expected_fingerprint):
        raise EvidenceError("Stable dark 查询缺少完整提交或 schema 指纹")
    candidates = sorted(
        (path for path in EVIDENCE_ROOT.glob("*.json") if not REHEARSAL_NAME_RE.fullmatch(path.name)),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for path in candidates:
        try:
            payload, digest = _load_verified(path.name)
            _validate_deployment(payload, successful_only=True)
        except (EvidenceError, OSError, ValueError):
            continue
        if (
            payload.get("agent_release_mode") == "dark"
            and payload.get("target_commit") == expected_commit
            and payload.get("target_agent_schema_fingerprint") == expected_fingerprint
        ):
            return {
                "name": path.name,
                "sha256": digest,
                "backup": _verify_backup(payload["backup"]),
                "finished_at": payload.get("finished_at"),
            }
    raise EvidenceError("没有找到真实哈希、提交、备份与 smoke 链均通过的 dark 证据")


def _verify_one_rehearsal(
    *,
    name: str,
    expected_sha256: str | None,
    expected_commit: str,
    expected_fingerprint: str,
    dark_name: str,
    dark_sha: str,
) -> dict[str, str]:
    if not REHEARSAL_NAME_RE.fullmatch(name):
        raise EvidenceError("rehearsal 证据文件名无效")
    if not name.endswith(f"-{expected_commit[:12]}.json"):
        raise EvidenceError("rehearsal 文件名未绑定目标提交前缀")
    dark, _ = _load_verified(dark_name, dark_sha)
    _validate_deployment(dark, successful_only=True)
    if not (
        dark.get("agent_release_mode") == "dark"
        and dark.get("target_commit") == expected_commit
        and dark.get("target_agent_schema_fingerprint") == expected_fingerprint
    ):
        raise EvidenceError("rehearsal 引用的前序证据不是同提交、同结构的 dark 部署")
    rehearsal, rehearsal_sha = _load_verified(name, expected_sha256)
    snapshot = rehearsal.get("snapshot")
    predecessor = rehearsal.get("predecessor")
    counts = rehearsal.get("snapshot_counts")
    if not (
        rehearsal.get("schema_version") == 2
        and rehearsal.get("operation") == "agent_schema_restored_snapshot_rehearsal"
        and rehearsal.get("status") == "succeeded"
        and rehearsal.get("target_commit") == expected_commit
        and rehearsal.get("agent_schema_fingerprint") == expected_fingerprint
        and rehearsal.get("schema_startup_passes") == 2
        and rehearsal.get("workers_started") is False
        and isinstance(snapshot, dict)
        and isinstance(predecessor, dict)
        and predecessor.get("name") == dark_name
        and predecessor.get("sha256") == dark_sha
        and isinstance(counts, dict)
        and set(counts) == {"users", "notes", "plans"}
        and all(isinstance(value, int) and value >= 0 for value in counts.values())
        and counts.get("users", 0) > 0
        and re.fullmatch(
            r"zhicui_(?:restore_verify|agent_rehearsal)_[A-Za-z0-9._-]+",
            str(rehearsal.get("isolated_database") or ""),
        )
    ):
        raise EvidenceError("恢复快照演练没有绑定真实 dark 前序证据、提交或结构")
    dark_finished = _timestamp(dark.get("finished_at"), "dark finished_at")
    rehearsal_started = _timestamp(rehearsal.get("started_at"), "rehearsal started_at")
    rehearsal_finished = _timestamp(rehearsal.get("finished_at"), "rehearsal finished_at")
    if rehearsal_started < dark_finished or rehearsal_finished < rehearsal_started:
        raise EvidenceError("恢复快照演练时间早于 dark 前序证据或顺序无效")
    verified_snapshot = _verify_backup(snapshot)
    dark_backup = _verify_backup(dark["backup"])
    if verified_snapshot != dark_backup:
        raise EvidenceError("演练归档真实 SHA-256 与 dark 备份不一致")
    return {"name": name, "sha256": rehearsal_sha}


def _verify_rehearsal(request: dict[str, Any]) -> dict[str, Any]:
    expected_commit = str(request.get("expected_commit") or "")
    expected_fingerprint = str(request.get("expected_fingerprint") or "")
    dark_name = str(request.get("dark_evidence_name") or "")
    dark_sha = str(request.get("dark_evidence_sha256") or "")
    requested_name = str(request.get("rehearsal_evidence_name") or "")
    requested_sha = str(request.get("rehearsal_evidence_sha256") or "")
    if not COMMIT_RE.fullmatch(expected_commit) or not FINGERPRINT_RE.fullmatch(expected_fingerprint):
        raise EvidenceError("演练校验缺少完整提交或 schema 指纹")
    if not SHA256_RE.fullmatch(dark_sha):
        raise EvidenceError("演练校验缺少真实 dark SHA-256")
    if requested_name or requested_sha:
        if not requested_name or not SHA256_RE.fullmatch(requested_sha):
            raise EvidenceError("Stable 引用的 rehearsal 名称或 SHA-256 无效")
        return _verify_one_rehearsal(
            name=requested_name,
            expected_sha256=requested_sha,
            expected_commit=expected_commit,
            expected_fingerprint=expected_fingerprint,
            dark_name=dark_name,
            dark_sha=dark_sha,
        )

    candidates = sorted(
        (
            path
            for path in EVIDENCE_ROOT.glob("agent-schema-rehearsal-*.json")
            if REHEARSAL_NAME_RE.fullmatch(path.name)
        ),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for candidate in candidates:
        try:
            return _verify_one_rehearsal(
                name=candidate.name,
                expected_sha256=None,
                expected_commit=expected_commit,
                expected_fingerprint=expected_fingerprint,
                dark_name=dark_name,
                dark_sha=dark_sha,
            )
        except (EvidenceError, OSError, ValueError):
            continue
    raise EvidenceError("没有找到同提交、同 dark SHA 与同真实备份的不可变 rehearsal 证据")


def _store_smoke(payload: dict[str, Any]) -> dict[str, str]:
    deploy_id = str(payload.get("deployment_id") or "")
    commit = str(payload.get("target_commit") or "")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", deploy_id) or not COMMIT_RE.fullmatch(commit):
        raise EvidenceError("smoke 证据缺少固定部署 ID 或提交")
    if payload.get("schema_version") != 2 or payload.get("operation") != "production_smoke":
        raise EvidenceError("smoke 证据 schema/operation 无效")
    _validate_smoke(payload, deploy_id=deploy_id, commit=commit)
    if _runtime_commit() != commit:
        raise EvidenceError("smoke 证据提交与当前真实 runtime Git 提交不一致")
    name, digest = _atomic_store(f"{deploy_id}-smoke.json", payload)
    return {"name": name, "sha256": digest}


def _store_deployment(payload: dict[str, Any]) -> dict[str, str]:
    _validate_deployment(payload, successful_only=False)
    if payload.get("status") == "succeeded":
        if _runtime_commit() != payload.get("target_commit"):
            raise EvidenceError("成功部署证据提交与当前真实 runtime Git 提交不一致")
        latest_backup = _verify_latest_backup()
        backup = payload.get("backup") if isinstance(payload.get("backup"), dict) else {}
        if any(backup.get(field) != latest_backup[field] for field in latest_backup):
            raise EvidenceError("成功部署证据未绑定当前恢复验证状态及真实备份 SHA-256")
    name, digest = _atomic_store(f"{payload['deployment_id']}.json", payload)
    return {"name": name, "sha256": digest}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if os.name != "posix" or os.geteuid() != 0:
        raise EvidenceError("release evidence helper 必须由 root 在 Linux 上运行")
    if len(args) != 1:
        raise EvidenceError("用法：release-evidence-store.py <status|verify-backup|store-smoke|store-deployment|verify-dark|verify-rehearsal>")
    command = args[0]
    _assert_root_dir(EVIDENCE_ROOT)
    if command == "status":
        result: dict[str, Any] = {"status": "ready", "mode": "root-owned-0600-sha256"}
    elif command == "verify-backup":
        result = _verify_latest_backup()
    elif command == "store-smoke":
        result = _store_smoke(_stdin_json())
    elif command == "store-deployment":
        result = _store_deployment(_stdin_json())
    elif command == "verify-dark":
        result = _find_dark(_stdin_json())
    elif command == "verify-rehearsal":
        result = _verify_rehearsal(_stdin_json())
    else:
        raise EvidenceError("未知 release evidence helper 命令")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EvidenceError as exc:
        print(f"release evidence 校验失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
