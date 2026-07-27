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

The system SHALL allow an authenticated user to remove a Douyin video from their Zhicui library and SHALL keep that video hidden for that user after subsequent synchronization.

#### Scenario: User removes one video

- **WHEN** the user confirms removal of a visible library video
- **THEN** the video disappears from that user's library

#### Scenario: Removed video is synchronized again

- **WHEN** a later Douyin synchronization contains a work ID previously removed by the current user
- **THEN** the system keeps that video hidden for that user

#### Scenario: Another user views the library

- **WHEN** a different authenticated user has not removed the same work ID
- **THEN** that user's library visibility is not changed by the first user's removal

### Requirement: Bounded batch library removal

The system SHALL allow an authenticated user to remove between 1 and 50 selected library videos in one confirmed operation.

#### Scenario: User confirms batch removal

- **WHEN** the user selects multiple visible videos and confirms batch removal
- **THEN** all accepted work IDs disappear from the user's current library view and selection

#### Scenario: Batch request exceeds the limit

- **WHEN** a client submits more than 50 work IDs
- **THEN** the backend rejects the request without changing hidden-item records

#### Scenario: Removal is repeated

- **WHEN** the same work ID is submitted more than once or removed again later
- **THEN** the operation succeeds idempotently without duplicate hidden-item records

### Requirement: Non-destructive removal semantics

The system MUST NOT unfavorite content on Douyin or delete synchronized metadata, generated transcripts, knowledge cards, plans, or video files when removing an item from the Zhicui library.

#### Scenario: User reviews the confirmation

- **WHEN** a user initiates single or batch removal
- **THEN** the confirmation explains that only the Zhicui library view changes

#### Scenario: Removal completes

- **WHEN** a removal operation succeeds
- **THEN** existing generated Notes and plans remain available outside the library view
