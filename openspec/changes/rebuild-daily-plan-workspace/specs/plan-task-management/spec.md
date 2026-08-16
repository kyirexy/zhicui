## MODIFIED Requirements

### Requirement: Users can maintain plan metadata
The system SHALL allow a plan owner to update a non-empty plan title, an optional China-local start date, a bounded duration, and status active or done.

#### Scenario: Rename or reschedule plan
- **WHEN** the owner submits a valid title, start date, or duration
- **THEN** the plan returns with normalized metadata and an updated timestamp

#### Scenario: Complete and reopen plan
- **WHEN** the owner marks a plan done or active
- **THEN** the status changes without altering tasks and completed_at is set or cleared consistently

#### Scenario: Reject invalid metadata
- **WHEN** the owner submits an empty title, invalid date, unsupported duration, unsupported status, or no fields
- **THEN** the system rejects the request without changing the plan

### Requirement: Task representations remain synchronized
The system MUST keep flat tasks and per-day tasks synchronized for add, edit, move, reorder, focus, toggle, and delete operations, including legacy plans where one representation or schema-v3 field is missing.

#### Scenario: Update modern plan
- **WHEN** a task in a plan with flat and per-day data is changed
- **THEN** both representations contain the same task fields, position, focus metadata, and completion state

#### Scenario: Update legacy plan
- **WHEN** a legacy task is read or changed without a flat representation, position, focus metadata, or completion timestamp
- **THEN** the system reconstructs missing structure without fabricating a completion timestamp and completes the requested mutation

### Requirement: Completion state follows task execution
The system SHALL record a task completion timestamp when it becomes done, clear it when reopened, mark a plan done when its final unfinished task is completed, and reopen a done plan when a task becomes unfinished.

#### Scenario: Finish final task
- **WHEN** the owner completes the only remaining unfinished task
- **THEN** the task and plan receive completion timestamps and the returned plan status is done

#### Scenario: Reopen task
- **WHEN** the owner marks a task unfinished in a done plan
- **THEN** task and plan completion timestamps are cleared and the returned plan status is active

## ADDED Requirements

### Requirement: Users can reorder plan tasks
The system SHALL allow an owner to save one complete, unique ordering of all tasks in a plan and MUST reject partial, duplicate, or foreign task IDs.

#### Scenario: Save valid order
- **WHEN** the owner submits every current task ID exactly once
- **THEN** tasks receive continuous positions and both task representations return in that order

