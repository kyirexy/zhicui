## Why

现有同步只能读取当前账号的喜欢、收藏或逐条粘贴作品链接，用户无法保存一个指定博主并反复增量同步其新作品。知萃需要把博主主页变成可复用、按需更新的资料来源，同时维持当前不自动抓取、不长期保存媒体和不自动执行视觉解析的成本边界。

## What Changes

- 在现有“同步视频”Sheet 内加入“指定博主”，支持保存并手动更新抖音、B站和小红书博主。
- 增加博主来源、作品来源映射和持久同步任务，提供幂等、增量、取消、重启恢复与永久移除保护。
- 增加服务器端三平台适配器：B站使用现有 yt-dlp，抖音扩展 MIT sidecar，小红书扩展隔离的 GPL-3.0 sidecar。
- 同步最近 20、50 或 100 条公开作品；小红书仅同步视频。只保存元数据与普通文稿，媒体临时使用后清理。
- 在现有管理配置中增加功能开关、连接器健康测试、小红书加密服务凭证和并发配置。
- 不增加主导航，不引入 MediaCrawler，不提供定时自动监控或多博主批量更新。

## Capabilities

### New Capabilities

- `saved-creator-source-sync`: 保存、解析、手动增量同步三平台博主，并管理后台任务、凭证隔离、媒体生命周期和用户交互。

### Modified Capabilities

<!-- No existing requirement is weakened or replaced; creator sources extend the current library. -->

## Impact

- 后端增加 SQLAlchemy 模型、用户与管理 API、持久 Worker 和三平台连接器适配层。
- 抖音与小红书 loopback sidecar 增加博主解析及作品枚举能力；部署需要固定版本、健康检查和许可证说明。
- 前端同步 Sheet、全局后台状态和资料删除路径增加博主来源语义。
- 数据库继续只保存标识、元数据、普通文稿与脱敏任务结果，不保存 Cookie、签名媒体 URL 或媒体文件。
