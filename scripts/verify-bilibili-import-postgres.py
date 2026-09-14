"""在独立临时 PostgreSQL 验证真实进程崩溃恢复和全局并发上限；不访问平台或生产库。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone


def main():
    backend = Path(os.environ["BILI_TEST_BACKEND"]).resolve()
    artifact = Path(os.environ["BILI_TEST_ARTIFACT"]).resolve()
    artifact.mkdir(parents=True, exist_ok=True)
    dsn = os.environ["BILI_TEST_DSN"]
    from sqlalchemy.engine import make_url
    parsed = make_url(dsn)
    socket_path = str(parsed.query.get("host", ""))
    if (parsed.get_backend_name() != "postgresql" or parsed.database != "bilibili_job_test"
            or parsed.host or not socket_path.startswith("/tmp/zhicui-import-job-pg-")
            or not socket_path.endswith("/socket")):
        raise RuntimeError("仅允许唯一 /tmp 临时集群的 Unix socket 测试库")
    os.environ.update(DATABASE_URL=dsn, JWT_SECRET="isolated-bilibili-job-probe-only",
                      LITELLM_LOCAL_MODEL_COST_MAP="True")
    sys.path.insert(0, str(backend))
    import app.main  # 只注册模型，不启用全站 worker。
    from sqlalchemy import text
    from app.core.database import Base, engine, SessionLocal
    from app.models.user import User
    from app.services import platform_library_service as library
    from app.services import platform_import_job_service as jobs

    def fixture_extract(url, db):
        video_id = url.rstrip("/").rsplit("/", 1)[-1]
        with engine.begin() as connection:
            probe_id = connection.execute(text(
                "INSERT INTO extraction_probe(video_id, worker_pid, started_at) "
                "VALUES (:video_id, :pid, clock_timestamp()) RETURNING id"
            ), {"video_id": video_id, "pid": os.getpid()}).scalar_one()
        time.sleep(1.2)
        with engine.begin() as connection:
            connection.execute(text("UPDATE extraction_probe SET finished_at=clock_timestamp() WHERE id=:id"), {"id": probe_id})
        return ({"video_id": video_id, "title": "隔离测试视频", "author_name": "测试作者"},
                "【视频字幕】\n仅用于断线恢复验证的字幕内容。",
                {"source_kind": "platform-import", "platform": "bilibili", "source_url": url,
                 "cover_url": "https://i0.hdslb.com/isolated-fixture.jpg", "author_name": "测试作者",
                 "speech_ready": True, "transcript_source": "manual-subtitle"})

    library._extract_bilibili = fixture_extract
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if mode == "crash-worker":
        original = library.import_one

        def commit_then_pause(*args, **kwargs):
            result = original(*args, **kwargs)
            (artifact / "note-committed").write_text("ready", encoding="utf-8")
            while True:
                time.sleep(1)
            return result

        library.import_one = commit_then_pause
        jobs.process_job_item(sys.argv[2])
        return
    if mode == "worker":
        (artifact / f"worker-{sys.argv[2]}-ready").write_text("ready", encoding="utf-8")
        deadline = time.monotonic() + 90
        while not (artifact / "start-workers").exists():
            if time.monotonic() > deadline:
                raise RuntimeError("等待并发测试起点超时")
            time.sleep(0.05)
        jobs.runner.start()
        while not (artifact / "stop-workers").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        jobs.runner.stop()
        return

    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE extraction_probe(id serial PRIMARY KEY, video_id text, worker_pid integer, started_at timestamptz, finished_at timestamptz)"))
    with SessionLocal() as db:
        db.add(User(id="isolated-bili-owner", username="isolated-bili-owner", email="isolated@example.test", hashed_password="unused"))
        db.commit()
    stamp = datetime.now(timezone.utc).isoformat()
    values = [f"https://www.bilibili.com/video/BV1Probe{index:04d}" for index in range(4)]
    with SessionLocal() as db:
        first = jobs.create_job(db, user_id="isolated-bili-owner", values=values[:2], source_mode="collect",
                                source_synced_at=stamp, source_snapshot_size=4)
    assert first["pending"] == 2 and first["success"] == 0
    processes = []
    streams = []

    def start_worker(*args):
        stream = (artifact / ("-".join(args) + ".log")).open("w", encoding="utf-8")
        streams.append(stream)
        child = subprocess.Popen([sys.executable, __file__, *args], stdout=stream, stderr=subprocess.STDOUT)
        processes.append(child)
        return child

    def wait_for(check, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(0.1)
        raise AssertionError("隔离集成验证等待超时")

    try:
        crashing = start_worker("crash-worker", first["id"])
        wait_for(lambda: (artifact / "note-committed").exists())
        crashing.kill()
        crashing.wait(timeout=10)
        with SessionLocal() as db:
            interrupted = jobs.get_job(db, user_id="isolated-bili-owner", job_id=first["id"])
            assert interrupted["status"] == "running" and interrupted["pending"] == 2
            second = jobs.create_job(db, user_id="isolated-bili-owner", values=values[2:], source_mode="collect",
                                     source_synced_at=stamp, source_rank_offset=2, source_snapshot_size=4)
            replay = jobs.create_job(db, user_id="isolated-bili-owner", values=values[:2], source_mode="collect",
                                     source_synced_at=stamp, source_snapshot_size=4)
            assert replay["id"] == first["id"]
        for index in range(4):
            start_worker("worker", str(index))
        wait_for(lambda: all((artifact / f"worker-{index}-ready").exists() for index in range(4)))
        (artifact / "start-workers").write_text("start", encoding="utf-8")

        def complete():
            with SessionLocal() as db:
                return all(jobs.get_job(db, user_id="isolated-bili-owner", job_id=job_id)["status"] == "succeeded"
                           for job_id in [first["id"], second["id"]])

        wait_for(complete)
        with engine.connect() as connection:
            counts = dict(connection.execute(text("SELECT video_id,count(*) FROM extraction_probe GROUP BY video_id")).all())
            peak = connection.execute(text(
                "SELECT max(active) FROM (SELECT sum(delta) OVER (ORDER BY stamp,delta) AS active FROM ("
                "SELECT started_at AS stamp, 1 AS delta FROM extraction_probe UNION ALL "
                "SELECT finished_at AS stamp, -1 AS delta FROM extraction_probe WHERE finished_at IS NOT NULL"
                ") events) active_windows"
            )).scalar_one()
        assert len(counts) == 4 and set(counts.values()) == {1}, counts
        assert peak == 2, peak
        with SessionLocal() as db:
            completed_jobs = [jobs.get_job(db, user_id="isolated-bili-owner", job_id=job_id) for job_id in [first["id"], second["id"]]]
            ordered = library.list_notes(db, user_id="isolated-bili-owner", platform="bilibili", source_mode="collect")
            assert [row.video_id for row in ordered] == [value.rsplit("/", 1)[-1] for value in values]
            assert sum(job["success"] for job in completed_jobs) == 4
            assert sum(job["reused"] for job in completed_jobs) == 1
            assert not any("note" in entry.get("item", {}) for job in completed_jobs for entry in job["items"])
        report = {"verified": True, "isolated_postgresql": True, "network_platform_calls": 0,
                  "worker_processes": 4, "global_peak_extractions": int(peak), "total_extractions": sum(counts.values()),
                  "persisted_jobs": 2, "completed_items": 4, "reused_after_crash": 1,
                  "crash_after_note_commit": True, "order_preserved": True, "duplicate_post_same_job": True}
        (artifact / "postgres-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report), flush=True)
    finally:
        (artifact / "stop-workers").write_text("stop", encoding="utf-8")
        for child in processes:
            if child.poll() is None:
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)
        for stream in streams:
            stream.close()


if __name__ == "__main__":
    main()
