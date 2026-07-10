"""
AI content extraction service.

Takes a raw transcript and produces a structured knowledge card using
DeepSeek-V3 via LiteLLM.
"""

from __future__ import annotations

import json
from typing import Any

from litellm import completion

from app.core.config import settings

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
- recipe: 美食烹饪、食谱教程
- insight: 知识观点、认知方法论
- history: 历史科普、文化解读
- product: 产品测评、好物推荐
- plan: 计划打卡、目标管理、训练安排、习惯养成
- general: 不属于以上任何类别
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
你是一个计划生成助手。根据视频转录文本，提取其中的计划/训练/打卡内容，
生成一份按天组织的可执行计划。

输出严格遵守 JSON 格式，不要包含任何其他文字：
{
  "goal": "计划的终极目标（20-50字）",
  "duration": "周期描述（如4周，28天）",
  "days": [
    {
      "day": 1,
      "label": "第一天：适应期",
      "tasks": [
        {"id": "t-001", "title": "具体任务", "done": false}
      ]
    },
    {
      "day": 2,
      "label": "第二天：进阶",
      "tasks": [
        {"id": "t-002", "title": "任务标题", "done": false},
        {"id": "t-003", "title": "另一任务", "done": false}
      ]
    }
  ],
  "dynamic_fields": [
    {"name": "goal", "label": "终极目标", "type": "text", "value": "..."},
    {"name": "duration", "label": "周期", "type": "text", "value": "4周"},
    {"name": "progress", "label": "整体进度", "type": "progress", "value": 0},
    {"name": "metrics", "label": "量化指标", "type": "list", "value": ["体重减5kg", "体脂降3%"]},
    {"name": "checkpoints", "label": "里程碑", "type": "checklist", "value": ["Week1: 建立习惯", "Week2: 初见成效"]},
    {"name": "resources", "label": "参考资料", "type": "list", "value": ["饮食计划表", "训练视频链接"]}
  ]
}

要求：
- days 数组每条代表一天，day 从 1 开始连续编号
- 每天至少 1 条 task，最多 8 条 task
- 每条 task 必须有 id（t-001 起）、title、done（默认 false）
- dynamic_fields 由你根据视频内容动态决定哪些字段展示（最少 3 个字段）
- 字段类型可选: text/number/list/checklist/progress/quote
- 没有内容就写空数组 []
"""


def generate_plan(transcript: str) -> dict[str, Any] | None:
    """Generate a structured plan using LLM. Returns None on failure."""
    try:
        raw = _call_llm(
            system=_PLAN_GENERATOR_PROMPT,
            user=f"视频转录文本：\n\n{transcript[:3000]}",
            max_tokens=2048,
        )
        plan = json.loads(raw)
        plan.setdefault("goal", "")
        plan.setdefault("duration", "")
        plan.setdefault("tasks", [])
        plan.setdefault("metrics", [])
        plan.setdefault("resources", [])
        plan.setdefault("checkpoints", [])
        for i, t in enumerate(plan.get("tasks", [])):
            if isinstance(t, dict):
                t.setdefault("id", f"t-{i+1:03d}")
                t.setdefault("done", False)
        return plan
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

    # Dynamic fields (new format) — AI decides which fields to display
    dynamic_fields = plan.get("dynamic_fields") or []
    if isinstance(dynamic_fields, list) and dynamic_fields:
        fields = []
        for f in dynamic_fields:
            if isinstance(f, dict) and f.get("name") and f.get("label"):
                fields.append({"name": f["name"], "label": f["label"],
                              "type": f.get("type", "text"), "value": f.get("value")})
    else:
        # Legacy: build fields from flat plan
        fields = []
        if plan.get("goal"):
            fields.append({"name": "goal", "label": "终极目标", "type": "text", "value": plan["goal"]})
        if plan.get("duration"):
            fields.append({"name": "duration", "label": "周期", "type": "text", "value": plan["duration"]})

    # Day-organized tasks (new format)
    days = plan.get("days") or []
    tasks_flat = []
    if isinstance(days, list) and days:
        total_days = len(days)
        for day_obj in days:
            if isinstance(day_obj, dict):
                for t in day_obj.get("tasks", []):
                    if isinstance(t, dict):
                        t.setdefault("id", f"t-{len(tasks_flat)+1:03d}")
                        t.setdefault("done", False)
                        tasks_flat.append(t)
    else:
        # Legacy flat tasks
        tasks_flat = plan.get("tasks") or []
        if not total_days and tasks_flat:
            total_days = 1

    # Parse total_days from duration
    duration = plan.get("duration", "")
    if duration and not total_days:
        num_match = re.search(r'(\d+)', str(duration))
        if num_match:
            num = int(num_match.group(1))
            if '周' in str(duration): total_days = num * 7
            elif '月' in str(duration): total_days = num * 30
            else: total_days = num

    return fields, tasks_flat, total_days
