## ADDED Requirements

### Requirement: Agent Turn 映射统一产品 Run 协议
系统 SHALL 让普通用户可调用的多视频问答、流式 Turn、取消和重试映射到版本化产品 Run 与单调事件，同时 SHALL 保持现有 Turn/Message API 对旧客户端兼容；视频领域私有工具 MUST NOT 出现在产品 Action Registry 或 MCP 工具列表。

#### Scenario: Agent 通过 Action 发起多视频问答
- **WHEN** 具备 `ask:run` scope 的客户端提交所属用户的视频范围与问题
- **THEN** 系统创建或复用一个产品 Run，并把真实 Turn 阶段映射为可续读事件
- **AND** 最终回答事件只出现一次且证据仍遵守现有验证要求

#### Scenario: 客户端查询 capability
- **WHEN** 客户端读取多视频问答 Action 详情
- **THEN** 能力只描述用户级提问、会话、取消与重试
- **AND** 不列出 `video.source_scan`、`video.transcript_map`、外部查证、综合或 claim 修复等私有工具

