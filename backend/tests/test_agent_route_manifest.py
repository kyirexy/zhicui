from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]
API_DIR = BACKEND / "app" / "api"
MANIFEST_PATH = BACKEND / "app" / "agent_interface" / "route_manifest.json"
INVENTORY_PATH = BACKEND / "app" / "agent_interface" / "route_inventory.json"


def _constant_string(node: ast.AST | None) -> str:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""


def discovered_routes() -> list[tuple[str, str, str]]:
    routes: list[tuple[str, str, str]] = []
    for path in sorted(API_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        prefixes: dict[str, str] = {}
        for node in tree.body:
            if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
                continue
            if not isinstance(node.value, ast.Call) or not isinstance(node.value.func, ast.Name) or node.value.func.id != "APIRouter":
                continue
            prefix = ""
            for keyword in node.value.keywords:
                if keyword.arg == "prefix":
                    prefix = _constant_string(keyword.value)
            prefixes[node.targets[0].id] = prefix
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                if decorator.func.attr not in {"get", "post", "put", "patch", "delete"}:
                    continue
                if not isinstance(decorator.func.value, ast.Name):
                    continue
                router_name = decorator.func.value.id
                if router_name not in prefixes or not decorator.args:
                    continue
                route_path = _constant_string(decorator.args[0])
                routes.append((decorator.func.attr.upper(), prefixes[router_name] + route_path, path.name))
    return routes


def _route_key(method: str, route_path: str) -> str:
    return f"{method} {route_path}"


class AgentRouteManifestTests(unittest.TestCase):
    def test_route_inventory_matches_declared_routes_exactly(self) -> None:
        inventory = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        declared = inventory.get("routes")
        self.assertIsInstance(declared, list)
        self.assertTrue(all(isinstance(item, str) and item for item in declared))
        self.assertEqual(
            len(declared),
            len(set(declared)),
            "route_inventory.json contains duplicate method/path entries",
        )
        self.assertEqual(
            declared,
            sorted(declared),
            "route_inventory.json must remain sorted so review diffs are deterministic",
        )

        discovered_entries = [
            (_route_key(method, route_path), source)
            for method, route_path, source in discovered_routes()
        ]
        discovered_keys = [key for key, _source in discovered_entries]
        duplicate_declarations = sorted(
            {
                key
                for key in discovered_keys
                if discovered_keys.count(key) > 1
            }
        )
        self.assertEqual(
            duplicate_declarations,
            [],
            "Duplicate FastAPI method/path declarations:\n" + "\n".join(duplicate_declarations),
        )
        discovered = set(discovered_keys)
        expected = set(declared)
        added = sorted(discovered - expected)
        removed = sorted(expected - discovered)
        details: list[str] = []
        if added:
            details.append(
                "New routes missing from route_inventory.json:\n  " + "\n  ".join(added)
            )
        if removed:
            details.append(
                "Routes removed from FastAPI but still present in route_inventory.json:\n  "
                + "\n  ".join(removed)
            )
        self.assertEqual(
            details,
            [],
            "\n\n".join(details)
            + "\n\nUpdate the exact inventory and review the route's Agent-boundary classification deliberately.",
        )

    def test_every_declared_route_has_exactly_one_first_match_classification(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        allowed = set(manifest["allowed_classifications"])
        rules = [(re.compile(item["pattern"]), item) for item in manifest["rules"]]
        unclassified: list[str] = []
        invalid: list[str] = []
        for method, route_path, source in discovered_routes():
            match = next((item for pattern, item in rules if pattern.search(route_path)), None)
            if match is None:
                unclassified.append(f"{method} {route_path} ({source})")
            elif match.get("classification") not in allowed:
                invalid.append(f"{method} {route_path}: {match.get('classification')}")
        self.assertEqual(unclassified, [], "Unclassified routes:\n" + "\n".join(unclassified))
        self.assertEqual(invalid, [])

    def test_admin_rules_are_never_action_classified(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        rules = [(re.compile(item["pattern"]), item) for item in manifest["rules"]]
        violations = []
        for method, route_path, source in discovered_routes():
            match = next((item for pattern, item in rules if pattern.search(route_path)), None)
            if route_path.startswith("/api/admin") and (match or {}).get("classification") != "admin":
                violations.append(f"{method} {route_path} ({source})")
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
