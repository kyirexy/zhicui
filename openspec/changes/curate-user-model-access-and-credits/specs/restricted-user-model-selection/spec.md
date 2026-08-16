## ADDED Requirements

### Requirement: 普通用户只能选择已发布模型
桌面端与用户 API SHALL 只展示管理员已启用且对普通用户可见的具体模型，并 SHALL 显示免费或每次萃点信息。

#### Scenario: 用户打开模型选择器
- **WHEN** 至少一个模型已发布
- **THEN** 选择器只显示发布模型及“使用自己的模型”入口
- **AND** 不显示 Provider 目录、API Base、模型密钥或智能路由

#### Scenario: 用户保存模型选择
- **WHEN** 用户选择一个启用的 Offering
- **THEN** 后端保存 Offering 标识并让后续 Agent 请求使用该模型

#### Scenario: 用户伪造未发布模型
- **WHEN** 用户直接向 API 提交未发布或已停用的 Offering 标识
- **THEN** API 返回 422 且不改变当前选择

### Requirement: 平台至少提供一个可用默认模型
系统 SHALL 在目录为空时创建一个由当前平台 LLM 配置支持的免费默认模型，并 SHALL 确保最多一个启用模型被标记为默认。

#### Scenario: 首次启动且目录为空
- **WHEN** 后端完成数据库初始化
- **THEN** 普通用户目录至少返回一个免费模型
- **AND** 新用户自动使用该默认模型

### Requirement: 用户可以配置自己的兼容模型
系统 SHALL 保留用户 OpenAI Compatible Provider 配置，并 MUST 加密保存 API Key、只返回掩码和连接状态。

#### Scenario: 用户启用自定义模型
- **WHEN** 用户保存合法的模型 ID、HTTP(S) API Base 和 API Key
- **THEN** 后续 Agent 请求使用该用户配置
- **AND** 模型选择器将其显示为“我的模型”

#### Scenario: 用户恢复平台模型
- **WHEN** 用户清除自定义配置
- **THEN** 系统恢复管理员发布的默认模型
