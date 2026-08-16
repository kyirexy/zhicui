## Why

独立计划 Tab 已经建立，但 Android 窄屏仍存在顶部空白过大、悬浮新增按钮偏位、计划行层级拥挤和删除确认可访问性不完整的问题。同时 Windows 桌面侧栏没有 Android 下载入口，用户无法从正在使用的桌面客户端顺畅获取最新版移动端。

## What Changes

- 收紧移动端计划中心的首屏结构，让标题、摘要和三个内部视图在无需大段滚动时即可操作。
- 将计划列表、计划详情、快速新增和删除确认调整为适合单手操作、软键盘和底部安全区的移动布局。
- 在 Windows 桌面侧栏左下区域新增清晰的 Android 下载按钮，直接下载可信 APK。
- 重新生成 Android APK 与公开版本清单，但不自动提交或推送代码。

## Capabilities

### New Capabilities

- `desktop-android-download-entry`: 定义 Windows 桌面客户端获取 Android 安装包的固定入口和下载行为。

### Modified Capabilities

- `clear-action-plan-workspace`: 完善移动端计划中心从浏览、创建、详情、任务操作到安全删除的可用布局。
- `mobile-app-updates`: 要求重新构建的 APK 与公开版本清单保持一致，并包含本次移动端体验更新。

## Impact

- 前端计划页与样式：`app/plans/page.tsx`、`components/plans/PlanWorkspace.module.css`。
- 桌面侧栏：`components/DesktopAppFrame.tsx`、`app/globals.css`。
- Android 静态导出、Gradle 构建产物及 `public/download/latest.json`。
- 不修改计划后端 API 或数据模型，不执行 Git 提交和远程推送。
