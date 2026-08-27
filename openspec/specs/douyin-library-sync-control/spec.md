# Douyin Library Sync Control Specification

## Purpose

Define bounded Douyin library synchronization, optional post-sync AI processing, and safe account-session controls without storing video binaries in the application database.

## Requirements

### Requirement: Visible bounded synchronization controls

The system SHALL display synchronization presets for 20, 50, and 100 items without requiring the user to expand another settings section, SHALL allow an authenticated user to enter an integer synchronization count from 1 through 100, and SHALL start synchronization only after an explicit user action.

#### Scenario: User selects a visible preset

- **WHEN** the collection interface is opened
- **THEN** the 20-item, 50-item, and 100-item preset controls are immediately visible and selectable

#### Scenario: User enters a custom range

- **WHEN** the user enters an integer from 1 through 100
- **THEN** the next manually triggered synchronization uses that exact bounded count

#### Scenario: Backend or desktop bridge rejects an invalid range

- **WHEN** a client submits a count below 1 or above 100
- **THEN** the request is rejected without starting a local connector or downloader job

#### Scenario: No automatic synchronization occurs

- **WHEN** the user has connected an account but does not click synchronization
- **THEN** the system does not start a private-list request, scheduled refresh, or automatic retry

### Requirement: Bounded automatic processing

The system SHALL let the user enter an automatic-processing count from 0 through the selected synchronization count and SHALL never process more items than were selected for synchronization.

#### Scenario: Processing is enabled

- **WHEN** generation is enabled and synchronization completes
- **THEN** the system automatically processes at most the configured count and at most the synchronized item count

#### Scenario: Sync range is reduced

- **WHEN** the user lowers the synchronization count below the current processing count
- **THEN** the interface clamps the processing count to the new synchronization count

#### Scenario: Generation is disabled

- **WHEN** generation is disabled or the processing count is zero
- **THEN** synchronization updates the library metadata without automatically generating transcripts or knowledge cards

### Requirement: Safe Douyin session sign-out

The system SHALL allow an authenticated user to explicitly end the active local Douyin session without deleting synchronized library metadata, generated transcripts, knowledge cards, plans, or video files, and SHALL retain legacy cloud-session clearing only for compatible old clients.

#### Scenario: User confirms sign-out on Windows

- **WHEN** a connected Windows user confirms the `退出抖音` action
- **THEN** the current user's local Douyin profile is removed and the application reports disconnected status
- **AND** no other user's profile or synchronized data is changed

#### Scenario: User cancels sign-out

- **WHEN** the user cancels the confirmation
- **THEN** the current local session and library data remain unchanged

#### Scenario: Legacy client signs out

- **WHEN** an old client clears its cloud sidecar session
- **THEN** the compatibility session is cleared without deleting metadata or knowledge outcomes

### Requirement: Guided account rebinding

The system SHALL provide a `换绑账号` action that clears the current user's local Douyin profile and then starts an official-page login flow; it SHALL NOT treat a server Cookie handoff as the default path for updated Windows clients.

#### Scenario: Rebinding succeeds

- **WHEN** a connected Windows user confirms `换绑账号`
- **THEN** the previous local profile is cleared before the official Douyin login page opens

#### Scenario: Local session clearing fails

- **WHEN** the desktop client cannot safely remove the current user's isolated profile
- **THEN** the application shows an adjacent error and does not start a new login session

### Requirement: Session privacy and activity logging

The system MUST NOT expose, upload, persist in the application database, or log Douyin cookies, LocalStorage, signatures, profile paths, or account secrets and SHALL record only bounded operation metadata for login, synchronization, logout, and rebinding requests.

#### Scenario: Administrator reviews user activity

- **WHEN** an administrator views the activity report after a local sync, logout, or rebind action
- **THEN** the report identifies operation, source mode, bounded count, result category, and client capability version
- **AND** it contains no Cookie values, signatures, local paths, or response bodies

### Requirement: User-scoped persistent library removal

The system SHALL treat the default library removal as user-scoped temporary removal, SHALL hide the work immediately for that user, and SHALL restore it after the next successful synchronization that completes after the removal; the system SHALL keep a work hidden across synchronization only when the user explicitly chooses permanent hiding.

#### Scenario: User removes one video

- **WHEN** the user confirms the default removal of a visible library video
- **THEN** the video disappears from that user's current library and is marked as temporarily removed

