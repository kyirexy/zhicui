"""官网案例管理及私有媒体；上传先校验，提交成功后才释放旧文件。"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import quote
import uuid
import warnings

from fastapi import HTTPException, Request
from PIL import Image
from python_multipart.multipart import MultipartParser, parse_options_header
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.admin_audit_log import AdminAuditLog
from app.models.showcase_case import ShowcaseCase, utcnow

logger = logging.getLogger(__name__)
MIB = 1024 * 1024
MEDIA_LIMITS = {"video/mp4": 100 * MIB, "image/gif": 20 * MIB}
BODY_LIMIT = 100 * MIB + 64 * 1024
SAFE_NAME = re.compile(r"^[a-f0-9]{32}\.(?:mp4|gif|jpg|part)$")
TEXT_FIELDS = ("title", "industry", "person_name", "role", "summary", "challenge", "workflow", "outcome", "source_url", "source_label")


def media_root() -> Path:
    configured = settings.CASE_MEDIA_DIR.strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if not settings.DATABASE_URL.startswith("sqlite"):
        return Path("/var/lib/zhicui-case-media")
    return Path(__file__).resolve().parents[2] / "data" / "case-media"


def media_path(name: str | None) -> Path:
    if not name or not SAFE_NAME.fullmatch(name):
        raise HTTPException(404, "案例媒体不存在")
    root = media_root().resolve()
    path = root / name
    if path.is_symlink() or path.resolve().parent != root:
        raise HTTPException(404, "案例媒体不存在")
    return path


def remove_file(name: str | None) -> None:
    if not name:
        return
    try:
        media_path(name).unlink(missing_ok=True)
    except (OSError, HTTPException):
        # 不回滚已经提交的案例；下次上传在持有目录锁时回收无引用文件。
        logger.warning("案例旧媒体清理失败，将在后续上传重试")


@contextmanager
def upload_lock(root: Path):
    """跨进程串行上传，避免并发绕过磁盘总额限制；不阻塞事件循环。"""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (root / ".upload.lock").open("a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise HTTPException(409, "案例正在保存或备份，请稍后再试") from exc
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"0")
                lock.flush()
        else:
            import fcntl
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise HTTPException(409, "案例正在保存或备份，请稍后再试") from exc
        locked = True
        yield
    finally:
        if locked:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def reclaim_orphans(db: Session, root: Path) -> None:
    """仅在上传锁内回收本服务生成且数据库不再引用的文件。"""
    referenced = {name for row in db.query(ShowcaseCase.media_name, ShowcaseCase.poster_name) for name in row if name}
    for path in root.iterdir():
        if SAFE_NAME.fullmatch(path.name) and path.name not in referenced and not path.is_symlink():
            path.unlink(missing_ok=True)


def check_storage(root: Path, *, used: int, incoming: int = 0) -> None:
    if used + incoming > max(1, settings.CASE_MEDIA_MAX_TOTAL_MB) * MIB:
        raise HTTPException(507, "案例媒体空间已满，请删除不用的案例后重试")
    if shutil.disk_usage(root).free - incoming < max(1, settings.CASE_MEDIA_MIN_FREE_MB) * MIB:
        raise HTTPException(507, "服务器剩余空间不足，请联系管理员后重试")


class MultipartMediaWriter:
    """只接收一个 file，原始 multipart 边界/头部也有独立上限。"""
    def __init__(self, target, root: Path, used: int):
        self.target, self.root, self.used = target, root, used
        self.size = 0
        self.mime = ""
        self.parts = 0
        self.finished = False
        self.part_finished = False
        self.headers: dict[bytes, bytes] = {}
        self.header_name = bytearray()
        self.header_value = bytearray()
        self.header_bytes = 0
        self.last_space_check = 0

    def on_part_begin(self):
        self.parts += 1
        if self.parts > 1:
            raise HTTPException(400, "每次只能上传一个 file 文件")

    def on_header_field(self, data, start, end):
        self._header_limit(end - start)
        self.header_name.extend(data[start:end])

    def on_header_value(self, data, start, end):
        self._header_limit(end - start)
        self.header_value.extend(data[start:end])

    def _header_limit(self, amount: int):
        self.header_bytes += amount
        if self.header_bytes > 8192:
            raise HTTPException(400, "上传文件头过长")

    def on_header_end(self):
        key = bytes(self.header_name).lower()
        if key in self.headers:
            raise HTTPException(400, "上传文件头重复")
        self.headers[key] = bytes(self.header_value)
        self.header_name.clear()
        self.header_value.clear()

    def on_headers_finished(self):
        disposition, options = parse_options_header(self.headers.get(b"content-disposition", b""))
        if disposition != b"form-data" or options.get(b"name") != b"file" or b"filename" not in options:
            raise HTTPException(400, "请使用名为 file 的文件字段上传")
        mime, _ = parse_options_header(self.headers.get(b"content-type", b""))
        self.mime = mime.decode("ascii", errors="replace").lower()
        if self.mime not in MEDIA_LIMITS:
            raise HTTPException(400, "仅支持 MP4 视频或 GIF 动图")

    def on_part_data(self, data, start, end):
        amount = end - start
        if not self.mime:
            raise HTTPException(400, "缺少有效媒体类型")
        if self.size + amount > MEDIA_LIMITS[self.mime]:
            raise HTTPException(413, "MP4 不得超过 100 MB，GIF 不得超过 20 MB")
        if self.used + self.size + amount > max(1, settings.CASE_MEDIA_MAX_TOTAL_MB) * MIB:
            raise HTTPException(507, "案例媒体空间已满，请删除不用的案例后重试")
        if self.size == 0 or self.size - self.last_space_check >= MIB:
            check_storage(self.root, used=self.used + self.size, incoming=amount + MIB)
            self.last_space_check = self.size
        self.target.write(data[start:end])
        self.size += amount

    def on_part_end(self):
        self.part_finished = True

    def on_end(self):
        self.finished = True

    def callbacks(self):
        return {name: getattr(self, name) for name in (
            "on_part_begin", "on_header_field", "on_header_value", "on_header_end",
            "on_headers_finished", "on_part_data", "on_part_end", "on_end",
        )}


async def receive_media(request: Request, path: Path, used: int) -> tuple[str, int]:
    content_type, options = parse_options_header(request.headers.get("content-type", ""))
    boundary = options.get(b"boundary", b"")
    if content_type != b"multipart/form-data" or not 1 <= len(boundary) <= 70:
        raise HTTPException(400, "请使用有效的 multipart/form-data 上传")
    length = request.headers.get("content-length")
    if length is not None:
        try:
            declared = int(length)
        except ValueError as exc:
            raise HTTPException(400, "上传长度无效") from exc
        if declared < 0 or declared > BODY_LIMIT:
            raise HTTPException(413, "上传请求超过 100 MB 限制")
        check_storage(path.parent, used=used, incoming=declared)
    total = 0
    with path.open("xb") as target:
        os.chmod(path, 0o600)
        writer = MultipartMediaWriter(target, path.parent, used)
        parser = MultipartParser(boundary, writer.callbacks())
        try:
            async with asyncio.timeout(180):
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > BODY_LIMIT:
                        raise HTTPException(413, "上传请求超过 100 MB 限制")
                    # 分块处理，即使 ASGI 服务器交付了很大的单个块也不额外复制整段。
                    for offset in range(0, len(chunk), 256 * 1024):
                        parser.write(chunk[offset:offset + 256 * 1024])
                parser.finalize()
        except TimeoutError as exc:
            raise HTTPException(408, "上传超时，请缩小文件后重试") from exc
        except HTTPException:
            raise
        except OSError as exc:
            raise HTTPException(507, "媒体写入失败，请检查服务器可用空间和目录权限") from exc
        except Exception as exc:
            raise HTTPException(400, "上传内容不完整或格式无效") from exc
        if not writer.finished or not writer.part_finished or not writer.size:
            raise HTTPException(400, "上传文件为空或传输不完整")
        target.flush()
        os.fsync(target.fileno())
        return writer.mime, writer.size


def _run_media_tool(args: list[str], timeout: int = 45) -> bytes:
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(400, "媒体校验未完成，请使用较短且完整的 MP4 或 GIF") from exc
    if result.returncode:
        raise HTTPException(400, "媒体无法完整解码，请重新导出 MP4 或 GIF")
    return result.stdout


def validate_and_poster(path: Path, mime: str, poster: Path) -> None:
    """验证签名和实际解码结果，并生成不包含元数据的静止首帧。"""
    with path.open("rb") as source:
        signature = source.read(16)
    try:
        if mime == "image/gif":
            if signature[:6] not in {b"GIF87a", b"GIF89a"}:
                raise HTTPException(400, "文件内容不是有效 GIF")
            with path.open("rb") as source:
                source.seek(-1, os.SEEK_END)
                if source.read(1) != b";":
                    raise HTTPException(400, "GIF 文件不完整，请重新导出后上传")
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    if image.format != "GIF" or not 0 < max(image.size) <= 4096:
                        raise HTTPException(400, "GIF 尺寸无效，最长边不得超过 4096 像素")
                    first = None
                    pixels = 0
                    for index in range(1001):
                        try:
                            image.seek(index)
                        except EOFError:
                            break
                        pixels += image.width * image.height
                        if index == 1000 or pixels > 500_000_000:
                            raise HTTPException(400, "GIF 解码体积过大，请缩短或降低分辨率")
                        image.load()
                        if first is None:
                            first = image.convert("RGB")
                    if first is None:
                        raise HTTPException(400, "GIF 没有可用画面")
                    first.thumbnail((1600, 1600))
                    first.save(poster, format="JPEG", quality=82, optimize=True)
        else:
            if signature[4:8] != b"ftyp":
                raise HTTPException(400, "文件内容不是有效 MP4")
            ffprobe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
            if not ffprobe or not ffmpeg:
                raise HTTPException(503, "服务器媒体校验组件暂不可用，请联系管理员")
            metadata = json.loads(_run_media_tool([
                ffprobe, "-v", "error", "-protocol_whitelist", "file", "-show_entries",
                "stream=codec_type,codec_name,width,height:format=format_name,duration", "-of", "json", str(path),
            ], 15))
            videos = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
            if not videos or "mp4" not in metadata.get("format", {}).get("format_name", ""):
                raise HTTPException(400, "MP4 必须包含有效视频画面")
            if any(stream.get("codec_name") != "h264" for stream in videos):
                raise HTTPException(400, "请导出 H.264 编码的 MP4，确保手机和浏览器可以播放")
            audios = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "audio"]
            if any(stream.get("codec_name") not in {"aac", "mp3"} for stream in audios):
                raise HTTPException(400, "MP4 音频请使用 AAC 或 MP3 编码，也可以上传无声视频")
            if not 0 < float(metadata.get("format", {}).get("duration", 0)) <= 1800:
                raise HTTPException(400, "MP4 时长须在 30 分钟以内")
            if any(not 0 < max(int(item.get("width", 0)), int(item.get("height", 0))) <= 4096 for item in videos):
                raise HTTPException(400, "视频尺寸无效，最长边不得超过 4096 像素")
            _run_media_tool([ffmpeg, "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
                             "-threads", "2", "-protocol_whitelist", "file", "-i", str(path),
                             "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], 60)
            _run_media_tool([ffmpeg, "-nostdin", "-v", "error", "-threads", "2", "-protocol_whitelist", "file",
                             "-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-vf",
                             "scale=1600:1600:force_original_aspect_ratio=decrease", "-q:v", "3", "-y", str(poster)], 20)
            with Image.open(poster) as generated:
                generated.load()
                generated.convert("RGB").save(poster, format="JPEG", quality=82, optimize=True)
        os.chmod(poster, 0o600)
    except HTTPException:
        raise
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(400, "媒体损坏或无法解码，请重新导出后上传") from exc


def get_case(db: Session, case_id: int, *, public: bool = False, lock: bool = False) -> ShowcaseCase:
    query = db.query(ShowcaseCase).filter(ShowcaseCase.id == case_id)
    if public:
        query = query.filter(ShowcaseCase.published.is_(True), ShowcaseCase.authenticity_confirmed.is_(True))
    if lock:
        query = query.with_for_update()
    item = query.populate_existing().first()
    if not item:
        raise HTTPException(404, "案例不存在")
    return item


def as_dict(item: ShowcaseCase, *, admin: bool = False) -> dict:
    version = quote(item.updated_at.isoformat(), safe="")
    public = item.published and item.authenticity_confirmed
    result = {name: getattr(item, name) for name in TEXT_FIELDS}
    result.update({
        "id": item.id, "authenticity_confirmed": item.authenticity_confirmed,
        "published": item.published, "sort_order": item.sort_order,
        "media_type": item.media_type, "media_size": item.media_size,
        "media_url": f"/api/showcase-cases/{item.id}/media?v={version}" if public and item.media_name else None,
        "poster_url": f"/api/showcase-cases/{item.id}/poster?v={version}" if public and item.poster_name else None,
        "updated_at": item.updated_at.isoformat(),
    })
    if admin:
        result["preview_url"] = f"/api/admin/showcase-cases/{item.id}/media?v={version}" if item.media_name else None
        result["preview_poster_url"] = f"/api/admin/showcase-cases/{item.id}/poster?v={version}" if item.poster_name else None
    return result


def ensure_publishable(item: ShowcaseCase) -> None:
    if not item.published:
        return
    if not all(getattr(item, name, "").strip() for name in ("title", "industry", "summary")):
        raise HTTPException(400, "发布前请填写标题、行业和案例摘要")
    if not item.authenticity_confirmed:
        raise HTTPException(400, "发布前请确认案例真实且已获得展示授权")
    if not item.media_name or not item.poster_name or not media_path(item.media_name).is_file() or not media_path(item.poster_name).is_file():
        raise HTTPException(400, "发布前请上传并验证 MP4 或 GIF 媒体")


def audit(db: Session, admin_id: str, action: str, item: ShowcaseCase, detail: dict) -> None:
    # 与案例 mutation 同事务提交，避免案例成功而审计缺失。
    db.add(AdminAuditLog(admin_user_id=admin_id, action=action, target_type="showcase_case",
                         target_id=str(item.id), detail=json.dumps(detail, ensure_ascii=False)))


async def replace_media(db: Session, request: Request, case_id: int, admin_id: str) -> ShowcaseCase:
    get_case(db, case_id)
    root = media_root()
    token = uuid.uuid4().hex
    partial, poster = root / f"{token}.part", root / f"{token}.jpg"
    final = None
    committed = False
    try:
        with upload_lock(root):
            reclaim_orphans(db, root)
            used = sum(path.stat().st_size for path in root.iterdir() if path.is_file() and not path.is_symlink())
            check_storage(root, used=used, incoming=MIB)
            mime, size = await receive_media(request, partial, used)
            check_storage(root, used=used + size, incoming=8 * MIB)
            validation = asyncio.create_task(asyncio.to_thread(validate_and_poster, partial, mime, poster))
            try:
                await asyncio.shield(validation)
            except asyncio.CancelledError:
                # 等解码线程退出再清理，避免断连后线程重新生成遗留首帧。
                await validation
                raise
            check_storage(root, used=used + size + poster.stat().st_size)
            item = get_case(db, case_id, lock=True)
            old_media, old_poster = item.media_name, item.poster_name
            final = root / f"{token}.{'mp4' if mime == 'video/mp4' else 'gif'}"
            partial.replace(final)
            item.media_name, item.poster_name = final.name, poster.name
            item.media_type, item.media_size = mime, size
            item.published = False
            item.authenticity_confirmed = False
            item.updated_at = utcnow()
            audit(db, admin_id, "showcase_media_replace", item, {"media_type": mime, "media_size": size, "published": False})
            db.commit()
            committed = True
            remove_file(old_media)
            remove_file(old_poster)
            return item
    except BaseException:
        db.rollback()
        raise
    finally:
        if not committed:
            partial.unlink(missing_ok=True)
            poster.unlink(missing_ok=True)
            if final:
                final.unlink(missing_ok=True)
