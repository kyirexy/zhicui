## ADDED Requirements

### Requirement: 持久 Agent Thread 可保存有界领域上下文
系统 SHALL 让 Agent Thread 以显式类型和用户拥有的对象标识保存可选领域上下文，并 SHALL 使旧视频会话在无上下文列时继续按视频研究会话工作。

#### Scenario: 恢复计划会话
- **WHEN** 用户刷新一个绑定 Plan 的正在运行或已完成 Thread
- **THEN** 系统恢复同一 Thread、Turn 事件和 Plan 上下文
- **AND** 不将 Plan Thread 改为全库视频会话

#### Scenario: 读取旧视频会话
- **WHEN** 数据库中的旧 Thread 没有领域上下文列值
- **THEN** 系统将它解释为 video 会话
- **AND** 现有来源、消息和 Turn 继续可读

