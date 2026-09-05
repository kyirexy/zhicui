# agent-knowledge-creation Specification

## Purpose
TBD - created by archiving change add-agent-knowledge-write. Update Purpose after archive.
## Requirements
### Requirement: Agent 只响应明确的知识写入意图

系统 SHALL 仅在用户明确肯定地要求保存、记录、整理或写入知识时调用知识创建工具，并 MUST NOT 因普通问答、含糊表达、否定表达或仅询问保存方法而写入知识库。

#### Scenario: 用户明确要求保存知识

- **WHEN** 用户说“把上面的结论整理后保存到我的知识库”
- **THEN** Agent 调用 `knowledge.create`

#### Scenario: 用户仅讨论知识保存

- **WHEN** 用户询问“怎么把内容保存到知识库”或说“先不要保存”
- **THEN** Agent 按普通问答处理
- **AND** 不创建知识条目

### Requirement: Agent 将对话和资料整理为知识条目

系统 SHALL 使用当前用户要求、最近对话以及当前线程可用资料生成非空标题、摘要和正文，并通过现有知识服务创建属于当前用户的知识条目。

#### Scenario: 保存上一轮回答

- **WHEN** 用户在已有 Agent 回答后要求“把刚才的回答记下来”
- **THEN** 新知识正文包含该回答中的主要信息
- **AND** 条目的 `user_id` 为当前线程用户

#### Scenario: 根据选中资料创建知识

- **WHEN** 用户明确要求将当前资料整理为知识
- **THEN** Agent 在有界范围内读取所选资料并形成结构化知识正文

### Requirement: 创建结果可从对话直接打开

系统 SHALL 在创建成功后返回 `knowledge_created` 结构化结果，其中包含知识 ID、标题、摘要和内容规模；客户端 SHALL 显示简洁的创建结果和知识详情入口。

#### Scenario: 知识创建成功

- **WHEN** `knowledge.create` 成功持久化条目
- **THEN** Agent 回复明确说明知识已保存
- **AND** 用户可以从该回复打开新知识条目

### Requirement: 创建失败不留下半成品

系统 MUST 在生成、写入或消息持久化失败时清理本轮创建的知识条目和孤立消息，并向调用方返回失败。

#### Scenario: 模型整理失败

- **WHEN** 知识整理模型返回无效结构或调用失败
- **THEN** 数据库中不新增知识条目
- **AND** 本轮不留下孤立用户消息
