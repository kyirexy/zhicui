## Why

现有博主同步只能一次处理最近 20、50 或 100 条作品，用户无法先浏览一个博主的完整公开视频目录，再有选择地准备文稿。直接把“全部”解释为全量 ASR 会造成不可控的耗时与成本，因此需要把全量元数据发现和最多 50 条的按需转写拆开。

## What Changes

- 保留现有最近 20/50/100 条普通文稿同步，并兼容旧 `{limit}` 请求。
- 为抖音、B站增加“全部公开作品”元数据目录刷新；目录刷新不下载媒体、不执行 ASR、不生成 AI 卡片。
- 新增独立 `/library/creators` 页面，支持保存博主、搜索和筛选目录、分页浏览、最多选择 50 条准备普通文稿、取消与失败重试。
- 扩展博主作品、持久运行和逐条运行状态模型，支持可恢复发现、租约、有限退避重试、需用户处理状态以及完整扫描后的不可用标记。
- 抖音复用并扩展现有隔离 sidecar；B站以固定版本 yutto loopback sidecar 只读枚举投稿，并按 BVID 聚合多 P 文稿。
- 小红书继续只支持最近 20/50/100 条；不增加定时追更、媒体归档或自动 AI 处理。

## Capabilities

### New Capabilities

- `creator-catalog-workspace`: 独立博主页面、完整作品目录、分页筛选和最多 50 条按需准备文稿。
- `creator-catalog-connectors`: 抖音与 B站全量元数据连接器、取消、健康门控和敏感数据边界。

### Modified Capabilities

- `saved-creator-source-sync`: 将仅允许最近 20/50/100 的手动同步扩展为近期文稿、全量清单和勾选文稿三种明确操作，并强化持久恢复与逐条状态。

## Impact

- 后端：`CreatorSourceItem`、`CreatorSyncRun`、新 `CreatorSyncRunItem`，Creator Source API、worker、连接器与启动迁移。
- 前端：新增 `/library/creators`，扩展类型/API/全局任务状态，并从现有视频资料库提供入口。
- 部署：升级并固定抖音 sidecar，新增 GPL-3.0 yutto 2.2.0 独立 loopback 服务、token 文件、健康检查与源码说明。
- 验证：扩展后端 unittest、连接器假服务测试及 Next.js production build；功能默认关闭，管理员健康检查后显式开放。
