## ADDED Requirements

### Requirement: 用户拥有可编辑的知识页

系统 SHALL 允许已认证用户创建、读取、更新和删除仅属于自己的知识页；知识页 SHALL 至少包含标题、摘要、正文、状态、来源类型和时间戳。

#### Scenario: 用户创建知识页

- **WHEN** 用户提交非空标题和正文，并可选提交摘要与来源说明
- **THEN** 系统创建一条归属于该用户的 canonical 知识页
- **AND** 返回的页面标记来源为 manual

#### Scenario: 用户访问其他人的知识页

- **WHEN** 用户尝试读取、修改或删除其他用户的知识页
- **THEN** 系统拒绝访问且不泄露该页面内容

### Requirement: 有效视频摘要进入待整理

系统 SHALL 将当前用户拥有、生成状态可用且包含可读 AI 核心结论或 sections 的视频 Note 投影为待整理候选，并 SHALL NOT 将只有原始文稿、尚在处理或生成失败/降级的视频显示为知识候选。

#### Scenario: 视频只有完整文稿

- **WHEN** 用户的视频 Note 有非空文稿但没有核心结论、结论或有效 sections
- **THEN** 该 Note 继续存在于视频资料库
- **AND** 不出现在“我的知识”的待整理视图

#### Scenario: 视频已有摘要成果

- **WHEN** 用户的视频 Note 包含核心结论、结论或至少一个有效 section
- **THEN** 该 Note 出现在待整理视图
- **AND** 候选展示摘要、来源视频信息和更新时间

#### Scenario: 视频摘要生成失败或仍在处理

- **WHEN** Note 的生成状态为 error、failed、fallback、pending 或 processing
- **THEN** 该 Note 不出现在待整理视图
- **AND** 历史深链仍可只读打开来源说明，但不提供保存为知识页操作

### Requirement: 用户显式保存候选为知识页

系统 SHALL 仅在用户主动保存时把视频候选创建为知识页，并 SHALL 保存来源 Note 关联；同一用户重复保存同一候选 SHALL 返回同一知识页。

#### Scenario: 用户保存视频候选

- **WHEN** 用户在有权访问的待整理候选上执行“保存为知识页”
- **THEN** 系统使用候选标题、摘要和 sections 创建 canonical 知识页
- **AND** 页面来源标记为 video 并关联该 Note
- **AND** 该候选从待整理视图移除

#### Scenario: 用户重复保存候选

- **WHEN** 用户再次保存已经沉淀的同一视频候选
- **THEN** 系统返回已有知识页而不创建重复记录

### Requirement: 候选与知识数据保持用户隔离

系统 SHALL 在列出、搜索、保存和读取知识成果时使用当前用户 ID 过滤 KnowledgeEntry 与 Note。

#### Scenario: 用户保存无权访问的视频候选

- **WHEN** 用户提交属于其他用户或不存在的 Note ID
- **THEN** 系统返回不存在或无权访问
- **AND** 不创建知识页或来源关联

### Requirement: Agent 输出不会自动成为知识

系统 SHALL NOT 因 Agent 生成回答、摘要或分析消息而自动创建知识页；未来 Agent 成果只有通过明确保存动作才能进入“我的知识”。

#### Scenario: Agent 完成一次回答

- **WHEN** Agent 在线程中生成新回答但用户没有执行保存操作
- **THEN** 知识页数量保持不变
