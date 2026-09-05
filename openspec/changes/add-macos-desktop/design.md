## Context

Electron 已有 activate/window-all-closed 和 open-url 处理。浏览器采集使用 Playwright 的 Chrome/Edge channel，支持 macOS 安装路径。现有打包和 CLI 本机桥接仅启用 Windows。

## Goals / Non-Goals

Goals: 可在 macOS runner 构建 Intel/Apple Silicon 安装包，支持原生菜单与平台正确的本机桥接路径。
Non-Goals: 此次不制作 iOS、不购买证书、不由云端工作流自动发布线上安装包。用户已追加授权部署 Web 与所有安装包，允许单独发布明确标注的 Mac 测试包。

## Decisions

- 复用 Electron 与现有用户数据路径；macOS 使用原生标题栏，避免自定义拖动条和红黄绿按钮重叠。
- 本机 Agent 描述文件与 CLI 统一采用 ~/Library/Application Support/Zhicui；保留权限、认证和用户隔离。
- 独立 macOS electron-builder 配置提供 dmg/zip 和专属更新目录；测试包显式禁用自动更新。
- 手动 GitHub Actions 构建，默认无签名；正式模式验证证书和 Apple 公证凭据后构建并验证签名、公证。产物仅保留在 Actions artifact。
- 授权后的测试发布使用 /download/mac/test/<提交>/，经本地、服务器与公网回读哈希校验；Nginx 从持久目录提供下载，不改动任何正式更新 feed。

## Risks / Trade-offs

- 缺少 macOS 主机 → 本地做跨平台逻辑验证，云端构建和真实扫码验收保持未完成。
- 未签名测试包受 Gatekeeper 限制 → 仅用于开发验证，正式分发走签名公证。
- Safari 不支持现有 Chromium 连接方式 → 同步仍需 Mac 安装 Chrome 或 Edge。
