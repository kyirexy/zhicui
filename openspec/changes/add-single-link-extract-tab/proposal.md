## Why

桌面首页的“解析链接”当前在没有内嵌回调时跳转到 `/library`，让用户误以为单条解析属于视频资料页，也缺少一个可以反复进入、查看处理状态的稳定工作区。单条链接提取需要成为与批量视频资料、博主作品并列但边界清晰的独立入口。

## What Changes

- 新增 `/extract` 单条解析工作区，承载粘贴链接、提取进度、错误提示、知识卡结果和计划入口。
- 在桌面端左侧导航新增“单条解析”Tab，排列在“视频资料”和“博主作品”之间，并提供正确的选中态。
- 首页与工作台中的“解析链接 / 提取单条链接”统一导航到 `/extract`，不再跳转到 `/library` 或依赖首页内嵌展开。
- 移动端继续使用现有五个底部 Tab；`/extract` 可从首页快捷操作进入，但不新增第六个底部导航。
- 将 `/extract` 纳入现有登录保护和桌面工作区布局。

## Capabilities

### New Capabilities

- `single-link-extraction-workspace`: 定义单条链接独立工作区、桌面导航入口、提取状态和响应式行为。

### Modified Capabilities

- `douyin-library-homepage`: 将首页的单条提取次要操作从当前页内嵌流程调整为导航至独立工作区。

## Impact

- 前端导航配置、图标映射、桌面工作区状态和登录保护。
- 新增 Next.js `/extract` 客户端页面，并复用现有 `ExtractionContext`、`InputBar`、`PipelineProgress` 与 `CardRenderer`。
- 首页及 `WorkspaceActionHome` 的单条解析入口。
- 不新增后端 API、数据库字段或依赖。
