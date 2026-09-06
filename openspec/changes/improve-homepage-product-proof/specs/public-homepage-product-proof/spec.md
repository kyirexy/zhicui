## ADDED Requirements

### Requirement: Public home explains a concrete product outcome
公开官网 SHALL 用中文清楚说明内容输入与知识卡片或行动结果之间的关系，并 SHALL 在首屏提供主要体验入口和次要示例入口。

#### Scenario: Anonymous visitor opens the website
- **WHEN** 未登录用户通过普通浏览器访问根路由
- **THEN** 用户无需登录即可理解主要使用场景、看到体验入口，并进入产品示例区域

### Requirement: Visitors can inspect an honest input-to-output demonstration
官网 SHALL 提供无需登录即可操作的示例展示，包含输入内容、整理步骤或状态和可读的结果结构；预设演示 MUST 明确标识为示例，MUST NOT 被呈现为正在调用 AI 的真实提取。

#### Scenario: Visitor interacts with the demonstration
- **WHEN** 用户选择示例或操作示例展示控件
- **THEN** 页面呈现与所选输入对应的结果，并保留示例身份说明

#### Scenario: Visitor repeats the interaction
- **WHEN** 用户反复切换或重新查看演示
- **THEN** 演示仍可操作且不产生重复实时提取请求、错误状态或 React DOM 所有权异常

### Requirement: Demonstration provenance is visible and truthful
示例 SHALL 展示来源说明；使用公共来源时 SHALL 显示可核验的来源信息，使用自编内容时 SHALL 明确说明其为演示内容。官网 MUST NOT 捏造用户评价、用户规模、性能数据或将自编内容归属于真实作者。

#### Scenario: Visitor inspects example provenance
- **WHEN** 用户阅读示例输入和结果
- **THEN** 用户可以区分公共来源素材和自编演示，并可以理解所见内容属于示例还是实际产品记录

### Requirement: Mobile product introduction states actual availability
官网 SHALL 包含适合移动设备使用场景的产品介绍和现有客户端下载入口；Android 与 Windows SHALL 保留内测状态，iOS SHALL 说明尚未提供，Mac SHALL 保留实际测试状态。

#### Scenario: Visitor chooses a device platform
- **WHEN** 用户查看或选择客户端平台
- **THEN** 页面展示与实际可用状态一致的入口或说明，不承诺未提供的安装包与能力

### Requirement: Product proof remains readable and accessible across devices
官网 SHALL 在桌面与手机窄屏保持正文、示例结果和行动按钮完整可读；交互控件 SHALL 具有可识别名称、键盘可操作性和焦点反馈，并 SHALL 在用户偏好减少动态效果时保留完整可用内容。

#### Scenario: Visitor uses a narrow mobile viewport
- **WHEN** 用户通过手机窄屏查看首页和示例
- **THEN** 主要内容无需横向滚动即可阅读，按钮可点击且示例内容不被裁切

#### Scenario: Visitor uses keyboard navigation or reduced motion
- **WHEN** 用户使用键盘操作示例，或系统启用减少动态效果
- **THEN** 所有核心操作仍可完成，焦点位置可辨识，内容不会依赖动画才能出现
