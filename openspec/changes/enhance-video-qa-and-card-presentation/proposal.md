## Why

现有笔记问答已经能基于转录内容作答，但只返回一段纯文本，用户无法查看答案依据，也无法在刷新或页面切换后延续当前追问。卡片系统虽然已有多套主题，详情页中的切换入口和内容层级仍不够清晰，卡片与问答也像两个割裂的功能。

## What Changes

- 将笔记问答响应升级为结构化结果，包含答案、经过服务端校验的原文证据、依据充分度和后续推荐问题。
- 在同一笔记内保留最近的会话状态，让用户能够连续追问、点击证据并清晰区分“原文明确提到”和“来源不足”。
- 将卡片、外观选择、导出/原文入口和问答整合为统一的内容工作区，并针对桌面端和移动端分别优化布局。
- 重组卡片主题选择器，用阅读、表达、专业三组呈现 9 套主题，补充推荐标识和更清晰的真实预览。
- 在笔记详情页开放当前卡片的临时样式与密度切换，不改变用户的全局默认设置。

## Capabilities

### New Capabilities

- `grounded-video-qa`: 基于用户自有笔记的转录与摘要进行连续问答，返回可核验的原文证据和后续追问。
- `card-presentation-workspace`: 以响应式工作区展示知识卡片、外观控制、来源入口和内容问答，并提供分组主题选择。

### Modified Capabilities

<!-- 当前 openspec/specs/ 下没有可修改的既有能力。 -->

## Impact

- 后端：`backend/app/services/ai_juicer.py` 的问答提示词、结构化解析与证据校验，`backend/app/api/routes.py` 的问答响应。
- 前端：问答类型和 API 客户端、`ContentChat`、`CardRenderer`、`StylePicker`、`StyleToolbar`、笔记详情页和相关全局样式。
- API：`POST /api/notes/{note_id}/ask` 保留现有 `answer` 与 `grounded` 字段，并新增证据与推荐问题字段；不涉及数据库迁移。
- 依赖：复用现有 React、Phosphor Icons、GSAP 与 CSS，不新增运行时依赖。
