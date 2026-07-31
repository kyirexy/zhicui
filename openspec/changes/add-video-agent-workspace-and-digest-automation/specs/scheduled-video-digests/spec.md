## ADDED Requirements

### Requirement: User can configure a daily video digest
The system SHALL let an authenticated user create, edit, pause, resume, and delete a daily digest with a local execution time, IANA timezone, recipient email, and editable instruction.

#### Scenario: Create an enabled daily digest
- **WHEN** the user saves a valid daily time, timezone, email, and instruction
- **THEN** the system persists the automation and calculates its next run time

#### Scenario: Pause a digest
- **WHEN** the user disables an automation
- **THEN** the system stops claiming future scheduled runs while preserving configuration and run history

#### Scenario: Edit a paused digest
- **WHEN** the user edits the name, time, scope, or instruction of a paused automation
- **THEN** the system preserves its paused state unless the user explicitly resumes it

### Requirement: Daily digest scope is yesterday's newly organized content
The system SHALL build a daily digest from user-owned, transcript-ready videos that were newly organized into 知萃 on the previous local calendar day.

#### Scenario: Yesterday has ready videos
- **WHEN** the automation runs and eligible videos exist
- **THEN** the system creates a frozen source snapshot and generates a grounded digest from those transcripts

#### Scenario: Yesterday has no ready videos
- **WHEN** the automation runs and no eligible videos exist
- **THEN** the system records a successful no-content run with an honest explanatory result and does not fabricate a summary

### Requirement: Every digest run is inspectable and reusable
The system SHALL persist each run's status, source count, result, delivery status, timestamps, error, and linked Agent task when one is created.

#### Scenario: Continue from a digest
- **WHEN** a completed run has a linked Agent task
- **THEN** the user can open that task and continue asking questions against the same source snapshot

#### Scenario: Preview a digest
- **WHEN** a user chooses “立即生成一次”
- **THEN** the system generates and saves a preview and never sends email from the manual-preview API

### Requirement: Scheduled execution is server-side and duplicate-safe
The system SHALL execute due automations independently of browser or desktop client availability and SHALL use a persistent lease to prevent duplicate execution.

#### Scenario: Client is offline
- **WHEN** a digest becomes due while the user's clients are closed
- **THEN** the backend still claims and executes the automation

#### Scenario: Two workers observe the same due automation
- **WHEN** multiple backend workers poll the same due row
- **THEN** only the worker that atomically acquires the unexpired lease executes that scheduled occurrence

#### Scenario: One digest takes longer than a polling interval
- **WHEN** a claimed digest is queued or the LLM is still running
- **THEN** the worker renews a heartbeat and no other worker marks the active run stale

#### Scenario: Service recovers after a missed schedule
- **WHEN** the backend starts after one or more scheduled occurrences were missed
- **THEN** it creates at most one catch-up run for the most recent occurrence and selects the previous day relative to that stored occurrence

### Requirement: Email delivery reports the truth
The system SHALL separate digest generation status from email delivery status and SHALL never report an email as sent without a successful SMTP submission.

#### Scenario: SMTP is configured
- **WHEN** a scheduled digest is generated, the account email is verified, and SMTP accepts the message
- **THEN** the run records that submission to SMTP succeeded without claiming final inbox delivery

#### Scenario: Account email is not verified
- **WHEN** a scheduled digest is ready but the account email has not completed signed-link verification
- **THEN** the digest remains available in 知萃 and no message is submitted to SMTP

#### Scenario: SMTP is not configured
- **WHEN** a digest is generated in an environment without SMTP configuration
- **THEN** the run preserves the digest, records delivery status as not configured, and shows the user that no email was sent

#### Scenario: SMTP send fails
- **WHEN** message submission raises an error
- **THEN** the run preserves the digest, records delivery status as failed with a safe error summary, and allows retry or preview

### Requirement: Automation data is user-scoped
The system SHALL restrict configuration, runs, recipients, and linked Agent tasks to the authenticated owner.

#### Scenario: Access another user's automation
- **WHEN** a user requests another user's automation or run ID
- **THEN** the system returns a not-found response without leaking its contents
