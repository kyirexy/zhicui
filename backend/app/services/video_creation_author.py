"""「创作工坊」SVML 创作服务:知萃 LLM 生成 / 迭代 hypit SVML。

创作流程:需求文本 → LLM 生成 SVML 草稿 → 写入 job 项目目录 → `hypit check`
预检 → 语法错误回喂 LLM 自动修正(最多 MAX_CHECK_ATTEMPTS 轮)→ 返回草稿。
draft 阶段不触发任何生成或渲染,也不产生费用;confirm 之后才由 worker 估价渲染。
"""

from __future__ import annotations

from app.core.config import settings
from app.services import hypit_service
from app.services.hypit_service import HypitError

MAX_CHECK_ATTEMPTS = 3

# 内置于 prompt 的 SVML 语法精华:来自 hypit 官方 examples(interview /
# complex-explainer)的结构观察,覆盖头部、import、script 语义分段、
# 语义锚点与发音标注、零生成组件与生成组件、SVRUN 目标声明。
SVML_SYNTAX_GUIDE = """SVML 语法规则(必须严格遵守):
1. 文件第一行必须是 `<?svml using="@hypit/markup@1"?>`,根元素是 <svml>…</svml>。
2. 所有包能力先 <import> 再使用:`<import as="script" from="@hypit/script@1"/>`
   `<import as="text" from="@hypit/text@1"/>` `<import as="time" from="@hypit/timeline-author@1"/>`
   `<import as="caption" from="@hypit/caption@1"/>` `<import as="fish" from="@hypit/fishaudio-speech@1"/>`
   `<import as="gpt" from="@hypit/gpt-image@1"/>` `<import as="seedance" from="@hypit/seedance@1"/>`
   `<import as="film" from="@hypit/film@1"/>` `<import as="render" from="@hypit/render-hyperframes@1"/>`
   本地样式:`<import as="look" source="./look.svs"/>`。不得 import 未列出的包名。
3. 台词写在 `<script id="story">` 内,按语义分段:`<opening>` `<body>` `<closing>` 等小节;
   每行 `<角色名>台词内容`;`||` 把台词切成自然的朗读短句;`@{anchor-id!}` 标注动效锚点;
   `<词 | 读音>` 标注多音字发音(如 `<长 | zhang>`)。
4. 共享的视觉描述用 `<text:Value id="...">多行描述</text:Value>` 定义,别处用 {id} 引用。
5. 画面与动效以组件方式表达,一个组件一个语义(榜单/卡片/字幕/图表);
   组件的参数用 `={shared-id}` 引用 text:Value,不要内联大段文字。
6. 保持作品短小:总时长目标 15-40 秒;不确定的能力宁可不用,优先零生成组件
   (text/program/caption/film),生成组件(gpt-image/seedance/fishaudio)只在
   用户明确要求出镜人物、实景画面或配音时使用,且数量控制在 1-2 个。
7. 只输出 SVML 文件本身的完整内容,不要 markdown 代码围栏,不要解释。"""

SYSTEM_PROMPT = f"""你是知萃「创作工坊」的导演兼 SVML 编剧,负责把用户的视频需求写成
hypit 可渲染的 SVML 项目。你的作品将由 hypit Runtime 在服务器上渲染为 MP4。

{SVML_SYNTAX_GUIDE}

创作要求:
- 用中文思考与创作;台词自然口语化,信息密度高,有明确的观看理由。
- 先想清楚"观众为什么看、看完记住什么",再落笔;每个段落服务于一个语义。
- 尊重用户给定的主题、风格与时长;未提及时长则取 20-30 秒。

回答格式(严格遵守):
第一行到最后一行输出完整 SVML 文件内容;SVML 之后另起一行输出一行 `EXPLANATION:` 开头的
中文创作说明(不超过 120 字,向用户讲述你的创作思路,不要复述 SVML 本身)。"""

ITERATE_SYSTEM_PROMPT = f"""你是知萃「创作工坊」的导演兼 SVML 编剧,负责按用户反馈修改已有的
hypit SVML 项目。保留原作中仍然成立的部分,只改动反馈要求的内容。

{SVML_SYNTAX_GUIDE}

回答格式(严格遵守):
第一行到最后一行输出修改后的完整 SVML 文件内容;SVML 之后另起一行输出一行 `EXPLANATION:` 开头的
中文修改说明(不超过 120 字,说明改了什么、为什么)。"""


