## ADDED Requirements

### Requirement: Explicit permanent-hide confirmation

The system SHALL expose permanent hiding as a distinct destructive action and MUST require a confirmation that describes its persistent effect before changing records.

#### Scenario: User opens permanent-hide confirmation

- **WHEN** a user chooses permanent hiding for one or more works
- **THEN** the confirmation identifies the number of affected works and states that future synchronization will keep them hidden until restored

#### Scenario: User cancels permanent hiding

- **WHEN** the user cancels the confirmation
- **THEN** no hidden-item record is created or changed

#### Scenario: User confirms permanent hiding

- **WHEN** the user confirms the destructive action
- **THEN** the accepted works are marked permanent and the interface shows a permanent-hidden status message

### Requirement: Visible permanent-hidden management

The library SHALL expose a separately labeled permanent-hidden count and management view for the current user.

#### Scenario: Permanent-hidden records exist

- **WHEN** the current user has one or more permanently hidden works
- **THEN** the library displays an `已永久隐藏` entry with the count

#### Scenario: User opens the manager

- **WHEN** the user opens the permanent-hidden entry
- **THEN** the interface lists the user's permanent records with a visible permanent status indicator and restoration actions

#### Scenario: No permanent-hidden records exist

- **WHEN** the current user has no permanently hidden works
- **THEN** the manager displays a clear empty state without suggesting that videos were deleted

### Requirement: Restore permanent-hidden works

The system SHALL let the current user restore one or up to 50 selected permanent-hidden works without requiring the external video catalog to be available.

#### Scenario: User restores one work

- **WHEN** the user restores one permanently hidden work
- **THEN** its permanent hidden record is removed and the work can appear in the library if it exists in the synchronized catalog

#### Scenario: User restores multiple works

- **WHEN** the user confirms restoration for between 1 and 50 selected permanent-hidden works
- **THEN** all matching permanent records are removed idempotently

#### Scenario: Catalog metadata is unavailable

- **WHEN** the external catalog cannot provide a title or cover for a permanent-hidden record
- **THEN** the manager still displays a safe identifier and permits restoration

### Requirement: Legacy hidden-record compatibility

The system SHALL treat hidden records created before hide modes were introduced as permanent records until the user restores them.

#### Scenario: Existing deployment is upgraded

- **WHEN** the database migration adds the hide-mode field to existing hidden records
- **THEN** those records remain hidden and appear in the permanent-hidden manager
