## ADDED Requirements

### Requirement: Selected videos expose two coherent next actions

视频资料页 SHALL 在用户选择一条或多条支持批量处理的视频后，提供“提取结构化文案”和“去问 AI”两个明确动作，并 SHALL 以动作开始时的完整选择快照作为处理目标。

#### Scenario: User requests structured copy

- **WHEN** 用户勾选多条可处理的抖音视频并点击“提取结构化文案”
- **THEN** 系统把完整选择快照提交为一个 `full` 批量任务
- **AND** 已有处理结果被幂等复用，缺少的文稿与结构化结果被补齐

#### Scenario: Selection contains an ineligible video

- **WHEN** 选择快照中存在当前不可提取的视频
- **THEN** 系统不静默排除该视频或缩小任务范围
- **AND** 页面保留选择并在批量动作附近说明无法继续的原因

#### Scenario: Selection is locked during processing

- **WHEN** 结构化提取或 AI 资料准备任务正在运行
- **THEN** 卡片复选、全选、清空和冲突的批量动作不可改变本次选择
- **AND** 完成或失败后原选择仍保留供用户核对或重试

### Requirement: AI handoff preserves the exact selected set

视频资料页 SHALL 在进入 Agent 前为选择快照中的每条视频解析唯一、用户拥有且文稿可用的 Note ID，并 MUST NOT 用成功子集替代原选择。

#### Scenario: Every selected video already has a transcript

- **WHEN** 用户点击“去问 AI”且选择快照中的每条视频都有可用文稿和 Note ID
- **THEN** 系统按快照顺序把全部且仅这些 Note ID 传入 Agent

#### Scenario: Some selected videos need transcripts

- **WHEN** 用户点击“去问 AI”且部分选中视频尚无可用文稿
- **THEN** 系统先对这些视频执行 transcript-only 批量任务
- **AND** 只有全部选择项都得到唯一 Note ID 后才进入 Agent

#### Scenario: Transcript preparation partially fails

- **WHEN** 任一选中视频无法完成文稿准备或未返回 Note ID
- **THEN** 系统停留在视频资料页并保留完整选择
- **AND** 系统显示失败反馈且不得只携带成功项进入 Agent

### Requirement: Agent shows selected sources first

Agent 来源面板 SHALL 精确恢复入口传入的去重来源集合，SHALL 定向读取当前列表中缺失的已选来源元数据，并 SHALL 将已选与未选资料分区展示。

#### Scenario: User arrives from the video library

- **WHEN** Agent URL 携带两条有效的 `source_ids`
- **THEN** 来源选择计数为 2 且只有这两条资料处于选中状态
- **AND** 两条已选资料显示在“已选”分区顶部
- **AND** 其他当前结果显示在其后的“未选”分区

#### Scenario: Selected source is outside the first result page

- **WHEN** 入口携带的用户自有资料不在当前来源接口的普通前 100 条结果中
- **THEN** 系统通过定向来源查询取得其真实元数据并显示在已选分区
- **AND** 当前筛选、搜索结果顺序和总数语义保持不变

#### Scenario: User changes scope or search

- **WHEN** 用户切换来源范围或执行新的资料搜索
- **THEN** 已选分区及准确计数继续保留
- **AND** 未选分区按新的当前结果更新且不重复显示已选资料

### Requirement: Batch-selection capability remains platform-aware

视频资料页 MUST 仅向存在等价批量提取与 Note 交接能力的平台展示本次批量动作。

#### Scenario: User browses Bilibili or Xiaohongshu sources

- **WHEN** 用户切换到当前不支持统一批量选择的 B站或小红书资料
- **THEN** 页面不显示或伪造抖音专属的批量结构化提取与精确 Agent 交接能力
