#!/usr/bin/env python3
"""根据已审阅的完整能力表刷新发布摘要，便于重复验收。"""
import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
os.environ.setdefault("JWT_SECRET", "manifest-generation-only-not-a-runtime-secret")
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
from app.agent_interface.contracts import ALL_SCOPE_IDS
from app.services.product_action_registry import registry

descriptors = sorted((item.descriptor().model_dump(mode="json") for item in registry.all()), key=lambda item: item["id"])
manifest = {
    "schema_version": 1, "interface_version": "v1", "action_count": len(descriptors),
    "cloud_action_count": sum(item["execution_location"] == "cloud" for item in descriptors),
    "local_windows_action_count": sum(item["execution_location"] == "local_windows" for item in descriptors),
    "available_cloud_action_count": sum(item["available"] and item["execution_location"] == "cloud" for item in descriptors),
    "unavailable_local_windows_action_count": sum(not item["available"] and item["execution_location"] == "local_windows" for item in descriptors),
    "remote_mcp_tool_count": sum(item["available"] and item["execution_location"] == "cloud" and item["mcp_exposed"] for item in descriptors) + 3,
    "scope_count": len(ALL_SCOPE_IDS),
    "descriptor_sha256": hashlib.sha256(json.dumps(descriptors, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
}
(root / "backend/app/agent_interface/stable_capabilities_v1.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest))
