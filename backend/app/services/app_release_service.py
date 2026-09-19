"""Public Android release metadata backed by the deployed static manifest."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
_RELEASE_MANIFEST_PATH = (
    Path(__file__).resolve().parents[3]
    / "frontend"
    / "public"
    / "download"
    / "releases"
    / "android"
    / "beta.json"
)


def _is_trusted_download_url(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.hostname == "luxai.cn"
        and parsed.port is None
        and parsed.username is None
        and parsed.password is None
        and bool(re.fullmatch(r"/download/android/Zhicui-[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*\.apk", parsed.path))
    )


def get_latest_android_release() -> dict[str, Any]:
    """Read and validate the release manifest on every request.

    The file is intentionally tiny and uncached here so a newly deployed
    manifest becomes visible immediately without restarting a worker.
    """

    try:
        payload = json.loads(_RELEASE_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Android 版本清单暂时不可用") from exc

    version = payload.get("version")
    build = payload.get("build")
    notes = payload.get("release_notes")
    download_url = payload.get("download_url")
    published_at = payload.get("published_at")
    size_bytes = payload.get("size_bytes")
    ui_update_mode = payload.get("ui_update_mode", "bundled")
    expected_download_path = (
        f"/download/android/Zhicui-{version}-{build}.apk"
        if isinstance(version, str) and isinstance(build, int) and not isinstance(build, bool)
        else ""
    )
    parsed_download_url = urlparse(download_url) if isinstance(download_url, str) else None

    valid = (
        payload.get("schema_version") == 2
        and payload.get("platform") == "android"
        and payload.get("channel") == "beta"
        and payload.get("availability") == "available"
        and isinstance(version, str)
        and bool(_VERSION_RE.fullmatch(version))
        and isinstance(build, int)
        and not isinstance(build, bool)
        and build > 0
        and isinstance(published_at, str)
        and bool(published_at.strip())
        and isinstance(download_url, str)
        and _is_trusted_download_url(download_url)
        and parsed_download_url is not None
        and parsed_download_url.path == expected_download_path
        and isinstance(size_bytes, int)
        and not isinstance(size_bytes, bool)
        and size_bytes > 0
        and ui_update_mode in {"bundled", "remote"}
        and isinstance(notes, list)
        and 1 <= len(notes) <= 20
        and all(
            isinstance(note, str) and 1 <= len(note.strip()) <= 240
            for note in notes
        )
        and len({note.strip() for note in notes}) == len(notes)
    )
    if not valid:
        raise RuntimeError("Android 版本清单格式无效")

    return {
        "schema_version": 2,
        "platform": "android",
        "channel": "beta",
        "ui_update_mode": ui_update_mode,
        "version": version,
        "build": build,
        "published_at": published_at,
        "download_url": download_url,
        "size_bytes": size_bytes,
        "mandatory": bool(payload.get("mandatory", False)),
        "release_notes": [note.strip() for note in notes],
    }
