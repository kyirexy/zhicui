## MODIFIED Requirements

### Requirement: Plan reads are user scoped
The system MUST return only plans owned by the authenticated user from plan lists, detail views, statistics, execution overviews, weekly reviews, and AI coaching previews.

#### Scenario: List own plans
- **WHEN** an authenticated user requests any plan collection, overview, or review
- **THEN** every plan, task, count, and summary is derived only from that user

#### Scenario: Read another user's plan
- **WHEN** an authenticated user requests a plan or coaching preview owned by another user
- **THEN** the system responds as if the plan does not exist

### Requirement: Plan mutations are user scoped
The system MUST apply manual creation ownership, metadata, focus, reorder, coaching apply, task mutations, and deletion only within the authenticated user's plans.

#### Scenario: Mutate own plan
- **WHEN** a user creates or updates valid plan data within owned plans
- **THEN** the system persists the change under that user and returns only owned data

#### Scenario: Mutate another user's plan
- **WHEN** a user attempts focus, reorder, coaching, task, metadata, or delete mutation against another user's plan
- **THEN** the system returns the same not-found or validation response used for absent owned data and changes no plan
