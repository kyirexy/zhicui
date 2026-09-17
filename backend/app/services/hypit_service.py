"""hypit CLI 的 subprocess 封装(「创作工坊」服务器渲染)。

每个 job 在 HYPIT_PROJECT_ROOT 下有独立项目目录(main.svml / render.svrun,
.hypit 由 CLI 自行生成)。所有命令都带 --json 并按有界时限执行:模板沿用
creator_connectors 的 Popen + 短轮询 communicate + deadline + kill,保证
悬挂的渲染进程永远不会拖住 worker 线程。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from app.core.config import settings

SVML_FILENAME = "main.svml"
SVRUN_FILENAME = "render.svrun"
OUTPUT_NAME = "final.video"

SVRUN_TEMPLATE = """<?svml using="@hypit/run-markup@1"?>

<svrun version="1">
  <author source="./{svml}"/>
  <target output="{output}"/>
</svrun>
"""


class HypitError(Exception):
    """面向调用方的渲染失败;message 可直接展示给用户。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _cli_path() -> str:
    resolved = shutil.which(settings.HYPIT_CLI_PATH)
    if not resolved:
        raise HypitError(
            "hypit_unavailable",
            "服务器尚未安装 hypit 命令行工具,创作工坊暂时不可用",
        )
    return resolved


# HypiHub 生成凭据:管理员在系统设置里配置(Fernet 加密存 system_settings),
# 以环境变量传给 hypit 子进程(credential store env 按 key 名解析)。
# 缓存 5 分钟:避免每次渲染命令都查库;管理员改密钥后最多 5 分钟生效。
HYPIHUB_KEY_SETTING = "hypihub_api_key"
HYPIHUB_KEY_ENV = "HYPIHUB_API_KEY"
_credential_cache: tuple[str, float] = ("", 0.0)
_CREDENTIAL_TTL_SECONDS = 300.0


def _credential_env() -> dict[str, str]:
    global _credential_cache
    now = time.monotonic()
    cached_secret, cached_at = _credential_cache
    if now - cached_at > _CREDENTIAL_TTL_SECONDS:
        cached_secret = ""
        try:
            from app.core.database import SessionLocal
            from app.services import settings_service

            with SessionLocal() as db:
                cached_secret = settings_service.get_secret(db, HYPIHUB_KEY_SETTING)
        except Exception:  # noqa: BLE001 - 凭据缺失不应阻塞渲染命令
            cached_secret = ""
        _credential_cache = (cached_secret, now)
    return {HYPIHUB_KEY_ENV: cached_secret} if cached_secret else {}


def project_root() -> Path:
    return Path(settings.HYPIT_PROJECT_ROOT)


def job_dir(job_id: str) -> Path:
    return project_root() / job_id


def write_project(job_id: str, *, svml_text: str, svrun_text: str | None = None) -> Path:
    """把 job 的源文件写入项目目录并返回目录路径。"""
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / SVML_FILENAME).write_text(svml_text, encoding="utf-8")
    if svrun_text is None:
        svrun_text = SVRUN_TEMPLATE.format(svml=SVML_FILENAME, output=OUTPUT_NAME)
    (directory / SVRUN_FILENAME).write_text(svrun_text, encoding="utf-8")
    return directory


