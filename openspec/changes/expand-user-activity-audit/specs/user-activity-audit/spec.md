## ADDED Requirements

### Requirement: Privacy-bounded user activity events
The system SHALL record key user activity events with timestamp, user association when safely available, outcome, route status, and only allowlisted structured metadata. The system MUST NOT store passwords, cookies, JWTs, request bodies, video transcripts, user questions, or video files in activity logs.

#### Scenario: Successful registration is recorded
- **WHEN** a user successfully registers
- **THEN** the system records one registration event associated with the new user and a successful outcome

#### Scenario: Login attempt is recorded without credentials
- **WHEN** a user attempts to log in
- **THEN** the system records the login outcome and MUST NOT store the submitted identifier or password in event details

#### Scenario: Unknown detail fields are rejected
- **WHEN** an activity caller supplies a detail key outside the allowlist
- **THEN** the system omits that key before persistence

### Requirement: Auditable Douyin synchronization lifecycle
The system SHALL record separate start and terminal events for every Douyin synchronization task, including source type, requested count, final totals, success count, failed count, and skipped count when available.

#### Scenario: Synchronization start records requested scope
- **WHEN** a user starts synchronization for likes, favorites, or own works
- **THEN** the system records the source type, requested count, task identifier, and started outcome

#### Scenario: Successful synchronization records final counts
- **WHEN** polling observes a synchronization task in a successful terminal state
- **THEN** the system records exactly one completion event with total, success, failed, and skipped counts

#### Scenario: Failed synchronization records final counts
- **WHEN** polling observes a synchronization task in a failed terminal state
- **THEN** the system records exactly one failure event with available counts and a bounded non-sensitive error category

#### Scenario: Repeated terminal polling is idempotent
- **WHEN** the same user polls the same terminal synchronization task multiple times
- **THEN** the system retains only one terminal activity event for that task and terminal status

### Requirement: Administrator user activity timeline
The system SHALL provide administrators with a paginated user activity timeline that can be filtered by time range, action type, and user, and that displays human-readable outcome details.

#### Scenario: Administrator filters one user's actions
- **WHEN** an administrator selects a user and action type
- **THEN** the report returns only matching events and preserves pagination and time range filters

#### Scenario: Synchronization summary is readable
- **WHEN** a synchronization event contains structured details
- **THEN** the interface displays a Chinese summary including source and requested or final counts without requiring the administrator to inspect raw JSON

#### Scenario: Historical events remain visible
- **WHEN** an older event has no structured details
- **THEN** the interface continues to display its timestamp, user, action, route, status, duration, and IP without error
