"""Process-wide TTL cache for rarely-changing configuration.

Hot request paths (LLM/ASR config resolution, agent rollout flags) re-read the
same SystemSetting rows on every call, yet those values only change when an
administrator saves the admin panel or a user edits their model selection. A
short in-process TTL removes the repeated queries without risking stale reads
beyond a few seconds.

This deliberately stays in-process: production runs a single uvicorn worker
(`--workers 1`), so no cross-instance invalidation is needed. Redis becomes
worthwhile only if the deployment ever scales past one process — see
core/rate_limit.py for the same evolutionary note.

Pattern copied from readiness_service (module-level lock + monotonic TTL),
generalised with a version counter so writers can invalidate immediately:
`bump()` invalidates every cache on the next read; callers that must never
serve a stale value can call `invalidate()` directly.

Cached values must be plain data (str/bool/dict), never ORM entities: an
entity loaded through one session expires on that session's commit and would
raise DetachedInstanceError when a later request read it back from the cache.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Generic, TypeVar

T = TypeVar("T")
K = TypeVar("K")
V = TypeVar("V")

DEFAULT_TTL_SECONDS = 30.0
# 作用域数量上界：生产只有一个 engine，测试每个用例一个；留足余量即可。
_MAX_SCOPES = 64


def scope_of(db: Any) -> Any:
    """Identify which database a session reads, for cache keying.

    A process normally holds a single engine, but not always: the test suite
    builds a fresh in-memory SQLite engine per case. Keying entries by the
    bound engine keeps a value loaded from one database from being served for
    another — otherwise configuration leaks across cases, and any future
    multi-database deployment would serve one tenant another's settings.
    """
    if db is None:
        return None
    try:
        return db.get_bind()
    except Exception:
        return None


class TTLCache(Generic[T]):
    """A TTL cache with one slot per database scope.

    One scope per process is the production shape (single engine), so the
    common path is still a single dict lookup; the map only holds extra slots
    when more than one engine is alive.
    """

    def __init__(
        self,
        name: str,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_scopes: int = _MAX_SCOPES,
    ) -> None:
        self._name = name
        self._ttl = max(0.1, float(ttl_seconds))
        self._max_scopes = max(1, int(max_scopes))
        self._lock = threading.Lock()
        self._slots: "OrderedDict[Any, tuple[T, float, int]]" = OrderedDict()

    def get_or_load(self, loader: Callable[[], T], *, scope: Any = None) -> T:
        """Return the cached value for ``scope``, or call loader() once to build it.

        The loader runs outside the lock so a slow DB read never blocks
        concurrent readers longer than one load; last-writer-wins keeps the
        semantics correct for idempotent config loaders.
        """
        generation = _current_generation()
        now = time.monotonic()
        with self._lock:
            entry = self._slots.get(scope)
            if entry is not None:
                value, expires_at, cached_generation = entry
                if cached_generation == generation and now < expires_at:
                    self._slots.move_to_end(scope)
                    return value

        value = loader()

        with self._lock:
            self._slots[scope] = (value, time.monotonic() + self._ttl, generation)
            self._slots.move_to_end(scope)
            while len(self._slots) > self._max_scopes:
                self._slots.popitem(last=False)
        return value

    def invalidate(self, scope: Any = None) -> None:
        """Drop one scope's value, or every scope when scope is None."""
        with self._lock:
            if scope is None:
                self._slots.clear()
            else:
                self._slots.pop(scope, None)

    def clear(self) -> None:
        self.invalidate()


# --- process-wide generation counter -----------------------------------

_version_lock = threading.Lock()
_version = 0


def _current_generation() -> int:
    with _version_lock:
        return _version


def bump() -> None:
    """Invalidate every TTLCache instance on its next read.

    Writers (set_setting, catalog save, user model changes) call this so a
    config change takes effect immediately instead of waiting out the TTL.
    Cheap: one integer increment per write, one int comparison per read.
    """
    global _version
    with _version_lock:
        _version += 1


def make_cache(
    name: str,
    ttl_seconds: float = DEFAULT_TTL_SECONDS,
) -> "TTLCache[Any]":
    return TTLCache(name, ttl_seconds)


class KeyedTTLCache(Generic[K, V]):
    """A bounded, per-key TTL cache (e.g. one rollout verdict per user).

    Entries expire after ``ttl_seconds`` (lazily, on read) and the whole map
    is invalidated by ``bump()`` when configuration changes. A simple size
    bound keeps memory flat for per-user keys: eviction drops the oldest
    entries by last-access order (cheap approximation of LRU).

    Callers that read a database pass ``(scope_of(db), ...)`` as part of the
    key so values do not cross between engines.
    """

    def __init__(
        self,
        name: str,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_entries: int = 4096,
    ) -> None:
        self._name = name
        self._ttl = max(0.1, float(ttl_seconds))
        self._max_entries = max(16, int(max_entries))
        self._lock = threading.Lock()
        self._entries: "OrderedDict[K, tuple[V, float, int]]" = OrderedDict()

    def get_or_load(self, key: K, loader: Callable[[], V]) -> V:
        generation = _current_generation()
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                value, expires_at, cached_generation = entry
                if cached_generation == generation and now < expires_at:
                    self._entries.move_to_end(key)
                    return value
        value = loader()
        with self._lock:
            self._entries[key] = (value, time.monotonic() + self._ttl, generation)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
        return value

    def invalidate(self, key: K | None = None) -> None:
        """Drop one key, or the whole map when key is None."""
        with self._lock:
            if key is None:
                self._entries.clear()
            else:
                self._entries.pop(key, None)

    def clear(self) -> None:
        self.invalidate()
