"""真实案例发布边界、媒体验证、失败原子性与空间限制回归。"""
from __future__ import annotations

import asyncio
from io import BytesIO
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "showcase-cms-test-secret")

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.showcase_case_routes import router
from app.core.auth import get_current_admin
from app.core.database import get_db
from app.models.admin_audit_log import AdminAuditLog
from app.models.showcase_case import ShowcaseCase
from app.services import showcase_case_service as service


def gif_bytes() -> bytes:
    target = BytesIO()
    first = Image.new("RGB", (32, 24), "green")
    second = Image.new("RGB", (32, 24), "blue")
    first.save(target, format="GIF", save_all=True, append_images=[second], duration=100, loop=0)
    return target.getvalue()


class ShowcaseCasesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = patch.multiple(service.settings, CASE_MEDIA_DIR=str(self.root), CASE_MEDIA_MAX_TOTAL_MB=1024, CASE_MEDIA_MIN_FREE_MB=1)
        self.config.start()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        ShowcaseCase.__table__.create(self.engine)
        AdminAuditLog.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.app = FastAPI()
        self.app.include_router(router)

        def database():
            with self.Session() as session:
                yield session

        def admin(request: Request):
            token = request.headers.get("authorization")
            if token == "Bearer user":
                raise HTTPException(403, "需要管理员权限")
            if token != "Bearer admin":
                raise HTTPException(401, "请先登录")
            return SimpleNamespace(id="test-admin")

        @self.app.exception_handler(HTTPException)
        async def envelope(_request, exc):
            return JSONResponse({"success": False, "data": None, "error": exc.detail}, status_code=exc.status_code)

        self.app.dependency_overrides[get_db] = database
        self.app.dependency_overrides[get_current_admin] = admin
        self.client = TestClient(self.app)
        self.headers = {"Authorization": "Bearer admin"}

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        self.config.stop()
        self.temp.cleanup()

    def create(self, **fields):
        response = self.client.post("/api/admin/showcase-cases", json={"title": "真实使用记录", "industry": "教育", "summary": "经本人确认的学习整理过程", **fields}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    def upload(self, case_id, content=None, mime="image/gif", filename="../../private-user.gif"):
        return self.client.post(f"/api/admin/showcase-cases/{case_id}/media", files={"file": (filename, gif_bytes() if content is None else content, mime)}, headers=self.headers)

    def publish(self, case_id):
        return self.client.patch(f"/api/admin/showcase-cases/{case_id}", json={"authenticity_confirmed": True, "published": True}, headers=self.headers)

    def test_drafts_and_media_require_admin_and_published_media_supports_ranges(self):
        self.assertEqual(self.client.get("/api/showcase-cases").json()["data"], [])
        item = self.create()
        for headers, status in [({}, 401), ({"Authorization": "Bearer user"}, 403)]:
            self.assertEqual(self.client.get("/api/admin/showcase-cases", headers=headers).status_code, status)
            self.assertEqual(self.client.post(f"/api/admin/showcase-cases/{item['id']}/media", content=b"bad", headers=headers).status_code, status)
        uploaded = self.upload(item["id"])
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        case = uploaded.json()["data"]
        self.assertIsNone(case["media_url"])
        self.assertIsNone(case["poster_url"])
        self.assertNotIn("private-user", uploaded.text)
        self.assertNotIn("media_name", case)
        self.assertEqual(self.client.get(case["preview_url"]).status_code, 401)
        self.assertEqual(self.client.get(case["preview_url"], headers=self.headers).content, gif_bytes())
        self.assertEqual(self.client.get(f"/api/showcase-cases/{item['id']}/media").status_code, 404)
        self.assertEqual(self.client.get(f"/api/showcase-cases/{item['id']}/poster").status_code, 404)
        self.assertEqual(self.publish(item["id"]).status_code, 200)
        public = self.client.get("/api/showcase-cases").json()["data"][0]
        self.assertNotIn("preview_url", public)
        self.assertEqual(self.client.get(public["poster_url"]).headers["content-type"], "image/jpeg")
        ranged = self.client.get(public["media_url"], headers={"Range": "bytes=0-5"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.content, b"GIF89a")
        self.assertIn("no-store", ranged.headers["cache-control"])
        self.client.patch(f"/api/admin/showcase-cases/{item['id']}", json={"published": False}, headers=self.headers)
        self.assertEqual(self.client.get(public["media_url"]).status_code, 404)
        self.assertEqual(self.client.get(public["poster_url"]).status_code, 404)

    def test_publish_validation_partial_updates_and_sort_order(self):
        item = self.create(sort_order=5)
        self.assertEqual(self.publish(item["id"]).status_code, 400)
        self.assertEqual(self.upload(item["id"]).status_code, 200)
        missing_confirmation = self.client.patch(f"/api/admin/showcase-cases/{item['id']}", json={"published": True}, headers=self.headers)
        self.assertEqual(missing_confirmation.status_code, 400)
        self.assertEqual(self.publish(item["id"]).status_code, 200)
        renamed = self.client.patch(f"/api/admin/showcase-cases/{item['id']}", json={"title": "新的真实记录", "published": True, "authenticity_confirmed": True}, headers=self.headers).json()["data"]
        self.assertFalse(renamed["published"])
        self.assertFalse(renamed["authenticity_confirmed"])
        self.assertEqual(renamed["summary"], item["summary"])
        self.assertEqual(self.publish(item["id"]).status_code, 200)
        other = self.create(sort_order=-1)
        self.upload(other["id"])
        self.publish(other["id"])
        self.assertEqual([row["id"] for row in self.client.get("/api/showcase-cases").json()["data"]], [other["id"], item["id"]])
        for invalid in [{"source_url": "javascript:alert(1)"}, {"source_url": "https://user:pass@example.org"}, {"sort_order": 10001}, {"published": "true"}, {"media_name": "attack.gif"}]:
            self.assertEqual(self.client.patch(f"/api/admin/showcase-cases/{item['id']}", json=invalid, headers=self.headers).status_code, 422)

    def test_replacement_and_delete_release_old_files_and_audit(self):
        item = self.create()
        self.upload(item["id"])
        self.publish(item["id"])
        old_files = {path.name for path in self.root.iterdir() if service.SAFE_NAME.fullmatch(path.name)}
        replaced = self.upload(item["id"]).json()["data"]
        self.assertFalse(replaced["published"])
        self.assertFalse(replaced["authenticity_confirmed"])
        self.assertTrue(all(not (self.root / name).exists() for name in old_files))
        self.assertEqual(self.client.delete(f"/api/admin/showcase-cases/{item['id']}", headers=self.headers).status_code, 200)
        self.assertFalse(any(service.SAFE_NAME.fullmatch(path.name) for path in self.root.iterdir()))
        with self.Session() as db:
            self.assertEqual(db.query(ShowcaseCase).count(), 0)
            self.assertEqual(db.query(AdminAuditLog).filter(AdminAuditLog.action == "showcase_media_replace").count(), 2)
            self.assertEqual(db.query(AdminAuditLog).filter(AdminAuditLog.action == "showcase_delete").count(), 1)

    def test_invalid_and_oversized_media_keep_published_content_and_cleanup(self):
        item = self.create()
        self.upload(item["id"])
        before = self.publish(item["id"]).json()["data"]
        for content, mime in [(b"<script>alert(1)</script>", "image/gif"), (b"GIF89a broken", "image/gif"), (gif_bytes()[:-1], "image/gif"), (b"\x00\x00\x00\x18ftypisom corrupt", "video/mp4"), (gif_bytes(), "image/png")]:
            response = self.upload(item["id"], content, mime)
            self.assertEqual(response.status_code, 400, response.text)
        with patch.dict(service.MEDIA_LIMITS, {"image/gif": 10}):
            self.assertEqual(self.upload(item["id"]).status_code, 413)
        self.assertEqual(self.client.get(before["media_url"]).content, gif_bytes())
        self.assertEqual(len([p for p in self.root.iterdir() if service.SAFE_NAME.fullmatch(p.name)]), 2)

    def test_commit_failure_preserves_previous_media(self):
        item = self.create()
        self.upload(item["id"])
        before = self.publish(item["id"]).json()["data"]
        with patch("sqlalchemy.orm.Session.commit", side_effect=RuntimeError("test commit failure")):
            with self.assertRaises(RuntimeError):
                self.upload(item["id"])
        self.assertEqual(self.client.get(before["media_url"]).content, gif_bytes())
        self.assertEqual(len([p for p in self.root.iterdir() if service.SAFE_NAME.fullmatch(p.name)]), 2)

    def test_disk_reserve_quota_and_backup_lock_block_upload(self):
        item = self.create()
        with patch.object(service.shutil, "disk_usage", return_value=SimpleNamespace(free=100)):
            self.assertEqual(self.upload(item["id"]).status_code, 507)
        with patch.object(service.settings, "CASE_MEDIA_MAX_TOTAL_MB", 1):
            self.assertEqual(self.upload(item["id"]).status_code, 507)
        with service.upload_lock(self.root):
            self.assertEqual(self.upload(item["id"]).status_code, 409)
            self.assertEqual(self.client.patch(f"/api/admin/showcase-cases/{item['id']}", json={"sort_order": 2}, headers=self.headers).status_code, 409)
            self.assertEqual(self.client.delete(f"/api/admin/showcase-cases/{item['id']}", headers=self.headers).status_code, 409)
        self.assertFalse(any(p.suffix == ".part" for p in self.root.iterdir()))

    def test_stream_limit_truncation_and_multiple_files_are_rejected(self):
        item = self.create()
        multiple = self.client.post(f"/api/admin/showcase-cases/{item['id']}/media", files=[("file", ("a.gif", gif_bytes(), "image/gif")), ("file", ("b.gif", gif_bytes(), "image/gif"))], headers=self.headers)
        self.assertEqual(multiple.status_code, 400)

        async def receive_limited():
            chunks = iter([{"type": "http.request", "body": b"x" * 20, "more_body": False}])
            async def receive():
                return next(chunks)
            request = Request({"type": "http", "headers": [(b"content-type", b"multipart/form-data; boundary=abc")]}, receive)
            with patch.object(service, "BODY_LIMIT", 10):
                await service.receive_media(request, self.root / ("a" * 32 + ".part"), 0)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(receive_limited())
        self.assertEqual(caught.exception.status_code, 413)
        with self.assertRaises(HTTPException):
            service.media_path("../../secret.gif")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要已有 ffmpeg/ffprobe")
    def test_real_mp4_decodes_and_generates_jpeg_poster(self):
        item = self.create()
        fixture = self.root / "test-fixture.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x24:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(fixture)], check=True, timeout=20)
        response = self.upload(item["id"], fixture.read_bytes(), "video/mp4", "private-original.mp4")
        self.assertEqual(response.status_code, 200, response.text)
        case = response.json()["data"]
        self.assertEqual(case["media_type"], "video/mp4")
        poster = self.client.get(case["preview_poster_url"], headers=self.headers)
        with Image.open(BytesIO(poster.content)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertLessEqual(max(image.size), 1600)
        self.assertEqual(self.publish(item["id"]).status_code, 200)
        ranged = self.client.get(f"/api/showcase-cases/{item['id']}/media", headers={"Range": "bytes=0-15"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.content, fixture.read_bytes()[:16])
        unsupported = self.root / "unsupported-codec.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x24:d=0.2", "-c:v", "mpeg4", "-y", str(unsupported)], check=True, timeout=20)
        rejected = self.upload(item["id"], unsupported.read_bytes(), "video/mp4")
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("H.264", rejected.json()["error"])


if __name__ == "__main__":
    unittest.main()
