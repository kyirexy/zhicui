## ADDED Requirements

### Requirement: Stable local development identity
系统 SHALL 在开发会话功能启用时创建或复用一个身份稳定的保留开发用户，并在每次申请时确保该用户处于可登录状态。

#### Scenario: First local development session
- **WHEN** 开发开关已启用且回环地址首次请求开发会话
- **THEN** 系统创建保留开发用户并签发标准 JWT

#### Scenario: Repeated local development session
- **WHEN** 同一环境再次请求开发会话
- **THEN** 系统复用同一用户记录而不创建重复用户

#### Scenario: Disabled development user is repaired
- **WHEN** 保留开发用户在本地数据库中被停用后再次请求开发会话
- **THEN** 系统恢复该用户的可用状态并签发标准 JWT

### Requirement: Automatic development session recovery
开发构建 SHALL 在没有有效本地 JWT 时自动申请开发会话，并对暂时性失败进行有限次数重试。

#### Scenario: Backend is ready
- **WHEN** 开发页面启动且开发会话接口可用
- **THEN** 前端自动保存返回的 JWT 和用户信息，无需输入账号密码

#### Scenario: Backend becomes ready during retry window
- **WHEN** 首次开发会话请求暂时失败但后续重试成功
- **THEN** 前端自动进入应用且不展示注册要求

#### Scenario: Automatic retries are exhausted
- **WHEN** 所有有限重试均失败
- **THEN** 前端停止自动请求并展示可操作的开发登录入口

### Requirement: One-click development entry
开发登录页 SHALL 提供无需账号密码的一键开发入口，并 SHALL 保留普通登录注册能力。

#### Scenario: Manual development entry succeeds
- **WHEN** 开发者点击“一键进入开发模式”且本地接口可用
- **THEN** 前端建立会话并跳转至安全的站内目标

#### Scenario: Developer tests normal authentication
- **WHEN** 开发者选择普通账号登录或注册
- **THEN** 页面提供现有账号表单并执行标准认证流程

#### Scenario: Unsafe redirect is supplied
- **WHEN** 登录页收到绝对地址或协议相对地址作为跳转参数
- **THEN** 前端忽略该参数并跳转到首页

### Requirement: Production authentication isolation
生产环境 MUST NOT 暴露、自动调用或接受开发会话捷径。

#### Scenario: Production frontend
- **WHEN** 应用以生产模式构建
- **THEN** 登录页不展示开发入口且不会自动请求开发会话

#### Scenario: Development bypass disabled
- **WHEN** 后端未启用开发认证开关
- **THEN** 开发会话接口返回未找到且不创建开发用户

#### Scenario: Non-loopback request
- **WHEN** 非回环来源请求启用的开发会话接口
- **THEN** 后端拒绝请求且不签发 JWT
