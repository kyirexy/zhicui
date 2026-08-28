#!/usr/bin/env python3
"""Fail closed before systemd starts the pinned yutto sidecar."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


ROOT = Path("/opt/yutto-sidecar")
TOKEN = ROOT / "server.token"
YUTTO = ROOT / ".venv/bin/yutto"
LICENSE = ROOT / "LICENSE.yutto-GPL-3.0"
NOTICE = ROOT / "SOURCE-NOTICE.md"


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    if TOKEN.is_symlink() or not TOKEN.is_file() or TOKEN.stat().st_size < 32:
        fail("yutto token file is missing or unsafe")
    if stat.S_IMODE(TOKEN.stat().st_mode) != 0o600:
        fail("yutto token permissions must be 0600")
    if TOKEN.stat().st_uid != os.getuid():
        fail("yutto token owner does not match service user")
    if not YUTTO.is_file() or not os.access(YUTTO, os.X_OK):
        fail("pinned yutto executable is unavailable")
    if not LICENSE.is_file() or not NOTICE.is_file():
        fail("yutto license/source notice is unavailable")
    for directory in (ROOT / "tmp", ROOT / "blocked-downloads"):
        if directory.is_symlink() or not directory.is_dir():
            fail("yutto runtime directory is unsafe")
    completed = subprocess.run(
        [str(YUTTO), "--version"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0 or completed.stdout.strip() != "yutto 2.2.0":
        fail("yutto runtime version mismatch")


if __name__ == "__main__":
    main()
