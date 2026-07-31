## Why

普通网页无法读取抖音登录 Cookie，也无法让服务器上的浏览器变成用户本机设备；现有 localhost 连接方式要求用户单独运行技术工具，服务器二维码又会显示 Linux/异地位置并触发风控。既然可靠绑定需要安装本地能力，应将它做成完整、可更新的知萃 Windows 应用，而不是暴露连接器和端口。

## What Changes

- 新增知萃 Windows 桌面应用，复用现有网页产品和正式 API，提供单实例、深链和自动更新基础。
- 桌面应用在用户本机启动已安装的 Chrome（缺失时回退 Edge）完成抖音扫码，使用用户自己的 Windows 设备与网络。
- 登录结果通过已有的短时签名交接接口回传；Cookie 按知萃账号隔离地进入扫码服务会话，不写入知萃数据库。
- 视频库在桌面应用内直接发起本机登录；普通网页不再自动访问 `127.0.0.1`，而是引导打开或下载桌面应用。
- 手机网页和 Android 继续提示在 Windows 应用完成一次绑定，绑定后同一知萃账号可跨端使用。
- 新增 Windows 安装包构建与 GitHub Release 自动更新配置基础。

## Capabilities

### New Capabilities

- `windows-desktop-app`: Windows 应用壳、单实例、深链、可信导航、版本信息和更新能力。
- `desktop-douyin-login`: 本机 Chrome/Edge 扫码、短时签名回传、取消、超时和 Cookie 安全边界。

### Modified Capabilities

无。

## Impact

- 新增 `desktop/` Electron 工程及 Windows NSIS 打包配置。
- 前端视频库新增桌面运行时检测和本机扫码桥接，调整网页/移动端登录引导。
- 后端复用 `/api/library/douyin/local-handoff` 与 `/complete`，不新增 Cookie 或视频数据库字段。
- 发布流程需要生成 Windows 安装包；未配置代码签名证书时 Windows 可能显示 SmartScreen 提示。
