# plan-task-management Specification

## Purpose
TBD - created by archiving change strengthen-plan-execution-workspace. Update Purpose after archive.
## Requirements
### Requirement: Users can maintain plan metadata
The system SHALL allow a plan owner to update a non-empty plan title and set the plan status to active or done.

#### Scenario: Rename plan
- **WHEN** the owner submits a valid new title
- **THEN** the plan returns with the trimmed title and an updated timestamp

#### Scenario: Complete and reopen plan
- **WHEN** the owner marks a plan done or active
- **THEN** the plan status changes without altering its tasks

#### Scenario: Reject invalid metadata
- **WHEN** the owner submits an empty title, unsupported status, or no fields
- **THEN** the system rejects the request without changing the plan

### Requirement: Users can edit task details
The system SHALL allow a plan owner to edit a task title, assigned day, scheduled date, and priority while preserving its identity and completion state.

#### Scenario: Edit task
- **WHEN** the owner saves valid task details
- **THEN** the returned task retains its ID and done value and contains the updated details

#### Scenario: Move task to another day
- **WHEN** the owner assigns a task to a different positive day number
- **THEN** the task is removed from its previous day, inserted into the target day, and the target day is created if absent

#### Scenario: Clear scheduled date
- **WHEN** the owner explicitly sets the task scheduled date to null
- **THEN** the date is removed from both task representations

#### Scenario: Reject invalid task details
- **WHEN** the owner submits an empty title, invalid date, unsupported priority, invalid day, or no fields
- **THEN** the system rejects the request without changing the task

### Requirement: Task representations remain synchronized
The system MUST keep flat tasks and per-day tasks synchronized for add, edit, move, toggle, and delete operations, including legacy plans where one representation is missing.

#### Scenario: Update modern plan
- **WHEN** a task in a plan with flat and per-day data is changed
- **THEN** both representations contain the same task fields and completion state

#### Scenario: Update legacy day-only plan
- **WHEN** a task in a plan whose flat task list is empty is changed
- **THEN** the system reconstructs the flat representation and completes the requested mutation

### Requirement: Completion state follows task execution
The system SHALL mark a plan done when its final unfinished task is completed and SHALL reopen a done plan when a task becomes unfinished.

#### Scenario: Finish final task
- **WHEN** the owner completes the only remaining unfinished task
- **THEN** the returned plan status is done

#### Scenario: Reopen task
- **WHEN** the owner marks a task unfinished in a done plan
- **THEN** the returned plan status is active

