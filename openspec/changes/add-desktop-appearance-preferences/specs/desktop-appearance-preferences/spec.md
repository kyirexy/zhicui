## ADDED Requirements

### Requirement: Desktop appearance is selectable
系统 SHALL 在设置页为桌面用户提供浅色、深色和跟随系统三种侧栏外观，并在选择后立即应用。

#### Scenario: User selects a light sidebar
- **WHEN** 桌面用户在设置页选择“浅色”
- **THEN** 左侧导航、品牌入口和账号区立即使用可访问的浅色令牌

#### Scenario: User selects a dark sidebar
- **WHEN** 桌面用户在设置页选择“深色”
- **THEN** 左侧导航立即使用深色令牌，当前导航与正文仍满足清晰对比

#### Scenario: User follows the system appearance
- **WHEN** 桌面用户选择“跟随系统”并切换应用主题
- **THEN** 侧栏外观随当前应用主题同步切换

### Requirement: Desktop density is selectable
系统 SHALL 为桌面工作区提供舒展与紧凑两种布局密度，且不得通过缩小正文到不可读尺寸实现紧凑模式。

#### Scenario: User selects compact density
- **WHEN** 桌面用户选择“紧凑”
- **THEN** 侧栏宽度、顶部栏高度和工作区间距缩小，同时主要点击目标仍不少于 40 像素

#### Scenario: User selects comfortable density
- **WHEN** 桌面用户选择“舒展”
- **THEN** 桌面工作区恢复默认间距与至少 44 像素的主要点击目标

### Requirement: Appearance preferences persist locally
系统 MUST 在当前设备持久化桌面外观和布局密度，并兼容没有新字段的旧设置数据。

#### Scenario: Desktop app restarts
- **WHEN** 用户修改外观后关闭并重新打开桌面应用
- **THEN** 应用恢复上次选择，不要求重新设置

#### Scenario: Existing settings are upgraded
- **WHEN** 本地已有旧版 `videocapsule-settings` 数据但缺少桌面外观字段
- **THEN** 系统保留原有卡片设置，并为新字段应用安全默认值

### Requirement: Desktop preferences stay runtime scoped
系统 MUST 只在可信 Electron 桌面运行时应用桌面侧栏和密度属性，不得改变普通网页或 Android 的导航布局。

#### Scenario: User opens the cloud website in a browser
- **WHEN** 页面不存在可信的 `window.zhicuiDesktop` bridge
- **THEN** 网页继续使用现有响应式顶部导航和移动端底栏
