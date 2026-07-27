## ADDED Requirements

### Requirement: Global authenticated feedback entry

The client SHALL provide an accessible feedback entry for authenticated users across supported web and Android views.

#### Scenario: Desktop entry

- **WHEN** an authenticated user opens a desktop view
- **THEN** a feedback button is visible at the bottom-right without covering primary navigation

#### Scenario: Mobile entry

- **WHEN** an authenticated user opens a mobile or Capacitor view
- **THEN** the feedback button is positioned above the bottom navigation
- **AND** it respects bottom and right safe-area insets

#### Scenario: Unauthenticated view

- **WHEN** no authenticated user session exists
- **THEN** the feedback entry is not shown

### Requirement: Structured feedback submission

The system SHALL accept categorized feedback with a subject and detailed content and SHALL record only bounded, non-secret client context.

#### Scenario: Successful submission

- **WHEN** an authenticated user submits a valid category, subject, and description
- **THEN** the system stores the feedback for that user with status `pending`
- **AND** returns the created feedback record

#### Scenario: Invalid submission

- **WHEN** required content is missing or exceeds the configured length
- **THEN** the system rejects the request with a validation response
- **AND** no feedback record is created

#### Scenario: Client context privacy

- **WHEN** feedback is submitted from web or Android
- **THEN** the stored context is limited to page path, platform, user agent, viewport, and app version
- **AND** tokens, passwords, cookies, page content, images, and videos are not stored

#### Scenario: Submission rate limit

- **WHEN** a user has already submitted five feedback records within ten minutes
- **THEN** the next submission is rejected with HTTP 429

### Requirement: User-owned feedback history

The system SHALL let an authenticated user review their own recent feedback and SHALL prevent access to other users' feedback.

#### Scenario: View own history

- **WHEN** a user opens the feedback dialog history view
- **THEN** the system returns that user's feedback in newest-first order
- **AND** shows category, subject, status, submission time, and any administrator reply

#### Scenario: User isolation

- **WHEN** a user requests feedback history
- **THEN** records belonging to other users are never returned

### Requirement: Administrative feedback management

The admin panel SHALL provide a feedback center for reviewing and processing all submitted feedback.

#### Scenario: Filter and search feedback

- **WHEN** an administrator selects a status, category, or keyword
- **THEN** the feedback list is filtered server-side and remains paginated

#### Scenario: Inspect feedback context

- **WHEN** an administrator opens a feedback record
- **THEN** the panel shows the submitting user, category, subject, full content, page path, bounded client environment, status, and timestamps

#### Scenario: Process feedback

- **WHEN** an administrator changes a feedback status or saves a reply
- **THEN** the updated record is persisted with the handling administrator
- **AND** the user can see the new status and reply in their own history

### Requirement: Feedback authorization and audit

The system SHALL enforce authenticated user ownership and administrator-only moderation and SHALL record relevant actions.

#### Scenario: Unauthorized moderation

- **WHEN** a non-administrator calls an admin feedback endpoint
- **THEN** the system rejects the request with HTTP 403

#### Scenario: Submission activity log

- **WHEN** a user successfully submits feedback
- **THEN** the system records a user activity event without copying the full feedback content into the activity detail

#### Scenario: Administrator audit log

- **WHEN** an administrator updates feedback status or reply
- **THEN** the system records an administrator audit event containing the feedback identifier and changed fields
