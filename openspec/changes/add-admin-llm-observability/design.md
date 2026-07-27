## Context

运行时 LLM 配置目前由 `system_settings` 保存 model、api_base 和加密 API Key，`ai_juicer` 通过 LiteLLM 发起调用。管理端直接暴露三个文本输入，且没有统一记录 LiteLLM 返回的 usage。现有 `admin_audit_logs` 只覆盖管理员写操作，不适合承载所有用户行为。系统同时部署在 SQLite 开发环境和 PostgreSQL 正式环境，且不能把文案、问题、密钥或视频内容写入日志。

## Goals / Non-Goals

**Goals:**

- 将 DeepSeek 官方 OpenAI 兼容接口封装为受约束预设，同时兼容现有自定义端点。
- 在不改变业务调用结果的前提下，对成功的 LLM 响应记录真实上报 Token。
- 对有意义的用户写操作建立轻量、安全、可查询的操作轨迹。
- 以一个高信息密度但分区明确的管理端工作区展示配置、用量和日志。

**Non-Goals:**

- 不从文本长度估算历史 Token，也不回填本次发布前的用量。
- 不采集或存储请求正文、提示词、文案、问答内容、视频、密码或密钥。
- 不实现账单金额估算，因为新模型定价可能变化且用户只要求 Token。
- 不替换现有管理员审计日志。

## Decisions

### 1. Provider metadata remains in `system_settings`

新增 `llm_provider` 键，并提供 `deepseek` 与 `custom` 两种模式。DeepSeek 模式由后端强制模型白名单和官方 base URL，不能依赖前端校验。读取旧配置时，根据模型名和 base URL 推断 provider，保证现有部署无迁移阻断。

替代方案是为配置建立新表，但当前配置是单例键值且已支持加密和运行时热更新，新表只会增加迁移复杂度。

### 2. Separate append-only tables for usage and activity

新增 `llm_usage_logs` 与 `user_activity_logs`，两者都只保存低敏元数据并为 created_at、user_id、action/model 建索引。独立表避免把高频用户行为混入不可变的管理员安全审计语义。

### 3. Context variables attribute nested LLM calls

HTTP 中间件从有效 JWT 的 `sub` 建立 request-scoped context，`ai_juicer` 的深层调用无需逐层增加 user_id 参数。LLM usage 服务使用独立短事务保存，失败时回滚并吞掉记录异常，不能让观测能力破坏用户主流程。

替代方案是给所有 agent 函数传入 Session 和 user_id，但调用链分支多，侵入性更强，也容易漏传。

### 4. One normalized LLM completion helper

`settings_service` 提供运行时模型路由：DeepSeek 展示模型保持 `deepseek-v4-*`，传给 LiteLLM 时规范为 OpenAI 兼容路由。`ai_juicer` 和管理端连接测试在响应返回后使用同一 usage 提取与记录函数。保留少量历史直接调用点时也必须显式补采集。

### 5. Middleware logs bounded user operations

中间件只记录成功解析到用户的非 GET API 请求，并排除认证接口和观测接口；认证成功由路由显式记录，以便拿到新登录用户。动作由 method/path 规则归一化，path 去除动态 ID 与 query string，日志不读取 request body。

### 6. Admin information architecture

LLM 配置页提供 DeepSeek 预设卡、模型单选、只读 endpoint 和 API Key；切到自定义模式才显示自由输入。原“审计日志”入口升级为“用量与日志”，内部用三个标签切换 Token 用量、用户操作、管理审计，避免继续增加侧栏按钮。

## Risks / Trade-offs

- [LiteLLM 或上游未返回 usage] → 不估算 Token，只显示已上报调用；报告明确标注统计口径。
- [中间件独立写库增加少量请求开销] → 仅记录状态变更并使用单行短事务，排除轮询和健康检查。
- [SQLite 写竞争] → 记录失败不影响业务；正式环境 PostgreSQL 承担持续写入。
- [旧配置被误判为 DeepSeek] → 仅当模型属于明确白名单或 base URL 为官方地址时推断，否则归为 custom。
- [日志表持续增长] → 本次提供有界查询与索引，后续可增加保留策略，不在本次自动删除运营数据。

## Migration Plan

1. 发布后导入新模型并由 `Base.metadata.create_all()` 创建两张新表。
2. 部署兼容的 provider 读取逻辑，旧配置无需改写即可继续使用。
3. 部署请求上下文、观测服务和管理员接口。
4. 部署管理端 UI；首次打开用量与日志时，新数据可能为空，这是正常状态。
5. 回滚代码时新表可保留且不会影响旧版本；无需删除数据表。

## Open Questions

无阻塞问题。Token 金额估算和日志保留期限留待获得稳定定价与运营周期后再设计。
