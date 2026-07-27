## ADDED Requirements

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
