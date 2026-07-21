## ADDED Requirements

### Requirement: Mobile result workspace uses three tabs
带有笔记 ID 的移动端结果工作台 MUST 提供“知识卡片”“完整内容”和“AI 提问”三个页签，并 MUST 默认选中知识卡片。

#### Scenario: User opens a result on mobile
- **WHEN** 用户在小于桌面断点的视口打开知识库详情或新提取结果
- **THEN** 页面显示三个结果页签且知识卡片面板首先可见

#### Scenario: User opens AI question tab
- **WHEN** 用户选择“AI 提问”页签
- **THEN** 页面在同一结果工作台位置展示基于完整视频文案和 AI 理解的问答面板

#### Scenario: User returns to content
- **WHEN** 用户从 AI 提问切换到知识卡片或完整内容
- **THEN** 对应内容面板可见且已产生的问答消息被保留

### Requirement: Desktop assistant remains persistent
达到桌面断点时，结果工作台 MUST 将 AI 问答常驻右侧，并 MUST 继续允许左侧切换知识卡片和完整内容。

#### Scenario: Viewport changes from mobile assistant to desktop
- **WHEN** 用户在移动端选中 AI 提问后将视口扩大到桌面断点
- **THEN** 左侧显示知识卡片，右侧显示原有问答会话且不会创建第二个聊天实例

### Requirement: Three-tab navigation is accessible
移动端结果页签 MUST 维护正确的 `tablist`、`tab`、`tabpanel`、`aria-selected` 和 `aria-controls` 关系，并 MUST 支持键盘顺序切换。

#### Scenario: Keyboard user navigates mobile tabs
- **WHEN** 焦点位于移动端结果页签且用户按左右方向键、Home 或 End
- **THEN** 焦点与选中面板在三个可用页签之间循环或移动到首尾
