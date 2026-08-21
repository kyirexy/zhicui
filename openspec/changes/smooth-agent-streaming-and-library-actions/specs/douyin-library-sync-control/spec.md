## ADDED Requirements

### Requirement: Selected-video hide actions remain directly discoverable
When the desktop video library has one or more selected items, the selected-item toolbar SHALL show both temporary removal and permanent hiding as labeled actions without requiring the user to open the more-actions menu. The actions SHALL continue to use the existing confirmation, user scoping, batch bounds, and non-destructive data semantics.

#### Scenario: Desktop selection contains removable Douyin videos
- **WHEN** the user selects one or more Douyin library videos on a desktop-width viewport
- **THEN** the toolbar directly shows labeled “移出视频资料” and “永久隐藏” actions with the applicable Douyin item count

#### Scenario: Mixed-platform selection
- **WHEN** the selection contains Douyin and non-Douyin videos
- **THEN** each hide action reports and applies only the eligible Douyin subset rather than the total cross-platform selection count

#### Scenario: Selected items are not eligible for the Douyin hide API
- **WHEN** no selected item is an eligible Douyin library video
- **THEN** both direct hide actions remain visible but disabled

#### Scenario: User invokes a direct hide action
- **WHEN** the user activates temporary removal or permanent hiding from the selected-item toolbar
- **THEN** the same existing alert dialog explains the selected mode and requires confirmation before any state changes

#### Scenario: Narrow viewport preserves toolbar usability
- **WHEN** the viewport is at or below the mobile library breakpoint
- **THEN** the two hide actions may use the existing compact more-actions menu so the fixed selection toolbar does not grow beyond its intended mobile layout
