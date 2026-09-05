## Why

用户只有 Windows 开发设备，希望开始提供 macOS 桌面客户端。现有 Electron 应用需要消除平台限制，并提供可在云端执行的 Mac 构建路径。

## What Changes

- 添加 Apple Silicon 与 Intel 的 macOS 安装包配置及手动云端构建流程。
- 适配原生窗口菜单、协议唤起、本机 Agent 桥接和跨平台路径。
- 隔离 Mac 更新源，区分未签名测试构建与签名公证发布。
- 提供所需软件、凭据和 Mac 验收说明。

## Capabilities

### New Capabilities
- `macos-desktop`: Mac 桌面运行、构建与发布准备。

### Modified Capabilities
无。

## Impact

涉及 desktop、CLI 本机连接层和 GitHub Actions；复用现有后端和网页。此次不宣称已通过真实 Mac 验收，云端工作流不自动发布安装包。用户后续明确授权发布后，将经哈希校验的测试包上传到正式站的独立测试下载目录。
