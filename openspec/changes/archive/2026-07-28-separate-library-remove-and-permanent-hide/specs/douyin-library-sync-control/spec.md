## MODIFIED Requirements

### Requirement: User-scoped persistent library removal

The system SHALL treat the default library removal as user-scoped temporary removal, SHALL hide the work immediately for that user, and SHALL restore it after the next successful synchronization that completes after the removal; the system SHALL keep a work hidden across synchronization only when the user explicitly chooses permanent hiding.

#### Scenario: User removes one video

- **WHEN** the user confirms the default removal of a visible library video
- **THEN** the video disappears from that user's current library and is marked as temporarily removed

#### Scenario: A later synchronization succeeds

- **WHEN** a synchronization started for the current user completes successfully after the temporary removal
- **THEN** the system clears the eligible temporary removal and allows the video to appear again

#### Scenario: A synchronization fails

- **WHEN** a synchronization fails after a temporary removal
- **THEN** the video remains temporarily removed

#### Scenario: User permanently hides a video

- **WHEN** the user explicitly confirms permanent hiding
- **THEN** the system keeps the video hidden for that user after subsequent synchronization

#### Scenario: Another user views the library

- **WHEN** a different authenticated user has not removed or permanently hidden the same work ID
- **THEN** that user's library visibility is not changed by the first user's action

### Requirement: Bounded batch library removal

The system SHALL allow an authenticated user to temporarily remove or permanently hide between 1 and 50 selected library videos in one confirmed operation.

#### Scenario: User confirms batch removal

- **WHEN** the user selects multiple visible videos and confirms temporary removal
- **THEN** all accepted work IDs disappear from the user's current library view and selection until a later successful synchronization

#### Scenario: User confirms batch permanent hiding

- **WHEN** the user selects multiple visible videos and explicitly confirms permanent hiding
- **THEN** all accepted work IDs remain hidden for that user across subsequent synchronization

#### Scenario: Batch request exceeds the limit

- **WHEN** a client submits more than 50 work IDs
- **THEN** the backend rejects the request without changing hidden-item records

#### Scenario: Removal is repeated

- **WHEN** the same work ID is submitted more than once or hidden again later
- **THEN** the operation succeeds idempotently without duplicate hidden-item records or downgrading a permanent record to temporary

### Requirement: Non-destructive removal semantics

The system MUST NOT unfavorite content on Douyin or delete synchronized metadata, generated transcripts, knowledge cards, plans, or video files when temporarily removing, permanently hiding, or restoring an item in the Zhicui library.

#### Scenario: User reviews temporary removal confirmation

- **WHEN** a user initiates single or batch temporary removal
- **THEN** the confirmation explains that only the current Zhicui library view changes and the item can return after synchronization

#### Scenario: User reviews permanent hiding confirmation

- **WHEN** a user initiates single or batch permanent hiding
- **THEN** the confirmation explains that future synchronization will not show the item until the user restores it

#### Scenario: A visibility operation completes

- **WHEN** a removal, permanent-hide, or restore operation succeeds
- **THEN** existing generated Notes and plans remain available outside the library view

## ADDED Requirements

### Requirement: Accurate hidden-item synchronization feedback

The collection interface SHALL distinguish source items from visible items and SHALL report when synchronized works are absent because the current user has hidden them.

#### Scenario: Every synchronized work is permanently hidden

- **WHEN** synchronization succeeds with one or more source items and no visible items because all of them are permanently hidden
- **THEN** the interface reports the synchronized source count and offers access to the permanent-hidden manager instead of saying that zero works were collected

#### Scenario: Some synchronized works are hidden

- **WHEN** synchronization succeeds and only some source items are hidden
- **THEN** the interface displays the visible works and exposes the relevant hidden count
