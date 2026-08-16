"""Guardrails for the interactive Agent's detailed-video-analysis tool.

The model never receives provider, pricing, credentials, force flags or user
identifiers.  This module first ranks the current thread's transcript snapshot
and returns only owned Note identifiers for the billing/orchestration layer.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from app.models.note import Note
from app.services import ai_juicer


ANALYZE_VIDEO_DETAILS_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "analyze_video_details",
        "description": (
            "仅当当前问题必须读取视频画面、动作、界面、图表或可见文字时，"
            "对当前 Agent 来源快照中的少量相关视频执行详细解析。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "note_ids": {
                    "type": "array",
                    "items": {"type": "string", "format": "uuid"},
                    "minItems": 1,
                    "maxItems": 10,
                }
            },
            "required": ["note_ids"],
            "additionalProperties": False,
        },
    },
}


_VISUAL_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"画面|镜头|关键帧|截图|屏幕上|视频里(?:显示|出现|看到)",
        r"动作.{0,8}(?:示范|演示|姿势|是否正确|做对|细节)",
        r"(?:先|随后|然后|接着).{0,12}(?:拿起|放下|指向|递给|移动|转动|按下|点击|打开|关闭)",
        r"(?:拿起|放下|指向|递给|摆放|移动|转动|按下|点击|打开|关闭).{0,12}(?:什么|哪个|哪里|先|后)",
        r"(?:展示|演示|操作).{0,8}(?:了什么|哪个|哪一步|先后)",
        r"手势|姿势|表情|穿着|服装|颜色|外观|长什么样",
        r"可见文字|画面文字|OCR|字幕画面|招牌|标签上写",
        r"图表|折线图|柱状图|示意图|流程图|界面布局|按钮位置",
        r"物体|道具|产品外形|包装|logo|标志",
    )
)


_VISUAL_TOOL_GATE_PROMPT = """\
你是知萃交互式 Agent 的视频画面工具守门员。你会先看到候选视频的文稿片段，
再决定当前问题是否仍然必须读取像素画面。

仅在以下条件同时成立时调用工具：
1. 问题依赖动作先后、姿势、物体、界面、图表、颜色、人物外观或可见文字；
2. 给出的文稿片段不足以可靠回答该画面事实；
3. 只选择当前问题真正需要的少量候选视频。

如果文稿已经明确回答，或只是总结观点、深度研究、泛泛提到“视频/图表”，不要调用。
不得猜测来源外 ID，不得输出 URL、Provider、价格、API Key、force 或用户 ID。

