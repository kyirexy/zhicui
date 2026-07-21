"""
AI content extraction service.

Takes a raw transcript and produces a structured knowledge card using
DeepSeek-V3 via LiteLLM.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from litellm import completion

from app.core.config import settings
from app.core.database import SessionLocal
from app.services import settings_service


def _get_llm_config() -> dict[str, str]:
    """Resolve effective LLM config: DB (admin runtime) first, .env fallback.

    Opens a short-lived session so ai_juicer (whose call signatures carry no
    DB dependency) can read runtime config set via the admin panel. Without
    this helper, the three call sites at lines 287/462/675 raise NameError,
    get swallowed by the retry loop's ``except Exception``, and every card
    silently degrades to the fallback — so the admin "LLM config" and
    "re-extract" features have no effect.
    """
    with SessionLocal() as db:
        return settings_service.get_llm_config(db)


# ---------------------------------------------------------------------------
# Content-type detection (keyword-based)
# ---------------------------------------------------------------------------

_KEYWORDS: dict[str, list[str]] = {
    "recipe": [
        "食谱", "做法", "食材", "烹饪", "炒", "煮", "炖", "蒸", "烤",
        "调料", "大火", "小火", "翻炒", "腌制", "切片", "切块",
        "克", "毫升", "适量", "勺", "盐", "糖", "酱油", "醋",
    ],
    "insight": [
        "思维", "认知", "方法论", "底层逻辑", "心理学", "习惯",
        "成长", "建议", "提升", "效率", "管理", "目标", "复盘",
        "深度思考", "本质", "规律", "原理",
    ],
    "history": [
        "历史", "朝代", "皇帝", "战争", "文明", "古代", "公元",
        "世纪", "王朝", "帝国", "革命", "改革", "战役", "史记",
    ],
    "product": [
        "测评", "推荐", "好物", "性价比", "价格", "对比",
        "种草", "拔草", "开箱", "使用体验", "优缺点", "值得买",
        "品牌", "型号", "参数",
    ],
    "plan": [
        "计划", "打卡", "瘦身", "减肥", "健身", "日程", "周计划",
        "日计划", "月计划", "每天", "挑战", "目标", "自律",
        "早起", "习惯养成", "30天", "21天", "坚持", "每日",
        "进度", "打卡表", "时间表", "安排", "任务清单",
    ],
}

_CARD_TYPES = ("recipe", "insight", "history", "product", "plan", "general")


def detect_content_type(transcript: str) -> str:
    """Classify transcript content into one of the predefined card types."""
    scores: dict[str, int] = {t: 0 for t in _CARD_TYPES}

    for card_type, keywords in _KEYWORDS.items():
        for kw in keywords:
            if kw in transcript:
                scores[card_type] += 1

    best = max(scores, key=lambda k: scores[k])
    # Require at least 2 keyword hits to avoid false positives on short text.
    if scores[best] >= 2:
        return best
    return "general"


# ---------------------------------------------------------------------------
# System prompts (Chinese, type-specific)
# ---------------------------------------------------------------------------

_BASE_INSTRUCTION = (
    "你是一位专业的知识提炼助手。请根据用户提供的视频转录文本，"
    "生成结构化的知识卡片。输出必须严格遵守下面的 JSON 格式。"
)

_TYPE_HINTS: dict[str, str] = {
    "recipe": (
        "这是一段美食/烹饪类视频的转录文本。请提取：\n"
        "- 食材清单与用量\n"
        "- 烹饪步骤（按顺序）\n"
        "- 关键技巧与注意事项\n"
        "- 踩坑提示（常见失败原因）"
    ),
    "insight": (
        "这是一段知识/观点/方法论类视频的转录文本。请提取：\n"
        "- 核心观点\n"
        "- 分论点及论据\n"
        "- 可操作的行动建议\n"
        "- 常见误区"
    ),
    "history": (
        "这是一段历史/文化类视频的转录文本。请提取：\n"
        "- 关键历史事件与时间线\n"
        "- 重要人物与关系\n"
        "- 因果关系与影响\n"
        "- 容易混淆或记错的知识点"
    ),
    "product": (
        "这是一段产品测评/种草类视频的转录文本。请提取：\n"
        "- 产品基本信息\n"
        "- 优点与缺点\n"
        "- 适用场景与人群\n"
        "- 购买建议与性价比分析"
    ),
    "general": (
        "请提取这段视频转录文本的核心内容：\n"
        "- 主题概述\n"
        "- 关键要点（3-5 个）\n"
        "- 实用建议或结论\n"
        "- 需要注意的事项"
    ),
    "plan": (
        "这是一段计划/打卡/目标管理类视频的转录文本。除了知识卡片外，"
        "请额外生成一份可执行的动态计划：\n"
        "- 识别计划的终极目标（goal）和周期（duration）\n"
        "- 将视频中的步骤和行动项拆解为具体的任务列表（tasks），"
        "每条任务含标题和可选日期\n"
        "- 如果适用，提取量化指标（metrics）和里程碑检查点（checkpoints）\n"
        "- 提取视频中提到的资源链接或参考（resources）\n"
        "输出中必须额外包含 \"plan\" 字段（见 JSON Schema）。"
    ),
}

_JSON_SCHEMA_INSTRUCTION = """\
请以如下 JSON 格式输出，不要包含任何其他文字：

{
  "sections": [
    {"title": "小节标题", "content": "小节内容", "icon": "icon-key"}
  ],
  "conclusion": "三句话总结，用换行符分隔",
  "pitfall_rating": 3,
  "card_type": "general",
  "tone": "informational",
  "density": "medium",
  "hero_quote": "一句最有冲击力的金句（10-30字）",
  "key_insight": "用一句话提炼整段视频的最核心洞察（30-60字）",
  "stats": [
    {"label": "标签", "value": "数字或关键词"}
  ],
  "plan": {
    "goal": "计划的终极目标（一句话，20-50字）",
    "duration": "计划的周期描述（如'7天'、'30天'、'12周'）",
    "tasks": [
      {
        "id": "t-001",
        "title": "具体可执行的任务标题",
        "scheduled_at": "2026-06-17T06:00",
        "done": false
      }
    ],
    "metrics": [
      {"label": "量化指标名", "value": "目标值", "unit": "单位（可选）"}
    ],
    "resources": [
      {"label": "资源/工具名称", "url": "链接或说明（可选）"}
    ],
    "checkpoints": [
      {"day": 7, "label": "第7天里程碑描述"}
    ]
  }
}

