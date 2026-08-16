# plan-execution-overview Specification

## Purpose
TBD - created by archiving change strengthen-plan-execution-workspace. Update Purpose after archive.
## Requirements
### Requirement: Execution overview summarizes current workload
The system SHALL provide the authenticated user with counts for active plans, open tasks, tasks due today, and overdue tasks.

#### Scenario: Load overview
- **WHEN** a user opens the plan workspace
- **THEN** the overview returns counts calculated from all of that user's non-completed plans

#### Scenario: Empty overview
- **WHEN** the user has no active plans or open tasks
- **THEN** the overview returns zero counts and empty focus lists

### Requirement: Focus tasks are classified once
The system MUST classify each unfinished task into at most one of overdue, today, or upcoming using its scheduled date and plan day.

#### Scenario: Overdue scheduled task
- **WHEN** an unfinished task has a scheduled date before today
- **THEN** it appears in overdue and not in today or upcoming

#### Scenario: Today task
- **WHEN** an unfinished task is scheduled today or has no explicit scheduled date and belongs to the plan's current day
- **THEN** it appears in today unless it is overdue

#### Scenario: Upcoming task
- **WHEN** an unfinished task is neither overdue nor due today
- **THEN** it appears in upcoming

### Requirement: Overview supports direct execution
Each focus task SHALL include enough plan and task identity, schedule, day, and priority data for the client to display context and navigate to its owning plan.

#### Scenario: Open focus task
- **WHEN** the user selects a focus task in the overview
- **THEN** the client opens the owning plan detail where that task can be edited or completed

