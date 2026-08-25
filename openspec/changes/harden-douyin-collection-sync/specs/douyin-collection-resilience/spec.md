## ADDED Requirements

### Requirement: 收藏同步使用有边界的双通道读取
系统 SHALL 优先通过现有抖音收藏 API 读取元数据，并 SHALL 仅在明确识别到收藏来源阻断时，使用当前用户作用域的后台浏览器会话尝试一次页面内请求回退。

#### Scenario: API 正常返回收藏
- **WHEN** 收藏 API 返回可解析的作品列表或确认的空列表
- **THEN** 系统使用 API 结果完成任务且不启动浏览器回退

#### Scenario: API 被平台阻断
- **WHEN** 收藏 API 返回 `blocked`、Argus 拒绝或等价的风险控制结果
- **THEN** 系统至多启动一次当前用户作用域的浏览器回退
- **AND** 不把 Cookie、签名参数或原始平台响应返回给业务服务

#### Scenario: 页面要求安全验证
- **WHEN** 浏览器回退页面要求验证码、重新登录或其他用户验证
- **THEN** 系统停止自动读取并返回 `needs_action`
- **AND** 不自动处理或绕过验证

### Requirement: 收藏来源使用作用域熔断与单飞控制
系统 SHALL 按用户作用域和收藏来源维护短期熔断状态，并 MUST 在冷却期间拒绝重复访问受限端点；同一作用域同时最多运行一个收藏发现任务。

#### Scenario: 双通道均被阻断
- **WHEN** API 被阻断且浏览器回退未取得可用结果
- **THEN** 系统打开收藏来源熔断并返回确定的建议重试时间

#### Scenario: 用户在冷却期间重试
- **WHEN** 同一用户在收藏熔断到期前再次请求同步
- **THEN** 系统立即返回 `source_blocked` 且不访问抖音端点或启动浏览器

#### Scenario: 收藏随后成功
- **WHEN** 冷却到期后的收藏任务成功读取列表
- **THEN** 系统清除该作用域的收藏失败计数和熔断状态

#### Scenario: 其他来源同步
- **WHEN** 收藏来源处于熔断状态且用户同步喜欢或本人作品
- **THEN** 系统正常处理对应来源且不继承收藏熔断状态

### Requirement: 连接器返回脱敏的来源级诊断
系统 SHALL 为同步任务返回来源、实际通道、是否尝试回退、错误类别、建议重试时间和是否需要用户处理，并 MUST 只使用定义好的安全字段。

#### Scenario: 管理员诊断收藏失败
- **WHEN** 收藏同步因平台阻断结束
- **THEN** 管理端可看到 `source_mode=collection`、`channel`、`fallback_attempted`、`error_code` 和重试时间
- **AND** 看不到 Cookie、Authorization、签名媒体 URL、原始 HTML、本地路径或平台请求头

#### Scenario: 连接器仍健康但收藏不可读
- **WHEN** sidecar 健康且 Cookie 有效但收藏来源被阻断
- **THEN** 健康状态与账号连接状态保持正常，并单独报告收藏来源不可读

### Requirement: 浏览器回退保持隔离和元数据边界
系统 MUST 只在回环 sidecar 内使用当前用户自己的会话执行收藏页面回退，并 MUST 只输出允许列表内的作品元数据。

#### Scenario: 浏览器捕获收藏响应
- **WHEN** 官方页面产生可用的收藏列表响应
- **THEN** sidecar 对作品字段执行允许列表清洗后返回元数据
- **AND** 不下载或持久化视频媒体

#### Scenario: 并发用户执行回退
- **WHEN** 两个用户分别触发收藏浏览器回退
- **THEN** 每个任务仅能访问自己的作用域 Cookie 和临时浏览器上下文

