from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "deploy"
    / "verify-server-runtime.py"
)
SPEC = importlib.util.spec_from_file_location(
    "verify_server_runtime",
    SCRIPT_PATH,
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ServerRuntimeVerifierTests(unittest.TestCase):
    def test_iter_route_paths_expands_included_router(self) -> None:
        health = SimpleNamespace(path="/api/health")
        nested = SimpleNamespace(path="/api/nested")
        original_router = SimpleNamespace(routes=[health, nested])
        included = SimpleNamespace(original_router=original_router)
        app = SimpleNamespace(routes=[included])

        self.assertEqual(
            set(MODULE.iter_route_paths(app)),
            {"/api/health", "/api/nested"},
        )

    def test_iter_route_paths_handles_direct_routes_and_cycles(self) -> None:
        route = SimpleNamespace(path="/api/direct", routes=[])
        route.routes.append(route)
        app = SimpleNamespace(routes=[route])

        self.assertEqual(
            list(MODULE.iter_route_paths(app)),
            ["/api/direct"],
        )

    def test_load_runtime_environment_uses_explicit_file_without_logging_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                'JWT_SECRET="runtime-secret-not-for-logs"\nPORT=8000\n',
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                MODULE.load_runtime_environment(str(env_path.resolve()))
                self.assertEqual(os.environ["JWT_SECRET"], "runtime-secret-not-for-logs")
                self.assertEqual(os.environ["PORT"], "8000")

    def test_load_runtime_environment_rejects_relative_or_missing_file(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "绝对路径"):
            MODULE.load_runtime_environment("backend/.env")


if __name__ == "__main__":
    unittest.main()
