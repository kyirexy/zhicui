## ADDED Requirements

### Requirement: Record reported LLM usage
The system SHALL record the provider, display model, business operation, attributed user, prompt Token, completion Token, total Token, and timestamp for each successful LLM response that reports usage.

#### Scenario: Authenticated user LLM call
- **WHEN** a signed-in user triggers a successful LLM call with usage metadata
- **THEN** the system stores a usage row attributed to that user

#### Scenario: Usage logging failure
- **WHEN** the usage row cannot be persisted
- **THEN** the original LLM response still succeeds and the application records no prompt, transcript, key, or message content

### Requirement: Administrator usage reporting
The system SHALL expose an administrator-only paginated usage report with totals, model grouping, daily grouping, and recent calls for a bounded time window.

#### Scenario: Query 30-day usage
- **WHEN** an administrator requests the 30-day usage report
- **THEN** the response includes prompt, completion and total Token counts, call count, active user count, model totals, daily totals, and recent rows

#### Scenario: Non-admin queries usage
- **WHEN** a non-admin user requests the usage report
- **THEN** the system denies access
