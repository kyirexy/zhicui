## ADDED Requirements

### Requirement: Record meaningful user operations
The system SHALL record authenticated state-changing API operations with the user, normalized action, HTTP method, route path, response status, elapsed time, IP address, and timestamp.

#### Scenario: User changes a plan
- **WHEN** an authenticated user creates, adjusts, completes, or deletes plan data
- **THEN** the system stores a corresponding normalized user operation

#### Scenario: Successful login or registration
- **WHEN** login, registration, or a local development session succeeds
- **THEN** the system stores the account operation attributed to the resulting user

### Requirement: Protect sensitive content
The system MUST NOT store authorization headers, API Keys, passwords, request bodies, query strings, video files, transcripts, questions, or generated answers in user operation logs.

#### Scenario: Log content extraction
- **WHEN** a user starts an extraction request containing a source URL
- **THEN** the log stores only the normalized action and route template without the URL or body

### Requirement: Administrator activity reporting
The system SHALL expose an administrator-only paginated user activity report with filters and aggregate counts.

#### Scenario: Filter activity by action
- **WHEN** an administrator selects an action and time window
- **THEN** the response returns matching rows and summary counts ordered newest first

#### Scenario: Read-only noise is excluded
- **WHEN** the system serves health checks, auth session restoration, or observability report polling
- **THEN** those requests are not added to the user operation log
