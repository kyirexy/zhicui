#!/usr/bin/env python3
"""Authenticated loopback health probe; prints no token or task payload."""

from __future__ import annotations

import asyncio
import json
import stat
from pathlib import Path

from websockets.asyncio.client import connect


EXPECTED_VERSION = "2.2.0"
REQUIRED_CAPABILITIES = {
    "resolve.start", "task.subscribe", "task.get", "task.cancel",
}
URL = "ws://127.0.0.1:11223"
TOKEN_FILE = Path("/opt/yutto-sidecar/server.token")


async def rpc(websocket, request_id: int, method: str, params: dict) -> dict:
    await websocket.send(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            separators=(",", ":"),
        )
    )
    while True:
        payload = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5))
        if payload.get("id") != request_id:
            continue
        if payload.get("error") is not None:
            raise RuntimeError("JSON-RPC health probe failed")
        return payload["result"]


async def main() -> None:
    if TOKEN_FILE.is_symlink() or not TOKEN_FILE.is_file():
        raise SystemExit("unsafe token file")
    if stat.S_IMODE(TOKEN_FILE.stat().st_mode) != 0o600:
        raise SystemExit("unsafe token permissions")
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    async with connect(URL, open_timeout=5, close_timeout=3, compression=None) as websocket:
        auth = await rpc(websocket, 1, "server.authenticate", {"token": token})
        info = await rpc(websocket, 2, "server.info", {})
    healthy = (
        auth.get("authenticated") is True
        and info.get("version") == EXPECTED_VERSION
        and REQUIRED_CAPABILITIES.issubset(set(info.get("capabilities") or []))
    )
    print(json.dumps({"healthy": healthy, "version": info.get("version")}, ensure_ascii=False))
    if not healthy:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