字段说明：
- sections: 3-6 个小节。每节包含：
    title: 小节标题（6-14 字，禁用标点结尾）
    content: 小节正文（80-200 字；可用 - 开头的列表项）
    icon: 从下表枚举中选一个最贴切的 key（不要写 emoji）
        信息类: lightbulb / target / compass / brain / eye
        步骤类: list-checks / route / play / rocket / flag
        警示类: alert-triangle / shield / x-circle / siren
        数据类: trending-up / chart-bar / activity / sparkles
        人物类: users / heart / smile / message-square
        中性类: book-open / bookmark / quote / pin
- conclusion: 恰好三句话，每句一行。
- pitfall_rating: 1-5 整数，踩坑风险评级（1 几乎不踩坑，5 极易踩坑）。
- card_type: 与输入一致（若内容为计划/打卡/目标管理类，必须设为 "plan"）。
- tone: 视频基调，三选一：
    "emotional"      — 情绪/共鸣/金句类（鸡汤、观点、共情）
    "informational"  — 干货/教程/方法论/科普类（步骤、参数、清单）
    "hybrid"         — 既有金句又有干货（最常见的认知/商业类）
- density: 信息密度，三选一：
    "low"     — 主打 1-2 个核心观点，sections 控制在 3 个
    "medium"  — 4 个 sections，每节中等长度
    "high"    — 5-6 个 sections，含步骤/清单，正文偏长
  density 必须与 tone 协调：emotional → 通常 low；informational → 通常 high；hybrid → medium。
- hero_quote: 整段视频里最有传播力的一句话原文（如视频里没有合适的金句，
  可由你高度浓缩；务必保留作者口吻与冲击力）。
- key_insight: 你对整段视频的"一句话点睛"（不是金句，是分析者的视角）。
- stats: 0-3 个亮点数据/关键词，用于卡片上方"指标条"。
    例如 {"label":"核心观点","value":"3 条"}, {"label":"风险等级","value":"中"}, {"label":"适合人群","value":"创业者"}。
    没有合适数据就给 []。
- plan: 若 card_type === "plan" 必须输出，否则可以省略（不输出或输出 null）。
    若输出 plan，必须包含 goal / duration / tasks（至少 3 条任务）。
    tasks 中每条必须有 id（t-001 起）、title、done（默认 false）。
    scheduled_at 为可选的 ISO8601 时间字符串。
    metrics / resources / checkpoints 为可选字段，没有就给 []。
