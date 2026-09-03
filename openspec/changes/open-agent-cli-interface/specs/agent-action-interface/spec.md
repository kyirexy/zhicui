## ADDED Requirements

### Requirement: 产品能力由显式版本化 Registry 声明
系统 SHALL 通过显式 `ProductActionRegistry` 暴露普通用户 Action；每个 Action MUST 声明 ID、版本、中文说明、输入/输出 JSON Schema、scope、读写与风险等级、运行类型、执行位置、幂等策略、稳定错误码和处理器，且 MUST NOT 从路由或 Python/TypeScript 函数自动反射生成能力。

#### Scenario: Agent 发现可用能力
- **WHEN** 已授权客户端请求 `GET /api/agent-interface/v1/capabilities`
- **THEN** 系统仅返回该凭证 scope 内可用的普通用户 Action 及版本化 Schema
- **AND** 响应不包含管理端、内部研究工具、数据库、任意 Shell、秘密或临时媒体地址

#### Scenario: 请求未知或关闭的 Action
- **WHEN** 客户端调用未注册、版本不兼容或功能开关关闭的 Action
- **THEN** 系统返回稳定的 `ACTION_NOT_FOUND`、`VERSION_UNSUPPORTED` 或 `ACTION_DISABLED`
- **AND** 不尝试动态导入或执行任何处理器

### Requirement: Action 调用使用统一版本化 Envelope
系统 SHALL 让每次 Action 调用返回包含 `api_version`、`action`、`request_id`、`run`、`status`、`data`、`error` 与脱敏 `meta` 的 JSON Envelope，并 SHALL 对 Schema 错误、认证、权限、资源归属、限流、确认和执行失败使用稳定错误码。

#### Scenario: 即时只读 Action 成功
- **WHEN** 凭证具备 scope 且输入通过 Schema 和资源归属校验
- **THEN** `invoke` 返回 `succeeded` Envelope 与符合输出 Schema 的数据
- **AND** 响应与日志均不包含 bearer token、JWT、API Key、Cookie 或临时媒体 URL

#### Scenario: 跨用户资源被引用
- **WHEN** Action 输入引用不属于凭证所有者的资料、会话、计划或任务
- **THEN** 系统返回 `RESOURCE_NOT_FOUND` 或等价的不泄露归属信息错误
- **AND** 不执行 handler 也不确认该资源是否属于其他用户

### Requirement: 长任务具有持久化 Run 和单调事件
系统 SHALL 为流式和长任务持久化 Run 与事件，状态仅使用 `queued/running/waiting_for_user/succeeded/failed/canceled`，事件序号 SHALL 单调递增，且每个 Run MUST 只产生一次最终完成事件。

#### Scenario: 客户端断线后续读
- **WHEN** 客户端通过 `Last-Event-ID` 或最后 sequence 重新连接 Run 事件流
- **THEN** 系统从下一条持久事件继续发送
- **AND** 已发送终态不被复制且事件顺序不倒退

#### Scenario: Run 等待扫码或目录选择
- **WHEN** 本机或云端 Action 需要用户完成扫码、验证码或目录选择
- **THEN** Run 进入 `waiting_for_user` 并返回不含秘密的操作说明
- **AND** 用户完成后同一 Run 可继续而不新建重复任务

#### Scenario: 用户取消运行中的 Run
- **WHEN** 所有者调用取消接口且 Run 尚未进入终态
- **THEN** 系统记录取消请求并最终进入 `canceled`
- **AND** 失去租约或已取消的 worker 不得再提交成功结果

### Requirement: 幂等键防止重复执行与计费
系统 SHALL 按用户、凭证、Action 与规范化输入绑定幂等键，并 SHALL 在有效窗口内复用同一结果或 Run；相同键与不同输入组合 MUST 被拒绝。

#### Scenario: Agent 重试超时的写 Action
- **WHEN** Agent 使用相同 `Idempotency-Key` 和相同输入重试
- **THEN** 系统返回原 Envelope 或原 Run
- **AND** 不重复写入、同步、计费或发送通知

#### Scenario: 相同幂等键用于不同输入
- **WHEN** 客户端复用幂等键但输入摘要不同
- **THEN** 系统返回 `IDEMPOTENCY_CONFLICT`
- **AND** 两个请求都不会产生新的副作用

### Requirement: 敏感写操作需要一次服务端确认
系统 SHALL 为删除资料、账号注销、本地文件删除、更新安装和密钥修改签发短期、单用途 `confirmation_id`，确认 MUST 绑定用户、凭证、Action 与参数摘要，Agent MUST NOT 能自行生成或复用批准。

#### Scenario: 未确认的敏感 Action
- **WHEN** Agent 首次调用需要确认的 Action
- **THEN** 系统返回 `CONFIRMATION_REQUIRED` 与短期确认引用
- **AND** 不执行副作用

#### Scenario: 确认被重放或参数改变
- **WHEN** 已使用、过期、归属不同或参数摘要不匹配的确认被提交
- **THEN** 系统返回 `CONFIRMATION_INVALID`
- **AND** 不执行副作用

### Requirement: 普通用户路由必须被分类
系统 SHALL 维护路由覆盖清单，使每个普通用户路由被标记为 Action、内部传输或资源流；CI MUST 在新增未分类路由时失败，并 MUST 断言所有管理路由不在 Registry。

#### Scenario: 开发者新增用户 API
- **WHEN** CI 发现新的非管理 API 路由没有分类记录
- **THEN** 覆盖测试失败并列出 method 与 path
- **AND** 该路由不能随 Agent 能力发布

