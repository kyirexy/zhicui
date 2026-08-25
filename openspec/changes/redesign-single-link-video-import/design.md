## Context

`/extract` 当前在 `ExtractionContext` 完成后拿到 `CardData`，其中 `id` 是已保存 note id；随后页面本地渲染 `CardRenderer`。现有 `/library/detail?note=<id>` 已由 `VideoKnowledgeWorkspace` 提供原视频、文稿、摘要和提问，是单条视频的权威详情界面。

## Goals / Non-Goals

**Goals:**

- 让单条解析成为清晰、单一职责的视频导入流程。
- 完成后无缝进入现有视频详情并看到原视频。
- 移除入口页的卡片概念和重复结果 UI。
- 保持手动提交、跨路由提取状态与错误恢复能力。

**Non-Goals:**

- 不移除后端已有的结构化摘要字段或历史卡片兼容能力。
- 不重做 `VideoKnowledgeWorkspace` 播放器与详情布局。
- 不改变批量同步流程。

## Decisions

1. 在 `/extract` 监听 `cardData.id` 并使用 `router.replace('/library/detail?note=...')`。使用 replace 避免用户返回时再次落入已完成并立即跳转的页面。
2. 在发起新解析前记录当前任务的导航状态，确保旧的 `cardData` 不会在页面初次挂载时意外触发跳转；仅对本页本次提交完成的结果自动导航。
3. 删除 `CardRenderer` 和行动计划结果卡。详情页是结果唯一呈现位置，避免双份 UI 与“知识卡”术语。
4. 保留进度和取消；完成到路由切换之间展示“正在打开视频资料”，提供可理解的过渡状态。
5. 当完成数据缺少 id 时，不导航，显示“已保存，可前往视频资料查看”的回退操作。
6. `parse_done` 流式事件携带经过白名单挑选的视频预览字段，`transcribe_done` 携带本次完整文稿；`ExtractionContext` 仅在内存中保存这些中间结果并在新任务/取消时清空。入口页据此渐进展示原视频和文稿，最终 `done` 前绝不导航。
7. B站详情不把 yt-dlp 的 DASH 分离轨道或网页 URL交给原生 `<video>`。当存在合法 BVID 时使用固定域名的 B站官方 iframe 播放器；yt-dlp 继续只负责元数据、字幕与 ASR 输入。

## Risks / Trade-offs

- [Risk] 全局 context 可能保留上一次结果 → 只在用户从本页启动任务后设置自动导航许可，并在导航后立即清除许可。
- [Risk] 详情 API 写入后短暂不可见 → SSE 的 done 在持久化后发送，且详情页已有加载状态。
- [Risk] 用户希望停留查看结果 → 统一详情页覆盖原视频、文稿和后续操作，信息更完整。
