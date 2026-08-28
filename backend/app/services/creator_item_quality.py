"""Pure catalog-metadata quality rules.

The connector boundary deliberately persists only public, stable metadata.  A
metadata-only fallback may therefore know a BVID before it knows enough to
render a trustworthy card.  Keeping these rules pure makes the same decision
available to discovery, selection and the administrative repair workflow.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import urlparse


QUALITY_FIELDS = ("title", "cover_url", "author_name", "published_at", "description")
_PLACEHOLDER_TITLE = re.compile(
    r"^(?:B站作品\s*(?:BV|av)?[0-9A-Za-z]+|抖音作品(?:\s*[0-9A-Za-z_-]+)?|"
    r"视频作品|未知标题|未命名(?:视频|作品)?|untitled)$",
    re.IGNORECASE,
)
_UNKNOWN_AUTHOR = re.compile(r"^(?:未知作者|未知用户|unknown|佚名)$", re.IGNORECASE)


def _text(value: object) -> str:
    return str(value or "").replace("\x00", "").strip()


def _valid_public_source(value: object) -> bool:
    parsed = urlparse(_text(value))
    return bool(
        parsed.scheme in {"http", "https"}
        and parsed.hostname
        and not parsed.username
        and not parsed.password
    )


def _has_published_at(value: object) -> bool:
    if isinstance(value, datetime):
        return True
    return bool(_text(value))


def assess_catalog_metadata(values: Any) -> dict[str, Any]:
    """Return an allowlisted, deterministic quality decision.

    Missing presentation fields make an item degraded and visible as waiting
    for enrichment.  Missing trustworthy identity (title/author/source URL) or
    a generated placeholder blocks selected transcription: a stable ID alone
    is not presented as a successfully prepared work.
    """

    def get(name: str, default: object = "") -> object:
        if isinstance(values, dict):
            return values.get(name, default)
        return getattr(values, name, default)

    title = _text(get("title"))
    author = _text(get("author_name"))
    description = _text(get("description"))
    cover_url = _text(get("cover_url"))
    source_url = _text(get("source_url"))
    issues: list[str] = []

    if not title:
        issues.append("missing_title")
    elif _PLACEHOLDER_TITLE.fullmatch(title):
        issues.append("placeholder_title")
    if not cover_url:
        issues.append("missing_cover")
    if not author or _UNKNOWN_AUTHOR.fullmatch(author):
        issues.append("missing_author")
    if not _has_published_at(get("published_at", None)):
        issues.append("missing_published_at")
    if not description:
        issues.append("missing_description")
    if not _valid_public_source(source_url):
        issues.append("invalid_source_url")

    blocking = any(
        issue in {
            "missing_title",
            "placeholder_title",
            "missing_author",
            "invalid_source_url",
        }
        for issue in issues
    )
    return {
        "metadata_quality": (
            "needs_action" if blocking else "degraded" if issues else "complete"
        ),
        "quality_issues": issues,
        "needs_enrichment": bool(issues),
        "transcription_blocked": blocking,
    }


def safe_quality_issues(value: object) -> list[str]:
    """Normalize stored issue codes without exposing arbitrary upstream text."""

    if not isinstance(value, list):
        return []
    allowed = {
        "missing_title",
        "placeholder_title",
        "missing_cover",
        "missing_author",
        "missing_published_at",
        "missing_description",
        "invalid_source_url",
        "short_transcript",
    }
    return [str(issue) for issue in value if str(issue) in allowed]
