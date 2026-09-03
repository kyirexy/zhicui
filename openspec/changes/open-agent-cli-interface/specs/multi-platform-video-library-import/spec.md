## ADDED Requirements

### Requirement: 资料导入与同步具有显式普通用户 Action
系统 SHALL 为链接导入、资料列表/详情、喜欢/收藏/作品同步、文稿提取与批处理提供显式产品 Action，并 SHALL 保持来源、数量、幂等和用户隔离约束；每次同步 MUST 由用户或 Agent 明确调用，MUST NOT 自动同步、离线排队或在风控后连续重试。

#### Scenario: Agent 顺序同步喜欢与收藏
- **WHEN** 用户授权的 Agent 明确请求喜欢和收藏两个来源
- **THEN** 系统按来源顺序执行或创建一个可追踪 Run，并分别报告每个来源结果
- **AND** 风控或等待验证时停止对应来源且不自动连续重试

#### Scenario: Agent 批量提取文稿
- **WHEN** Agent 对所属用户资料提交批量文稿 Action 和幂等键
- **THEN** 系统创建持久 Run 并逐条追加成功、复用或失败事件
- **AND** 断线重试不会创建第二批任务或重复计费