"""


def get_system_prompt(content_type: str) -> str:
    """Return the full system prompt for a given content type."""
    hint = _TYPE_HINTS.get(content_type, _TYPE_HINTS["general"])
    return f"{_BASE_INSTRUCTION}\n\n{hint}\n\n{_JSON_SCHEMA_INSTRUCTION}"


# ---------------------------------------------------------------------------
# Card generation
# ---------------------------------------------------------------------------

def generate_card(
    transcript: str,
    content_type: str,
    video_title: str,
) -> dict[str, Any]:
    """Call LLM to produce a structured knowledge card.

    The call is retried up to ``_MAX_LLM_ATTEMPTS`` times on transient
    failures (network errors, JSON parse errors, empty responses). We
    progressively relax constraints across retries: first attempt uses the
    full schema; later attempts shrink ``max_tokens`` if the model exhausted
    its budget on reasoning, and ultimately we fall back to a single-section
    card built from the raw text — never a hard failure that breaks the
    pipeline mid-stream.

    Returns
    -------
    dict
        Keys: ``sections`` (list), ``conclusion`` (str), ``pitfall_rating`` (int),
        ``card_type`` (str), ``tone`` (str), ``density`` (str),
        ``hero_quote`` (str), ``key_insight`` (str), ``stats`` (list).
    """
    last_error: Exception | None = None
    for attempt in range(_MAX_LLM_ATTEMPTS):
        try:
            return _generate_card_once(
                transcript=transcript,
                content_type=content_type,
                video_title=video_title,
                attempt=attempt,
            )
        except Exception as exc:  # noqa: BLE001 — retry on any LLM error
            last_error = exc
            traceback_str = ""
            try:
                import traceback as _tb
                traceback_str = _tb.format_exc()
            except Exception:
                pass
            print(
                f"[ai_juicer] Attempt {attempt + 1}/{_MAX_LLM_ATTEMPTS} failed: "
                f"{exc}\n{traceback_str}",
                flush=True,
            )

    # All retries exhausted — emit a degraded card so the pipeline still
    # produces a saved note instead of a 500.
    return _fallback_card(
        transcript=transcript,
        content_type=content_type,
        error_message=str(last_error) if last_error else "未知错误",
    )


_MAX_LLM_ATTEMPTS = 3


def _generate_card_once(
    transcript: str,
    content_type: str,
    video_title: str,
    attempt: int,
) -> dict[str, Any]:
    """Single LLM round-trip. Raises on any failure so retry can catch."""
    system_prompt = get_system_prompt(content_type)

    user_message = (
        f"视频标题：{video_title}\n\n"
        f"视频转录文本如下：\n\n{transcript}"
    )

    # Build LiteLLM call parameters.
    # Supports custom Anthropic-compatible endpoints (e.g. mimo proxy).
    import os  # noqa: F401  # kept for callers that monkey-patch env

    llm_cfg = _get_llm_config()
    llm_kwargs: dict = {
        "model": llm_cfg["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        # Slight jitter across retries to dodge transient determinism issues.
        "temperature": 0.3 + (attempt * 0.1),
        # Give the first attempt the full budget; if that hit a wall, shrink
        # to encourage the model to skip reasoning and emit JSON directly.
        "max_tokens": 8192 if attempt == 0 else 4096,
        # 60s per attempt — keeps total wall-clock under 3 minutes worst case.
        "timeout": 60,
    }

    # Custom API base and key for proxied Anthropic endpoints.
    if llm_cfg["api_base"]:
        llm_kwargs["api_base"] = llm_cfg["api_base"]
    if llm_cfg["api_key"]:
        llm_kwargs["api_key"] = llm_cfg["api_key"]

    response = completion(**llm_kwargs)

    choice = response.choices[0]
    raw: str = choice.message.content or ""

    # For thinking models (e.g. deepseek-v4-pro), content may be None when
    # the reasoning phase consumes the token budget.  Fall back to the
    # reasoning_content if available.
    if not raw.strip() and hasattr(choice.message, "reasoning_content"):
        raw = choice.message.reasoning_content or ""

    if not raw.strip():
        raise RuntimeError(
            "LLM 返回内容为空（思考模型可能消耗了全部 token 预算）。"
        )

    raw = raw.strip()

    # Strip markdown code fences if present.
    if raw.startswith("```"):
        # Remove opening fence (```json or ```)
        first_newline = raw.index("\n")
        raw = raw[first_newline + 1 :]
    if raw.endswith("```"):
        raw = raw[:-3]
    raw = raw.strip()

    card: dict[str, Any] = json.loads(raw)
    return _normalize_card(card, content_type)


def _normalize_card(card: dict[str, Any], content_type: str) -> dict[str, Any]:
    """Coerce a raw LLM card dict into the canonical shape with safe defaults."""
    # Ensure required keys exist.
    card.setdefault("sections", [])
    card.setdefault("conclusion", "")
    card.setdefault("pitfall_rating", 3)
    card.setdefault("card_type", content_type)
    card.setdefault("tone", "hybrid")
    card.setdefault("density", "medium")
    card.setdefault("hero_quote", "")
    card.setdefault("key_insight", "")
    card.setdefault("stats", [])

    # Validate pitfall_rating range.
    try:
        card["pitfall_rating"] = max(1, min(5, int(card["pitfall_rating"])))
    except (TypeError, ValueError):
        card["pitfall_rating"] = 3

    # Validate tone enum.
    if card.get("tone") not in {"emotional", "informational", "hybrid"}:
        card["tone"] = "hybrid"

    # Validate density enum.
    if card.get("density") not in {"low", "medium", "high"}:
        card["density"] = "medium"

    # Normalize plan field if present.
    raw_plan = card.get("plan")
    if isinstance(raw_plan, dict):
        # Ensure required sub-keys exist.
        raw_plan.setdefault("goal", "")
        raw_plan.setdefault("duration", "")
        raw_plan.setdefault("tasks", [])
        raw_plan.setdefault("metrics", [])
        raw_plan.setdefault("resources", [])
        raw_plan.setdefault("checkpoints", [])
        # Ensure each task has id/done.
        for t in raw_plan.get("tasks", []):
            if isinstance(t, dict):
                t.setdefault("done", False)
                if "id" not in t:
                    import uuid
                    t["id"] = f"t-{uuid.uuid4().hex[:8]}"
        # Coerce fields metadata.
        fields_meta = card.get("plan_fields", [])
        if not isinstance(fields_meta, list):
            fields_meta = []
        card["plan_fields"] = fields_meta
    card["plan"] = raw_plan if isinstance(raw_plan, dict) else None

    # Coerce stats to a small list of {label, value} pairs.
    raw_stats = card.get("stats") or []
    clean_stats: list[dict[str, str]] = []
    if isinstance(raw_stats, list):
        for item in raw_stats[:3]:
            if isinstance(item, dict) and "label" in item and "value" in item:
                clean_stats.append({
                    "label": str(item["label"])[:12],
                    "value": str(item["value"])[:24],
                })
    card["stats"] = clean_stats

    return card


def _fallback_card(
    transcript: str,
    content_type: str,
    error_message: str,
) -> dict[str, Any]:
    """Build a minimal-but-valid card when every LLM attempt has failed.

    This is a last-resort safety net so the pipeline always produces a saved
    note. The transcript is preserved in full; the user can still re-extract
    later when the LLM is healthy again.
    """
    # Take the first ~600 chars of the transcript as the section content.
    snippet = transcript.strip()[:600]
    if len(transcript) > 600:
        snippet = snippet.rsplit("。", 1)[0] + "。…"

    return _normalize_card(
        {
            "sections": [
                {
                    "title": "原始内容摘要",
                    "content": snippet,
                    "icon": "book-open",
                },
            ],
            "conclusion": (
                "AI 处理暂时不可用，已保留视频原文。\n"
                f"系统提示：{error_message[:80]}\n"
                "你可以稍后在笔记详情页重新生成卡片。"
            ),
            "pitfall_rating": 3,
            "card_type": content_type,
            "tone": "informational",
            "density": "low",
            "hero_quote": "",
            "key_insight": "AI 暂时无法生成结构化卡片，但视频原文已保留。",
            "stats": [],
        },
        content_type,
    )

# ---------------------------------------------------------------------------
# Shared LLM call helper
# ---------------------------------------------------------------------------

def _call_llm(
    system: str,
    user: str,
    model_override: str | None = None,
    max_tokens: int = 4096,
    temperature: float = 0.3,
    timeout: int = 60,
) -> str:
    """Single LLM round-trip. Returns raw text, raises on any failure."""
    import os

    llm_cfg = _get_llm_config()
    kwargs: dict = {
        "model": model_override or llm_cfg["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "timeout": timeout,
    }
    if llm_cfg["api_base"]:
        kwargs["api_base"] = llm_cfg["api_base"]
    if llm_cfg["api_key"]:
        kwargs["api_key"] = llm_cfg["api_key"]

    response = completion(**kwargs)
    choice = response.choices[0]
    raw: str = choice.message.content or ""
    if not raw.strip() and hasattr(choice.message, "reasoning_content"):
        raw = choice.message.reasoning_content or ""
    if not raw.strip():
        raise RuntimeError("LLM returned empty content")
    raw = raw.strip()
    if raw.startswith("```"):
        first_newline = raw.index("\n")
        raw = raw[first_newline + 1:]
    if raw.endswith("```"):
        raw = raw[:-3]
    return raw.strip()


# ---------------------------------------------------------------------------
# Grounded note Q&A
# ---------------------------------------------------------------------------

_NOTE_CHAT_SYSTEM_PROMPT = """\
你是知萃的内容追问助手。你只能依据当前笔记提供的标题、AI 对内容的结构化理解，以及视频完整文稿或从完整文稿中检索出的相关原文片段回答。

