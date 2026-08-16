## ADDED Requirements

### Requirement: Weekly review uses recorded execution history
The system SHALL calculate a China-local Monday-through-Sunday review from recorded task schedules and completion timestamps.

#### Scenario: Review current week
- **WHEN** a user requests a valid week start
- **THEN** the response contains completed, scheduled, carried-over, overdue, and completed-plan counts scoped to that user

#### Scenario: Review per plan
- **WHEN** review data includes tasks from multiple plans
- **THEN** the response groups truthful completion and carry-over counts by plan without inventing progress deltas

### Requirement: Incomplete historical coverage is disclosed
The system MUST flag a review as partial when owned completed tasks lack a recorded completion timestamp.

#### Scenario: Legacy completion has no timestamp
- **WHEN** at least one completed task predates completion-time tracking
- **THEN** the task remains in overall plan progress but is excluded from weekly completion counts
- **AND** the review returns `partial_history: true` and a history boundary message

