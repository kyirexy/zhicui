#!/usr/bin/env python3
"""只生成 Core 独立验收清单；不修改 Full Stable 清单。"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
os.environ.setdefault("JWT_SECRET", "manifest-generation-only-not-a-runtime-secret")
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
from app.core.config import settings
from app.agent_interface.profiles import CORE_ACTION_IDS, CORE_SCOPE_IDS
from app.services.product_action_registry import registry

settings.AGENT_INTERFACE_PROFILE = "core"
descriptors = sorted((definition.descriptor().model_dump(mode="json") for definition in registry.all() if definition.id in CORE_ACTION_IDS), key=lambda item: item["id"])
if {item["id"] for item in descriptors} != set(CORE_ACTION_IDS):
    raise SystemExit("Core 明确动作清单与 Registry 不一致")
manifest = {
    "schema_version": 1,
    "interface_version": "v1",
    "release_profile": "core",
    "action_count": len(descriptors),
    "cloud_action_count": sum(item["execution_location"] == "cloud" for item in descriptors),
    "local_windows_action_count": sum(item["execution_location"] == "local_windows" for item in descriptors),
    "available_cloud_action_count": sum(item["available"] and item["execution_location"] == "cloud" for item in descriptors),
    "unavailable_local_windows_action_count": sum(not item["available"] and item["execution_location"] == "local_windows" for item in descriptors),
    "remote_mcp_tool_count": sum(item["available"] and item["execution_location"] == "cloud" and item["mcp_exposed"] for item in descriptors) + 3,
    "scope_count": len(CORE_SCOPE_IDS),
    "scope_ids": sorted(CORE_SCOPE_IDS),
    "action_ids": sorted(CORE_ACTION_IDS),
    "descriptor_sha256": hashlib.sha256(json.dumps(descriptors, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
}
target = root / "backend/app/agent_interface/core_capabilities_v1.json"
target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"profile": "core", "actions": manifest["action_count"], "scopes": manifest["scope_count"], "descriptor_sha256": manifest["descriptor_sha256"]}))
