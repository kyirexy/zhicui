"""Bounded public-web research for the Q&A agent.

The LLM never receives browser control. This module performs a small search,
validates every destination, fetches a bounded amount of public text, and
returns normalized evidence for a later synthesis call.
"""
from __future__ import annotations

import html
import ipaddress
import json
import re
import socket
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import requests

_SEARCH_URL = "https://html.duckduckgo.com/html/"
_GITHUB_SEARCH_URL = "https://api.github.com/search/repositories"
_USER_AGENT = (
    "Mozilla/5.0 (compatible; ZhicuiResearch/1.0; +https://luxai.cn)"
)
_MAX_SEARCH_QUERIES = 3
_MAX_RESULTS = 6
_MAX_RESPONSE_BYTES = 320_000
_MAX_PAGE_TEXT = 6_000
_REQUEST_TIMEOUT = (4, 10)
_BLOCKED_HOST_SUFFIXES = (".local", ".localhost", ".internal", ".home")
_PROXY_SYNTHETIC_NETWORK = ipaddress.ip_network("198.18.0.0/15")


class WebResearchError(RuntimeError):
    """Safe, user-presentable research failure."""


@dataclass(frozen=True)
class WebSource:
    """A normalized external source safe to expose to the client."""

    title: str
    url: str
    domain: str
    snippet: str
    query: str
    verified: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class _VisibleTextParser(HTMLParser):
    """Extract title and visible text without executing or interpreting HTML."""

    _SKIP_TAGS = {"script", "style", "noscript", "svg", "form"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.in_title = False
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        if tag in self._SKIP_TAGS:
            self.skip_depth += 1
        elif tag == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
        elif tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data.strip():
            return
        self.text_parts.append(data)
        if self.in_title:
            self.title_parts.append(data)


class _DuckResultParser(HTMLParser):
    """Extract result titles, links and snippets from DuckDuckGo HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, Any]] = []
        self._active_anchor = False
        self._active_snippet = False

    @staticmethod
    def _classes(attrs: list[tuple[str, str | None]]) -> set[str]:
        value = next((value for key, value in attrs if key == "class"), "") or ""
        return set(value.split())

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        classes = self._classes(attrs)
        if tag == "a" and "result__a" in classes:
            href = next((value for key, value in attrs if key == "href"), "") or ""
            self.results.append({"url": href, "title": [], "snippet": []})
            self._active_anchor = True
        elif self.results and "result__snippet" in classes:
            self._active_snippet = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self._active_anchor = False
        elif tag in {"div", "span"}:
            self._active_snippet = False

    def handle_data(self, data: str) -> None:
        if not self.results or not data.strip():
            return
        if self._active_anchor:
            self.results[-1]["title"].append(data)
        elif self._active_snippet:
            self.results[-1]["snippet"].append(data)


def _is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _is_safe_resolved_ip(value: str) -> bool:
    """Allow public IPs plus the fake-IP range used by local TUN proxies."""
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return _is_public_ip(value) or address in _PROXY_SYNTHETIC_NETWORK


def is_public_http_url(url: str) -> bool:
    """Return True only for an HTTP(S) URL resolving entirely to public IPs."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    hostname = parsed.hostname.rstrip(".").lower()
    if (
        hostname == "localhost"
        or hostname.endswith(_BLOCKED_HOST_SUFFIXES)
        or parsed.username
        or parsed.password
    ):
        return False
    try:
        direct_ip = ipaddress.ip_address(hostname)
    except ValueError:
        direct_ip = None
    if direct_ip is not None:
        return _is_public_ip(str(direct_ip))
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        }
    except (socket.gaierror, OSError):
        return False
    return bool(addresses) and all(_is_safe_resolved_ip(address) for address in addresses)


