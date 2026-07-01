"""
小红书 (Xiaohongshu / RedNote) content extraction adapter.

Extracts note metadata and text content from 小红书 share/discovery URLs.

Strategy (tried in order):
1. SSR HTML scrape — look for embedded __INITIAL_STATE__ data in the page
   (works on rednote.com for some pages, xiaohongshu.com is CSR-only)
2. Signed API — use xhshow to generate X-S/X-T anti-crawler headers + feed API
   (requires a valid a1 cookie from a logged-in session)
3. Clear error — if all above fail, return a descriptive error instead of crashing

Design note: unlike Douyin/B站, 小红书 is primarily a text+image platform
(no ASR needed — the content itself is the "transcript"). This adapter returns
the note text directly.
"""

from __future__ import annotations

import json
import re
import time
import random
import urllib.request
from typing import Any
from http.cookiejar import CookieJar


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Mobile/15E148 Safari/604.1"
)

DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/143.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# URL detection helpers
# ---------------------------------------------------------------------------

def is_xhs_url(url: str) -> bool:
    """Check if a URL is a 小红书 link."""
    return bool(
        'xiaohongshu.com' in url
        or 'rednote.com' in url
        or 'xhslink.com' in url
    )


def extract_note_id(url: str) -> str | None:
    """Extract the note ID from a 小红书 URL.

    Handles:
      - https://www.xiaohongshu.com/discovery/item/{note_id}
      - https://www.xiaohongshu.com/explore/{note_id}
      - https://www.rednote.com/discovery/item/{note_id}
      - https://www.rednote.com/explore/{note_id}
      - https://xhslink.com/{short_code}  (needs redirect follow)
    """
    # Direct item/explore patterns
    patterns = [
        r'(?:discovery/item|explore)/([a-f0-9]+)',
    ]
    for pat in patterns:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get_html(url: str, mobile: bool = False) -> str:
    """Fetch a page and return its HTML text."""
    ua = MOBILE_UA if mobile else DESKTOP_UA
    req = urllib.request.Request(url, headers={
        "User-Agent": ua,
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,image/apng,*/*;q=0.8,"
            "application/signed-exchange;v=b3;q=0.7"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.xiaohongshu.com/explore",
    })
    resp = urllib.request.urlopen(req, timeout=15)
    return resp.read().decode("utf-8")


def _follow_short_link(short_url: str) -> str:
    """Follow an xhslink.com short link to its real URL."""
    req = urllib.request.Request(short_url, headers={
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    resp = urllib.request.urlopen(req, timeout=15)
    return resp.geturl() or short_url


def _generate_a1() -> str:
    """Generate a plausible a1 cookie value for XHS anti-crawler signing."""
    ts = int(time.time() * 1000)
    rand = "".join(random.choices("0123456789abcdef", k=40))
    return f"18{hex(ts)[2:]}{rand}"


# ---------------------------------------------------------------------------
# Stage 1: SSR HTML scraping
# ---------------------------------------------------------------------------

def _parse_initial_state(html: str) -> dict[str, Any]:
    """Parse the __INITIAL_STATE__ JSON from a 小红书 HTML page.

    Returns the parsed dict, or empty dict if not found / unparseable.
    """
    idx = html.find("__INITIAL_STATE__")
    if idx < 0:
        return {}

    brace_start = html.find("{", idx)
    if brace_start < 0:
        return {}

    # Manually track brace depth to extract the JSON object
    depth = 0
    end = brace_start
    for i in range(brace_start, min(brace_start + 500000, len(html))):
        ch = html[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    raw = html[brace_start:end]
    # Replace JS 'undefined' with JSON null
    cleaned = raw.replace("undefined", "null")

    try:
        return json.loads(cleaned) or {}
    except json.JSONDecodeError:
        return {}


def _extract_note_from_state(data: dict[str, Any]) -> dict[str, Any] | None:
    """Extract note data from the parsed __INITIAL_STATE__ structure.

    Tries multiple known paths in XHS page state:
    - PC path:  note -> noteDetailMap -> [-1] -> note
    - Phone path: noteData -> data -> noteData
    """
    # PC web path
    note_detail_map = data.get("note", {}).get("noteDetailMap", {})
    if note_detail_map:
        # Get any entry (key is usually the note ID)
        for _key, entry in note_detail_map.items():
            if isinstance(entry, dict):
                nd = entry.get("note", entry)
                if isinstance(nd, dict) and nd:
                    return nd

    # Phone web path
    note_data = data.get("noteData", {}).get("data", {}).get("noteData", {})
    if isinstance(note_data, dict) and note_data:
        return note_data

    return None


def _scrape_ssr(url: str) -> dict[str, Any]:
    """Try to extract note data from SSR HTML.

    Raises RuntimeError if no data is found.
    """
    note_id = extract_note_id(url)
    if not note_id:
        raise RuntimeError(f"无法从链接中提取小红书笔记 ID: {url[:80]}")

    # Try both domains and both path formats
    urls_to_try = [
        f"https://www.xiaohongshu.com/discovery/item/{note_id}",
        f"https://www.xiaohongshu.com/explore/{note_id}",
        f"https://www.rednote.com/discovery/item/{note_id}",
        f"https://www.rednote.com/explore/{note_id}",
    ]

    for page_url in urls_to_try:
        try:
            html = _get_html(page_url)
            data = _parse_initial_state(html)
            note = _extract_note_from_state(data)
            if note and note.get("title"):
                note["_source_url"] = page_url
                note["_extraction_method"] = "ssr"
                return note
        except Exception:
            continue

    raise RuntimeError(
        "小红书页面不含服务端渲染数据（CSR 页面）。"
        "笔记内容需要小红书登录 Cookie 才能获取。"
    )


# ---------------------------------------------------------------------------
# Stage 2: Signed API (needs login cookie)
# ---------------------------------------------------------------------------

_XHSHOW_AVAILABLE = False
try:
    from xhshow import Xhshow
    _XHSHOW_AVAILABLE = True
except ImportError:
    pass


def _scrape_api(url: str, cookie_str: str = "") -> dict[str, Any]:
    """Try to fetch note detail via XHS internal API with xhshow signing.

    Requires a valid a1 cookie from a logged-in 小红书 session.
    Without a login cookie, the API returns code -101 (not logged in).

    Args:
        url: 小红书 note URL
        cookie_str: Optional cookie string from a logged-in session.
                    Should contain at minimum 'a1'. Can also include
                    'web_session', 'webId', etc.

    Raises RuntimeError with actionable message.
    """
    if not _XHSHOW_AVAILABLE:
        raise RuntimeError(
            "小红书 API 提取需要 xhshow 库。请安装: pip install xhshow"
        )

    note_id = extract_note_id(url)
    if not note_id:
        raise RuntimeError(f"无法从链接中提取小红书笔记 ID: {url[:80]}")

    # Build cookies dict from string or from request
    cookies: dict[str, str] = {}
    if cookie_str:
        for part in cookie_str.split(";"):
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                cookies[k.strip()] = v.strip()

    # If no a1 cookie, try to get one from a page visit first
    if "a1" not in cookies:
        try:
            cj = CookieJar()
            opener = urllib.request.build_opener(
                urllib.request.HTTPCookieProcessor(cj)
            )
            req = urllib.request.Request(
                "https://www.xiaohongshu.com/explore",
                headers={
                    "User-Agent": DESKTOP_UA,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            )
            opener.open(req, timeout=15)
            for c in cj:
                cookies[c.name] = c.value
        except Exception:
            pass  # Continue without — signing library will error

    # Generate a1 if still missing (will likely fail with auth error but
    # at least gives us a validly-signed request to see the error)
    if "a1" not in cookies:
        cookies["a1"] = _generate_a1()

    # Sign and send the feed API request
    try:
        encipher = Xhshow()
        signed_headers = encipher.sign_headers_post(
            uri="/api/sns/web/v1/feed",
            cookies=cookies,
            payload={
                "source_note_id": note_id,
                "image_formats": ["jpg", "webp", "avif"],
                "extra": {"need_body_topic": 1},
            },
        )
    except Exception as e:
        raise RuntimeError(f"小红书 API 签名失败: {e}")

    all_headers = {
        "User-Agent": DESKTOP_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://www.xiaohongshu.com",
        "Referer": "https://www.xiaohongshu.com/",
    }
    all_headers.update(signed_headers)

    payload = json.dumps({
        "source_note_id": note_id,
        "image_formats": ["jpg", "webp", "avif"],
        "extra": {"need_body_topic": 1},
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
        data=payload,
        headers=all_headers,
    )

    try:
        resp = urllib.request.urlopen(req, timeout=15)
        result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"小红书 API 请求失败 (HTTP {e.code}): {body[:300]}")
    except Exception as e:
        raise RuntimeError(f"小红书 API 请求失败: {e}")

    code = result.get("code", -1)
    success = result.get("success", False)

    if not success or code != 0:
        msg = result.get("msg", "未知错误")
        if code == -101:
            raise RuntimeError(
                "小红书 API 要求登录。请在小红书网页版登录后，"
                "将 Cookie 字符串设置到环境变量 XHS_COOKIE，"
                "或通过请求参数传入 cookie。"
                f"\nAPI 返回: code={code}, msg={msg}"
            )
        raise RuntimeError(
            f"小红书 API 返回错误: code={code}, msg={msg}"
        )

    # Extract note data from response
    data = result.get("data", {})
    items = data.get("items", [])
    if not items:
        raise RuntimeError("小红书 API 返回空数据。笔记可能已删除或不可访问。")

    note_item = items[0]
    note_card = note_item.get("note_card", note_item)

    note_data = {
        "note_id": note_card.get("note_id") or note_card.get("id") or note_id,
        "title": note_card.get("title") or note_card.get("display_title", ""),
        "desc": note_card.get("desc", ""),
        "type": note_card.get("type", "normal"),
        "author": "",
        "images": [],
        "tags": [],
        "_extraction_method": "api",
    }

    # Author info
    user = note_card.get("user", {})
    if user:
        note_data["author"] = user.get("nickname") or user.get("nick_name", "")
        note_data["author_id"] = user.get("user_id", "")

    # Images
    image_list = note_card.get("image_list", [])
    for img in image_list:
        if isinstance(img, dict):
            url_info = img.get("url_default") or img.get("url") or img.get("info_list", [{}])[0].get("url", "")
            if url_info:
                note_data["images"].append(url_info)

    # Tags
    tag_list = note_card.get("tag_list", [])
    for tag in tag_list:
        if isinstance(tag, dict):
            note_data["tags"].append(tag.get("name", ""))
        elif isinstance(tag, str):
            note_data["tags"].append(tag)

    return note_data


# ---------------------------------------------------------------------------
# Stage 3: Combined extraction (tries methods in order)
# ---------------------------------------------------------------------------

def parse_xhs_note(
    url: str,
    cookie: str = "",
) -> dict[str, Any]:
    """Extract 小红书 note metadata: title, content, author, images, etc.

    Tries, in order:
    1. SSR HTML scraping (no auth, works for some rednote.com pages)
    2. Signed API call (requires xhshow + login cookie)

    Args:
        url: 小红书 note URL (xiaohongshu.com, rednote.com, or xhslink.com)
        cookie: Optional login cookie string for API authentication.
                Should contain a valid 'a1' cookie at minimum.

    Returns:
        dict with keys: note_id, title, desc, type, author, images, tags

    Raises:
        RuntimeError: If all extraction methods fail, with a descriptive message.
        NotImplementedError: If the URL is not a recognized XHS link.
    """
    # Follow short links first
    if "xhslink.com" in url:
        try:
            url = _follow_short_link(url)
        except Exception as e:
            raise RuntimeError(f"无法解析小红书短链接: {e}")

    if not is_xhs_url(url):
        raise NotImplementedError(
            f"不是小红书链接，当前仅支持 xiaohongshu.com / rednote.com / xhslink.com。"
            f"链接: {url[:80]}..."
        )

    errors: list[str] = []

    # Method 1: SSR scrape
    try:
        return _scrape_ssr(url)
    except RuntimeError as e:
        errors.append(f"SSR 抓取: {e}")

    # Method 2: Signed API
    try:
        return _scrape_api(url, cookie)
    except RuntimeError as e:
        errors.append(f"API 提取: {e}")

    # All methods failed
    raise RuntimeError(
        "无法提取小红书笔记内容。\n\n"
        "原因汇总:\n" + "\n".join(f"  - {err}" for err in errors) +
        "\n\n提示:\n"
        "  1. 小红书大部分内容需要登录才能查看。\n"
        "  2. 请在小红书网页版 (xiaohongshu.com) 登录后，\n"
        "     从浏览器开发者工具 → Application → Cookies 中复制 Cookie 字符串。\n"
        "  3. 将 Cookie 设置到环境变量 XHS_COOKIE 后重试。\n"
        "  4. 示例: export XHS_COOKIE=\"a1=...; webId=...; web_session=...\""
    )


def extract_xhs_content(url: str, cookie: str = "") -> str:
    """Get the full text content of a 小红书 note.

    This is the primary function called by the extraction pipeline.
    For 小红书, the content is the note text itself (no ASR needed).

    Args:
        url: 小红书 note URL
        cookie: Optional login cookie string

    Returns:
        Full text content of the note (title + description).
    """
    note = parse_xhs_note(url, cookie=cookie)

    parts: list[str] = []

    title = note.get("title", "")
    if title:
        parts.append(title)

    desc = note.get("desc", "")
    if desc:
        parts.append(desc)

    # Add image URLs as a reference
    images = note.get("images", [])
    if images:
        parts.append(f"\n[图片数量: {len(images)}]")

    tags = note.get("tags", [])
    if tags:
        parts.append(f"[标签: {', '.join(tags)}]")

    return "\n\n".join(parts) if parts else ""
