# creator-source-chat-selection Specification

## Purpose
TBD - created by archiving change add-creator-sources-to-new-chat. Update Purpose after archive.
## Requirements
### Requirement: 新会话可以按博主整组选择视频
系统 SHALL 在 AI 问答新会话的资料选择面板中提供博主浏览维度，并允许用户在不离开当前界面的情况下把一个博主的已就绪视频加入资料选择。

#### Scenario: 选择有已就绪视频的博主
- **WHEN** 用户在新会话资料面板中选择一个拥有已就绪视频的博主
- **THEN** 系统切换到仅已选资料模式并把该博主的可用视频加入当前选择
- **AND** 用户留在 AI 问答界面且可以立即开始提问

#### Scenario: 再次选择已加入的博主
- **WHEN** 用户再次点击一个已完整加入的博主
- **THEN** 系统从当前选择中移除该博主对应的视频
- **AND** 其他已选视频保持不变

### Requirement: 博主整组选取遵守会话资料上限
系统 MUST 对按博主加入的资料执行与逐条选择相同的去重和数量上限，并 SHALL 告知用户实际加入结果。

#### Scenario: 博主视频超过剩余容量
- **WHEN** 博主的未选视频数量超过当前会话剩余资料容量
- **THEN** 系统只加入不超过上限的资料
- **AND** 界面明确显示实际加入数量及上限原因

#### Scenario: 博主没有可问答视频
- **WHEN** 博主尚无已生成完整文稿且可用的视频
- **THEN** 该博主保持可见并显示零条可用
- **AND** 系统不改变当前资料选择且不跳转页面

### Requirement: 博主选择器覆盖移动端交互状态
博主选择视图 SHALL 在移动端提供足够的触控区域，并 MUST 覆盖加载、失败、空列表、不可用和已选择状态。

#### Scenario: 移动端选择博主
- **WHEN** 用户在移动端打开新会话资料面板并进入博主视图
- **THEN** 每个博主使用整行可点击控件显示名称、平台、头像、可用数量和选择状态
- **AND** 选择后资料面板保持打开以便用户确认或继续选择

#### Scenario: 博主列表读取失败
- **WHEN** 博主列表接口暂时失败
- **THEN** 博主视图就地显示失败原因和重试操作
- **AND** 抖音与 B站的逐条视频选择仍然可用
