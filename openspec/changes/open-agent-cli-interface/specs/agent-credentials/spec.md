## ADDED Requirements

### Requirement: Agent 凭证可分 scope、到期和吊销
系统 SHALL 支持浏览器设备授权与 PAT，两者 MUST 绑定用户、凭证 ID、明确 scopes、到期时间和吊销状态；PAT 默认有效期 MUST 不超过 90 天，管理员身份 MUST NOT 自动扩大 Agent scopes。

#### Scenario: 用户创建 PAT
- **WHEN** 已登录用户在 Agent 接入中心选择 scopes 并创建 PAT
- **THEN** 系统只显示一次完整令牌并保存可识别前缀
- **AND** 后续列表仅显示名称、前缀、scopes、创建/到期/最后使用和吊销状态

#### Scenario: 凭证已过期或被吊销
- **WHEN** 客户端使用过期或被吊销的 Agent 凭证调用 Action
- **THEN** 系统返回稳定的 `TOKEN_EXPIRED` 或 `TOKEN_REVOKED`
- **AND** 不刷新最后使用时间也不执行 Action

### Requirement: 服务端只保存不可逆令牌摘要
系统 MUST 只保存带服务端 pepper 的令牌摘要、非敏感前缀与元数据，MUST NOT 在数据库、日志、审计或错误中保存完整 PAT、access token 或 refresh token。

#### Scenario: 数据库备份被检查
- **WHEN** 运维人员查看 Agent 凭证表和审计表
- **THEN** 只能看到摘要、前缀、scope 和生命周期元数据
- **AND** 不能从记录恢复可用令牌

### Requirement: 浏览器设备授权需要用户明确批准
系统 SHALL 为 CLI 生成短期 device code 与易输入 user code，并 SHALL 仅在已登录用户打开验证页面明确批准后签发短期 access token 与可轮换 refresh token。

#### Scenario: CLI 发起设备登录
- **WHEN** 用户运行 `zhicui auth login`
- **THEN** CLI 获得验证 URL、user code 与轮询间隔并打开系统浏览器
- **AND** 未批准前轮询只返回 pending，不签发凭证

#### Scenario: refresh token 被轮换
- **WHEN** 客户端使用有效 refresh token 获取新 access token
- **THEN** 服务端废止旧 refresh token 并签发新 token
- **AND** 旧 token 的再次使用触发该凭证族吊销或安全错误

### Requirement: scope、限流和归属在执行前统一校验
系统 SHALL 在 Action handler 前按用户、凭证和 Action 校验 scopes、资源归属与共享限流；拒绝事件 SHALL 写入脱敏审计但 MUST NOT 泄露资源、输入秘密或令牌。

#### Scenario: PAT 缺少写 scope
- **WHEN** 只有 `library:read` 的 PAT 调用资料写入 Action
- **THEN** 系统返回 `SCOPE_REQUIRED` 并列出所需 scope 名称
- **AND** 不执行 handler

#### Scenario: 同一凭证超过 Action 限额
- **WHEN** 凭证在窗口内超过该 Action 的调用限制
- **THEN** 系统返回 `RATE_LIMITED` 与安全的重试时间
- **AND** 不自动排队或重复调用同步任务

### Requirement: 用户可查看并撤销连接
系统 SHALL 允许用户查看自己的 PAT、设备连接、scopes、最近调用与最后使用时间，并 SHALL 支持立即吊销单个凭证或整个设备连接。

#### Scenario: 用户撤销被盗设备
- **WHEN** 用户在接入中心吊销一个设备连接
- **THEN** 该设备全部 access/refresh token 立即失效
- **AND** 其他未选择连接继续有效

