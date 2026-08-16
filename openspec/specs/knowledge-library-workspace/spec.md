# knowledge-library-workspace Specification

## Purpose
TBD - created by archiving change redesign-knowledge-and-plan-workspaces. Update Purpose after archive.
## Requirements
### Requirement: 知识库以可检索内容对象为核心

知识库 SHALL 默认使用高密度内容列表展示用户拥有的知识条目，并同时提供标题、摘要、类型、更新时间和内容规模等可扫描信息。

#### Scenario: 用户打开有大量内容的知识库

- **WHEN** 用户进入知识库且账号中存在知识条目
- **THEN** 页面默认以列表形式展示内容对象
- **AND** 首屏不使用大面积深绿色背景或单张超大特色卡片占据主要空间

#### Scenario: 用户搜索知识内容

- **WHEN** 用户输入标题、结论或卡片内容关键词
- **THEN** 页面调用现有检索接口返回匹配结果
- **AND** 搜索状态与清除入口保持可见

### Requirement: 用户可以在列表和卡片视图之间切换

知识库 SHALL 提供列表与卡片两种视图，切换只改变呈现方式，不改变当前搜索、类型筛选和分页结果。

#### Scenario: 用户切换为卡片视图

- **WHEN** 用户在已有筛选条件下选择卡片视图
- **THEN** 当前结果使用紧凑卡片排列
- **AND** 搜索关键词、类型筛选和当前页保持不变

### Requirement: 知识库提供全库 Agent 入口

知识库 SHALL 提供清晰的“向资料提问”入口，并复用现有视频 Agent 的资料选择与引用能力。

#### Scenario: 用户从知识库开始提问

- **WHEN** 用户点击“向资料提问”
- **THEN** 系统进入视频 Agent 工作区
- **AND** 用户仍可在 Agent 中选择全部、收藏夹范围或手选视频

### Requirement: 移动端知识库保持完整且易触控

移动网页和 Capacitor Android SHALL 支持搜索、类型筛选、视图切换、分页、打开详情和进入 Agent。

#### Scenario: 用户在窄屏设备浏览知识库

- **WHEN** 视口小于移动端断点
- **THEN** 页面使用单列紧凑内容行或卡片
- **AND** 筛选与视图控件可横向滚动且不遮挡内容
- **AND** 主要操作拥有至少 44px 的可触控区域并避开底部安全区

