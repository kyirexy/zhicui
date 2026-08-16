## ADDED Requirements

### Requirement: 用户可以选择三种 AI 路由模式

系统 SHALL 提供“知萃基础 AI”“OmniRoute 智能路由”和“其他 OpenAI 兼容供应商”三种模式，并 SHALL 默认使用知萃基础 AI。

#### Scenario: 用户从未配置 AI 服务

- **WHEN** 用户首次打开 AI 路由设置
- **THEN** 知萃基础 AI 被选中
- **AND** 用户无需填写模型、地址或密钥即可继续使用基础能力

#### Scenario: 用户选择可用的 OmniRoute

- **WHEN** 服务器已启用 OmniRoute 且用户保存该模式
- **THEN** 后端为该用户解析服务器托管的 OmniRoute 配置
- **AND** 前端不要求或显示共享网关密钥

#### Scenario: 用户选择其他兼容供应商

- **WHEN** 用户选择自带供应商
- **THEN** 前端允许填写供应商、模型、API Base 和 API Key
- **AND** 后端继续加密 API Key 且读取响应只显示掩码

### Requirement: AI 路由设置支持测试和恢复

用户 SHALL 能够测试当前有效连接并恢复到平台默认配置；错误 SHALL 显示在操作区域附近。

#### Scenario: 连接测试成功

- **WHEN** 当前有效配置返回可见模型响应
- **THEN** 前端显示已连接的供应商和模型

#### Scenario: 连接测试失败

- **WHEN** 网关或供应商连接失败
- **THEN** 前端显示可重试错误
- **AND** API Key 不出现在错误信息或日志中

#### Scenario: 用户恢复默认

- **WHEN** 用户点击恢复知萃基础 AI
- **THEN** 自定义配置被清除
- **AND** 后续请求使用平台配置

### Requirement: 桌面侧栏左下提供独立 AI 路由工作台入口

Windows 桌面客户端 SHALL 在左下支持区域提供“AI 路由”入口，并 SHALL 打开独立 AI 路由工作台。

#### Scenario: 桌面用户打开 AI 路由

- **WHEN** 用户点击侧栏左下“AI 路由”
- **THEN** 客户端打开 `/ai-routing`
- **AND** 侧栏和桌面上下文栏将该页面标记为当前页面

#### Scenario: 移动端用户管理 AI 路由

- **WHEN** 用户在 Android 或移动网页进入 AI 路由工作台
- **THEN** 相同的模型搜索、直接选择、连接测试和恢复功能按单列布局可用
- **AND** 控件具有至少 44px 的触控区域

### Requirement: 用户可以直接浏览并选择 OmniRoute 实时模型

系统 SHALL 通过知萃后端读取 OmniRoute 实时模型目录和免费模型元数据，不得把共享网关密钥下发到浏览器。工作台主流程 SHALL 让用户搜索后直接点击一个可用模型，用户选择 SHALL 真实影响后续 AI 请求。

#### Scenario: 网关在线且目录可用

- **WHEN** 用户打开 AI 路由工作台
- **THEN** 页面直接展示网关返回的可用模型、供应商和免费标记
- **AND** 用户可以按名称搜索，整行点击即可选择，不需要先切换目录、路由或供应商 Tab

#### Scenario: 用户选择一个可用模型

- **WHEN** 用户点击一个目录模型
- **THEN** 用户配置模式变为 OmniRoute 且保存该模型 ID
- **AND** 后续摘要、知识问答和 Agent 使用该模型 ID 经 OmniRoute 执行

#### Scenario: 用户需要供应商或管理配置

- **WHEN** 用户需要填写自有 API Key 或进入高级控制台
- **THEN** 页面底部提供次级文字入口
- **AND** 这些配置不会与模型选择并列成主导航或主筛选项

#### Scenario: 网关离线

- **WHEN** 工作台无法读取 OmniRoute
- **THEN** 页面显示就地错误和重试操作
- **AND** 知萃基础 AI 仍可被选择和使用

### Requirement: 高级 OmniRoute 管理能力受管理员边界保护

系统 SHALL 仅向知萃管理员提供高级控制台入口，并 SHALL 依赖 OmniRoute 自身认证保护供应商账号、密钥、组合编辑、代理和系统设置。

#### Scenario: 普通用户打开工作台

- **WHEN** 当前用户不是管理员
- **THEN** 响应和页面均不包含高级控制台地址
- **AND** 用户不能读取或修改共享供应商凭据

#### Scenario: 管理员打开工作台

- **WHEN** 当前用户是管理员且高级控制台地址已配置
- **THEN** 页面显示“高级控制台”入口
- **AND** 进入后仍需通过 OmniRoute 管理认证
