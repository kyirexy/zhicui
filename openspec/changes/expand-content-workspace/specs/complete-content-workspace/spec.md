## ADDED Requirements

### Requirement: Complete source overview
结果工作台 SHALL 在“完整内容”页签中展示可用的原始内容上下文，包括完整标题、来源类型、文稿字数、AI 内容简介和来源入口。

#### Scenario: Extracted video has a transcript
- **WHEN** 用户查看带有完整转写的新提取结果或知识库详情
- **THEN** 用户切换到“完整内容”页签后，左侧内容区显示标题、来源统计、简介和完整视频文案

#### Scenario: Extracted article has body text
- **WHEN** 用户查看公众号文章或小红书笔记结果
- **THEN** 同一内容区将抓取正文作为完整文稿展示

#### Scenario: Source text is unavailable
- **WHEN** 结果没有可用的 `transcript_raw`
- **THEN** 内容区显示明确的缺失状态并继续展示 AI 简介和知识卡片

### Requirement: Searchable full transcript
完整文稿 SHALL 在结果工作台的“完整内容”页签中可见，并 SHALL 支持搜索、复制和限定高度内的滚动阅读。

#### Scenario: User reviews long transcript
- **WHEN** 文稿长度超过桌面首屏
- **THEN** 文稿在内部滚动区域完整保留且不会无限拉长卡片

#### Scenario: User searches transcript
- **WHEN** 用户输入文稿关键词
- **THEN** 文稿视图仅展示并标记匹配内容

#### Scenario: User copies transcript
- **WHEN** 用户点击复制全文
- **THEN** 系统将未经截断的原始文稿写入剪贴板

### Requirement: Preserved AI knowledge card
结果工作台 MUST 保留独立的 AI 知识卡片、样式选择、信息量选择和卡片导出能力。

#### Scenario: Card is the initial result view
- **WHEN** 内容全览存在且用户首次打开结果工作台
- **THEN** “知识卡片”页签默认选中，知识卡片立即显示且不被原始文稿替换

#### Scenario: Card is exported
- **WHEN** 用户导出卡片 PNG
- **THEN** 导出内容只包含知识卡片，不包含原始文稿或问答面板

#### Scenario: Detailed card density
- **WHEN** 用户选择详细信息量
- **THEN** 卡片展示更完整的 AI 章节和补充信息，但不重复内容全览中的完整文稿

### Requirement: Preserved grounded AI assistant
带有笔记 ID 的结果工作台 MUST 保留基于完整文稿和 AI 卡片理解的问答面板。

#### Scenario: Desktop result workspace
- **WHEN** 视口达到桌面断点
- **THEN** 知识卡片和完整内容共用左侧页签阅读区，AI 问答位于右侧并保持粘性

#### Scenario: Mobile result workspace
- **WHEN** 视口小于桌面断点
- **THEN** 知识卡片和完整内容继续通过页签切换，AI 问答位于当前页签内容之后

#### Scenario: User asks a question
- **WHEN** 用户从右侧问答输入问题
- **THEN** 系统继续基于完整文稿与 AI 卡片理解生成带依据的回答

### Requirement: Accessible tab navigation
同时提供知识卡片和完整内容的结果工作台 MUST 使用可访问的页签导航，并且切换页签 MUST NOT 卸载或重置右侧 AI 问答。

#### Scenario: User switches result view
- **WHEN** 用户点击“知识卡片”或“完整内容”页签
- **THEN** 仅对应面板可见，页签同步更新 `aria-selected`，右侧 AI 问答保持原状态

#### Scenario: Keyboard user changes tab
- **WHEN** 焦点位于结果页签且用户按左右方向键、Home 或 End
- **THEN** 焦点和选中状态移动到目标页签，并显示对应面板

### Requirement: Duplicate-content control
复用结果组件的页面 SHALL 能关闭内容全览，以避免页面自身已经展示全文时出现重复。

#### Scenario: Detailed processing page
- **WHEN** 处理过程页渲染知识卡片且已单独展示原始文稿
- **THEN** 该页关闭卡片工作台内的内容全览，同时保留卡片和 AI 问答
