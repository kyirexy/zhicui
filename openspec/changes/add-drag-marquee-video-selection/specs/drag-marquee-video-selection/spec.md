## ADDED Requirements

### Requirement: Desktop users can drag a marquee to select videos

视频资料页和 AI 来源列表 SHALL 允许桌面用户使用鼠标主按钮拖出矩形选区，并 SHALL 在手势提交时选择与该范围相交的可见、可选择资料项。

#### Scenario: User selects multiple library cards
- **WHEN** 用户在视频资料选择面按下鼠标主按钮并拖动超过激活阈值
- **THEN** 页面显示不遮挡内容的矩形选区
- **AND** 用户释放鼠标后，范围命中的抖音视频成为当前选择

#### Scenario: User selects multiple Agent sources
- **WHEN** 用户在 AI 来源列表中拖动矩形覆盖多条可见资料
- **THEN** 手势释放后，恰好命中的可用 Note ID 被写入现有来源选择集合
- **AND** 已选资料仍在提交后显示于未选资料上方

#### Scenario: User drags without a modifier
- **WHEN** 用户未按 Ctrl 或 Command 完成一次框选
- **THEN** 新命中集合替换手势开始前的选择

#### Scenario: User appends with a platform modifier
- **WHEN** 用户按住 Ctrl 或 Command 完成一次框选
- **THEN** 新命中项被追加到手势开始时的选择且原选择保留

### Requirement: Marquee selection respects business limits and locks

框选 SHALL 复用现有选择上限和处理锁定，MUST NOT 绕过批量提取或 Agent 来源限制。

#### Scenario: Library selection reaches its limit
- **WHEN** 资料库框选命中的新资料会使选择超过 50 条
- **THEN** 系统只按当前 DOM 顺序保留上限内的选择
- **AND** 本轮手势只显示一次上限反馈

#### Scenario: Agent source selection reaches its limit
- **WHEN** AI 来源框选命中的新资料会使选择超过 100 条
- **THEN** 系统保留已有选择并只追加剩余容量允许的资料
- **AND** 无法读取但已存在于入口选择集合中的 ID 仍占用上限

#### Scenario: Selection context becomes locked
- **WHEN** 资料库开始批处理或 AI 来源在手势中进入加载状态
- **THEN** 当前框选被取消且不会提交候选 ID
- **AND** 手势开始前的业务选择保持不变

### Requirement: Marquee selection preserves existing interactions

框选 SHALL 保留普通点击、复选框、键盘选择、播放链接和触屏滚动，并 MUST NOT 由同一次拖动额外触发卡片导航或 label 反选。

#### Scenario: Pointer movement stays below the threshold
- **WHEN** 用户在卡片或来源行按下并释放鼠标且移动未超过激活阈值
- **THEN** 页面不进入框选
- **AND** 原有点击、详情导航或 checkbox 行为照常执行

#### Scenario: Drag ends over an interactive item
- **WHEN** 一次已激活的框选手势释放并产生合成 click
- **THEN** 系统抑制该次 click，且不会额外打开详情或反转某一 checkbox

#### Scenario: User starts on an explicit control
- **WHEN** 用户从复选框、按钮、输入框或播放链接开始拖动
- **THEN** 系统不启动框选并保留该控件原有交互

#### Scenario: User scrolls or cancels the gesture
- **WHEN** 框选期间发生滚动、Escape、pointercancel 或窗口失焦
- **THEN** 系统移除选区并丢弃本次候选选择
- **AND** 临时文字选择和全局事件状态被完整恢复

#### Scenario: User operates on touch input
- **WHEN** 用户使用触摸或触控笔浏览资料列表
- **THEN** 系统不启动框选、不修改 touch-action，并保持原生滚动

### Requirement: Marquee selection remains platform-aware

资料库框选 SHALL 只命中当前支持统一批量选择的抖音资料，并 MUST NOT 将同一列表中的 B站或小红书行加入抖音选择集合。

#### Scenario: Drag range crosses a cross-platform row
- **WHEN** 用户的选区范围与 B站或小红书资料行相交
- **THEN** 该跨平台资料不会加入抖音选择集合
- **AND** 已有的跨平台查看和初始化操作保持不变
