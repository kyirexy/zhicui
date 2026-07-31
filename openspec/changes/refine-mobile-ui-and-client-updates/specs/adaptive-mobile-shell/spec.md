## ADDED Requirements

### Requirement: Mobile shell reserves safe interactive space

The mobile Web and Android clients SHALL reserve space for the fixed bottom navigation and device safe area, and SHALL position floating actions so they do not cover primary content or navigation targets.

#### Scenario: User reaches the end of a mobile page
- **WHEN** the viewport width is below the desktop breakpoint
- **THEN** the final content remains fully scrollable above the bottom navigation and safe area
- **AND** the feedback launcher remains above the navigation without covering primary actions

### Requirement: Mobile controls remain readable and touch friendly

Primary controls, icon-only actions, navigation items and dismiss actions SHALL expose at least a 44px interactive target on touch devices, while visible text SHALL remain readable without zooming.

#### Scenario: User operates the video library on a phone
- **WHEN** the viewport is between 360px and 430px wide
- **THEN** video selection, playback, details and overflow actions can be activated through 44px touch targets
- **AND** card titles and processing states remain legible in the two-column grid

#### Scenario: Viewport is unusually narrow
- **WHEN** the viewport is narrower than 360px
- **THEN** the video grid falls back to a single column instead of clipping controls or text

### Requirement: Full-screen mobile workspaces respect safe areas

Mobile full-screen dialogs and AI workspaces SHALL use dynamic viewport units and top/bottom safe-area padding, and SHALL keep their close and submit controls reachable while the software keyboard is open.

#### Scenario: User opens library AI on mobile
- **WHEN** the AI workspace is opened below the desktop breakpoint
- **THEN** it occupies the available dynamic viewport without horizontal overflow
- **AND** the close control, message thread and composer remain reachable
