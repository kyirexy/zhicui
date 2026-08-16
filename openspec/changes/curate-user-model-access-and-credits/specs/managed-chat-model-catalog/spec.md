## ADDED Requirements

### Requirement: 管理员维护聊天模型发布目录
系统 SHALL 允许管理员新增、编辑、启停和排序聊天模型，并配置展示名称、真实模型 ID、运行来源、免费状态、每日免费次数、每次萃点和能力标签。

#### Scenario: 管理员发布免费模型
- **WHEN** 管理员保存一个启用、免费的聊天模型
- **THEN** 普通用户目录返回该模型的安全展示字段
- **AND** 响应不包含任何 Provider 密钥或内部 API Base

#### Scenario: 管理员停用模型
- **WHEN** 管理员停用一个已发布模型
- **THEN** 新的普通用户目录不再返回该模型
- **AND** 已选择该模型的用户在下次读取时回退到管理员默认模型

### Requirement: 管理目录禁止智能路由模型
系统 MUST 拒绝模型 ID 为 `auto` 或以 `auto/` 开头的 Offering，并且普通用户 API MUST NOT 返回智能路由选项。

#### Scenario: 管理员提交智能路由模型
- **WHEN** 管理员尝试保存 `auto` 或 `auto/vision` 模型
- **THEN** API 返回可操作的校验错误且不写入目录

### Requirement: 管理操作受管理员权限保护
聊天模型目录写操作 SHALL 使用现有管理员 JWT 权限和审计日志保护。

#### Scenario: 普通用户调用管理 API
- **WHEN** 非管理员尝试新增、修改或停用模型
- **THEN** API 返回 403 且不改变任何模型配置
