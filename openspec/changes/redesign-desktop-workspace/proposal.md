## Why

当前 Windows 桌面端只是把网页原样装进 Electron，首屏仍是营销落地页，导航、留白和信息密度也没有体现桌面应用优势。用户安装桌面端后应立即进入一个专注于同步、提问、计划和知识整理的原生工作台，而不是再次浏览网站介绍。

## What Changes

- 为 Electron 运行时新增独立的桌面应用壳，使用紧凑导航轨道、页面标题栏、账号区和桌面状态区。
- 桌面端根页面改为“今日工作台”，直接展示视频库状态、最近内容、待办计划和核心快捷操作。
- 视频库、知识库、计划和设置在桌面端使用统一的工作区宽度、面板层级、字体比例和交互状态。
- 普通 Web 与 Android/移动网页继续使用当前导航和首页，不因桌面端重设计改变核心布局。
- 保留现有账号、抖音绑定、问答、计划、反馈和自动更新能力，不改变 API 或数据存储边界。

## Capabilities

### New Capabilities

- `desktop-native-workspace`: 定义 Electron 桌面端专属应用壳、工作台首页、导航、核心页面适配和响应式退化行为。

### Modified Capabilities

无。

## Impact

- 新增桌面运行时壳、桌面工作台首页和桌面专属样式。
- 调整根布局、首页、现有导航组件及核心页面的桌面运行时标记。
- 复用现有 Next.js 16、React 19、Tailwind v4、CSS 变量和 Electron preload bridge，不新增后端 API 或 UI 依赖。
- Windows 安装包需重新构建；普通 Web 与 Android 构建需回归验证。