回答规则：
1. 先直接回答问题，再给出必要的依据或步骤；默认使用简洁中文。
2. 不得补造原文没有出现的数字、人物、结论、产品参数或因果关系。
3. 如果来源不足以回答，必须明确说“原内容没有提到这一点”，然后说明当前内容最多能支持什么判断。
4. 可以做归纳、对比和行动化整理，但推断必须标注为“基于原内容的推断”。
5. 对话历史只用于理解指代和上下文，不得覆盖笔记来源中的事实。
6. 不要声称访问了互联网、完整视频画面或笔记之外的资料。
7. evidence 中的 quote 必须逐字复制自【视频文稿上下文】或【AI 对内容的结构化理解】，不得改写。
8. follow_up_questions 最多给 3 个，必须能继续用同一份内容回答或核实。
9. 【视频文稿上下文】中的“相关片段/原文约 N% 处”是检索标记，不得复制进 evidence quote。
10. AI 结构化理解可以帮助归纳、关联和行动化，但具体事实应优先服从视频文稿原文。

只输出下面结构的 JSON，不要输出 Markdown 代码围栏或额外解释：
{
  "answer": "直接、清晰的中文回答",
  "evidence": [
    {"quote": "20-180 字的来源原文", "source": "transcript"}
  ],
  "grounded": true,
  "follow_up_questions": ["一个自然的后续问题"]
}

