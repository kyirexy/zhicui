## ADDED Requirements

### Requirement: Branded video research workspace
系统 SHALL 将通用“AI 助手”入口呈现为“知萃研伴”，并将该能力描述为基于用户个人视频资料的研究工作区。

#### Scenario: User opens the research workspace
- **WHEN** 用户通过桌面导航、移动导航或知识库入口进入 `/agent`
- **THEN** 系统显示“知萃研伴”名称
- **AND** 页面清晰呈现“视频、对话、成果”三个工作区角色

### Requirement: Searchable user-owned video sources
系统 SHALL 在视频面板中只列出当前登录用户有权访问且已有可用文稿的视频，并支持范围筛选、标题或作者搜索以及最多 100 条手动选择。

#### Scenario: User searches and selects videos
- **WHEN** 用户选择“手选”并输入标题或作者关键词
- **THEN** 系统显示匹配的当前用户视频
- **AND** 用户可以勾选或取消勾选视频
- **AND** 界面显示当前选择数量与 100 条上限

#### Scenario: User asks AI to find relevant videos
- **WHEN** 用户用自然语言提交智能视频搜索
- **THEN** 系统只扫描当前用户在所选范围内且文稿可用的视频
- **AND** 模型仅扩展检索词，结果排序由标题、作者、已保存摘要和文稿的真实命中决定
- **AND** 每条结果可显示真实命中字段或摘录，并由用户使用复选框确认
- **AND** 模型不可用时系统降级为关键词检索，不得伪造匹配理由或自动勾选来源

#### Scenario: User keeps selections across searches
- **WHEN** 用户连续执行不同搜索或切换范围
- **THEN** 已勾选视频继续保留并显示准确数量
- **AND** 用户可以查看或清空已选来源
- **AND** 新线程提交时后端重新校验来源归属、文稿状态与 100 条上限

#### Scenario: No readable videos exist
- **WHEN** 当前范围没有可用视频文稿
- **THEN** 视频面板显示明确空状态和前往视频库的下一步
- **AND** 系统不得显示伪造的视频来源

### Requirement: Immutable conversation source snapshot
系统 SHALL 为每个新对话保存创建时的来源快照，并 SHALL NOT 在已有对话中静默替换来源。

#### Scenario: User changes sources after a conversation started
- **WHEN** 当前线程已有消息且用户在视频面板选择新的范围或视频
- **THEN** 界面说明这些来源将用于新的研究
- **AND** 用户确认后系统创建新线程而不是修改当前线程的来源依据

### Requirement: Source-grounded conversation with verifiable citations
系统 SHALL 在对话面板中基于所选视频文稿回答，展示实际使用的视频数量、文稿覆盖、引用、回答边界和按需联网查证来源。

#### Scenario: Grounded answer is returned
- **WHEN** Agent 完成一次基于视频的问题回答
- **THEN** 对话面板显示回答正文
- **AND** 用户可展开查看引用原文及对应视频
- **AND** 外部查证内容与视频依据被明确区分

#### Scenario: Evidence is insufficient
- **WHEN** 所选视频不足以支持回答或引用校验不完整
- **THEN** 系统明确显示依据有限或回答边界
- **AND** 系统不得把推断伪装成来源事实

### Requirement: Persistent result studio
系统 SHALL 在成果面板中从当前线程已持久化的 assistant 消息派生可复用成果，并支持总结、对比、行动方案和自定义成果类型。

#### Scenario: Generated result appears in the studio
- **WHEN** 一次带有非普通回答输出类型的 Agent 消息完成并保存
- **THEN** 成果面板自动出现对应成果条目
- **AND** 条目显示类型、生成时间、来源覆盖和正文预览
- **AND** 用户可打开完整内容并复制

#### Scenario: User reopens an existing thread
- **WHEN** 用户打开一个已有成果消息的历史线程
- **THEN** 系统从已保存消息恢复成果列表
- **AND** 不需要重新调用模型即可查看成果

#### Scenario: Thread has no results
- **WHEN** 当前线程尚未生成成果
- **THEN** 成果面板显示说明性空状态和可用成果类型
- **AND** 不展示虚构的示例成果

### Requirement: Result generation shortcuts
系统 SHALL 允许用户从成果面板为当前来源快照发起总结、对比、行动方案或自定义产出，并复用现有 Agent 配额、错误和处理中状态。

#### Scenario: User requests an action plan result
- **WHEN** 用户点击“行动方案”且当前来源有效
- **THEN** 系统以 `action_plan` 输出类型发起新消息
- **AND** 生成期间显示处理中状态
- **AND** 完成后自动选中新的行动方案成果

#### Scenario: Generation is unavailable
- **WHEN** 没有可用来源、已有生成正在进行或已达到 Agent 限制
- **THEN** 相应成果操作被禁用或返回现有错误信息
- **AND** 系统不会重复提交请求

### Requirement: Responsive three-panel navigation
系统 SHALL 在宽屏同时展示视频、对话和成果三栏，并在平板与手机上提供可操作的三面板切换或抽屉降级。

#### Scenario: Desktop layout
- **WHEN** 可用视口足以容纳三栏
- **THEN** 视频面板位于左侧、对话位于中间、成果位于右侧
- **AND** 三栏各自拥有独立的滚动区域

#### Scenario: Mobile layout
- **WHEN** 用户在窄屏设备打开知萃研伴
- **THEN** 页面默认显示对话面板
- **AND** 用户可通过明确的“视频”和“成果”入口切换面板
- **AND** 所有主要点击目标满足移动端触达需求并避开底部安全区

### Requirement: Compact full-width desktop workspace
系统 SHALL 在桌面客户端占满可用内容区域，并通过紧凑控件和均衡列宽减少来源与成果面板的拥挤感。

#### Scenario: User opens the desktop workspace
- **WHEN** 桌面客户端显示三栏工作区
- **THEN** 工作区不受通用页面最大宽度或多余外边距限制
- **AND** 左右面板足以阅读视频命中信息和成果正文
- **AND** 范围筛选使用单个紧凑控件，而不是六个大卡片

### Requirement: Message conflict and failure semantics
系统 SHALL 区分线程忙碌、请求校验和模型失败，且诊断失败不得掩盖原始异常。

#### Scenario: User submits while the thread is running
- **WHEN** 同一线程已有回答仍在生成
- **THEN** 消息接口返回 `409 Conflict` 和可重试提示
- **AND** 前端保留用户输入并提示等待，不将其展示为参数错误

#### Scenario: Provider diagnostics fail
- **WHEN** 模型调用失败且读取提供商诊断配置也失败
- **THEN** 系统仍记录并返回原始 Agent 失败语义
- **AND** 不因诊断过程再次抛错而返回未处理的内部错误
