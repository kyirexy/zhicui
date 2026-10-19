"""读取公开投稿元数据；限量目录可匿名，不读取共用账号或下载媒体。"""
from datetime import datetime, timezone
import hashlib
import re
import time
from urllib.parse import urlencode, urlparse
from app.core.database import SessionLocal
from app.services import bilibili_binding_service as binding

_MIX = (46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52)


def _sign(params, nav):
    try:
        image = nav["wbi_img"]
        source = "".join(urlparse(image[k]).path.rsplit("/", 1)[1].split(".")[0] for k in ("img_url", "sub_url"))
        key = "".join(source[index] for index in _MIX)[:32]
    except (KeyError, TypeError, IndexError):
        raise binding.BilibiliBindingError("invalid_upstream_response", "B站请求签名信息无效", 502) from None
    signed = {k: re.sub(r"[!'()*]", "", str(v)) for k, v in {**params, "wts": int(time.time())}.items()}
    signed = dict(sorted(signed.items()))
    signed["w_rid"] = hashlib.md5((urlencode(signed) + key).encode()).hexdigest()
    return signed


def require_access(db, user_id, *, allow_public=False):
    """限量公开目录可匿名读取；已有凭据失效时必须停下，不能降级匿名。"""
    row = binding.get(db, user_id)
    if allow_public and (row is None or (
        row.status in {"disconnected", "pending"} and not row.credential_encrypted
    )):
        return None
    return binding.require_binding(db, user_id)


def _public_nav(client):
    """公开导航接口的未登录身份响应仍可提供普通 WBI 签名资料。"""
    response = client.get("https://api.bilibili.com/x/web-interface/nav", timeout=(5, 12), allow_redirects=False)
    if response.status_code in {403, 412, 429}:
        raise binding.BilibiliBindingError("bilibili_risk_control", "B站暂时限制请求，请在官方平台完成验证后再试")
    if response.status_code != 200:
        raise binding.BilibiliBindingError("bilibili_unavailable", "B站暂时无法连接", 502)
    try:
        payload = response.json()
    except ValueError:
        raise binding.BilibiliBindingError("invalid_upstream_response", "B站公开签名资料无效", 502) from None
    if not isinstance(payload, dict):
        raise binding.BilibiliBindingError("invalid_upstream_response", "B站公开签名资料无效", 502)
    if payload.get("code") in {-352, -401, -412, -799}:
        raise binding.BilibiliBindingError("bilibili_risk_control", "B站暂时限制请求，请在官方平台完成验证后再试")
    data = payload.get("data")
    if payload.get("code") not in {0, -101} or not isinstance(data, dict) or data.get("isLogin") is not False:
        raise binding.BilibiliBindingError("invalid_upstream_response", "B站未返回可核验的匿名签名资料", 502)
    _sign({}, data)
    return data


