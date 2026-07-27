## Why

当前管理端要求管理员手动理解并填写模型名和兼容地址，容易因 DeepSeek 模型与 LiteLLM 路由格式不同而配置失败；同时系统没有保存真实 LLM Token 用量，也只能查看管理员写操作，无法回答“哪个模型消耗了多少”和“用户在系统里做了什么”。

## What Changes

- 为 DeepSeek 增加官方预设配置，管理员只需选择 `deepseek-v4-flash` 或 `deepseek-v4-pro` 并填写 API Key，系统自动使用 `https://api.deepseek.com`。
- 保留自定义 OpenAI 兼容接口模式，避免破坏现有模型和代理配置。
- 对成功的 LLM 调用记录输入、输出和总 Token，并按时间、模型、用户和业务操作提供管理端汇总。
- 新增安全的用户操作日志，记录用户、动作、接口、状态和耗时，不保存请求正文、视频文件、文案、密钥或 Authorization。
- 将管理端的 LLM 配置改为预设式界面，并增加统一的“用量与日志”工作区，展示 Token 用量、用户操作和原有管理员审计。
- 登录、注册与本地开发会话也写入用户操作日志，使完整账号行为可追踪。

## Capabilities

### New Capabilities

- `admin-llm-provider-presets`: 管理员通过受约束的 DeepSeek 预设或自定义兼容接口配置运行时 LLM。
- `llm-usage-observability`: 记录并汇总 LLM 调用 Token，提供受管理员权限保护的查询接口。
- `user-activity-observability`: 以不记录敏感内容的方式记录用户操作并提供管理端查询。

### Modified Capabilities

无。当前 `openspec/specs/` 没有已同步的相关能力规格。

## Impact

- 后端新增两张 SQLAlchemy 表、请求上下文与操作日志中间件、Token 记录服务和两个管理员只读接口。
- 运行时 LLM 配置响应与更新请求增加 provider/preset 元数据；现有 model、api_base、api_key 字段保持兼容。
- `ai_juicer` 和管理端连接测试统一经过模型路由与 Token 采集辅助函数。
- 管理端页面与 API 类型扩展，不引入新的前端或后端依赖。
- 新表通过现有 `Base.metadata.create_all()` 在 SQLite 与 PostgreSQL 中创建。