def _extract_json(stdout: str) -> dict[str, Any] | None:
    """尽力从 stdout 提取一个 JSON 对象(CLI 可能输出进度行)。"""
    text = stdout.strip()
    if not text:
        return None
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    start = text.find("{")
    if start < 0:
        return None
    try:
        value = json.loads(text[start:])
        return value if isinstance(value, dict) else None
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def _run_command(
    args: list[str],
    *,
    cwd: Path,
    timeout_s: float,
    env_extra: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    """运行 hypit 子进程;到期先 terminate 再 kill,绝不悬挂。"""
    env = os.environ.copy()
    env.update(_credential_env())
    if env_extra:
        env.update(env_extra)
    try:
        process = subprocess.Popen(
            args,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
    except OSError as exc:
        raise HypitError("hypit_unavailable", f"无法启动 hypit 命令:{exc}") from exc

    deadline = time.monotonic() + timeout_s
    stdout = ""
    stderr = ""
    try:
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except (subprocess.TimeoutExpired, OSError):
                        process.kill()
                    raise HypitError(
                        "hypit_timeout", "hypit 命令执行超时,请稍后重试或缩小创作规模"
                    ) from None
    finally:
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=3)
            except (subprocess.TimeoutExpired, OSError):
                process.kill()
    return process.returncode, stdout, stderr


def _run_json(
    args: list[str],
    *,
    cwd: Path,
    timeout_s: float,
    error_prefix: str,
) -> dict[str, Any]:
    code, stdout, stderr = _run_command(args, cwd=cwd, timeout_s=timeout_s)
    payload = _extract_json(stdout)
    if code != 0:
        detail = _error_detail(payload, stderr)
        raise HypitError("hypit_command_failed", f"{error_prefix}:{detail}")
    if payload is None:
        raise HypitError(
            "hypit_command_failed", f"{error_prefix}:hypit 未返回可解析的结果"
        )
    return payload


def _error_detail(payload: dict[str, Any] | None, stderr: str) -> str:
    if payload:
        for key in ("message", "error", "failure", "detail"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:400]
    text = (stderr or "").strip()
    return text[:400] if text else "未知错误"


def _workspace_args(directory: Path) -> list[str]:
    return ["--workspace", str(directory)]


def check_source(directory: Path, *, svml_filename: str = SVML_FILENAME) -> dict[str, Any]:
    """语法预检;失败时抛出带具体原因的 HypitError。"""
    return _run_json(
        [_cli_path(), "check", svml_filename, "--json", *_workspace_args(directory)],
        cwd=directory,
        timeout_s=120,
        error_prefix="SVML 预检未通过",
    )


def price_project(directory: Path) -> dict[str, Any]:
    """对 SVRUN 估价;返回 hypit 的 pricing JSON(结构由 CLI 决定)。"""
    return _run_json(
        [_cli_path(), "pricing", SVRUN_FILENAME, "--json", *_workspace_args(directory)],
        cwd=directory,
        timeout_s=300,
        error_prefix="估价失败",
    )


def submit_build(directory: Path) -> str:
    """提交渲染并返回 build id。"""
    payload = _run_json(
        [
            _cli_path(), "build", SVRUN_FILENAME,
            "--json", "--follow", "--max-wait-ms", "15000",
            *_workspace_args(directory),
        ],
        cwd=directory,
        timeout_s=90,
        error_prefix="渲染提交失败",
    )
    build_id = _find_build_id(payload)
    if not build_id:
        raise HypitError("hypit_command_failed", "渲染提交失败:结果中缺少 build id")
    return build_id


def _find_build_id(payload: dict[str, Any]) -> str:
    for key in ("id", "buildId", "build_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.startswith("bld_"):
            return value
    for nested_key in ("build", "result", "summary"):
        nested = payload.get(nested_key)
        if isinstance(nested, dict):
            found = _find_build_id(nested)
            if found:
                return found
    return ""


TERMINAL_RESULT_STATES = {"complete", "failed", "cancelled"}


def poll_status(directory: Path, build_id: str, *, max_wait_ms: int = 15000) -> dict[str, Any]:
    """跟随一次 build 状态(最多 max_wait_ms),返回 status JSON。

    调用方根据 result.state 判断:complete/failed/cancelled 为终态,其余继续轮询。
    """
    return _run_json(
        [
            _cli_path(), "status", build_id,
            "--json", "--watch", "--max-wait-ms", str(max_wait_ms),
            *_workspace_args(directory),
        ],
        cwd=directory,
        timeout_s=max_wait_ms / 1000 + 60,
        error_prefix="渲染状态查询失败",
    )


def status_result_state(payload: dict[str, Any]) -> str:
    result = payload.get("result")
    if isinstance(result, dict):
        state = result.get("state")
        if isinstance(state, str):
            return state
    return "unknown"


def status_failure(payload: dict[str, Any]) -> str:
    """从 status JSON 提取失败原因;优先具体原因,再退到粗粒度字段。"""
    result = payload.get("result")
    candidates: list[Any] = []
    if isinstance(result, dict):
        candidates.append(result.get("failure"))
    candidates.append(payload.get("failure"))
    attention = payload.get("attention")
    if isinstance(attention, dict):
        candidates.append(attention.get("message"))
    work = payload.get("work")
    if isinstance(work, dict):
        candidates.append(work.get("outcome"))
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()[:400]
    return "渲染失败,原因未知"


def export_result(directory: Path, build_id: str, destination: Path) -> Path:
    """把最终 MP4 从 .hypit 结果目录导出到 destination(必须不存在)。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    _run_json(
        [
            _cli_path(), "get", build_id,
            "--output", OUTPUT_NAME, "--to", str(destination),
            "--json", *_workspace_args(directory),
        ],
        cwd=directory,
        timeout_s=300,
        error_prefix="成品导出失败",
    )
    if not destination.is_file():
        raise HypitError("hypit_command_failed", "成品导出失败:目标文件未生成")
    return destination


def fetch_logs(directory: Path, build_id: str, *, lines: int = 200) -> str:
    """尽力拉取渲染日志用于失败诊断;失败时返回空串,不抛错。"""
    try:
        code, stdout, _ = _run_command(
            [
                _cli_path(), "logs", build_id,
                "--json", "--lines", str(lines), *_workspace_args(directory),
            ],
            cwd=directory,
            timeout_s=60,
        )
    except HypitError:
        return ""
    payload = _extract_json(stdout) if code == 0 else None
    if payload:
        for key in ("logs", "lines", "text"):
            value = payload.get(key)
            if isinstance(value, list):
                return "\n".join(str(item) for item in value)[-4000:]
            if isinstance(value, str):
                return value[-4000:]
    return (stdout or "")[-4000:]


def cancel_build(directory: Path, build_id: str) -> None:
    """尽力取消渲染;失败不抛错(任务可能已经结束)。"""
    try:
        _run_json(
            [
                _cli_path(), "cancel", build_id,
                "--json", *_workspace_args(directory),
            ],
            cwd=directory,
            timeout_s=60,
            error_prefix="取消渲染失败",
        )
    except HypitError:
        return


def remove_project(job_id: str) -> None:
    """删除整个 job 项目目录(含 .hypit 产物);尽力而为。"""
    directory = job_dir(job_id)
    if directory.exists():
        shutil.rmtree(directory, ignore_errors=True)


def directory_size(path: Path) -> int:
    """递归统计目录字节数;目录不存在返回 0(配额守护用)。"""
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return total


def cli_available() -> bool:
    try:
        _cli_path()
    except HypitError:
        return False
    return True


def _self_check() -> int:  # pragma: no cover - 手动诊断入口
    """python -m app.services.hypit_service:打印 CLI 可用性。"""
    print("hypit cli:", _cli_path() if cli_available() else "NOT FOUND")
    print("python:", sys.version.split()[0])
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_self_check())
