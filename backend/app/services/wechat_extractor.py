"""
WeChat Official Account (微信公众号) article extractor.

微信公众号 articles are regular web pages — no video, no API, no auth required.
This service scrapes the article page and extracts metadata + full text content
for processing through the VideoCapsule AI pipeline.
"""

from __future__ import annotations

import re
from typing import Any

import requests
from bs4 import BeautifulSoup

# Standard browser User-Agent to avoid being blocked
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


def extract_wechat_article(url: str) -> dict[str, Any]:
    """Extract title, author, publish time, and full text from a 微信公众号 article.

    Parameters
    ----------
    url:
        A WeChat article URL, e.g. ``https://mp.weixin.qq.com/s/...``

    Returns
    -------
    dict
        Keys: ``video_id``, ``title``, ``content``, ``author``,
        ``publish_time``, ``platform``, ``download_url``.
    """
    headers = {"User-Agent": _USER_AGENT}
    resp = requests.get(url, headers=headers, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")

    # Title — #activity-name is the canonical container
    title_el = soup.select_one("#activity-name")
    title = title_el.get_text(strip=True) if title_el else ""

    # Main content body
    content_el = soup.select_one("#js_content")
    if not content_el:
        content_el = soup.select_one(".rich_media_content")

    content = ""
    if content_el:
        # Remove hidden/display:none elements (WeChat stores raw text in hidden
        # divs for copy purposes — we want the visible article only)
        for tag in content_el.select(
            '[style*="visibility: hidden"], [style*="display: none"]'
        ):
            tag.decompose()
        content = content_el.get_text("\n", strip=True)

    # Author / official account name
    author_el = soup.select_one("#js_name")
    author = author_el.get_text(strip=True) if author_el else ""

    # Publish timestamp
    time_el = soup.select_one("#publish_time")
    publish_time = time_el.get_text(strip=True) if time_el else ""

    # Use a hash of the URL as a stable identifier (WeChat URLs have a unique
    # path segment after /s/ that serves as the article ID)
    video_id = _derive_video_id(url)

    return {
        "video_id": video_id,
        "title": title,
        "content": content,
        "author": author,
        "publish_time": publish_time,
        "platform": "wechat",
        "download_url": url,  # the article page itself
    }


def _derive_video_id(url: str) -> str:
    """Extract a stable article ID from a WeChat URL.

    WeChat article URLs look like ``.../s/<article_id>`` or
    ``.../s?__biz=...&mid=...&idx=...&sn=...``. We prefer the path segment;
    otherwise hash the full URL.
    """
    # Try to pull the article ID from the path: /s/<id>
    match = re.search(r"/s/([a-zA-Z0-9_-]+)", url)
    if match:
        return f"wechat_{match.group(1)}"

    # Fallback: hash the URL to produce a stable identifier
    import hashlib

    return f"wechat_{hashlib.md5(url.encode()).hexdigest()[:12]}"
