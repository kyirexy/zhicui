## ADDED Requirements

### Requirement: AI plan coaching previews before mutation
The system SHALL generate a validated plan-adjustment preview without persisting changes and SHALL show additions, modifications, and removals before confirmation.

#### Scenario: Preview note-linked plan adjustment
- **WHEN** the owner asks the coach to adjust a plan linked to a note
- **THEN** the preview uses current plan state and available note context and returns a base version plus proposed operations

#### Scenario: Preview manual plan adjustment
- **WHEN** the owner asks the coach to adjust a manual plan
- **THEN** the preview uses the current plan and tasks without requiring note context

### Requirement: AI plan coaching applies safely
The system MUST apply a coaching proposal only to the same unmodified owned plan and MUST preserve completed-task history.

#### Scenario: Apply current proposal
- **WHEN** the owner confirms a valid proposal whose base timestamp matches the current plan
- **THEN** allowed changes are applied atomically and the updated plan is returned

#### Scenario: Reject stale proposal
- **WHEN** the plan changed after the preview was generated
- **THEN** the system returns conflict status and changes no data

#### Scenario: Preserve completed task
- **WHEN** a proposal attempts to modify or remove a completed task
- **THEN** the service retains that task's identity, content, completion state, and completion timestamp