def _split_response(raw: str) -> tuple[str, str]:
    """把模型输出拆成 (SVML 正文, 创作说明)。"""
    marker = "EXPLANATION:"
    index = raw.rfind(marker)
    if index < 0:
        return raw.strip(), ""
    svml = raw[:index].strip()
    explanation = raw[index + len(marker):].strip()
    if svml.startswith("```"):
        first_newline = svml.find("\n")
        svml = svml[first_newline + 1:] if first_newline >= 0 else svml[3:]
    if svml.endswith("```"):
        svml = svml[:-3]
    return svml.strip(), explanation[:300]


def _call_author(system: str, user: str) -> tuple[str, str]:
    # 局部 import:ai_juicer 体量大,保持 author 模块导入轻量。
    from app.services.ai_juicer import _call_llm

    raw = _call_llm(
        system,
        user,
        max_tokens=8192,
        temperature=0.4,
        timeout=180,
        operation="video_creation_author",
    )
    return _split_response(raw)


def _precheck(svml_text: str, job_id: str) -> None:
    """写盘并跑 hypit check;语法错误抛 HypitError(message 即反馈)。"""
    directory = hypit_service.write_project(job_id, svml_text=svml_text)
    hypit_service.check_source(directory)


def draft_svml(job_id: str, requirement: str) -> tuple[str, str]:
    """从需求生成 SVML 草稿;自动修正最多 MAX_CHECK_ATTEMPTS 轮。"""
    user_prompt = f"创作需求:\n{requirement.strip()}"
    feedback: list[str] = []
    last_svml = ""
    last_explanation = ""
    for attempt in range(1, MAX_CHECK_ATTEMPTS + 1):
        prompt = user_prompt if not feedback else (
            f"{user_prompt}\n\n你上一版 SVML 未通过 hypit 预检,错误信息:\n"
            f"{feedback[-1]}\n请修正语法后重新输出完整 SVML。"
        )
        last_svml, last_explanation = _call_author(SYSTEM_PROMPT, prompt)
        if not last_svml:
            feedback.append("模型没有输出 SVML 内容")
            continue
        try:
            _precheck(last_svml, job_id)
        except HypitError as exc:
            feedback.append(exc.message)
            continue
        return last_svml, last_explanation or "已完成创作。"
    raise HypitError(
        "svml_authoring_failed",
        "AI 创作多次未通过语法预检,请换一个更简单的需求描述再试,"
        f"最后一次错误:{feedback[-1] if feedback else '未知'}",
    )


def iterate_svml(job_id: str, current_svml: str, requirement: str, feedback: str) -> tuple[str, str]:
    """按用户反馈迭代现有 SVML;同样带预检自动修正。"""
    user_prompt = (
        f"创作需求:\n{requirement.strip()}\n\n"
        f"当前 SVML:\n{current_svml}\n\n"
        f"修改反馈:\n{feedback.strip()}"
    )
    check_feedback: list[str] = []
    last_svml = ""
    last_explanation = ""
    for attempt in range(1, MAX_CHECK_ATTEMPTS + 1):
        prompt = user_prompt if not check_feedback else (
            f"{user_prompt}\n\n你上一版修改未通过 hypit 预检,错误信息:\n"
            f"{check_feedback[-1]}\n请修正语法后重新输出完整 SVML。"
        )
        last_svml, last_explanation = _call_author(ITERATE_SYSTEM_PROMPT, prompt)
        if not last_svml:
            check_feedback.append("模型没有输出 SVML 内容")
            continue
        try:
            _precheck(last_svml, job_id)
        except HypitError as exc:
            check_feedback.append(exc.message)
            continue
        return last_svml, last_explanation or "已完成修改。"
    raise HypitError(
        "svml_authoring_failed",
        "AI 修改多次未通过语法预检,请把反馈说得更具体一些,"
        f"最后一次错误:{check_feedback[-1] if check_feedback else '未知'}",
    )


def feature_enabled() -> bool:
    """功能总开关:环境配置 + 管理员设置由路由层叠加。"""
    return bool(settings.HYPIT_ENABLED)
