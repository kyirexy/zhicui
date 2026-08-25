# creator-catalog-connectors Specification

## Purpose
TBD - created by archiving change add-full-creator-catalog-selection. Update Purpose after archive.
## Requirements
### Requirement: 抖音全量目录复用现有隔离连接器
系统 SHALL 通过固定并经回归验证的 `jiji262/douyin-downloader` sidecar 执行 metadata-only 全量发现，并 MUST 支持进度、取消和其已有的浏览器回退，不得引入第二套抖音采集核心。

#### Scenario: 完成抖音全量发现
- **WHEN** 连接器成功枚举博主全部当前可读公开作品
- **THEN** 它按页或事件返回允许列表内的稳定元数据和完成信号
- **AND** 不下载或持久化媒体

#### Scenario: 抖音要求验证码
- **WHEN** sidecar 报告登录失效、验证码或风控
- **THEN** 运行转为 `needs_action` 并停止自动重试
- **AND** 不改用共享 Cookie 或绕过平台控制

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

### Requirement: B站目录按 BVID 聚合多 P 视频
系统 SHALL 把一个 BVID 保存为一个目录项目，并 SHALL 在用户选择后按页码顺序提取所有可访问分 P、合并普通文稿并只创建一条资料记录。

#### Scenario: 选择多 P 投稿
- **WHEN** 一个已选 BVID 包含多个可访问分 P
- **THEN** 系统按 P1 到 Pn 顺序取得字幕或 ASR 文稿并使用分段标题合并
- **AND** 任何单 P 失败只暴露脱敏错误并保留已完成进度

### Requirement: 连接器只返回安全目录字段
系统 SHALL 对所有目录项应用字段允许列表，MUST NOT 返回或持久化 Cookie、Authorization、签名媒体 URL、临时下载 URL、本地路径、base64 或二进制。

#### Scenario: 上游响应含敏感字段
- **WHEN** sidecar 原始事件包含请求头、Cookie 或媒体下载地址
- **THEN** 连接器在进入业务模型前删除这些字段
- **AND** API、数据库、日志和运行结果均不包含其值

### Requirement: 连接器扫描完成语义保护旧目录
系统 SHALL 只有在全量枚举明确成功完成时把本次未再次发现的旧作品标记为不可用；部分失败、取消或需用户处理 MUST 保留旧可用状态。

#### Scenario: 扫描部分失败
- **WHEN** 连接器返回部分项目后因限频或网络错误终止
- **THEN** 已发现项目幂等更新且旧项目仍保持原可用状态
- **AND** 运行显示部分完成或等待有限重试

