## ADDED Requirements

### Requirement: 生产数据库自动备份并验证可恢复性
系统 SHALL 至少每日创建 PostgreSQL 一致性备份，使用受限权限、校验和、保留策略和独立存储目录，并 SHALL 定期在隔离数据库验证恢复。生产还 MUST 将加密归档、校验和、非敏感元数据及单独加密的恢复材料复制到异地故障域，并从远端回读校验；缺少真实外部凭据时 MUST fail closed。

#### Scenario: 定时备份成功
- **WHEN** 生产备份定时器运行
- **THEN** 它生成权限受限的备份、校验和与脱敏状态记录并按保留策略清理旧文件

#### Scenario: 恢复演练
- **WHEN** 管理员执行恢复验证
- **THEN** 备份被恢复到隔离数据库并通过关键表计数与只读查询校验，不覆盖生产库，随后异地副本和加密恢复材料通过远端存在性与内容哈希校验

#### Scenario: 异地凭据缺失
- **WHEN** 生产环境未配置真实对象存储/rclone 或独立 SSH 目标及加密恢复材料
- **THEN** readiness 与部署闸门保持 not ready，且系统不得上传明文备份密钥或伪造异地验证状态

### Requirement: 深度健康反映真实依赖
系统 SHALL 分离 liveness 与 readiness；readiness MUST 检查数据库、任务租约、关键 AI 配置及启用中的连接器，并 SHALL 对普通响应隐藏秘密和内部路径。

#### Scenario: yutto 未运行
- **WHEN** B站全量连接器被启用但 yutto 协议探测失败
- **THEN** readiness 显示 degraded 或 unhealthy 且不得报告完整健康

### Requirement: 严重故障形成可操作告警
系统 SHALL 聚合 critical 错误、readiness 持续失败、备份失败和平台同步异常，提供管理端未确认告警，并在配置 HTTPS Webhook 时发送脱敏通知和冷却后的恢复通知。

#### Scenario: 相同错误重复发生
- **WHEN** 同类 critical 错误在冷却窗口内重复发生
- **THEN** 系统合并计数且不无限发送重复通知

### Requirement: 高风险和高成本入口受限流保护
系统 MUST 对登录、注册、密码重验、AI 生成和平台同步施加按 IP、账号和用户的适当窗口限制，并 SHALL 返回可重试时间而不是静默失败。

#### Scenario: 登录尝试过多
- **WHEN** 同一来源在窗口内超过失败登录阈值
- **THEN** 系统返回 429、记录安全事件且不透露账号是否存在

### Requirement: 生产响应采用安全基线
生产系统 SHALL 限定 CORS 来源并提供 HSTS、CSP、frame、content-type、referrer 和 permissions 安全策略，MUST 保持 SSE、客户端下载和 OAuth/客户端回跳所需能力可用。

#### Scenario: 非允许来源预检
- **WHEN** 未允许的网页来源请求受保护 API
- **THEN** 响应不授予跨域读取权限
