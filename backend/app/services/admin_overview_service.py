"""管理端宽口径概览：只读聚合与有界投影，不复制正文或媒体。"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, or_
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.note import Note
from app.models.plan import Plan
from app.models.knowledge_entry import KnowledgeEntry
from app.models.creator_sync import CreatorSource, CreatorSyncRun
from app.models.library_extraction_batch import LibraryExtractionBatchItem
from app.models.llm_usage_log import LlmUsageLog
from app.models.application_error_log import ApplicationErrorLog
from app.models.feedback import Feedback
from app.models.video_analysis import VideoAnalysisRun


def overview(db: Session, *, days: int = 7, page: int = 1) -> dict:
    if days not in (1, 7, 30) or not 1 <= page <= 10000:
        raise ValueError("统计范围或页码无效")
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    def count(model):
        return db.query(func.count(model.id)).filter(model.created_at >= since).scalar() or 0

    transcript = func.length(func.trim(func.coalesce(Note.transcript_raw, ""))) > 0
    summary = and_(Note.ai_initialized.is_(True), func.length(func.trim(func.coalesce(Note.ai_summary, ""))) > 2)
    note_filter = Note.created_at >= since
    ready, summarized = db.query(
        func.sum(case((transcript, 1), else_=0)),
        func.sum(case((summary, 1), else_=0)),
    ).filter(note_filter).one()
    usage = db.query(func.count(LlmUsageLog.id), func.sum(LlmUsageLog.total_tokens),
                     func.count(func.distinct(LlmUsageLog.user_id))).filter(LlmUsageLog.created_at >= since).one()
    # 只判断已知稳定标识/来源域名；不能确定平台的资料明确归入其他。
    platform = case(
        (or_(Note.video_id.like("bilibili:%"), Note.video_url.like("%://www.bilibili.com/%"),
             Note.video_url.like("%://bilibili.com/%"), Note.video_url.like("%://b23.tv/%")), "B站"),
        (or_(Note.video_url.like("%://www.douyin.com/%"), Note.video_url.like("%://v.douyin.com/%")), "抖音"),
        (Note.video_url.like("%://mp.weixin.qq.com/%"), "公众号"),
        else_="其他 / 未识别",
    )
    sources = db.query(platform.label("platform"), func.count(Note.id)).filter(note_filter).group_by(platform).all()
    def states(model, column, timestamp):
        return [{"status": state, "count": total} for state, total in
                db.query(column, func.count(model.id)).filter(timestamp >= since).group_by(column).all()]

    recent = db.query(
        Note.id, func.substr(Note.video_title, 1, 120).label("title"),
        func.substr(User.username, 1, 40).label("username"), platform.label("platform"),
        func.length(func.coalesce(Note.transcript_raw, "")).label("chars"),
        summary.label("summary_ready"), Note.created_at,
    ).outerjoin(User, Note.user_id == User.id).filter(note_filter).order_by(
        Note.created_at.desc(), Note.id.desc()).offset((page - 1) * 10).limit(10).all()
    models = db.query(func.substr(LlmUsageLog.model, 1, 80), func.count(LlmUsageLog.id),
                      func.sum(LlmUsageLog.total_tokens)).filter(LlmUsageLog.created_at >= since).group_by(
        LlmUsageLog.model).order_by(func.count(LlmUsageLog.id).desc(), LlmUsageLog.model).limit(6).all()
    points = db.query(func.sum(VideoAnalysisRun.captured_points)).filter(VideoAnalysisRun.created_at >= since).scalar() or 0
    task_rows = db.query(
        LibraryExtractionBatchItem.id, LibraryExtractionBatchItem.state,
        func.substr(func.coalesce(Note.video_title, LibraryExtractionBatchItem.aweme_id), 1, 120).label("title"),
        func.substr(User.username, 1, 40).label("username"),
        LibraryExtractionBatchItem.transcript_chars, LibraryExtractionBatchItem.updated_at,
    ).outerjoin(Note, LibraryExtractionBatchItem.note_id == Note.id).outerjoin(
        User, LibraryExtractionBatchItem.user_id == User.id).filter(
        LibraryExtractionBatchItem.updated_at >= since).order_by(
        LibraryExtractionBatchItem.updated_at.desc(), LibraryExtractionBatchItem.id.desc()).limit(5).all()
    def iso(value):
        return value.replace(tzinfo=timezone.utc).isoformat() if value.tzinfo is None else value.isoformat()
    return {
        "days": days, "since": iso(since), "as_of": iso(now), "page": page, "per_page": 10,
        "metrics": {
            "new_users": count(User), "new_notes": count(Note), "transcripts_ready": ready or 0,
            "summaries_ready": summarized or 0, "new_plans": count(Plan),
            "new_knowledge": count(KnowledgeEntry), "new_creators": count(CreatorSource),
            "model_calls": usage[0], "tokens": usage[1] or 0, "model_users": usage[2],
            "errors": count(ApplicationErrorLog), "feedback": count(Feedback),
            "analysis_points": int(points),
        },
        "platforms": [{"name": name, "count": total} for name, total in sources],
        "tasks": {
            "library": states(LibraryExtractionBatchItem, LibraryExtractionBatchItem.state, LibraryExtractionBatchItem.updated_at),
            "creator": states(CreatorSyncRun, CreatorSyncRun.status, CreatorSyncRun.created_at),
            "vision": states(VideoAnalysisRun, VideoAnalysisRun.status, VideoAnalysisRun.created_at),
        },
        "models": [{"name": name, "calls": calls, "tokens": tokens or 0} for name, calls, tokens in models],
        "recent_tasks": [{"id": row.id, "title": row.title, "username": row.username or "未设置昵称",
                          "status": row.state, "transcript_chars": row.transcript_chars,
                          "updated_at": iso(row.updated_at)} for row in task_rows],
        "recent_notes": [{"id": row.id, "title": row.title, "username": row.username or "未设置昵称",
                          "platform": row.platform, "transcript_chars": row.chars,
                          "summary_ready": bool(row.summary_ready), "created_at": iso(row.created_at)} for row in recent],
    }
