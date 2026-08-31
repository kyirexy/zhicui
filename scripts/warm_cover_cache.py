#!/usr/bin/env python3
"""在后台预热用户资料封面，避免发布后首位用户承担冷缓存等待。"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

import requests


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.database import SessionLocal  # noqa: E402
from app.models.douyin_account_binding import DouyinAccountBinding  # noqa: E402
from app.models.douyin_local_library_item import DouyinLocalLibraryItem  # noqa: E402
from app.models.note import Note  # noqa: E402
from app.services import (  # noqa: E402
    douyin_library,
    image_memory_cache,
)


MAX_IMAGE_BYTES = 8 * 1024 * 1024
PUBLIC_HEADERS = {
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Encoding": "identity",
    "Referer": "https://www.douyin.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}
BILIBILI_HEADERS = {
    **PUBLIC_HEADERS,
    "Referer": "https://www.bilibili.com/",
}


def _fetch(url: str, headers: dict[str, str]) -> tuple[str, bytes] | None:
    response = None
    try:
        response = requests.get(
            url,
            headers=headers,
            stream=True,
            timeout=(5, 25),
            allow_redirects=False,
        )
        if response.is_redirect or response.is_permanent_redirect:
            return None
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "image/jpeg").split(";", 1)[0]
        if not content_type.lower().startswith("image/"):
            return None
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                return None
            chunks.append(chunk)
        content = b"".join(chunks)
        return (content_type, content) if content else None
    except requests.RequestException:
        return None
    finally:
        if response is not None:
            response.close()


def _warm_douyin(task: tuple[str, str, str, str]) -> bool:
    binding_id, session_scope, video_id, fallback_url = task
    candidates = [
        (
            douyin_library.companion_cover_url(video_id),
            {**PUBLIC_HEADERS, **douyin_library.companion_headers(session_scope)},
        ),
        (fallback_url, PUBLIC_HEADERS),
    ]
    for url, headers in candidates:
        if not url:
            continue
        result = _fetch(url, headers)
        if result is None:
            continue
        content_type, content = result
        image_memory_cache.put(
            f"douyin-cover:{binding_id}:{video_id}",
            content_type,
            content,
        )
        return True
    return False


def _warm_platform(task: tuple[str, str]) -> bool:
    note_id, cover_url = task
    result = _fetch(cover_url, BILIBILI_HEADERS)
    if result is None:
        return False
    content_type, content = result
    image_memory_cache.put(f"platform-cover:{note_id}", content_type, content)
    return True


def collect_tasks() -> tuple[list[tuple[str, str, str, str]], list[tuple[str, str]]]:
    db = SessionLocal()
    try:
        bindings = {
            row.user_id: row
            for row in db.query(DouyinAccountBinding).all()
            if row.status == "connected"
        }
        douyin_tasks = []
        for row in db.query(DouyinLocalLibraryItem).filter(
            DouyinLocalLibraryItem.available.is_(True),
        ).all():
            binding = bindings.get(row.user_id)
            if binding is None:
                continue
            douyin_tasks.append((
                binding.id,
                binding.session_scope,
                row.video_id,
                row.cover_url or "",
            ))

        platform_tasks = []
        for note in db.query(Note).all():
            try:
                payload = json.loads(note.ai_summary or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            meta = payload.get("source_meta") if isinstance(payload, dict) else None
            if not isinstance(meta, dict):
                continue
            if meta.get("source_kind") != "platform-import" or meta.get("platform") != "bilibili":
                continue
            target = str(meta.get("cover_url") or "").strip()
            parsed = urlparse(target)
            hostname = (parsed.hostname or "").lower()
            if (
                parsed.scheme == "https"
                and (
                    hostname in {"hdslb.com", "biliimg.com"}
                    or hostname.endswith((".hdslb.com", ".biliimg.com"))
                )
            ):
                platform_tasks.append((note.id, target))
        return douyin_tasks, platform_tasks
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    douyin_tasks, platform_tasks = collect_tasks()
    jobs = [(_warm_douyin, task) for task in douyin_tasks]
    jobs.extend((_warm_platform, task) for task in platform_tasks)
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as executor:
        futures = [executor.submit(function, task) for function, task in jobs]
        for future in as_completed(futures):
            if future.result():
                completed += 1
    print(
        f"封面预热完成：成功 {completed}/{len(jobs)}，"
        f"抖音 {len(douyin_tasks)}，B站 {len(platform_tasks)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
