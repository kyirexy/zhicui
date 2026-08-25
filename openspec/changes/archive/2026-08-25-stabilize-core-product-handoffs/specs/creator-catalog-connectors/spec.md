## MODIFIED Requirements

### Requirement: B站全量目录使用独立 yutto sidecar
系统 SHALL 优先使用固定版本 yutto 2.2.0 的 loopback sidecar，通过 `resolve.start` 和 `item_listed` 事件枚举空间投稿，MUST NOT 下载媒体或把 GPL 源码链接进 FastAPI。当固定版 yutto 因当前平台接口兼容问题明确失败，或对有效视频空间返回无法证明的空目录时，系统 SHALL 允许使用现有 yt-dlp 连接器执行一次 metadata-only 平铺枚举；降级路径 MUST 使用相同安全字段允许列表、取消语义和不下载媒体边界。

#### Scenario: 流式枚举 B站空间
- **WHEN** 后端启动 B站 `catalog_all` 运行且 yutto 能正常枚举
- **THEN** sidecar 逐条返回稳定 BVID 元数据并在结束时报告失败与完成状态
- **AND** 服务只监听回环地址并验证独立 token

#### Scenario: 固定版 yutto 无法读取当前空间接口
- **WHEN** yutto 明确报告连接器失败，或对一个有效视频空间返回无法证明的零项结果
- **THEN** 系统使用现有 yt-dlp 对同一官方空间地址执行一次 metadata-only 平铺枚举
- **AND** 成功结果标记为降级连接器来源且不包含媒体、Cookie、请求头或本地路径

#### Scenario: 两条目录路径都失败
- **WHEN** yutto 与 metadata-only 降级都无法完成枚举
- **THEN** 运行显示部分失败或需用户处理，不得标记为完整成功
- **AND** 旧目录项目继续保持原可用状态

#### Scenario: 保留许可证义务
- **WHEN** yutto sidecar 随生产部署发布
- **THEN** 部署包包含 GPL-3.0 许可证、固定版本和对应源码说明
- **AND** FastAPI 仅通过进程边界协议与其交互
