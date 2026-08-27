## MODIFIED Requirements

### Requirement: 视频资料页提供抖音、B 站和小红书导入

系统 SHALL 在第二个主导航“视频资料”页提供抖音、B 站和小红书链接导入入口，SHALL 接受用户手动提交的 1–10 条受支持链接，并 SHALL 接受 Windows 本地连接器按最多 100 条 metadata snapshot 分批登记而不要求用户返回首页。

#### Scenario: 用户导入一条 B 站视频
- **WHEN** 已登录用户在视频资料页提交有效 B 站视频链接
- **THEN** 系统在视频资料页创建或复用该用户的 B 站资料记录
- **AND** 成功反馈包含标题、平台和文案就绪状态

#### Scenario: 用户混合提交多个平台链接
- **WHEN** 用户一次手动提交不超过 10 条抖音、B 站和小红书链接
- **THEN** 系统逐条处理并分别报告成功、复用或失败
- **AND** 单条失败不 SHALL 丢弃其他成功结果

#### Scenario: Windows 本地连接器登记抖音来源
- **WHEN** 更新后的 Windows 客户端提交最多 100 条规范化抖音作品 metadata
- **THEN** 系统先幂等登记当前用户的来源快照并立即返回计数
- **AND** 文稿提取继续由现有按需或近期准备任务执行

#### Scenario: 用户提交不支持的平台
- **WHEN** 导入内容包含非抖音、非 B 站或非小红书链接
- **THEN** 系统拒绝该条并返回可操作的中文错误
- **AND** 系统不启动媒体下载或 AI 生成

## ADDED Requirements

### Requirement: 本地抖音快照与旧来源合并展示
系统 SHALL 将当前用户的本地抖音 metadata snapshot 与兼容 sidecar 来源合并，按作品 ID 去重，并 SHALL 保持喜欢、收藏和作品来源的独立顺序信息。

#### Scenario: 同一作品来自本地和旧来源
- **WHEN** 当前用户的相同抖音作品同时存在于本地快照和兼容 manifest
- **THEN** 视频资料页只展示一个作品
- **AND** 优先使用更新的本地公开元数据并保留全部来源模式

#### Scenario: Sidecar 私人列表读取不可用
- **WHEN** 云端 sidecar 因风控无法刷新私人列表但当前用户已有本地快照
- **THEN** 视频资料页继续展示本地同步的作品
- **AND** 用户可以对这些作品启动文稿提取或知识使用

