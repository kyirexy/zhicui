## ADDED Requirements

### Requirement: User-scoped synchronization and job lookup
The system SHALL execute every synchronization request and job lookup in the authenticated user's Douyin session scope.

#### Scenario: User starts synchronization
- **WHEN** an authenticated user starts a bounded synchronization
- **THEN** the downloader uses only that user's Cookie and writes only that user's library metadata snapshot

#### Scenario: Another user opens the library
- **WHEN** a second user has not synchronized the same content
- **THEN** the first user's downloader catalog does not appear in the second user's library

## MODIFIED Requirements

### Requirement: Safe Douyin session sign-out
The system SHALL allow an authenticated user to explicitly end only their own active Douyin downloader session without deleting any user's synchronized library metadata, generated transcripts, knowledge cards, plans, or video files.

#### Scenario: User confirms sign-out

- **WHEN** a connected user confirms the `退出抖音` action
- **THEN** only that user's downloader login cookies and active QR session state are cleared and the application reports that user as disconnected

#### Scenario: User cancels sign-out

- **WHEN** the user cancels the confirmation
- **THEN** the current user's Douyin session and library data remain unchanged

#### Scenario: Another user is connected

- **WHEN** one user signs out while another user has a valid Douyin binding
- **THEN** the other user's login state and synchronization jobs remain unchanged

### Requirement: Guided account rebinding
The system SHALL provide a `换绑账号` action that clears only the current user's Douyin session and then starts the existing QR-code login flow in that same user's scope.

#### Scenario: Rebinding succeeds

- **WHEN** a connected user confirms `换绑账号`
- **THEN** that user's previous session is cleared before a new QR login session starts without affecting other users

#### Scenario: Session clearing fails

- **WHEN** the downloader cannot safely clear the current user's session
- **THEN** the application shows an adjacent error and does not start a new QR login session

### Requirement: Session privacy and activity logging
The system MUST NOT expose or log Douyin cookies, session scopes or account secrets and SHALL record only bounded operation metadata for the current user's logout, rebinding and synchronization requests.

#### Scenario: Administrator reviews user activity

- **WHEN** an administrator views the activity report after a logout, rebind or synchronization action
- **THEN** the report identifies the user, operation and result without containing Cookie values, session scopes or account secrets
