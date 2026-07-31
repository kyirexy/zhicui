## Why

知萃已经同时提供移动网页、Android App 和 Windows 桌面端，但当前移动页面仍有底部导航与浮动反馈入口遮挡内容、视频卡片字号偏小、更新入口按平台割裂等问题。Windows 端也只有后台检查能力，用户无法看见下载进度或在下载完成后直接安装，影响长期使用。

## What Changes

- 统一移动端页面安全区、底部导航、浮动反馈入口和全屏弹层的空间关系。
- 保留视频库手机双列浏览，同时提高标题、状态、选择和更多操作的可读性与触控尺寸。
- 将设置页升级为跨端版本中心：Android 显示原生更新，Windows 显示桌面版本与安装进度，Web 提供两个客户端的清晰下载入口。
- Windows 客户端启动后自动检测新版，下载期间显示状态，下载完成后允许用户一键重启安装。
- 更新版本说明和移动端文案，避免展示过期或相互矛盾的版本信息。

## Capabilities

### New Capabilities

- `adaptive-mobile-shell`: 规定移动端底部安全区、触控目标、视频库密度和全屏交互的适配要求。
- `desktop-update-experience`: 规定 Windows 客户端自动检测、下载进度、更新提示和一键安装行为。

### Modified Capabilities

- `mobile-app-updates`: 设置页除 Android 原生更新外，应在普通 Web 环境提供明确的 Windows 与 Android 客户端入口，并保持移动布局可用。

## Impact

- 前端全局布局、底部导航、反馈入口、设置页、视频库移动样式和更新提示组件。
- Electron preload/IPC 更新契约、更新事件转发和安装动作。
- Windows 安装包版本与下载元数据；Android 生产静态资源重新同步。
- 不改变用户数据、抖音 Cookie 和视频文件的存储边界。
