## Why

当前 B 站和小红书只能逐条粘贴分享链接，无法像抖音视频库一样先登录账号、再查看并同步自己的喜欢或收藏。用户已经明确需要账号级资料入口，同时平台登录凭据不应离开用户本机或进入知萃数据库。

## What Changes

- 为 Windows 桌面端增加 B 站和小红书官方页面登录入口，使用按知萃用户及平台隔离的本机浏览器会话。
- 登录成功后允许同步最近 10 条喜欢或收藏；B 站通过登录态接口读取，小红书通过用户主动打开的个人主页可见内容读取。
- 桌面端只把规范化作品链接交给现有导入 API，Cookie、浏览器存储和平台令牌不上传服务器。
- 在“视频资料”页为 B 站和小红书提供连接状态、登录/重登、同步喜欢和同步收藏操作，并保留单链接批量导入。
- 对小红书同步标记 Beta 与风控提示；无法自动定位个人主页时，引导用户在打开的官方页面中进入自己的主页。
- 非 Windows 桌面环境继续提供链接导入，并明确账号同步需要桌面端。

## Capabilities

### New Capabilities

- `local-platform-account-sync`: 定义本机隔离浏览器登录、会话隐私、B 站/小红书喜欢与收藏链接采集、取消和错误反馈。

### Modified Capabilities

- `multi-platform-video-library-import`: 视频资料页除链接导入外，新增从本机账号同步得到的链接批次，并复用现有用户隔离导入流程。

## Impact

- `desktop/src/`：新增通用平台账号连接器，并扩展 Electron IPC、preload bridge、安全校验及状态事件。
- `frontend/src/components/PlatformLibraryPanel.tsx`、`frontend/src/lib/desktopRuntime.ts`：增加账号登录与喜欢/收藏同步界面和本地会话状态。
- 复用现有 `/api/library/imports`，首版不新增服务端 Cookie 存储或平台登录数据库表。
- 依赖现有 `playwright-core` 与用户安装的 Chrome/Edge；小红书页面结构或平台风控变化可能导致采集降级。
