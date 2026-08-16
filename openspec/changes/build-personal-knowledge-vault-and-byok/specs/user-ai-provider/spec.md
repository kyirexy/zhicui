## ADDED Requirements

### Requirement: 用户可以选择平台默认或自定义 AI 服务
系统 SHALL 允许每位用户独立选择平台默认服务或 OpenAI 兼容自定义服务，并配置模型、API Base 与 API Key。

#### Scenario: 未配置时使用平台默认服务
- **WHEN** 用户没有启用自定义供应商
- **THEN** Agent 使用平台维护的默认模型配置

#### Scenario: 启用自定义供应商
- **WHEN** 用户保存合法的 HTTPS API Base、模型名和 API Key 并启用配置
- **THEN** 该用户后续 Agent 调用使用自己的供应商配置

### Requirement: 用户密钥安全保存
系统 MUST 加密保存用户 API Key，配置读取接口 MUST 只返回是否已配置和掩码，不得返回明文。

#### Scenario: 读取已保存配置
- **WHEN** 用户打开 AI 服务设置
- **THEN** 页面能看到供应商、模型、端点和密钥掩码，但无法获得完整密钥

### Requirement: 用户可以测试连接并理解能力边界
系统 SHALL 提供不保存提示内容的连接测试，并清楚区分平台默认基础能力与自定义供应商解锁能力。

#### Scenario: 自定义端点连接失败
- **WHEN** 用户测试无法访问或不兼容的配置
- **THEN** 系统在配置表单附近显示可操作错误且保留当前平台默认服务
