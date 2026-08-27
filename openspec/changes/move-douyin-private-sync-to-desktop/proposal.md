## Why

生产环境从腾讯云数据中心 IP 读取抖音喜欢和收藏时会被平台判定为 `risk_controlled`，即使登录 Cookie 有效也无法形成稳定的消费产品体验。Windows 客户端已经具备按用户隔离的本机 Chrome/Edge 持久会话和 B站、小红书本地采集能力，现在应将抖音私人列表同步迁移到同一受控本地连接器，使用用户自己的网络和官方页面会话。

## What Changes

- Windows 客户端新增抖音持久本机会话，首次连接或平台要求验证时才显示官方 Chrome/Edge 页面。
- 喜欢、收藏和我的作品由桌面主进程在本机读取，Cookie、LocalStorage、签名参数和浏览器 profile 不上传服务器或暴露给渲染进程。
- 本地连接器只向现有资料导入链路提交规范化作品链接和公开元数据；视频文稿、知识使用和跨设备资料仍由云端完成。
- 抖音账号同步保持纯手动，支持 20/50/100 条和最多 100 条自定义数量；不定时追更、不自动重试风控失败。
- 已连接且会话有效时后台执行同步，不主动弹出网页；登录失效、验证码或平台验证时才引导用户打开官方页面。
- 普通 Web 和 Android 不伪装支持抖音私人列表读取，明确引导在 Windows 客户端连接或同步，已同步资料仍可跨端使用。
- 云端 sidecar 保留公开博主目录、单链接和旧客户端兼容能力，但新版 Windows 客户端不再把抖音私人列表作为默认云端同步通道。
- 账号状态文案区分“登录条件完整”与“本次读取成功”，不得把凭据存在描述为平台保证可同步。

## Capabilities

### New Capabilities

- `desktop-douyin-private-sync`: 定义 Windows 本机抖音登录、私人来源读取、数据边界、验证回退和版本兼容行为。

### Modified Capabilities

- `douyin-library-sync-control`: 将新版 Windows 客户端的喜欢、收藏和作品同步改为本机手动采集，并更新准确状态与冷却反馈要求。
- `multi-platform-video-library-import`: 允许受信任桌面连接器提交抖音规范化作品链接，并保持用户隔离、幂等与逐条导入反馈。

## Impact

- `desktop/src/platform-account.ts`、Electron contract/security/main/preload：增加抖音 provider、持久会话、采集和安全状态事件。
- `frontend/src/app/library/page.tsx`、同步 Sheet 与桌面运行时类型：桌面环境切换到本地抖音连接器并复用现有导入 API。
- `backend`：扩展批量导入对抖音规范化链接的支持与低敏来源诊断；保留旧客户端 API 兼容。
- Windows 安装包需要发布新的 Electron main/preload 版本；远程 Web UI 可以正常热更新，但本地采集能力必须通过原生自动更新交付。
- 不新增服务端 Cookie 字段，不新增 Python sidecar 到桌面包，不自动下载或永久保存视频文件。
