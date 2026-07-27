"""Import a legacy companion Cookie response without printing secret values."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: import_cookie_response.py TARGET", file=sys.stderr)
        return 2

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"invalid JSON input: {exc}", file=sys.stderr)
        return 2

    cookies = payload.get("cookies") if isinstance(payload, dict) else None
    if not isinstance(cookies, dict):
        print("input does not contain a Cookie mapping", file=sys.stderr)
        return 2

    clean: dict[str, str] = {}
    for key, value in cookies.items():
        if (
            isinstance(key, str)
            and isinstance(value, str)
            and key.strip()
            and value
            and len(key) <= 256
            and len(value) <= 16384
        ):
            clean[key.strip()] = value

    if not clean or len(clean) > 256:
        print("Cookie mapping is empty or too large", file=sys.stderr)
        return 2

    target = Path(sys.argv[1]).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        dir=str(target.parent),
        text=True,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(clean, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, target)
        os.chmod(target, 0o600)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)

    print(f"Imported {len(clean)} protected Cookie fields.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
