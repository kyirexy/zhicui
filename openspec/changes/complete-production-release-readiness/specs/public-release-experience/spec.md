## ADDED Requirements

### Requirement: 官网在支持宽度内无横向裁切
官网 SHALL 在 320px 及以上视口中不产生页面级横向滚动，标题、按钮、下载信息和法律入口 MUST 完整可见并可换行。

#### Scenario: 390px 手机访问首页
- **WHEN** 用户以 390px 宽度访问官网首页
- **THEN** Hero、下载按钮和后续标题均保持在视口内且主要操作至少 44px 高

### Requirement: 各客户端能力边界表述真实
官网和客户端 SHALL 明确 Web、Windows、Android 当前支持的导入、账号同步、查看和更新方式，不得把依赖 Windows 会话的能力描述为手机独立完成。

#### Scenario: Android 用户查看同步说明
- **WHEN** Android 用户查看平台账号同步能力
- **THEN** 页面说明账号会话采集需 Windows，而链接导入和跨端查看可在 Android 使用

### Requirement: 平台降级状态对用户友好
系统 SHALL 使用可操作、非技术化的文案区分平台限制、需重新登录、连接器不可用和资料质量不足，并 SHALL 保留已有资料。

#### Scenario: 抖音列表受限
- **WHEN** 平台限制喜欢或收藏读取
- **THEN** 用户看到冷却时间、可执行下一步和“已有资料不会丢失”，且系统不自动重试死循环

### Requirement: 空状态与错误状态提供单一下一步
公共页面和核心客户端的空状态 SHALL 提供一个清晰主要操作，错误 SHALL 就近展示且不依赖固定浮层或手工 DOM 移动。

#### Scenario: 下载信息暂时不可用
- **WHEN** 版本清单读取失败
- **THEN** 页面保留产品说明并提供明确重试，不显示损坏的下载按钮
