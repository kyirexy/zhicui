## Why

视频资料以卡片网格展示时，逐个点击复选框选择多条视频成本很高，尤其无法完成用户熟悉的“鼠标画一个范围”批量选择。现在需要把桌面框选补到资料库和 AI 来源列表中，让批量提取与去问 AI 的选择过程保持连续。

## What Changes

- 为视频资料网格和列表增加桌面鼠标拖拽框选，范围与资料项相交时实时更新选择。
- 默认拖拽建立新的选择集合，按住 Ctrl/Cmd 拖拽时在原选择上追加；Esc 可取消本次手势。
- 复用现有选择上限、批处理锁定和 AI 来源选择集合，不改变结构化文案及 Agent 交接语义。
- 保留卡片打开、播放、复选框、键盘操作与触屏滚动；触摸和触控笔不启用框选。
- 提供清晰但不遮挡内容的选区视觉层，并在拖拽完成后阻止同一次手势误触卡片。

## Capabilities

### New Capabilities

- `drag-marquee-video-selection`: 规定视频资料和 AI 来源列表中的桌面拖拽框选、追加选择、上限、锁定、点击保护与触屏边界。

### Modified Capabilities

无。

## Impact

- 前端新增可复用的框选手势 hook 和选区视觉组件。
- `frontend/src/app/library/page.tsx`、`LibraryVideoCard.tsx` 接入资料库框选。
- `frontend/src/components/agent/VideoAgentWorkspace.tsx` 接入 AI 来源列表框选。
- 不新增后端 API、第三方依赖、数据库字段或移动端手势。
