from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace


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


if __name__ == "__main__":
    unittest.main()