#### Scenario: A later synchronization succeeds

- **WHEN** a synchronization started for the current user completes successfully after the temporary removal
- **THEN** the system clears the eligible temporary removal and allows the video to appear again

#### Scenario: A synchronization fails

- **WHEN** a synchronization fails after a temporary removal
- **THEN** the video remains temporarily removed

#### Scenario: User permanently hides a video

- **WHEN** the user explicitly confirms permanent hiding
- **THEN** the system keeps the video hidden for that user after subsequent synchronization

#### Scenario: Another user views the library

- **WHEN** a different authenticated user has not removed or permanently hidden the same work ID
- **THEN** that user's library visibility is not changed by the first user's action

### Requirement: Bounded batch library removal

The system SHALL allow an authenticated user to temporarily remove or permanently hide between 1 and 50 selected library videos in one confirmed operation.

#### Scenario: User confirms batch removal

- **WHEN** the user selects multiple visible videos and confirms temporary removal
- **THEN** all accepted work IDs disappear from the user's current library view and selection until a later successful synchronization

#### Scenario: User confirms batch permanent hiding

- **WHEN** the user selects multiple visible videos and explicitly confirms permanent hiding
- **THEN** all accepted work IDs remain hidden for that user across subsequent synchronization

#### Scenario: Batch request exceeds the limit

- **WHEN** a client submits more than 50 work IDs
- **THEN** the backend rejects the request without changing hidden-item records

#### Scenario: Removal is repeated

- **WHEN** the same work ID is submitted more than once or removed again later
- **THEN** the operation succeeds idempotently without duplicate hidden-item records or downgrading a permanent record to temporary

### Requirement: Non-destructive removal semantics

The system MUST NOT unfavorite content on Douyin or delete synchronized metadata, generated transcripts, knowledge cards, plans, or video files when temporarily removing, permanently hiding, or restoring an item in the Zhicui library.

#### Scenario: User reviews temporary removal confirmation

- **WHEN** a user initiates single or batch temporary removal
- **THEN** the confirmation explains that only the current Zhicui library view changes and the item can return after synchronization

#### Scenario: User reviews permanent hiding confirmation

- **WHEN** a user initiates single or batch permanent hiding
- **THEN** the confirmation explains that future synchronization will not show the item until the user restores it

#### Scenario: A visibility operation completes

- **WHEN** a removal, permanent-hide, or restore operation succeeds
- **THEN** existing generated Notes and plans remain available outside the library view

### Requirement: Accurate hidden-item synchronization feedback

The collection interface SHALL distinguish source items from visible items and SHALL report when synchronized works are absent because the current user has hidden them.

#### Scenario: Every synchronized work is permanently hidden

- **WHEN** synchronization succeeds with one or more source items and no visible items because all of them are permanently hidden
- **THEN** the interface reports the synchronized source count and offers access to the permanent-hidden manager instead of saying that zero works were collected

#### Scenario: Some synchronized works are hidden

- **WHEN** synchronization succeeds and only some source items are hidden
- **THEN** the interface displays the visible works and exposes the relevant hidden count

### Requirement: Accurate collection discovery feedback

The synchronization interface SHALL distinguish login prerequisites from an actual successful read, SHALL distinguish an unknown running total from a confirmed empty result, SHALL display only confirmed progress counts, and SHALL identify whether the current task runs locally or through a legacy compatibility path without exposing implementation secrets.

#### Scenario: Login prerequisites are complete

- **WHEN** an account has the expected authentication evidence but no sync has run
- **THEN** the interface says the local login is valid
- **AND** it does not claim the source is guaranteed to synchronize

#### Scenario: Discovery total is not known yet

- **WHEN** a manual local synchronization is running and no work has been discovered
- **THEN** the interface says it is reading the selected source and does not claim that zero items were saved

#### Scenario: Discovery progress is known

- **WHEN** a running synchronization has discovered one or more works
- **THEN** the interface displays the confirmed discovered count

#### Scenario: Synchronization succeeds

- **WHEN** a synchronization completes with one or more accepted items
- **THEN** the interface reports actual discovered, accepted, reused, and failed counts before loading the refreshed library

#### Scenario: Completed synchronization is empty or restricted

- **WHEN** a synchronization completes with zero items or the platform requires verification
- **THEN** the interface explains the difference and offers the relevant retry, reconnect, or official-page verification action