只返回严格 JSON，二选一：
{"tool_call": null, "reason": "不调用的简短原因"}
或
{"tool_call": {"name": "analyze_video_details", "arguments": {"note_ids": ["候选 note_id"]}}, "reason": "必须看画面的简短原因"}
"""


@dataclass(frozen=True)
class AgentVisualToolDecision:
    needed: bool
    note_ids: tuple[str, ...] = ()
    reason: str = ""

    def tool_arguments(self) -> dict[str, list[str]]:
        return {"note_ids": list(self.note_ids)}


def requires_visual_analysis(question: str) -> bool:
    """Return true only for explicit, screen-dependent user intent.

    Research mode, a generic mention of "video", or a broad summary request is
    intentionally insufficient.  This keeps ordinary Agent turns at zero
    visual cost.
    """
    compact = re.sub(r"\s+", "", str(question or "")).strip()
    if not compact:
        return False
    return any(pattern.search(compact) for pattern in _VISUAL_PATTERNS)


def _source_meta(note: Note) -> dict[str, Any]:
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    meta = payload.get("source_meta")
    return meta if isinstance(meta, dict) else {}


def is_video_note(note: Note) -> bool:
    """Reject article/image records while retaining legacy video Notes."""
    meta = _source_meta(note)
    platform = str(meta.get("platform") or "").strip().lower()
    media_type = str(meta.get("media_type") or "").strip().lower()
    if platform == "wechat":
        return False
    if platform == "xiaohongshu" and media_type not in {"video", "视频"}:
        return False
    if media_type in {"image", "images", "article", "note", "图文"}:
        return False
    return bool((note.transcript_raw or "").strip())


def has_cached_visual_analysis(note: Note) -> bool:
    """Detect a usable persisted result without exposing its implementation."""
    try:
        payload = json.loads(note.ai_summary or "{}")
    except (json.JSONDecodeError, TypeError):
        return False
    detailed = payload.get("detailed_video_analysis") if isinstance(payload, dict) else None
    if not isinstance(detailed, dict):
        return False
    status = str(detailed.get("status") or "").strip().lower()
    return status in {"succeeded", "partial", "ready"} or bool(
        ai_juicer._note_visual_evidence(payload)
    )


def _selection_payload(note: Note) -> dict[str, Any]:
    meta = _source_meta(note)
    return {
        "note_id": note.id,
        "title": note.video_title,
        "author_name": str(meta.get("author_name") or ""),
        "transcript": str(note.transcript_raw or ""),
        "ai_summary": note.ai_summary,
    }


def select_relevant_video_notes(
    notes: Iterable[Note],
    question: str,
    *,
    limit: int = 3,
) -> list[Note]:
    """Search the transcript snapshot before selecting visual candidates."""
    safe_limit = max(1, min(int(limit or 3), 10))
    candidates = [note for note in notes if is_video_note(note)]
    if not candidates:
        return []
    by_id = {note.id: note for note in candidates}
    ranked = ai_juicer.rank_library_sources_for_selection(
        [_selection_payload(note) for note in candidates],
        str(question or "").strip(),
        limit=safe_limit,
    )
    selected = [
        by_id[note_id]
        for item in ranked.get("items", [])
        if (note_id := str(item.get("note_id") or "")) in by_id
    ]
    # 单一来源的显式画面问题即使没有可做词面匹配，也只有一个安全候选；
    # 多来源场景仍然 fail closed，绝不随意选择前 N 条进行视觉解析。
    if not selected and len(candidates) == 1:
        selected = candidates
    return selected[:safe_limit]


def _tool_gate_context(notes: Iterable[Note], question: str) -> str:
    blocks: list[str] = []
    for note in list(notes)[:10]:
        transcript = str(note.transcript_raw or "").strip()
        transcript_context = ai_juicer._build_note_transcript_context(
            transcript,
            question,
            direct_limit=3000,
            max_chunks=2,
        )[:5000]
        blocks.append(
            f"note_id：{note.id}\n"
            f"标题：{str(note.video_title or '未命名视频')[:160]}\n"
            f"文稿片段：\n{transcript_context or '无可用文稿'}"
        )
    return "\n\n---\n\n".join(blocks)[:24_000]


def _parse_tool_gate_payload(raw: str) -> dict[str, Any]:
    candidate = str(raw or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", candidate, re.I)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _request_visual_tool_call(
    notes: list[Note],
    question: str,
    *,
    maximum: int,
) -> tuple[list[str], str]:
    """Ask the text Agent for the strict tool call after transcript retrieval.

    Any model/network/schema failure fails closed to a normal text answer.  The
    returned arguments are validated again against the immutable candidate set
    here and against the full thread snapshot in ``agent_service``.
    """
    if not notes:
        return [], "没有安全候选视频"
    schema = json.dumps(ANALYZE_VIDEO_DETAILS_TOOL, ensure_ascii=False)
    try:
        raw = ai_juicer._call_llm(
            system=f"{_VISUAL_TOOL_GATE_PROMPT}\n\n【唯一可用工具 schema】\n{schema}",
            user=(
                f"【当前问题】\n{str(question or '').strip()[:600]}\n\n"
                f"【先检索到的候选文稿】\n{_tool_gate_context(notes, question)}"
            ),
            max_tokens=500,
            temperature=0.0,
            timeout=45,
            operation="agent_visual_tool_gate",
        )
    except Exception:
        return [], "画面工具判断暂时不可用"

    payload = _parse_tool_gate_payload(raw)
    tool_call = payload.get("tool_call")
    reason = str(payload.get("reason") or "").strip()[:240]
    if tool_call is None:
        return [], reason or "文稿足以回答"
    if not isinstance(tool_call, dict) or set(tool_call) != {"name", "arguments"}:
        return [], "工具调用结构无效"
    if str(tool_call.get("name") or "") != "analyze_video_details":
        return [], "工具名称无效"
    arguments = tool_call.get("arguments")
    if not isinstance(arguments, dict) or set(arguments) != {"note_ids"}:
        return [], "工具参数超出允许范围"
    raw_note_ids = arguments.get("note_ids")
    if not isinstance(raw_note_ids, list):
        return [], "工具参数无效"
    try:
        note_ids = validate_tool_note_ids(
            raw_note_ids,
            [note.id for note in notes],
            maximum=maximum,
        )
    except ValueError:
        return [], "工具选择了候选范围外的视频"
    return note_ids, reason or "文稿不足以回答画面事实"


def plan_tool_call(
    notes: Iterable[Note],
    question: str,
    *,
    limit: int = 3,
) -> AgentVisualToolDecision:
    """Build the only tool arguments the Agent is allowed to request."""
    if not requires_visual_analysis(question):
        return AgentVisualToolDecision(needed=False)
    selected = select_relevant_video_notes(notes, question, limit=limit)
    if not selected:
        return AgentVisualToolDecision(
            needed=False,
            reason="没有从当前文稿快照中找到需要读取画面的相关视频",
        )
    requested_note_ids, reason = _request_visual_tool_call(
        selected,
        question,
        maximum=max(1, min(int(limit or 3), 10)),
    )
    if not requested_note_ids:
        return AgentVisualToolDecision(needed=False, reason=reason)
    return AgentVisualToolDecision(
        needed=True,
        note_ids=tuple(requested_note_ids),
        reason=reason,
    )


def validate_tool_note_ids(
    requested_note_ids: Iterable[str],
    snapshot_note_ids: Iterable[str],
    *,
    maximum: int = 10,
) -> list[str]:
    """Fail closed when a model escapes the immutable source snapshot."""
    allowed = {str(item) for item in snapshot_note_ids}
    clean = list(dict.fromkeys(
        str(item or "").strip()
        for item in requested_note_ids
        if str(item or "").strip()
    ))
    if not clean or len(clean) > max(1, min(maximum, 10)):
        raise ValueError("详细解析工具需要 1–10 个来源快照内的视频")
    if any(note_id not in allowed for note_id in clean):
        raise ValueError("详细解析工具只能使用当前 Agent 来源快照中的视频")
    return clean
