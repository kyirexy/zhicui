## MODIFIED Requirements

### Requirement: 视频库是首页主操作
系统 SHALL 将进入视频库设置为首页首要操作，并 SHALL 保留单条链接提取作为次要且可发现的操作。

#### Scenario: 用户选择主要操作
- **WHEN** 用户点击首页主要按钮
- **THEN** 系统导航到 `/library`

#### Scenario: 用户选择单条提取
- **WHEN** 用户点击“提取单条链接”或“解析链接”
- **THEN** 系统导航到独立的 `/extract` 单条解析工作区
