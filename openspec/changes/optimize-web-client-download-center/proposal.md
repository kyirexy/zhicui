## Why

Web 首页虽然已有零散的客户端下载入口，但版本信息是硬编码的，顶部入口在不同宽度下只强调单一平台，用户无法一眼确认 Android 与 Windows 都可下载。现在需要把它收束为一个干净、可信、跨平台一致的下载中心，并延续产品的纯白中性视觉。

## What Changes

- Web 首页始终展示 Android 与 Windows 两个正式客户端下载入口，不因设备类型隐藏另一平台。
- 首页从公开发布清单读取真实版本号、安装包大小、系统架构与下载地址；单个平台清单不可用时使用安全的内置回退值，不影响另一平台下载。
- 根据浏览器设备标记“本机推荐”，但不自动跳转、不阻止用户选择其他平台。
- 顶部导航统一为“下载客户端”入口并定位到下载中心，避免顶部只显示 Windows 或只显示 Android 的误导。
- 重构 Hero 与下载区的视觉层级：纯白背景、中性灰黑控件、清晰平台图标，品牌绿色仅保留在 Logo。
- 补全 Windows 发布清单的文件大小元数据，并保持 Android/Windows 公开下载地址无需登录即可访问。

## Capabilities

### New Capabilities

- `web-client-download-center`: 定义 Web 访客发现、比较并下载 Android 与 Windows 客户端，以及页面读取发布清单和按设备给出非阻塞推荐的行为。

### Modified Capabilities

无。

## Impact

- 受影响代码：Web 营销首页、全局 Web 顶部导航、客户端下载发布信息读取逻辑与下载区样式。
- 受影响静态资源：`frontend/public/download/latest.json` 与 `frontend/public/download/desktop-latest.json`（只消费现有 Android 清单并补充 Windows 文件大小）。
- 不改变后端 API、身份验证、原生客户端更新流程或现有安装包内容。
