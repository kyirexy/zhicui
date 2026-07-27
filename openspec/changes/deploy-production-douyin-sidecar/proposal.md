## Why

知萃线上已经包含批量抖音视频库界面，但生产服务器没有本地开发环境中的 `douyin-downloader :9000` 伴随服务，因此视频库会显示未连接；现有扫码流程还依赖弹出桌面浏览器，无法在无桌面的云服务器上使用。需要部署可远程扫码、按用户选择范围同步的元数据伴随服务，同时确保生产服务器不持久化任何视频文件。

## What Changes

- 将本地改造版 `douyin-downloader` 部署到生产服务器，使用独立 Python 虚拟环境和 systemd 服务，只监听 `127.0.0.1:9000`。
- 将 Cookie 与资料库元数据保存在伴随服务目录，Cookie 使用仅服务账号可读的权限；知萃数据库与伴随服务目录均不保存视频二进制。
- 收藏同步由用户选择最近 50 或 100 条，最大 100 条；同步只读取元数据，不下载视频。
- 播放和 ASR 使用即时远程流；ASR 临时文件无论成功或失败都会清理。
- 扫码登录改为服务器虚拟显示中的标准 Chromium 生成二维码，知萃通过受认证 API 获取短生命周期二维码并直接在视频库页面展示。
- 为知萃后端增加二维码代理和安全响应过滤，伴随服务的 Cookie 明文永远不返回给浏览器。
- 增加可重复执行的生产安装脚本、systemd unit 与健康验证步骤。

## Capabilities

### New Capabilities

- `production-douyin-sidecar`: 在生产环境安全运行抖音收藏伴随服务，持久化有界元数据但不持久化视频。
- `remote-douyin-qr-login`: 在无桌面的生产服务器上生成并展示可远程扫码的抖音登录二维码，登录状态和 Cookie 对浏览器保持最小披露。

### Modified Capabilities

无。

## Impact

- 参考项目 `douyin-downloader/server/app.py` 的登录状态协议和 Playwright 启动方式。
- 知萃后端 `douyin_library` 适配器、登录 API 与生产配置。
- 知萃前端视频库登录区域和移动端二维码展示。
- `deploy/` 中新增伴随服务安装、systemd 和运行手册；生产服务器新增 `/opt/douyin-downloader`、独立 venv 与元数据目录。
