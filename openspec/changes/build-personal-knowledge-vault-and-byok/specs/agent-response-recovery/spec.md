## ADDED Requirements

### Requirement: Agent 可以恢复只有推理内容的模型响应
系统 SHALL 在模型响应存在但可见正文为空时执行最多一次受控重试，要求直接返回最终结构化结果。

#### Scenario: 第二次调用产生正文
- **WHEN** 第一次 Agent 模型响应只有推理内容且正文为空
- **THEN** 系统执行一次非推理最终答案重试并返回成功结果

#### Scenario: 重试后仍为空
- **WHEN** 恢复调用仍然没有可见正文
- **THEN** 系统停止重试并返回明确的模型响应错误，而不是无限调用

### Requirement: Agent 失败保留可诊断错误
系统 MUST 记录 Agent 原始异常类型、操作、供应商和模型，但 MUST NOT 记录 API Key、完整提示词或模型回答。

#### Scenario: Agent 调用抛出异常
- **WHEN** Agent 回答链路发生未处理异常
- **THEN** 管理员错误日志包含原始异常分类和安全元数据，用户收到稳定且可操作的错误消息
