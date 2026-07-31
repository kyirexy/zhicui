## ADDED Requirements

### Requirement: Desktop runtime uses a dedicated application shell

The Electron desktop client SHALL render a desktop-specific navigation shell only when the trusted preload bridge confirms the desktop runtime. Ordinary Web and Android clients MUST retain their existing application shell.

#### Scenario: Electron client opens
- **WHEN** `window.zhicuiDesktop.getRuntimeInfo()` confirms a trusted desktop runtime
- **THEN** the client displays the desktop navigation rail, page context bar and desktop content canvas
- **AND** the ordinary Web header, Web footer and mobile bottom navigation are not displayed

#### Scenario: Wide browser opens
- **WHEN** a normal browser uses a desktop-size viewport without the preload bridge
- **THEN** the client continues to display the existing Web layout

### Requirement: Desktop root route is an actionable workspace

The Electron root route SHALL present a signed-in workspace containing video-library status, recent knowledge, plan progress and direct actions instead of the marketing homepage.

#### Scenario: Desktop user opens the root route
- **WHEN** an authenticated desktop user visits `/`
- **THEN** the first viewport shows a clear primary action for the video library
- **AND** recent video, knowledge and plan information are presented without requiring the user to scroll through product marketing

#### Scenario: Workspace data is partially unavailable
- **WHEN** one workspace data request fails
- **THEN** the remaining workspace sections stay usable
- **AND** the failed section shows a concise local fallback with a relevant navigation action

### Requirement: Desktop navigation preserves product context

The desktop shell SHALL expose labeled navigation for the workspace, video library, knowledge library, plans and settings, SHALL indicate the active route, and SHALL expose admin navigation only to administrators.

#### Scenario: User changes desktop sections
- **WHEN** the user selects a navigation destination
- **THEN** the selected route becomes active and the context bar updates to the corresponding page title

#### Scenario: Non-admin uses the desktop app
- **WHEN** the authenticated user is not an administrator
- **THEN** the administration destination is not rendered

### Requirement: Desktop core pages share a coherent workspace layout

The video library, knowledge library, plans and settings routes SHALL use consistent desktop canvas spacing, surface hierarchy, heading scale and action sizing while preserving their existing business capabilities.

#### Scenario: User moves between core routes
- **WHEN** the user navigates among `/library`, `/notes`, `/plans` and `/settings`
- **THEN** page content aligns to the same desktop canvas and title context
- **AND** existing sync, Q&A, plan, deletion, feedback and update actions remain available

### Requirement: Desktop workspace is accessible and resilient

Desktop navigation and actions MUST expose visible keyboard focus, icon-only actions MUST have accessible labels, interaction feedback MUST finish within 200ms, and the layout MUST remain usable at the Electron minimum window size.

#### Scenario: Keyboard user navigates
- **WHEN** focus moves through the desktop shell and primary workspace actions
- **THEN** every interactive control presents a visible focus indicator in logical order

#### Scenario: Reduced motion is enabled
- **WHEN** the operating system requests reduced motion
- **THEN** desktop entrance and interaction animations are removed or reduced to effectively instantaneous feedback
