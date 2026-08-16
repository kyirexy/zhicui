## ADDED Requirements

### Requirement: Mobile navigation uses consumer-facing destinations
The mobile Web application and Capacitor Android client SHALL present task-oriented destinations and SHALL NOT expose administrator, provider, API key, AI routing, or internal model configuration routes in primary mobile navigation.

#### Scenario: Ordinary user navigates the mobile client
- **WHEN** the viewport is narrower than 768px
- **THEN** the bottom navigation displays 首页、视频、研伴、知识、计划
- **AND** no navigation item is labelled AI、模型、Provider or 管理端

#### Scenario: Mobile user opens settings
- **WHEN** an ordinary user opens settings below the mobile breakpoint
- **THEN** the settings navigation omits AI 服务 and other provider configuration sections
- **AND** a direct mobile link to a hidden technical section resolves to 常规设置

### Requirement: Mobile product chrome is solid white and neutral
The mobile product shell SHALL use solid white surfaces, warm neutral grays and near-black actions; the green brand color SHALL be retained for the Zhicui logo while product chrome SHALL NOT use purple or pale-green decorative washes.

#### Scenario: User moves between core mobile pages
- **WHEN** the user visits 首页、视频资料、研伴、知识、计划 or 设置
- **THEN** page backgrounds, navigation, controls and dialogs use the shared white/gray visual hierarchy
- **AND** the green Zhicui logo remains recognizable
- **AND** video imagery and third-party platform brand icons may retain their source colors

### Requirement: Mobile account, settings and feedback remain discoverable
The Android workspace home SHALL provide an immediately visible settings entry, and mobile feedback SHALL be available from settings without a persistent floating launcher covering content.

#### Scenario: User needs settings or feedback
- **WHEN** the user opens the Android home screen
- **THEN** a brand header provides a 44px settings target
- **AND** settings provides a 44px 反馈与帮助 action that opens the existing feedback dialog

#### Scenario: User browses or composes on mobile
- **WHEN** the viewport is narrower than 768px
- **THEN** no feedback launcher floats over video cards, plan actions, knowledge content or the研伴 composer

### Requirement: Core mobile workspaces are complete at common phone widths
All primary mobile workspaces SHALL remain usable at 360px, 390px and 430px widths with no document-level horizontal overflow, no clipped navigation item and no primary control smaller than 44px.

#### Scenario: User browses primary routes on a phone
- **WHEN** the viewport is 360px, 390px or 430px wide
- **THEN** 首页、视频资料、研伴、知识、计划、设置 and 登录 render meaningful content without a framework error overlay
- **AND** the bottom navigation and final content remain above the device safe area

#### Scenario: User opens a mobile dialog
- **WHEN** the user creates a record, confirms deletion, chooses sources or submits feedback
- **THEN** the dialog uses the browser top layer, fits within the dynamic viewport and keeps close and submit actions reachable

### Requirement: Mobile answering controls use user language
The mobile研伴 composer SHALL describe answer behavior without requiring ordinary users to understand internal AI routing or provider terminology.

#### Scenario: Answer options are loading or changing
- **WHEN** the answer catalog is loading or the user changes an option on mobile
- **THEN** the UI reports 正在准备回答 or 正在切换回答方式
- **AND** it does not present an AI routing page or provider configuration link

#### Scenario: User opens answer selection
- **WHEN** the user opens the mobile answer selector
- **THEN** only administrator-published choices and simple identifying icons are shown
- **AND** price-free promotional badges are not required to understand the selection
