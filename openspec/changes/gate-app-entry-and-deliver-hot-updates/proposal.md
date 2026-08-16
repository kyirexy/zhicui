## Why

Windows 与 Android 客户端当前把根路由当作公开页面，认证状态恢复期间或未登录时仍可能露出工作台外壳与骨架屏，用户无法明确知道应先登录或注册。与此同时，远端网页已经部署新版本时，正在运行的桌面客户端不会主动发现；Windows 原生更新器虽已接入，但发布源没有可消费的更新产物。

## What Changes

- Windows 与 Android 客户端启动后先恢复账号状态；无有效会话时直接进入统一的登录/注册页，不渲染工作台导航、数据骨架或后台请求。
- 保持普通浏览器官网首页公开，不把营销首页改成强制登录。
- 登录或注册成功后返回原目标页；退出登录后客户端立即回到登录页。
- 为远端网页构建提供不可缓存的版本标识；运行中的客户端在恢复焦点及低频轮询时发现新版，并在安全时刷新或提示用户刷新。
- 明确网页热更新与 Electron 原生更新的边界：网页与 API 更新无需重装，main/preload 等原生变化仍通过安装包更新。
- 补强 Windows 更新检查调度与发布契约，使更新源必须原子提供清单、安装包和差分文件；下载完成后由用户确认重启安装。

## Capabilities

### New Capabilities

- `client-auth-entry`: Windows 与 Android 客户端的启动认证门禁、登录注册入口和登出回流行为。
- `client-update-delivery`: 远端网页构建发现与刷新，以及 Windows 原生安装包更新的检查和发布契约。

### Modified Capabilities


## Impact

- 前端认证门禁、客户端壳层、首页分流、登录页和后台任务 Provider。
- Electron 主进程、preload/contract、更新检查调度与 electron-builder 发布配置。
- Next.js 构建版本文件、部署缓存策略与 Windows 发布产物。
- 不修改认证 API 的 JWT 语义，也不公开任何受保护的数据接口。
