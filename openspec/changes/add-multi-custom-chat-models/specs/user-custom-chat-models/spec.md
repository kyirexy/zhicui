# user-custom-chat-models

多自定义聊天模型能力：按用户维护多条自定义 BYOK 模型，支持增删改查、启用/停用、设为当前、连接测试，并让聊天路由按选中模型解析有效配置。

## ADDED Requirements

### Requirement: 按用户维护多条自定义模型

系统 SHALL 为每个已认证用户维护零到多条自定义聊天模型记录，单条记录包含展示名、供应商名、模型 ID、API Base、加密 API Key、启用状态、是否为当前选中模型，以及创建/更新时间。数据 SHALL 仅对所属用户可见。

#### Scenario: 用户新增自定义模型

- **WHEN** 已认证用户提交合法的展示名、供应商、模型 ID、API Base 和 API Key
- **THEN** 系统保存一条属于该用户的自定义模型，且 API Key 加密后落库
- **AND** 响应不返回明文 API Key，只返回是否已设置与掩码

#### Scenario: 用户读取自己的自定义模型列表

- **WHEN** 已认证用户请求自定义模型列表
- **THEN** 系统仅返回该用户自己的模型，按创建时间排序，并返回当前选中模型 ID

### Requirement: 自定义模型增删改查

系统 SHALL 提供自定义模型的创建、更新、删除与列表读取接口；所有变更 SHALL 强制用户作用域隔离，删除或更新不存在的记录返回 404，模型 ID 或 API Base 非法返回 422。

#### Scenario: 编辑保存自定义模型

- **WHEN** 用户更新自己某条自定义模型的模型 ID 或 API Key
- **THEN** 系统校验后将新值保存，返回该记录的序列化视图
- **AND** 当 API Key 留空时保留既有密钥不变

#### Scenario: 删除自定义模型

- **WHEN** 用户删除自己某条自定义模型
- **THEN** 该记录被删除；若被删除项是当前选中项，系统 SHALL 自动将当前选中模型回退为平台模型

### Requirement: 设为当前自定义模型

系统 SHALL 区分“已保存的自定义模型”与“当前生效模型”。用户 SHALL 能将任一启用中的自定义模型设为当前；设当前后，聊天路由 SHALL 使用该模型的配置；用户 SHALL 能切回平台模型。

#### Scenario: 切换到自定义模型

- **WHEN** 用户选择将启用中的自定义模型设为当前
- **THEN** 系统记录该选中状态，后续聊天请求 SHALL 使用该模型的 API 配置与模型 ID
- **AND** BYOK 请求不消耗平台聊天萃点

#### Scenario: 切回平台模型

- **WHEN** 用户选择平台模型作为当前
- **THEN** 系统清除自定义模型选中状态，后续聊天请求回落到平台 offering 选择

### Requirement: 连接测试选中模型与任意模型

系统 SHALL 提供自定义模型连接测试：验证当前选中或指定模型的 API Base/Key/模型 ID 是否能正常响应。测试失败返回 502 且不改动选中状态。

#### Scenario: 选中模型连接测试成功

- **WHEN** 用户对当前生效的自定义模型发起连接测试，且最小提示词得到可见回复
- **THEN** 系统返回连接成功与该模型的 provider/model

#### Scenario: 测试失败不改选中状态

- **WHEN** 自定义模型测试请求因网关、模型名或密钥错误失败
- **THEN** 系统返回 502 连接失败，且保留用户原有选中模型不变

### Requirement: 聊天路由按选中自定义模型解析配置

`effective_config()` SHALL 在用户选中启用中的自定义模型时，返回该模型的 `provider/model/runtime_model/api_base/api_key`。选中平台模型时继续返回平台 offering 配置。`uses_custom_provider()` SHALL 在选中自定义模型时返回真以维持 BYOK 免计费。

#### Scenario: 选中自定义模型后的有效配置

- **WHEN** 用户已选中一条启用中的自定义模型并发送聊天请求
- **THEN** 聊天请求使用该自定义模型的 API Base、API Key 与模型 ID
- **AND** `runtime_model` 在模型 ID 不包含 `/` 时前缀化为 `openai/<model>`

#### Scenario: 未选中自定义模型时回落到平台配置

- **WHEN** 用户未选中自定义模型，或选中的自定义模型被停用
- **THEN** 聊天请求使用平台模型目录中用户选中的 offering 有效配置

### Requirement: 旧单行自定义配置向后兼容

系统 SHALL 在启动迁移时将旧 `UserAIProviderConfig` 中 `mode='custom'` 且可用（含模型、API Base、API Key）的记录提升为第一条自定义模型并设为当前，且不破坏其后的 BYOK 免计费语义。旧单行 `mode='platform'` 选中 offering 语义保持不变。

#### Scenario: 旧自定义行提升为自定义模型

- **WHEN** 数据库存在历史 `UserAIProviderConfig` 且 `mode='custom'`、`enabled` 且字段完整
- **THEN** 启动迁移生成一条对应用户的自定义模型并设为当前，后续聊天请求继续使用该旧配置

#### Scenario: 旧平台选择不受影响

- **WHEN** 历史 `UserAIProviderConfig` 的 `mode='platform'`
- **THEN** 平台 offering 选中逻辑与计费逻辑保持不变
