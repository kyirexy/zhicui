## MODIFIED Requirements

### Requirement: Visible bounded synchronization controls
The system SHALL display synchronization presets for 20, 50, and 100 items without requiring the user to expand another settings section, SHALL allow an authenticated user to enter an integer synchronization count from 1 through 100, and SHALL start synchronization only after an explicit user action.

#### Scenario: User selects a visible preset
- **WHEN** the synchronization interface is opened
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

