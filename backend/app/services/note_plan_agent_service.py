"""从一条用户资料生成或修订其关联行动计划。"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services import ai_juicer, note_service, plan_service


class NotePlanAgentError(ValueError):
    """可稳定映射到 REST 与 Product Action 的领域错误。"""

    def __init__(self, code: str, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def generate_or_revise_from_note(
    db: Session,
    *,
    user_id: str,
    note_id: str,
    instruction: str,
) -> dict[str, Any]:
    """生成计划并安全保留已有任务的完成状态。"""
    clean_note_id = str(note_id or "").strip()
    clean_instruction = str(instruction or "").strip()
    if not clean_note_id:
        raise NotePlanAgentError("INVALID_INPUT", "缺少视频资料标识")
    if len(clean_instruction) < 2 or len(clean_instruction) > 1000:
        raise NotePlanAgentError("INVALID_INPUT", "计划要求需为 2–1000 个字符")

    note = note_service.get_note(db, clean_note_id, user_id=user_id)
    if note is None:
        raise NotePlanAgentError(
            "RESOURCE_NOT_FOUND",
            "视频资料不存在",
            status_code=404,
        )

    existing = plan_service.get_plan_by_note(
        db,
        clean_note_id,
        user_id=user_id,
    )
    try:
        agent_result = ai_juicer.generate_or_revise_plan(
            title=note.video_title,
            transcript=note.transcript_raw,
            ai_summary=note.ai_summary,
            instruction=clean_instruction,
            existing_plan=existing.to_dict() if existing else None,
        )
        plan_data = agent_result["plan"]
        fields, tasks, total_days = ai_juicer.plan_to_storage(plan_data)
        plan, created = plan_service.upsert_agent_plan(
            db,
            note_id=note.id,
            title=plan_data.get("goal") or note.video_title,
            fields=fields,
            tasks=tasks,
            days=plan_data.get("days") or [],
            total_days=total_days,
            user_id=user_id,
        )
    except NotePlanAgentError:
        raise
    except ValueError as exc:
        raise NotePlanAgentError("INVALID_INPUT", str(exc)) from exc

    return {
        "plan": plan.to_dict(),
        "created": created,
        "change_summary": agent_result["change_summary"],
        "source_context": agent_result["source_context"],
    }
