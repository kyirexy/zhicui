"""使用当前用户绑定读取公开投稿元数据，不读取服务账号或下载媒体。"""
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


def discover(user_id, profile_url, *, limit=None, on_item=None, should_cancel=None):
    parsed = urlparse(profile_url)
    match = re.fullmatch(r"/([1-9][0-9]{0,19})(?:/video)?/?", parsed.path)
    if parsed.scheme != "https" or parsed.hostname != "space.bilibili.com" or not match:
        raise binding.BilibiliBindingError("invalid_profile", "B站主页格式无效")
    with SessionLocal() as db:
        row = binding.require_binding(db, user_id)
        generation, identity = row.generation, row.platform_user_id
        cookies = binding.unseal(row.credential_encrypted)
    items, seen = [], set()
    target = min(50_000, max(1, int(limit))) if limit is not None else 50_000
    try:
        with binding.session(cookies) as client:
            nav = binding.api(client, "https://api.bilibili.com/x/web-interface/nav")
            if not nav.get("isLogin") or str(nav.get("mid")) != identity:
                raise binding.BilibiliBindingError("bilibili_login_required", "B站授权身份已失效，请重新绑定")
            page, total = 1, None
            while len(items) < target:
                if should_cancel and should_cancel():
                    raise binding.BilibiliBindingError("cancelled", "同步已取消")
                with SessionLocal() as db:
                    binding.require_binding(db, user_id, generation)
                data = binding.api(client, "https://api.bilibili.com/x/space/wbi/arc/search", _sign({
                    "mid": match[1], "ps": 30, "pn": page, "tid": 0, "order": "pubdate",
                }, nav))
                meta, listing = data.get("page"), data.get("list")
                videos = listing.get("vlist") if isinstance(listing, dict) else None
                count = meta.get("count") if isinstance(meta, dict) else None
                if not isinstance(count, int) or isinstance(count, bool) or count < 0 or not isinstance(videos, list):
                    raise binding.BilibiliBindingError("invalid_upstream_response", "B站投稿分页数据不完整")
                if total is not None and total != count:
                    raise binding.BilibiliBindingError("catalog_changed", "投稿数量在同步期间发生变化，请稍后重新同步")
                total = count
                for raw in videos:
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
                        published = datetime.fromtimestamp(int(raw["created"]), timezone.utc).isoformat()
                    except (ValueError, TypeError, KeyError, OverflowError, OSError):
                        published = None
                    item = {"external_id": bvid, "source_url": f"https://www.bilibili.com/video/{bvid}",
                            "title": str(raw.get("title") or "")[:300], "description": str(raw.get("description") or "")[:5000],
                            "cover_url": cover[:2048], "author_name": str(raw.get("author") or "")[:160],
                            "published_at": published, "duration_seconds": 0, "order_index": len(items), "parts": [], "media_type": "video"}
                    items.append(item)
                    if on_item:
                        on_item(item, len(items), total)
                    if len(items) >= target:
                        break
                if len(items) >= total or len(items) >= target:
                    break
                if not videos:
                    raise binding.BilibiliBindingError("catalog_incomplete", "B站投稿目录未读取完整，保留已有资料")
                page += 1
                time.sleep(0.6)
            if limit is None and (total is None or len(items) != total):
                raise binding.BilibiliBindingError("catalog_incomplete", "投稿数量超出本次安全上限，未标记全量完成")
            # 末页返回期间的断开/换绑也不能被当作本次成功。
            with SessionLocal() as db:
                binding.require_binding(db, user_id, generation)
            return {"items": items, "complete": len(items) == total, "total_count": total,
                    "failures": [], "connector": "bilibili-user-session"}
    except binding.BilibiliBindingError as exc:
        if exc.code == "bilibili_login_required":
            with SessionLocal() as db:
                binding.invalidate(db, user_id, generation)
        raise
