# Douyin Library Sync Control Specification

## Purpose

Define bounded Douyin library synchronization, optional post-sync AI processing, and safe account-session controls without storing video binaries in the application database.

## Requirements

### Requirement: Visible bounded synchronization controls

The system SHALL display synchronization presets for 50 and 100 items without requiring the user to expand another settings section, and SHALL allow an authenticated user to enter an integer synchronization count from 1 through 100.

#### Scenario: User selects a visible preset

- **WHEN** the collection interface is opened
- **THEN** the 50-item and 100-item preset controls are immediately visible and selectable

#### Scenario: User enters a custom range

- **WHEN** the user enters an integer from 1 through 100
- **THEN** the next synchronization request uses that exact bounded count

#### Scenario: Backend rejects an invalid range

- **WHEN** a client submits a count below 1 or above 100
- **THEN** the backend rejects the request without starting a downloader job

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

The system SHALL allow an authenticated user to explicitly end the active Douyin downloader session without deleting synchronized library metadata, generated transcripts, knowledge cards, plans, or video files.

#### Scenario: User confirms sign-out

- **WHEN** a connected user confirms the `退出抖音` action
- **THEN** the downloader login cookies and active session state are cleared and the application reports disconnected status

#### Scenario: User cancels sign-out

- **WHEN** the user cancels the confirmation
- **THEN** the current Douyin session and library data remain unchanged

### Requirement: Guided account rebinding

The system SHALL provide a `换绑账号` action that clears the current Douyin session and then starts the existing QR-code login flow.

#### Scenario: Rebinding succeeds

- **WHEN** a connected user confirms `换绑账号`
- **THEN** the previous session is cleared before a new QR login session starts

#### Scenario: Session clearing fails

- **WHEN** the downloader cannot safely clear the current session
- **THEN** the application shows an adjacent error and does not start a new QR login session

### Requirement: Session privacy and activity logging

The system MUST NOT expose or log Douyin cookies or account secrets and SHALL record only bounded operation metadata for logout and rebinding requests.

#### Scenario: Administrator reviews user activity

- **WHEN** an administrator views the activity report after a logout or rebind action
- **THEN** the report identifies the operation and result without containing cookie values or account secrets

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

The collection interface SHALL distinguish an unknown running total from a confirmed empty result, SHALL display only confirmed progress counts, and SHALL describe the bounded synchronization behavior in plain user-facing language without provider implementation terms.

#### Scenario: Collection total is not known yet

- **WHEN** a collection synchronization job is running and its reported total is missing or zero
- **THEN** the interface says it is reading the user's collection and does not claim that zero items were saved

#### Scenario: Collection progress is known

- **WHEN** a running collection synchronization job reports a positive total
- **THEN** the interface displays the confirmed successful count and total

#### Scenario: Collection synchronization succeeds

- **WHEN** a collection synchronization job completes with one or more successful items
- **THEN** the interface reports the actual synchronized count before loading the refreshed library

#### Scenario: Completed synchronization is empty

- **WHEN** a collection synchronization job completes successfully with zero items
- **THEN** the interface explains that no collection was read and suggests checking or rebinding the Douyin account

#### Scenario: User reads the collection explanation

- **WHEN** the collection source is selected
- **THEN** the interface explains the selected range, automatic transcript preparation, direct Q&A, on-demand knowledge cards, and no server-side video storage without naming ASR or a model provider