def _bounded_public_get(
    url: str,
    *,
    params: dict[str, str] | None = None,
    accept: str = "text/html,application/json;q=0.9",
) -> tuple[str, str]:
    """Fetch a public URL while validating every redirect and bounding bytes."""
    current_url = url
    current_params = params
    for _ in range(4):
        if not is_public_http_url(current_url):
            raise WebResearchError("搜索结果指向了不允许访问的网络地址")
        try:
            response = requests.get(
                current_url,
                params=current_params,
                headers={"User-Agent": _USER_AGENT, "Accept": accept},
                timeout=_REQUEST_TIMEOUT,
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as exc:
            raise WebResearchError("外部资料暂时无法访问") from exc
        current_params = None
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("Location", "").strip()
            response.close()
            if not location:
                raise WebResearchError("外部资料返回了无效跳转")
            current_url = urljoin(current_url, location)
            continue
        try:
            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > _MAX_RESPONSE_BYTES:
                raise WebResearchError("外部资料页面过大")
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_content(chunk_size=16_384):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _MAX_RESPONSE_BYTES:
                    raise WebResearchError("外部资料页面过大")
                chunks.append(chunk)
            encoding = response.encoding or "utf-8"
            return b"".join(chunks).decode(encoding, errors="replace"), response.url
        finally:
            response.close()
    raise WebResearchError("外部资料跳转次数过多")


def _clean_text(value: str, limit: int) -> str:
    normalized = re.sub(r"\s+", " ", html.unescape(value or "")).strip()
    return normalized[:limit]


def _clean_title(value: str) -> str:
    """Trim malformed/escaped closing-title tails returned by some sites."""
    normalized = _clean_text(value, 500)
    normalized = re.split(
        r"<\s*\\?/?title\b",
        normalized,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip(" -|·")
    return normalized[:180]


def _normalize_search_url(raw_url: str) -> str:
    value = html.unescape(raw_url or "").strip()
    if value.startswith("//"):
        value = f"https:{value}"
    parsed = urlparse(value)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target:
            value = unquote(target)
    return value


def _page_excerpt(url: str) -> tuple[str, str]:
    body, final_url = _bounded_public_get(url)
    parser = _VisibleTextParser()
    parser.feed(body)
    title = _clean_title(" ".join(parser.title_parts))
    text = _clean_text(" ".join(parser.text_parts), _MAX_PAGE_TEXT)
    return title, text


def _search_github(query: str, remaining: int) -> list[WebSource]:
    if remaining <= 0 or "github" not in query.lower():
        return []
    github_query = re.sub(r"\bgithub\b", " ", query, flags=re.IGNORECASE).strip()
    if not github_query:
        return []
    try:
        body, _ = _bounded_public_get(
            _GITHUB_SEARCH_URL,
            params={"q": github_query, "sort": "stars", "order": "desc", "per_page": str(min(3, remaining))},
            accept="application/vnd.github+json",
        )
        payload = json.loads(body)
    except (WebResearchError, ValueError, TypeError):
        return []
    sources: list[WebSource] = []
    for item in payload.get("items", [])[:remaining]:
        url = str(item.get("html_url") or "")
        if not is_public_http_url(url):
            continue
        description = _clean_text(str(item.get("description") or ""), 260)
        stars = int(item.get("stargazers_count") or 0)
        language = _clean_text(str(item.get("language") or ""), 40)
        detail = " · ".join(
            part for part in (
                description,
                f"{stars:,} stars" if stars else "",
                language,
            )
            if part
        )
        sources.append(WebSource(
            title=_clean_text(str(item.get("full_name") or "GitHub repository"), 180),
            url=url,
            domain="github.com",
            snippet=detail,
            query=query,
            verified=True,
        ))
    return sources


def _search_duckduckgo(query: str, remaining: int) -> list[WebSource]:
    if remaining <= 0:
        return []
    try:
        body, _ = _bounded_public_get(_SEARCH_URL, params={"q": query, "kl": "cn-zh"})
    except WebResearchError:
        return []
    parser = _DuckResultParser()
    parser.feed(body)
    sources: list[WebSource] = []
    for result in parser.results:
        url = _normalize_search_url(str(result["url"]))
        if not is_public_http_url(url):
            continue
        title = _clean_text(" ".join(result["title"]), 180)
        snippet = _clean_text(" ".join(result["snippet"]), 320)
        sources.append(WebSource(
            title=title or urlparse(url).hostname or "网页来源",
            url=url,
            domain=(urlparse(url).hostname or "").removeprefix("www."),
            snippet=snippet,
            query=query,
            verified=False,
        ))
        if len(sources) >= remaining:
            break
    return sources


def research_web(
    queries: list[str],
    *,
    max_results: int = _MAX_RESULTS,
    verify_pages: int = 3,
) -> dict[str, Any]:
    """Search and verify a small set of public web sources."""
    clean_queries: list[str] = []
    for raw_query in queries[:_MAX_SEARCH_QUERIES]:
        query = _clean_text(str(raw_query or ""), 180)
        if query and query not in clean_queries:
            clean_queries.append(query)
    bounded_results = max(1, min(int(max_results), _MAX_RESULTS))
    collected: list[WebSource] = []
    seen_urls: set[str] = set()

    for query in clean_queries:
        candidates = [
            *_search_github(query, bounded_results - len(collected)),
            *_search_duckduckgo(query, bounded_results - len(collected)),
        ]
        for source in candidates:
            canonical = source.url.rstrip("/")
            if canonical in seen_urls:
                continue
            seen_urls.add(canonical)
            collected.append(source)
            if len(collected) >= bounded_results:
                break
        if len(collected) >= bounded_results:
            break

    verified_sources: list[WebSource] = []
    pages_left = max(0, min(int(verify_pages), 3))
    for source in collected:
        if source.verified or pages_left <= 0:
            verified_sources.append(source)
            continue
        try:
            page_title, page_text = _page_excerpt(source.url)
            verified_sources.append(WebSource(
                title=page_title or source.title,
                url=source.url,
                domain=source.domain,
                snippet=_clean_text(page_text or source.snippet, _MAX_PAGE_TEXT),
                query=source.query,
                verified=True,
            ))
            pages_left -= 1
        except WebResearchError:
            verified_sources.append(source)

    return {
        "queries": clean_queries,
        "sources": [source.to_dict() for source in verified_sources],
        "searched": bool(clean_queries),
    }
