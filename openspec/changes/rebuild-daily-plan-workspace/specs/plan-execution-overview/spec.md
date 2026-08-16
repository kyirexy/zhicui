## MODIFIED Requirements

### Requirement: Execution overview summarizes current workload
The system SHALL provide the authenticated user with counts for active plans, open tasks, due-today tasks, overdue tasks, confirmed focus tasks, recommendations, and unscheduled tasks for a requested China-local date.

#### Scenario: Load overview
- **WHEN** a user opens the plan workspace for a valid date
- **THEN** the overview returns counts and categorized tasks calculated from all of that user's non-completed plans

#### Scenario: Empty overview
- **WHEN** the user has no active plans or open tasks
- **THEN** the overview returns zero counts and empty focus, recommendation, today, overdue, upcoming, and unscheduled lists

### Requirement: Focus tasks are classified once
The system MUST classify each unfinished task into at most one workload bucket while independently marking whether it is an explicitly selected focus for the requested date.

#### Scenario: Overdue scheduled task
- **WHEN** an unfinished task has a scheduled date before the requested date
- **THEN** it appears in overdue and not in today, upcoming, or unscheduled

#### Scenario: Today task
- **WHEN** an unfinished task is scheduled on the requested date or has no explicit date and belongs to the plan's current day
- **THEN** it appears in today unless it is overdue

#### Scenario: Unscheduled task
- **WHEN** an unfinished task has no explicit date and is not on the current plan day
- **THEN** it appears in unscheduled and may be used as a recommendation

## ADDED Requirements

### Requirement: Users confirm at most three daily focus tasks
The system SHALL allow an authenticated user to replace the ordered focus selection for one date with zero to three owned unfinished tasks.

#### Scenario: Save focus selection
- **WHEN** the user submits up to three valid owned unfinished tasks
- **THEN** the date's previous focus is replaced atomically and the overview returns the new order

#### Scenario: Reject invalid focus selection
- **WHEN** the selection contains more than three tasks, duplicates, a completed task, a missing task, or another user's task
- **THEN** the system rejects the entire selection and preserves the previous focus

