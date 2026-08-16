## ADDED Requirements

### Requirement: Users can create a manual plan
The system SHALL allow an authenticated user to create an owned plan without a linked note, with a non-empty title, optional start date and duration, and an optional first task.

#### Scenario: Create an empty plan
- **WHEN** a user submits a valid title without a first task
- **THEN** the system creates an active plan owned by that user with no note link

#### Scenario: Create a plan with first task
- **WHEN** a user submits a valid plan and first task
- **THEN** the returned plan contains the normalized unfinished task

#### Scenario: Reject invalid manual plan
- **WHEN** the title is empty, the start date is invalid, or the duration is outside the supported range
- **THEN** the system rejects the request without creating a plan

### Requirement: Users can capture a task from the workspace
The plan workspace SHALL expose one quick capture action that can create either a plan or a task, and task capture MUST require an owned destination plan.

#### Scenario: Capture task for today
- **WHEN** the user enters a task title, selects an owned plan, and chooses today
- **THEN** the task is created with today's China-local date and appears in the refreshed execution overview

