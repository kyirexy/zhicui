## ADDED Requirements

### Requirement: Agent 工具参数和来源范围受服务端控制
系统 SHALL 向交互式 Agent 暴露仅接受来源快照 Note UUID 列表的 `analyze_video_details` 工具。模型 MUST NOT 指定 URL、Provider、价格、API Key、force 或用户 ID，服务端 SHALL 拒绝来源快照外的 Note。

#### Scenario: Agent 请求来源外视频
- **WHEN** 工具参数包含不属于当前线程来源快照的 Note UUID
- **THEN** 服务端拒绝该项且不创建 Run 或预留

### Requirement: Agent 先用文稿筛选真正需要画面的来源
Agent SHALL 先检索文稿并只选择回答当前问题所需的相关视频，MUST NOT 因选择全部来源或深度研究模式而批量解析所有视频。

#### Scenario: 文稿足以回答
- **WHEN** 检索证据已足以回答且问题不依赖画面
- **THEN** Agent 不调用详细解析工具

### Requirement: Agent 按成本与数量请求授权
缓存结果 SHALL 直接使用；单条且推荐 Offering 为零萃点时 MAY 自动开始并说明；两条以上、任何萃点扣费或 BYOK 调用 MUST 返回当前消息流内的审批卡并在未授权前保持零视觉调用。

#### Scenario: 付费解析需要审批
- **WHEN** Agent 为当前问题准备的 Run 需要预留萃点
- **THEN** SSE 发送 `approval_required` 终态并关闭连接
- **AND** 审批绑定视频、Offering 版本、最大帧、调用数和萃点上限

#### Scenario: 用户拒绝读取画面
- **WHEN** 用户选择只按现有文案回答
- **THEN** Agent 继续回答并标注本次未读取视频画面

### Requirement: 批准后后台恢复原问题
用户批准 SHALL 通过独立接口启动持久任务；任务完成后系统 SHALL 恢复原问题并生成最终答案，而不悬挂原 SSE 连接。定时 Agent 和自动化 MUST NOT 创建新视觉费用。

#### Scenario: 分析完成恢复回答
- **WHEN** 已批准 Run 完成并产生视觉结果
- **THEN** 系统使用原问题、原来源快照和新视觉证据继续生成答案
- **AND** 视觉引用标记 `source: visual` 与服务端 `timestamp_ms`
