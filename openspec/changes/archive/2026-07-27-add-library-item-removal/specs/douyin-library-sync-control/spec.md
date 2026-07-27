## ADDED Requirements

### Requirement: User-scoped persistent library removal

The system SHALL allow an authenticated user to remove a Douyin video from their Zhicui library and SHALL keep that video hidden for that user after subsequent synchronization.

#### Scenario: User removes one video

- **WHEN** the user confirms removal of a visible library video
- **THEN** the video disappears from that user's library

#### Scenario: Removed video is synchronized again

- **WHEN** a later Douyin synchronization contains a work ID previously removed by the current user
- **THEN** the system keeps that video hidden for that user

#### Scenario: Another user views the library

- **WHEN** a different authenticated user has not removed the same work ID
- **THEN** that user's library visibility is not changed by the first user's removal

### Requirement: Bounded batch library removal

The system SHALL allow an authenticated user to remove between 1 and 50 selected library videos in one confirmed operation.

#### Scenario: User confirms batch removal

- **WHEN** the user selects multiple visible videos and confirms batch removal
- **THEN** all accepted work IDs disappear from the user's current library view and selection

#### Scenario: Batch request exceeds the limit

- **WHEN** a client submits more than 50 work IDs
- **THEN** the backend rejects the request without changing hidden-item records

#### Scenario: Removal is repeated

- **WHEN** the same work ID is submitted more than once or removed again later
- **THEN** the operation succeeds idempotently without duplicate hidden-item records

### Requirement: Non-destructive removal semantics

The system MUST NOT unfavorite content on Douyin or delete synchronized metadata, generated transcripts, knowledge cards, plans, or video files when removing an item from the Zhicui library.

#### Scenario: User reviews the confirmation

- **WHEN** a user initiates single or batch removal
- **THEN** the confirmation explains that only the Zhicui library view changes

#### Scenario: Removal completes

- **WHEN** a removal operation succeeds
- **THEN** existing generated Notes and plans remain available outside the library view
