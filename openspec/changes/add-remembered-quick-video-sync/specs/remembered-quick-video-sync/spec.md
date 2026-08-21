## ADDED Requirements

### Requirement: First quick sync requests configuration
The system SHALL open the existing video synchronization settings when a user invokes the homepage quick-sync entry on a device without confirmed quick-sync preferences.

#### Scenario: First homepage invocation
- **WHEN** the user clicks the homepage synchronization action and no confirmed quick-sync preference exists on the device
- **THEN** the system navigates to the video library and opens the synchronization settings dialog
- **AND** it does not begin synchronization before the user confirms the settings

### Requirement: Confirmed preferences enable direct synchronization
The system SHALL remember the confirmed Douyin source selection and bounded synchronization count on the current device and SHALL reuse them on later homepage quick-sync invocations.

#### Scenario: Returning user invokes quick sync
- **WHEN** a user with confirmed preferences clicks the homepage synchronization action
- **THEN** the system navigates to the video library and begins one synchronization run with the saved sources and count without opening the settings dialog

#### Scenario: Account is unavailable
- **WHEN** direct synchronization cannot start because the Douyin account is disconnected or expired
- **THEN** the system opens the synchronization settings dialog and exposes the existing login or recovery controls

### Requirement: Quick-sync intent is consumed once
The system SHALL consume a homepage quick-sync intent at most once per navigation.

#### Scenario: Library rerenders after invocation
- **WHEN** the library rerenders or synchronization state changes after consuming the quick-sync URL intent
- **THEN** the system does not start a second synchronization run

### Requirement: Preferences are editable in settings
The system SHALL provide a quick-sync control in the settings area where the user can update the saved Douyin sources and count or require confirmation on the next invocation.

#### Scenario: User saves changed preferences
- **WHEN** the user saves valid source and count values in settings
- **THEN** the next homepage quick-sync invocation uses those values directly

#### Scenario: User requests confirmation next time
- **WHEN** the user selects the control that requires confirmation on the next invocation
- **THEN** the next homepage quick-sync invocation opens the synchronization settings dialog with the last choices available

### Requirement: Homepage video previews preserve video identity
The system SHALL navigate each homepage video preview to the detail route for that exact video instead of opening the generic library list.

#### Scenario: User opens a Douyin preview
- **WHEN** the user clicks a Douyin work, collection, or liked-video preview on the homepage
- **THEN** the system opens `/library/detail` with that video's Douyin work ID

#### Scenario: User opens a Bilibili preview
- **WHEN** the user clicks a Bilibili preview on the homepage
- **THEN** the system opens `/library/detail` with that imported video's note ID

### Requirement: Homepage video previews display recoverable covers
The system SHALL display the available cover for each homepage video preview and SHALL retry a transient cover-loading failure before showing a stable fallback.

#### Scenario: Cover proxy is temporarily unavailable
- **WHEN** a homepage video cover fails on its first loading attempt
- **THEN** the system retries the same cover with a fresh request
- **AND** the cover appears if the retry succeeds

#### Scenario: Cover remains unavailable
- **WHEN** both bounded loading attempts fail or the video has no cover URL
- **THEN** the preview remains usable and shows a clear cover-unavailable fallback

### Requirement: Homepage prioritizes recent channel videos
The system SHALL place the latest synchronized channel videos ahead of secondary workspace tools and SHALL keep the assistant entry compact enough for video previews to appear in the initial desktop viewport.

#### Scenario: Desktop user opens the homepage
- **WHEN** a signed-in desktop user opens the workspace homepage
- **THEN** the compact video assistant entry appears above the latest synchronized videos
- **AND** Douyin works, collections, likes, and Bilibili each expose directly clickable previews in a space-efficient grid

#### Scenario: Mobile user opens the homepage
- **WHEN** a signed-in mobile user opens the workspace homepage
- **THEN** channel groups stack vertically
- **AND** each group preserves horizontally scrollable, directly clickable video previews without overflowing the page