source 只能是 transcript 或 summary。来源不足时 evidence 返回空数组，grounded 返回 false。
"""

_NOTE_TRANSCRIPT_DIRECT_LIMIT = 14000
_NOTE_TRANSCRIPT_CHUNK_SIZE = 2400
_NOTE_TRANSCRIPT_CHUNK_OVERLAP = 280
_NOTE_TRANSCRIPT_MAX_CHUNKS = 4
_NOTE_AI_CONTEXT_LIMIT = 8000
_NOTE_QUERY_STOP_SIGNALS = {
    "这个", "那个", "视频", "内容", "原文", "什么", "怎么", "如何",
    "哪些", "是否", "可以", "一下", "提到", "观点", "问题", "其中",
    "他们", "它们", "时候", "方面", "以及", "进行", "一个",
}


def _note_ai_summary_context(
    ai_summary: str | dict[str, Any] | None,
    limit: int = _NOTE_AI_CONTEXT_LIMIT,
) -> str:
    """Turn the stored card JSON into compact, readable Q&A context."""
    if isinstance(ai_summary, dict):
        parsed: Any = ai_summary
        raw_fallback = json.dumps(ai_summary, ensure_ascii=False)
    else:
        raw_fallback = (ai_summary or "").strip()
        if not raw_fallback:
            return ""
        try:
            parsed = json.loads(raw_fallback)
        except (json.JSONDecodeError, TypeError):
            return raw_fallback[:limit]

    if not isinstance(parsed, dict):
        return raw_fallback[:limit]

    parts: list[str] = []

    def add(label: str, value: Any) -> None:
        if value is None:
            return
        if isinstance(value, str):
            text = value.strip()
        elif isinstance(value, (int, float, bool)):
            text = str(value)
        else:
            return
        if text:
            parts.append(f"{label}：{text}")

    add("内容标题", parsed.get("title"))
    add("核心洞察", parsed.get("key_insight"))
    add("代表金句", parsed.get("hero_quote"))

    sections = parsed.get("sections")
    if isinstance(sections, list):
        section_lines: list[str] = []
        for index, section in enumerate(sections[:12], start=1):
            if not isinstance(section, dict):
                continue
            title = str(section.get("title") or f"要点 {index}").strip()
            content = str(section.get("content") or "").strip()
            if not content and isinstance(section.get("items"), list):
                content = "；".join(
                    str(item).strip()
                    for item in section["items"]
                    if str(item).strip()
                )
            if title or content:
                section_lines.append(f"{index}. {title}：{content}".rstrip("："))
        if section_lines:
            parts.append("AI 内容拆解：\n" + "\n".join(section_lines))

    add("AI 总结", parsed.get("conclusion"))

    stats = parsed.get("stats")
    if isinstance(stats, list):
        stat_lines = []
        for item in stats[:10]:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()
            value = str(item.get("value") or "").strip()
            if label and value:
                stat_lines.append(f"{label}：{value}")
        if stat_lines:
            parts.append("AI 提取数据：" + "；".join(stat_lines))

    rating = parsed.get("pitfall_rating")
    if isinstance(rating, (int, float)):
        parts.append(f"AI 风险/踩坑判断：{rating}/5")

    add("内容语气", parsed.get("tone"))
    context = "\n\n".join(parts).strip()
    return (context or raw_fallback)[:limit]


def _note_query_signals(query: str) -> list[tuple[str, int]]:
    """Extract deterministic Chinese n-grams and ASCII terms for retrieval."""
    normalized = query.lower().strip()
    weighted: dict[str, int] = {}

    for term in re.findall(r"[a-z0-9][a-z0-9._+-]{1,31}", normalized):
        weighted[term] = max(weighted.get(term, 0), min(8, len(term)))

    for sequence in re.findall(r"[\u4e00-\u9fff]+", normalized):
        if 2 <= len(sequence) <= 12 and sequence not in _NOTE_QUERY_STOP_SIGNALS:
            weighted[sequence] = max(weighted.get(sequence, 0), min(10, len(sequence) + 2))
        for size, weight in ((2, 2), (3, 4)):
            for index in range(max(0, len(sequence) - size + 1)):
                signal = sequence[index:index + size]
                if signal in _NOTE_QUERY_STOP_SIGNALS:
                    continue
                weighted[signal] = max(weighted.get(signal, 0), weight)

    return sorted(weighted.items(), key=lambda item: (-item[1], -len(item[0]), item[0]))


def _note_transcript_chunks(
    transcript: str,
    chunk_size: int = _NOTE_TRANSCRIPT_CHUNK_SIZE,
    overlap: int = _NOTE_TRANSCRIPT_CHUNK_OVERLAP,
) -> list[tuple[int, str]]:
    """Split a transcript into bounded overlapping chunks with source offsets."""
    if not transcript:
        return []

    chunks: list[tuple[int, str]] = []
    step = max(1, chunk_size - overlap)
    start = 0
    while start < len(transcript):
        text = transcript[start:start + chunk_size]
        if text:
            chunks.append((start, text))
        if start + chunk_size >= len(transcript):
            break
        start += step
    return chunks


def _uniform_chunk_indices(chunk_count: int, target_count: int) -> list[int]:
    """Return stable indices spread across the complete document."""
    if chunk_count <= 0 or target_count <= 0:
        return []
    if chunk_count <= target_count:
        return list(range(chunk_count))
    if target_count == 1:
        return [chunk_count // 2]
    return sorted({
        round(index * (chunk_count - 1) / (target_count - 1))
        for index in range(target_count)
    })


def _build_note_transcript_context(
    transcript: str,
    query: str,
    direct_limit: int = _NOTE_TRANSCRIPT_DIRECT_LIMIT,
    max_chunks: int = _NOTE_TRANSCRIPT_MAX_CHUNKS,
) -> str:
    """Backward-compatible text-only wrapper around detailed context building."""
    context, _ = _build_note_transcript_context_details(
        transcript,
        query,
        direct_limit=direct_limit,
        max_chunks=max_chunks,
    )
    return context


def _build_note_transcript_context_details(
    transcript: str,
    query: str,
    direct_limit: int = _NOTE_TRANSCRIPT_DIRECT_LIMIT,
    max_chunks: int = _NOTE_TRANSCRIPT_MAX_CHUNKS,
) -> tuple[str, dict[str, Any]]:
    """Build bounded context and report how the complete transcript was covered."""
    source_context: dict[str, Any] = {
        "transcript_chars": len(transcript),
        "transcript_mode": "none",
        "scanned_chunks": 0,
        "selected_chunks": 0,
        "ai_summary_used": False,
    }
    if not transcript:
        return "", source_context
    if len(transcript) <= direct_limit:
        source_context.update({
            "transcript_mode": "full",
            "scanned_chunks": 1,
            "selected_chunks": 1,
        })
        return transcript, source_context

    chunks = _note_transcript_chunks(transcript)
    signals = _note_query_signals(query)
    ranked: list[tuple[int, int]] = []
    for index, (_, chunk_text) in enumerate(chunks):
        lowered = chunk_text.lower()
        score = sum(lowered.count(signal) * weight for signal, weight in signals)
        ranked.append((score, index))

    selected: list[int] = []
    # Prefer positive, non-adjacent matches so overlapping chunks do not waste
    # the limited context budget on the same passage.
    for score, index in sorted(ranked, key=lambda item: (-item[0], item[1])):
        if score <= 0:
            break
        if any(abs(index - existing) <= 1 for existing in selected):
            continue
        selected.append(index)
        if len(selected) >= max_chunks:
            break

    # Broad questions and sparse matches still receive document-wide coverage.
    for index in _uniform_chunk_indices(len(chunks), max_chunks):
        if index not in selected:
            selected.append(index)
        if len(selected) >= max_chunks:
            break

    selected = sorted(selected[:max_chunks])
    parts: list[str] = []
    denominator = max(1, len(transcript) - 1)
    for display_index, chunk_index in enumerate(selected, start=1):
        start, chunk_text = chunks[chunk_index]
        position = round(start / denominator * 100)
        parts.append(
            f"[相关片段 {display_index}/{len(selected)} · 原文约 {position}% 处]\n"
            f"{chunk_text}"
        )
    source_context.update({
        "transcript_mode": "retrieved",
        "scanned_chunks": len(chunks),
        "selected_chunks": len(selected),
    })
    return "\n\n".join(parts), source_context


def _validated_note_evidence(
    raw_evidence: Any,
    transcript_text: str,
    summary_text: str,
    transcript_source: str | None = None,
) -> list[dict[str, Any]]:
    """Keep only unique quotes that can be found verbatim in supplied sources."""
    if not isinstance(raw_evidence, list):
        return []

    validated: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_evidence:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote") or "").strip()
        if not quote or quote in seen:
            continue

        source = ""
        if quote in transcript_text:
            source = "transcript"
        elif quote in summary_text:
            source = "summary"
        if not source:
            continue

        seen.add(quote)
        evidence: dict[str, Any] = {"quote": quote[:360], "source": source}
        if source == "transcript" and transcript_source:
            source_index = transcript_source.find(quote)
            if source_index >= 0:
                evidence["position_percent"] = round(
                    source_index / max(1, len(transcript_source) - 1) * 100
                )
        validated.append(evidence)
        if len(validated) >= 3:
            break
    return validated


def _note_follow_up_questions(raw_questions: Any) -> list[str]:
    """Normalize a short, de-duplicated list of model-suggested questions."""
    if not isinstance(raw_questions, list):
        return []

    questions: list[str] = []
    seen: set[str] = set()
    for item in raw_questions:
        question = str(item or "").strip()
        if not question or question in seen:
            continue
        seen.add(question)
        questions.append(question[:120])
        if len(questions) >= 3:
            break
    return questions


def answer_note_question(
    title: str,
    transcript: str | None,
    ai_summary: str | dict[str, Any] | None,
    question: str,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Answer a question using a saved note as the only factual source.

    The endpoint already validates ownership and input length. This helper also
    enforces a bounded context so a long transcript or client-supplied history
    cannot consume an unbounded model window.
    """
    clean_question = question.strip()
    if not clean_question:
        raise ValueError("问题不能为空")

    summary_text = _note_ai_summary_context(ai_summary)

    history_lines: list[str] = []
    retrieval_history: list[str] = []
    for item in (history or [])[-6:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()[:1000]
        if role not in {"user", "assistant"} or not content:
            continue
        label = "用户" if role == "user" else "助手"
        history_lines.append(f"{label}：{content}")
        if role == "user":
            retrieval_history.append(content)

    raw_transcript = (transcript or "").strip()
    retrieval_query = "\n".join([clean_question, *retrieval_history[-3:]])
    transcript_text, source_context = _build_note_transcript_context_details(
        raw_transcript,
        retrieval_query,
    )
    source_context["ai_summary_used"] = bool(summary_text)
    if source_context["transcript_mode"] == "full":
        transcript_coverage = "完整文稿已直接加入本次回答上下文。"
    elif source_context["transcript_mode"] == "retrieved":
        transcript_coverage = (
            f"已扫描完整文稿的 {source_context['scanned_chunks']} 个片段，"
            f"并选取 {source_context['selected_chunks']} 个相关原文片段进入回答上下文。"
        )
    else:
        transcript_coverage = "当前笔记没有可用视频文稿。"

    user_prompt = f"""\
【笔记标题】
{title.strip()[:512] or '未命名内容'}

【来源覆盖说明】
{transcript_coverage}
{"已同时加入 AI 对内容的结构化理解。" if summary_text else "没有可用的 AI 结构化理解。"}

【AI 对内容的结构化理解】
{summary_text or '无结构化摘要'}

【视频文稿上下文】
{transcript_text or '无可用视频文稿；只能依据 AI 对内容的结构化理解回答'}

【最近对话】
{chr(10).join(history_lines) if history_lines else '无'}

【当前问题】
{clean_question}
"""

    raw_answer = _call_llm(
        system=_NOTE_CHAT_SYSTEM_PROMPT,
        user=user_prompt,
        max_tokens=1600,
        temperature=0.2,
        timeout=60,
    )

    try:
        parsed = json.loads(raw_answer)
    except (json.JSONDecodeError, TypeError):
        return {
            "answer": raw_answer,
            "evidence": [],
            "grounded": False,
            "follow_up_questions": [],
            "source_context": source_context,
        }

    if not isinstance(parsed, dict):
        return {
            "answer": raw_answer,
            "evidence": [],
            "grounded": False,
            "follow_up_questions": [],
            "source_context": source_context,
        }

    answer = str(parsed.get("answer") or "").strip()
    if not answer:
        answer = "原内容没有提供足够信息来回答这个问题。"

    evidence = _validated_note_evidence(
        parsed.get("evidence"),
        transcript_text=transcript_text,
        summary_text=summary_text,
        transcript_source=raw_transcript,
    )
    return {
        "answer": answer,
        "evidence": evidence,
        # Never trust the model's boolean directly: evidence is grounded only
        # after the quote has been found in the exact context supplied above.
        "grounded": bool(evidence),
        "follow_up_questions": _note_follow_up_questions(
            parsed.get("follow_up_questions")
        ),
        "source_context": source_context,
    }


# ---------------------------------------------------------------------------
# Mini Agent 1: Intent Classifier (flash — cheap, fast)
# ---------------------------------------------------------------------------

_INTENT_CLASSIFIER_PROMPT = """\
你是一个视频内容分类器。根据视频转录文本的前1500字，判断内容类型和是否为计划类。

输出严格遵守 JSON 格式：
{
  "card_type": "recipe|insight|history|product|plan|general",
  "is_plan": true
}

分类标准：
- recipe: 美食烹饪、食谱教程（重点是"怎么做菜"）
- insight: 知识观点、认知方法论（重点是"怎么想"）
- history: 历史科普、文化解读
- product: 产品测评、好物推荐
- plan: 包含可执行的时间安排、训练计划、打卡周期、分步骤行动指南、按天/周组织的任务
  关键信号：出现"第X天""X周计划""每天做什么""打卡""周期""训练安排""饮食计划""执行步骤""3个月""21天"
  注意：即使内容包含食物/营养/知识讲解，只要核心是"按时间执行的计划或行动指南"，就归为 plan
- general: 不属于以上任何类别

判断 is_plan 时，优先看转录文本是否有明确的时间维度（天/周/月/阶段）和可执行任务，
而不仅仅是知识点分享。健身减脂、学习路线、备考安排、习惯养成类视频通常是 plan。
"""


def classify_intent(transcript: str) -> dict[str, Any]:
    """Quick LLM call to determine card_type and whether it's a plan.
    Falls back to keyword matching on failure.
    """
    kw_type = detect_content_type(transcript)
    snippet = transcript.strip()[:1500]
    try:
        raw = _call_llm(
            system=_INTENT_CLASSIFIER_PROMPT,
            user=f"视频转录文本：\n\n{snippet}",
            max_tokens=256,
        )
        result = json.loads(raw)
        card_type = result.get("card_type", kw_type)
        is_plan = result.get("is_plan", card_type == "plan")
        if card_type not in _CARD_TYPES:
            card_type = kw_type
        return {"card_type": card_type, "is_plan": bool(is_plan)}
    except Exception:
        return {"card_type": kw_type, "is_plan": kw_type == "plan"}


# ---------------------------------------------------------------------------
# Mini Agent 2: Plan Generator (separate from card generation)
# ---------------------------------------------------------------------------

_PLAN_GENERATOR_PROMPT = """\
你是一个自适应计划架构师。根据视频转录文本，提取其中真正存在的计划、训练、
打卡、学习或执行方法，生成一份粒度与原内容相匹配的可执行计划。

输出严格遵守 JSON 格式，不要包含任何其他文字：
{
  "goal": "计划的终极目标（20-50字）",
  "duration": "视频中有依据的周期描述，没有则留空",
  "days": [
    {
      "day": 1,
      "label": "启动阶段",
      "date": "YYYY-MM-DD（仅在有可靠日期依据时填写）",
      "focus": "当天或阶段的核心重点",
      "tasks": [
        {
          "id": "t-001",
          "title": "具体可执行任务",
          "done": false,
          "scheduled_at": "YYYY-MM-DDTHH:MM（仅在视频明确或可可靠换算时填写）",
          "duration_minutes": 30,
          "frequency": "每天 3 次",
          "priority": "high",
          "details": [
            {"name": "repetitions", "label": "每组次数", "type": "number", "value": 12},
            {"name": "success", "label": "完成标准", "type": "text", "value": "动作稳定且完成3组"}
          ]
        }
      ]
    }
  ],
  "dynamic_fields": [
    {"name": "goal", "label": "终极目标", "group": "目标与衡量", "type": "text", "value": "..."},
    {"name": "metrics", "label": "完成指标", "group": "目标与衡量", "type": "list", "value": ["..."]},
    {"name": "resources", "label": "所需资源", "group": "准备事项", "type": "list", "value": ["..."]}
  ]
}

要求：
- 你自主决定 dynamic_fields 的数量、名称、分组和类型，只保留视频有依据且对执行有帮助的字段，
  不设最少数量，不要为了凑字段而虚构内容
- 字段类型可以使用 text/number/date/time/duration/frequency/list/checklist/progress/quote/metric；
  需要其他类型时可给出清晰的字符串 type，前端会安全降级展示
- days 表示真实执行节点或阶段，day 必须是正整数但不要求连续；例如视频只讲第1、3、7天，
  就只生成 day=1、3、7，不补造其他天
- 任务数量由视频内容决定，不设固定的每天任务数；计划类内容至少要有 1 条真正可执行的 task
- 每条 task 必须有 id（t-001 起）、title、done（默认 false），title 要具体可执行，
  不要写空泛的“完成任务”
- scheduled_at 使用 YYYY-MM-DDTHH:MM，只有视频明确时间或可结合当前日期可靠换算时填写；
  没有依据就省略，不能虚构具体日期和时间
- duration_minutes、frequency、details 都是可选的，只有内容确实提到时才填写；
  details 数量和字段类型同样由你决定
- priority 仅使用 low/medium/high；没有明显优先级时使用 medium
- 没有内容的数组写 []；只有当视频完全不是计划类内容时，才返回空 days 和空 tasks
"""

_PLAN_TIMEZONE = ZoneInfo("Asia/Shanghai")
_PLAN_SCHEDULE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$")
_PLAN_PRIORITIES = {"low", "medium", "high"}


def _normalize_plan_field(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    name = str(value.get("name") or "").strip()
    label = str(value.get("label") or "").strip()
    if not name or not label:
        return None
    normalized = dict(value)
    normalized["name"] = name[:80]
    normalized["label"] = label[:120]
    normalized["type"] = str(value.get("type") or "text").strip()[:40] or "text"
    group = str(value.get("group") or "").strip()
    if group:
        normalized["group"] = group[:80]
    else:
        normalized.pop("group", None)
    return normalized


def _normalize_plan_schedule(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()[:16]
    return normalized if _PLAN_SCHEDULE_RE.fullmatch(normalized) else None


def _normalize_plan_task(
    value: Any,
    *,
    day_number: int,
    task_number: int,
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    title = str(value.get("title") or "").strip()
    if not title:
        return None

    normalized = dict(value)
    task_id = str(value.get("id") or "").strip()
    normalized["id"] = task_id[:80] or f"t-{task_number:03d}"
    normalized["title"] = title[:256]
    normalized["done"] = bool(value.get("done", False))
    normalized["day"] = day_number
    normalized["priority"] = (
        value.get("priority") if value.get("priority") in _PLAN_PRIORITIES else "medium"
    )

    scheduled_at = _normalize_plan_schedule(value.get("scheduled_at"))
    if scheduled_at:
        normalized["scheduled_at"] = scheduled_at
    else:
        normalized.pop("scheduled_at", None)

    duration = value.get("duration_minutes")
    if isinstance(duration, (int, float)) and 0 < duration <= 10080:
        normalized["duration_minutes"] = int(duration)
    else:
        normalized.pop("duration_minutes", None)

    frequency = str(value.get("frequency") or "").strip()
    if frequency:
        normalized["frequency"] = frequency[:120]
    else:
        normalized.pop("frequency", None)

    details = [
        field
        for item in (value.get("details") or [])
        if (field := _normalize_plan_field(item)) is not None
    ] if isinstance(value.get("details"), list) else []
    if details:
        normalized["details"] = details
    else:
        normalized.pop("details", None)
    return normalized


def _normalize_plan_payload(plan: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(plan)
    dynamic_fields = plan.get("dynamic_fields")
    normalized["dynamic_fields"] = [
        field
        for item in dynamic_fields
        if (field := _normalize_plan_field(item)) is not None
    ] if isinstance(dynamic_fields, list) else []

    normalized_days: list[dict[str, Any]] = []
    flat_tasks: list[dict[str, Any]] = []
    raw_days = plan.get("days")
    if isinstance(raw_days, list):
        for day_index, raw_day in enumerate(raw_days, start=1):
            if not isinstance(raw_day, dict):
                continue
            raw_day_number = raw_day.get("day")
            day_number = raw_day_number if isinstance(raw_day_number, int) and raw_day_number > 0 else day_index
            day_tasks: list[dict[str, Any]] = []
            for raw_task in raw_day.get("tasks") or []:
                task = _normalize_plan_task(
                    raw_task,
                    day_number=day_number,
                    task_number=len(flat_tasks) + 1,
                )
                if task is not None:
                    day_tasks.append(task)
                    flat_tasks.append(dict(task))
            normalized_day = dict(raw_day)
            normalized_day["day"] = day_number
            normalized_day["label"] = str(raw_day.get("label") or f"第{day_number}天").strip()[:160]
            normalized_day["tasks"] = day_tasks
            date_value = _normalize_plan_schedule(raw_day.get("date"))
            if date_value:
                normalized_day["date"] = date_value[:10]
            else:
                normalized_day.pop("date", None)
            focus = str(raw_day.get("focus") or "").strip()
            if focus:
                normalized_day["focus"] = focus[:240]
            else:
                normalized_day.pop("focus", None)
            if day_tasks:
                normalized_days.append(normalized_day)

    if not flat_tasks:
        raw_tasks = plan.get("tasks")
        if isinstance(raw_tasks, list):
            for raw_task in raw_tasks:
                raw_day_number = raw_task.get("day") if isinstance(raw_task, dict) else None
                day_number = (
                    raw_day_number
                    if isinstance(raw_day_number, int) and raw_day_number > 0
                    else 1
                )
                task = _normalize_plan_task(
                    raw_task,
                    day_number=day_number,
                    task_number=len(flat_tasks) + 1,
                )
                if task is not None:
                    flat_tasks.append(task)
        if flat_tasks:
            for day_number in sorted({int(task["day"]) for task in flat_tasks}):
                normalized_days.append({
                    "day": day_number,
                    "label": f"第{day_number}天",
                    "tasks": [
                        dict(task)
                        for task in flat_tasks
                        if task.get("day") == day_number
                    ],
                })

    normalized["days"] = normalized_days
    normalized["tasks"] = flat_tasks
    return normalized


def generate_plan(transcript: str) -> dict[str, Any] | None:
    """Generate a structured plan using LLM. Returns None on failure."""
    try:
        raw = _call_llm(
            system=_PLAN_GENERATOR_PROMPT,
            user=(
                f"当前北京时间日期：{datetime.now(_PLAN_TIMEZONE).date().isoformat()}\n"
                f"视频转录文本：\n\n{transcript[:5000]}"
            ),
            max_tokens=3072,
        )
        plan = json.loads(raw)
        plan.setdefault("goal", "")
        plan.setdefault("duration", "")
        plan.setdefault("tasks", [])
        plan.setdefault("metrics", [])
        plan.setdefault("resources", [])
        plan.setdefault("checkpoints", [])

        return _normalize_plan_payload(plan)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Image-based extraction (visual fallback when no transcript)
# ---------------------------------------------------------------------------

def extract_video_frames(video_url_or_path: str, max_frames: int = 8) -> list[str]:
    """Extract key frames from a video as base64-encoded JPEG strings.
    Returns empty list if ffmpeg is unavailable or fails.
    """
    import subprocess
    import base64
    import tempfile
    import os

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_url_or_path],
            capture_output=True, text=True, timeout=15,
        )
        duration = float(result.stdout.strip())
        if duration <= 0:
            return []

        interval = max(1.0, duration / max_frames)
        frames: list[str] = []

        with tempfile.TemporaryDirectory() as tmpdir:
            for i in range(max_frames):
                t = min(interval * i + interval / 2, duration - 0.5)
                out_path = os.path.join(tmpdir, f"frame_{i:02d}.jpg")
                subprocess.run(
                    ["ffmpeg", "-ss", str(t), "-i", video_url_or_path,
                     "-vframes", "1", "-q:v", "2", "-y", out_path],
                    capture_output=True, timeout=30,
                )
                if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                    with open(out_path, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode()
                        frames.append(f"data:image/jpeg;base64,{b64}")

        return frames
    except Exception:
        return []


def generate_card_from_images(
    images: list[str],
    video_title: str,
    content_type: str = "general",
) -> dict[str, Any] | None:
    """Generate a card from video frames using a vision-capable LLM.
    Falls back to None if the model doesn't support images.
    """
    if not images:
        return None

    try:
        content: list[dict] = [
            {"type": "text", "text": f"视频标题：{video_title}\n\n请根据这些视频截图生成知识卡片。"}
        ]
        for img in images:
            content.append({"type": "image_url", "image_url": {"url": img}})

        llm_cfg = _get_llm_config()
        kwargs: dict = {
            "model": llm_cfg["model"],
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 4096,
            "timeout": 90,
        }
        if llm_cfg["api_base"]:
            kwargs["api_base"] = llm_cfg["api_base"]
        if llm_cfg["api_key"]:
            kwargs["api_key"] = llm_cfg["api_key"]

        response = completion(**kwargs)
        choice = response.choices[0]
        raw: str = choice.message.content or ""
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw[raw.index("\n") + 1:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        card: dict[str, Any] = json.loads(raw)
        return _normalize_card(card, content_type)
    except Exception:
        return None

# ---------------------------------------------------------------------------
# Plan helpers
# ---------------------------------------------------------------------------

def plan_to_storage(plan: dict) -> tuple[list[dict], list[dict], int]:
    """Convert LLM plan into (fields, tasks, total_days). Supports new day-organized format."""
    import re
    total_days = 0
    normalized_plan = _normalize_plan_payload(plan)

    # Dynamic fields (new format) — AI decides which fields to display
    dynamic_fields = normalized_plan.get("dynamic_fields") or []
    if isinstance(dynamic_fields, list) and dynamic_fields:
        fields = [dict(field) for field in dynamic_fields]
    else:
        # Legacy: build fields from flat plan
        fields = []
        if normalized_plan.get("goal"):
            fields.append({"name": "goal", "label": "终极目标", "type": "text", "value": normalized_plan["goal"]})
        if normalized_plan.get("duration"):
            fields.append({"name": "duration", "label": "周期", "type": "text", "value": normalized_plan["duration"]})

    # Day-organized tasks (new format)
    days = normalized_plan.get("days") or []
    tasks_flat: list[dict[str, Any]] = []
    if isinstance(days, list) and days:
        total_days = max(
            (day.get("day", 0) for day in days if isinstance(day, dict)),
            default=0,
        )
        for day_obj in days:
            if isinstance(day_obj, dict):
                for t in day_obj.get("tasks", []):
                    if isinstance(t, dict):
                        tasks_flat.append(dict(t))
    else:
        # Legacy flat tasks
        tasks_flat = normalized_plan.get("tasks") or []
        if not total_days and tasks_flat:
            total_days = max(
                (
                    task.get("day", 1)
                    for task in tasks_flat
                    if isinstance(task, dict) and isinstance(task.get("day", 1), int)
                ),
                default=1,
            )

    # Parse total_days from duration
    duration = normalized_plan.get("duration", "")
    if duration and not total_days:
        num_match = re.search(r'(\d+)', str(duration))
        if num_match:
            num = int(num_match.group(1))
            if '周' in str(duration): total_days = num * 7
            elif '月' in str(duration): total_days = num * 30
            else: total_days = num

    return fields, tasks_flat, total_days