def discover(user_id, profile_url, *, limit=None, on_item=None, should_cancel=None, allow_public=False):
    parsed = urlparse(profile_url)
    match = re.fullmatch(r"/([1-9][0-9]{0,19})(?:/video)?/?", parsed.path)
    if (parsed.scheme != "https" or parsed.netloc != "space.bilibili.com" or not match
            or parsed.query or parsed.fragment):
        raise binding.BilibiliBindingError("invalid_profile", "B站主页格式无效")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100):
        raise binding.BilibiliBindingError("invalid_limit", "限量目录每次支持 1 至 100 条作品")
    if allow_public and limit is None:
        raise binding.BilibiliBindingError("invalid_limit", "公开目录必须指定本次读取上限")
    with SessionLocal() as db:
        row = require_access(db, user_id, allow_public=allow_public)
        generation, identity = (row.generation, row.platform_user_id) if row else (None, None)
        cookies = binding.unseal(row.credential_encrypted) if row else None
    items, seen = [], set()
    target = limit if limit is not None else 50_000
    page_size = min(30, target)
    try:
        with binding.session(cookies) as client:
            nav = binding.api(client, "https://api.bilibili.com/x/web-interface/nav") if identity else _public_nav(client)
            if identity and (not nav.get("isLogin") or str(nav.get("mid")) != identity):
                raise binding.BilibiliBindingError("bilibili_login_required", "B站授权身份已失效，请重新绑定")
            page, total, previous_published = 1, None, None
            while len(items) < target:
                if should_cancel and should_cancel():
                    raise binding.BilibiliBindingError("cancelled", "同步已取消")
                if identity:
                    with SessionLocal() as db:
                        binding.require_binding(db, user_id, generation)
                data = binding.api(client, "https://api.bilibili.com/x/space/wbi/arc/search", _sign({
                    "mid": match[1], "ps": page_size, "pn": page, "tid": 0, "order": "pubdate",
                }, nav))
                meta, listing = data.get("page"), data.get("list")
                videos = listing.get("vlist") if isinstance(listing, dict) else None
                count = meta.get("count") if isinstance(meta, dict) else None
                if not isinstance(count, int) or isinstance(count, bool) or count < 0 or not isinstance(videos, list):
                    raise binding.BilibiliBindingError("invalid_upstream_response", "B站投稿分页数据不完整")
                if total is not None and total != count:
                    raise binding.BilibiliBindingError("catalog_changed", "投稿数量在同步期间发生变化，请稍后重新同步")
                total = count
                if len(videos) > page_size or len(items) + len(videos) > total:
                    raise binding.BilibiliBindingError("invalid_upstream_response", "B站投稿分页数量不一致")
                short_page = limit is not None and len(videos) < min(page_size, total - len(items))
                for raw in videos:
                    if should_cancel and should_cancel():
                        raise binding.BilibiliBindingError("cancelled", "同步已取消")
                    if not isinstance(raw, dict) or not re.fullmatch(r"BV[0-9A-Za-z]{10}", str(raw.get("bvid") or "")):
                        raise binding.BilibiliBindingError("invalid_upstream_response", "B站返回了无法核验的投稿")
                    bvid = raw["bvid"]
                    if bvid in seen:
                        raise binding.BilibiliBindingError("catalog_changed", "B站投稿分页出现重复，已停止同步")
                    seen.add(bvid)
                    cover = str(raw.get("pic") or "")
                    cover = "https:" + cover if cover.startswith("//") else cover
                    cover_url = urlparse(cover)
                    if cover_url.hostname not in {"i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"} or cover_url.scheme not in {"https", "http"} or cover_url.query or cover_url.username:
                        cover = ""
                    try:
                        timestamp = int(raw["created"])
                        published = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
                    except (ValueError, TypeError, KeyError, OverflowError, OSError):
                        timestamp, published = None, None
                    if limit is not None:
                        # 只接受发布时间降序的唯一投稿，不能把置顶作品或缺失日期当作“最近”。
                        if (timestamp is None or timestamp <= 0 or isinstance(raw.get("created"), bool)
                                or raw.get("is_top") in (True, 1, "1")
                                or (previous_published is not None and timestamp > previous_published)):
                            raise binding.BilibiliBindingError("catalog_order_unverified", "B站投稿时间顺序无法核验，本次目录读取已停止")
                        previous_published = timestamp
                    item = {"external_id": bvid, "source_url": f"https://www.bilibili.com/video/{bvid}",
                            "title": str(raw.get("title") or "")[:300], "description": str(raw.get("description") or "")[:5000],
                            "cover_url": cover[:2048], "author_name": str(raw.get("author") or "")[:160],
                            "published_at": published, "duration_seconds": 0, "order_index": len(items), "parts": [], "media_type": "video"}
                    items.append(item)
                    if on_item:
                        on_item(item, len(items), total)
                    if len(items) >= target:
                        break
                if short_page:
                    raise binding.BilibiliBindingError("catalog_incomplete", "B站投稿分页缺少作品，未跳过缺项继续读取")
                if len(items) >= total or len(items) >= target:
                    break
                if not videos:
                    raise binding.BilibiliBindingError("catalog_incomplete", "B站投稿目录未读取完整，保留已有资料")
                page += 1
                time.sleep(0.6)
            if limit is None and (total is None or len(items) != total):
                raise binding.BilibiliBindingError("catalog_incomplete", "投稿数量超出本次安全上限，未标记全量完成")
            # 末页返回期间的断开/换绑也不能被当作本次成功。
            if identity:
                with SessionLocal() as db:
                    binding.require_binding(db, user_id, generation)
            return {"items": items, "complete": len(items) == total, "total_count": total,
                    "scope_complete": len(items) == min(target, total), "order": "published_desc",
                    "failures": [], "connector": "bilibili-user-session" if identity else "bilibili-public"}
    except binding.BilibiliBindingError as exc:
        if exc.code == "bilibili_login_required" and identity:
            with SessionLocal() as db:
                binding.invalidate(db, user_id, generation)
        raise
