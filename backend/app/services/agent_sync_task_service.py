"""任务心跳只更新台账，不启动平台采集或媒体处理。"""
import json
from datetime import datetime, timezone
from sqlalchemy import select
from app.models.agent_sync_task import AgentSyncTask
from app.models.library_sync import LibrarySyncRun

ACTIVE = {"restoring", "reading", "saving", "waiting_for_user"}


def serialize(row, db=None):
    state = json.loads(row.state_json)
    if db is not None and state.get("batch_ids"):
        batches = list(db.scalars(select(LibrarySyncRun).where(LibrarySyncRun.user_id == row.user_id,
            LibrarySyncRun.id.in_(state["batch_ids"]))))
        for key, field in (("saved", "accepted"), ("created", "created"), ("reused", "reused"), ("skipped", "skipped"), ("failed", "failed_count")):
            state[key] = sum(getattr(batch, field) for batch in batches)
    stamp = row.updated_at.replace(tzinfo=row.updated_at.tzinfo or timezone.utc)
    stage = state.get("stage", "restoring")
    if stage in ACTIVE and (datetime.now(timezone.utc) - stamp).total_seconds() > 90:
        stage = "paused"
    status = "running" if stage in ACTIVE else {"completed": "succeeded", "partial": "partial"}.get(stage, "failed")
    return {**state, "id": row.id, "task_id": row.id, "task_source": "CLI / Agent", "stage": stage,
            "status": status, "source_mode": state.get("mode", "like"), "requested_count": state.get("requested", 0),
            "accepted": state.get("saved", 0), "failed_count": state.get("failed", 0),
            "pending_count": max(0, state.get("read", 0) - state.get("saved", 0) - state.get("failed", 0) - state.get("skipped", 0)),
            "started_at": row.created_at.isoformat(), "updated_at": stamp.isoformat(),
            "finished_at": stamp.isoformat() if stage in {"completed", "partial"} else None,
            "resume_command": f"zhicui sync resume {row.id}", "coverage": state.get("coverage", "partial")}


def update(db, *, user_id, payload):
    row = db.scalar(select(AgentSyncTask).where(AgentSyncTask.id == payload["task_id"]).with_for_update())
    if row and row.user_id != user_id:
        raise ValueError("同步任务不存在")
    if row is None:
        row = AgentSyncTask(id=payload["task_id"], user_id=user_id)
        db.add(row)
    previous = json.loads(row.state_json or "{}")
    for key in ("platform", "mode", "requested"):
        if key in previous and previous[key] != payload.get(key):
            raise ValueError("续跑参数与原任务不同")
    state = {**previous, **payload}
    state["batch_ids"] = list(dict.fromkeys([*previous.get("batch_ids", []), *payload.get("batch_ids", [])]))
    if state["stage"] == "completed" and (state.get("saved", 0) + state.get("skipped", 0) + state.get("failed", 0) < state.get("read", 0)):
        raise ValueError("资料保存尚未完成")
    row.state_json = json.dumps(state, ensure_ascii=False)
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return serialize(row, db)


def list_tasks(db, *, user_id, limit=20):
    return [serialize(row, db) for row in db.scalars(select(AgentSyncTask).where(AgentSyncTask.user_id == user_id)
            .order_by(AgentSyncTask.updated_at.desc()).limit(limit))]
