"""验证生产锁安装后的后端运行时，不访问外部服务或业务数据。"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
from importlib.metadata import version
from pathlib import Path
from typing import Any, Iterable

from dotenv import dotenv_values


# 生产部署验证必须完全离线，避免 LiteLLM 导入时探测远端价格表。
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")


REQUIRED_IMPORTS = {
    "fastapi": "fastapi",
    "sqlalchemy": "sqlalchemy",
    "litellm": "litellm",
    "requests": "requests",
    "bs4": "beautifulsoup4",
    "pydantic": "pydantic",
    "jwt": "PyJWT",
    "cryptography": "cryptography",
    "cv2": "opencv-python-headless",
    "bilibili_api": "bilibili-api-python",
    "yt_dlp": "yt-dlp",
    "psycopg2": "psycopg2-binary",
}

FORBIDDEN_HEAVY_IMPORTS = ("funasr", "torch", "torchaudio", "modelscope")


def load_runtime_environment(env_file: str) -> None:
    """加载 systemd 使用的同一份环境配置，且不把任何值写入日志。"""

    path = Path(env_file)
    if not path.is_absolute() or not path.is_file():
        raise RuntimeError("生产运行时环境文件不存在或不是绝对路径")
    values = dotenv_values(path, interpolate=False)
    if not values:
        raise RuntimeError("生产运行时环境文件为空或无法解析")
    for key, value in values.items():
        if key and value is not None:
            os.environ[key] = value


def iter_route_paths(router: Any) -> Iterable[str]:
    """展开 FastAPI 新旧版本中的普通路由与延迟包含路由。"""

    pending = list(getattr(router, "routes", ()) or ())
    visited: set[int] = set()
    while pending:
        route = pending.pop()
        identity = id(route)
        if identity in visited:
            continue
        visited.add(identity)

        path = getattr(route, "path", None)
        if isinstance(path, str):
            yield path

        direct_routes = getattr(route, "routes", None)
        if direct_routes:
            pending.extend(direct_routes)
        original_router = getattr(route, "original_router", None)
        original_routes = getattr(original_router, "routes", None)
        if original_routes:
            pending.extend(original_routes)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--env-file", required=True)
    args = parser.parse_args()
    load_runtime_environment(args.env_file)

    for module_name in REQUIRED_IMPORTS:
        importlib.import_module(module_name)

    installed_heavy = [
        module_name
        for module_name in FORBIDDEN_HEAVY_IMPORTS
        if importlib.util.find_spec(module_name) is not None
    ]
    if installed_heavy:
        raise RuntimeError(
            "服务器精简环境不应包含本地 ASR 重型依赖："
            + ", ".join(installed_heavy)
        )

    from app.main import app
    from app.services import auth_service

    token = auth_service.create_access_token(
        "runtime-lock-check",
        "runtime-lock-check@zhicui.local",
    )
    payload = auth_service.decode_access_token(token)
    if not payload or payload.get("sub") != "runtime-lock-check":
        raise RuntimeError("PyJWT HS256 运行时兼容检查失败")
    route_paths = set(iter_route_paths(app))
    if "/api/health" not in route_paths:
        raise RuntimeError("FastAPI 应用未注册健康检查路由")

    print(
        json.dumps(
            {
                "ok": True,
                "route_count": len(route_paths),
                "versions": {
                    distribution: version(distribution)
                    for distribution in REQUIRED_IMPORTS.values()
                },
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
