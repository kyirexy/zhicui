## ADDED Requirements

### Requirement: OmniRoute 保持独立且可升级的集成边界

系统 SHALL 将 OmniRoute 作为 MIT 许可的独立上游工作树保存在 `integrations/OmniRoute`，并 SHALL 记录上游地址和固定提交，而不是复制或重写其核心路由实现。

#### Scenario: 开发者检出项目集成

- **WHEN** 开发者初始化项目的 OmniRoute 集成目录
- **THEN** 系统可以从记录的上游仓库获取固定版本源码
- **AND** OmniRoute 依赖不会被加入知萃前端的依赖图

### Requirement: 知萃可以通过服务器托管 OmniRoute 路由 AI 请求

后端 SHALL 从服务器环境解析 OmniRoute API Base、访问密钥和模型，并 SHALL 使用 OpenAI 兼容接口调用网关。共享访问密钥 MUST NOT 出现在用户配置响应、浏览器代码或日志中。

#### Scenario: 管理员已配置 OmniRoute

- **WHEN** API Base 和访问密钥均已配置
- **THEN** 用户 AI 配置接口将 OmniRoute 标记为可用
- **AND** 选择 OmniRoute 的请求通过其 `/v1` 兼容接口和配置模型执行

#### Scenario: 管理员未配置 OmniRoute

- **WHEN** API Base 或访问密钥缺失
- **THEN** 用户 AI 配置接口将 OmniRoute 标记为不可用
- **AND** 默认知萃基础 AI 继续正常工作

#### Scenario: 已选 OmniRoute 后服务器撤销配置

- **WHEN** 用户记录仍为 OmniRoute 模式但服务器配置已不可用
- **THEN** 后端运行时回退到知萃基础 AI
- **AND** 不向前端或日志暴露曾使用的共享密钥

### Requirement: OmniRoute 默认只对知萃服务器本机开放

项目 SHALL 提供默认绑定 loopback 地址的部署模板、持久数据卷和健康检查，并 MUST NOT 默认把 OmniRoute 管理面板暴露到公网。

#### Scenario: 管理员使用默认 Compose 模板

- **WHEN** 管理员启动 OmniRoute 服务
- **THEN** 端口只绑定到 `127.0.0.1`
- **AND** 数据保存在独立持久卷
- **AND** 知萃可通过配置的 OpenAI 兼容地址访问该服务

### Requirement: 第三方能力说明保持可验证和克制

前端 SHALL 描述 OmniRoute 的统一接口、智能路由和故障回退能力，但 MUST NOT 承诺固定免费额度、绝对可用性或绕过第三方服务条款。

#### Scenario: 用户查看 OmniRoute 模式

- **WHEN** AI 服务设置展示 OmniRoute 选项
- **THEN** 文案说明实际模型、费用和额度由已连接供应商决定
- **AND** 不展示无法由知萃保证的免费 Token 数量

### Requirement: 知萃提供安全的 OmniRoute 工作台数据适配层

后端 SHALL 代表已登录用户读取允许的 OmniRoute 健康、模型目录、免费层、免费供应商排行和自动路由数据，并 SHALL 只返回工作台需要的标准化字段。

#### Scenario: 工作台读取模型目录

- **WHEN** OmniRoute 返回模型、免费层和路由数据
- **THEN** 后端去重、限制和标准化响应
- **AND** 响应不包含共享密钥、供应商凭据、连接明文或内部错误堆栈

#### Scenario: 上游接口部分失败

- **WHEN** 健康检查成功但某个可选目录接口失败
- **THEN** 后端仍返回其余可用分区及对应可用性状态
- **AND** 前端可以局部展示并重试而不是整页崩溃
