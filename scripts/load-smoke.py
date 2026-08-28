#!/usr/bin/env python3
"""Bounded, read-only concurrency smoke test for a Zhicui deployment."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass
class Result:
    path: str
    status: int
    elapsed_ms: float
    error: str = ""


def request_once(base_url: str, path: str, token: str) -> Result:
    url = base_url.rstrip("/") + path
    headers = {"User-Agent": "Zhicui-Load-Smoke/1.0", "Cache-Control": "no-cache"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read(2048)
            status = response.status
        return Result(path, status, (time.perf_counter() - started) * 1000)
    except urllib.error.HTTPError as exc:
        return Result(path, exc.code, (time.perf_counter() - started) * 1000, f"HTTP {exc.code}")
    except Exception as exc:
        return Result(path, 0, (time.perf_counter() - started) * 1000, type(exc).__name__)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--requests", type=int, default=40)
    parser.add_argument("--p95-ms", type=int, default=2500)
    args = parser.parse_args()
    concurrency = max(1, min(args.concurrency, 32))
    request_count = max(concurrency, min(args.requests, 500))
    token = os.environ.get("ZHICUI_SMOKE_TOKEN", "").strip()
    paths = ["/api/health", "/api/readiness"]
    if token:
        paths.append("/api/notes?page=1&per_page=1")
    jobs = [paths[index % len(paths)] for index in range(request_count)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(pool.map(lambda path: request_once(args.base_url, path, token), jobs))
    successful = [result for result in results if 200 <= result.status < 300]
    latencies = [result.elapsed_ms for result in successful]
    summary = {
        "base_url": args.base_url,
        "requests": len(results),
        "concurrency": concurrency,
        "success": len(successful),
        "failed": len(results) - len(successful),
        "success_rate": round(len(successful) / max(1, len(results)), 4),
        "median_ms": round(statistics.median(latencies), 1) if latencies else 0,
        "p95_ms": round(percentile(latencies, 0.95), 1),
        "max_ms": round(max(latencies), 1) if latencies else 0,
        "errors": [
            {"path": result.path, "status": result.status, "error": result.error}
            for result in results if result.status < 200 or result.status >= 300
        ][:10],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["success_rate"] >= 0.99 and summary["p95_ms"] <= args.p95_ms else 1


if __name__ == "__main__":
    raise SystemExit(main())
