## ADDED Requirements

### Requirement: Private-list readiness is explicit and source-specific

The system SHALL evaluate Douyin private-list readiness without exposing credential values, SHALL treat likes and collections as independent capabilities, and MUST NOT treat `UIFID_TEMP` as satisfying a required `UIFID` session field.

#### Scenario: Likes are ready but collections are not
- **WHEN** an authenticated Douyin session can read likes but lacks the session context required by collections
- **THEN** the system reports the account as connected, allows a manual likes synchronization, and marks collections as requiring account verification

#### Scenario: Collection session field is missing
- **WHEN** a user requests collection synchronization and the scoped session lacks required `UIFID` context
- **THEN** the system does not repeatedly call the collection endpoint and returns `needs_action` with the safe code `argus_uifid_missing`

#### Scenario: Readiness is returned to the client
- **WHEN** the application reads the scoped Douyin connection status
- **THEN** the response contains only boolean readiness and allowlisted missing-requirement names and contains no Cookie values, tokens, signatures, or browser storage values

### Requirement: Private-list failures are not empty successes

The system SHALL classify access control, risk control, verification, expired sessions, malformed upstream responses, and confirmed empty lists separately, and SHALL count a zero-item result as successful only after an explicit complete upstream success.

#### Scenario: Likes endpoint returns HTTP 403
- **WHEN** the likes connector receives HTTP 403 or a platform challenge response
- **THEN** the source finishes as failed or `needs_action` with a safe error code and is not counted as a successful zero-item synchronization

#### Scenario: Collection response lacks a valid result shape
- **WHEN** the collection connector receives a non-JSON body or a response without a valid list and success status
- **THEN** the source finishes with `connector_error` and preserves all existing synchronized items

#### Scenario: Private list is confirmed empty
- **WHEN** the upstream request succeeds, explicitly reports success and returns a complete empty list without risk or verification signals
- **THEN** the source may finish successfully with zero discovered items and the interface explains that the list is currently empty

### Requirement: Manual private-list synchronization provides actionable feedback

The system SHALL display source-specific failure and recovery guidance after a manual Douyin synchronization and SHALL preserve successful results from other selected sources.

#### Scenario: Likes succeed and collections need action
- **WHEN** a combined manual synchronization reads likes successfully but collections require `UIFID` verification
- **THEN** the interface reports the likes result, identifies collections as not synchronized, and offers account reconnection without discarding the likes

#### Scenario: Douyin applies temporary risk control
- **WHEN** a private-list source returns `risk_controlled`
- **THEN** the interface tells the user to wait before retrying, displays an available bounded retry time, and does not automatically start another synchronization

#### Scenario: User reconnects the account
- **WHEN** the user completes account reconnection and the scoped session becomes ready for the requested source
- **THEN** a later manual synchronization may proceed without deleting existing library metadata, transcripts, knowledge, or plans

### Requirement: Private-list diagnostics are credential-safe

The system MUST log only allowlisted diagnostic fields for Douyin private-list operations and MUST NOT persist or emit full upstream URLs, query strings, Cookie values, tokens, signatures, or raw platform response bodies.

#### Scenario: Connector request fails
- **WHEN** a private-list request fails with an upstream HTTP or parsing error
- **THEN** logs and API responses contain only the endpoint path, safe error code, bounded counters and timing metadata

#### Scenario: Automated safety test scans diagnostics
- **WHEN** connector contract tests inspect stored models, API payloads and captured logs
- **THEN** no Cookie field value, signed query parameter, local sensitive path or binary response is present
