## Why

视频资料详情已有本地保存能力，但当前下载会直接使用预设目录，用户无法在每次下载时选择文件夹；同时 Electron 主进程使用 Node 内置网络流下载时可能在接近完成时触发断言并崩溃。需要把它完善为可靠的“选择目录并下载视频”功能。

## What Changes

- 在视频资料详情提供明确的“下载视频”操作。
- 点击下载后打开 Windows 原生文件夹选择器，取消选择时不创建文件。
- 将用户选择的文件夹用于本次下载，并记为后续默认位置。
- 展示下载进度、保存位置、完成状态和失败重试。
- 使用 Electron 网络栈读取视频，避免 Node `undici` 流在下载结束阶段导致主进程崩溃。
- Web 和 Android 保持现有远程播放体验，不展示本地路径选择操作。

## Capabilities

### New Capabilities
- `library-video-download`: 视频资料详情中的桌面端目录选择、可靠下载、进度与完成状态。

### Modified Capabilities

无。

## Impact

- 桌面端：`desktop/src/media-library.ts`、IPC 合约、主进程和 preload 桥接。
- 前端：桌面运行时类型、视频详情播放器及本地下载状态样式。
- 不新增服务端视频存储，不修改数据库结构。
