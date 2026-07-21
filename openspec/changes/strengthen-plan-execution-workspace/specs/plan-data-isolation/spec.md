## ADDED Requirements

### Requirement: Plan reads are user scoped
The system MUST return only plans owned by the authenticated user from plan lists, detail views, statistics, and execution overviews.

#### Scenario: List own plans
- **WHEN** an authenticated user requests the plan list
- **THEN** every returned plan belongs to that user

#### Scenario: Read another user's plan
- **WHEN** an authenticated user requests a plan owned by another user
- **THEN** the system responds as if the plan does not exist

#### Scenario: Aggregate own execution data
- **WHEN** an authenticated user requests plan statistics or overview
- **THEN** counts and focus tasks are calculated only from that user's plans

### Requirement: Plan mutations are user scoped
The system MUST apply plan metadata, task toggle, task creation, task editing, task deletion, and plan deletion only to plans owned by the authenticated user.

#### Scenario: Mutate own plan
- **WHEN** a user updates a plan or task they own with valid input
- **THEN** the system persists the change and returns the updated owned plan

#### Scenario: Mutate another user's plan
- **WHEN** a user attempts any mutation against another user's plan
- **THEN** the system returns the same not-found response used for an absent plan and changes no data
