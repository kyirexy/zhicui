## ADDED Requirements

### Requirement: Capture backend and LLM failures
The system SHALL store a detailed error record when an unhandled backend exception, an actionable HTTP error response, or an LLM provider call failure occurs. Routine 401, 403, and 404 control-flow responses SHALL NOT be persisted as application errors.

#### Scenario: Unhandled backend exception
- **WHEN** a backend request raises an exception that is not handled by a route
- **THEN** the system records the exception type, sanitized message, sanitized traceback, route template, method, status, attributed user, IP, severity, source, and time before returning the normal server error response

#### Scenario: LLM provider failure
- **WHEN** a LiteLLM completion raises before returning a valid response
- **THEN** the system records the safe provider, model, and business operation metadata with the sanitized exception and re-raises the original failure

### Requirement: Capture authenticated client failures
The system SHALL accept bounded runtime error reports from authenticated Web or Capacitor clients.

#### Scenario: Browser runtime error
- **WHEN** an authenticated client reports an uncaught error or unhandled rejection
- **THEN** the system records a sanitized frontend error without accepting headers, request bodies, transcripts, questions, passwords, API Keys, or generated answers

#### Scenario: Unauthenticated client report
- **WHEN** an unauthenticated caller submits a client error
- **THEN** the system denies the report

### Requirement: Redact sensitive error content
The system MUST sanitize messages, stack traces, paths, and metadata before persistence and MUST NOT provide fields capable of storing arbitrary request bodies.

#### Scenario: Exception contains a secret
- **WHEN** an exception message includes a bearer token, API Key assignment, secret-like key, password, or URL query string
- **THEN** the persisted value replaces the sensitive part with a redaction marker

### Requirement: Administrator error reporting
The system SHALL expose an administrator-only paginated error report with time, source, severity, and status filters, aggregate counts, and expandable detail.

#### Scenario: Administrator opens error logs
- **WHEN** an administrator selects the error log view
- **THEN** the interface shows totals, recent critical errors, affected users, filtered rows, sanitized messages, and expandable sanitized stack traces

#### Scenario: Non-admin reads errors
- **WHEN** a non-admin user requests error logs
- **THEN** the system denies access
