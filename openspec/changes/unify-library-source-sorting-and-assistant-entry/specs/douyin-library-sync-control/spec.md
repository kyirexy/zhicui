## ADDED Requirements

### Requirement: Consistent source-aware library sorting

The system SHALL let authenticated users sort both liked and collected Douyin works either by their source order or by publication time, SHALL remember each source's choice independently on the local device, and SHALL always order the user's own published works by publication time from newest to oldest.

#### Scenario: User sorts collected works by collection time

- **WHEN** the user selects the collection source and chooses `最近收藏`
- **THEN** the visible collection is ordered by its synchronized collection-source order

#### Scenario: User sorts liked works by like time

- **WHEN** the user selects the like source and chooses `最近喜欢`
- **THEN** the visible likes are ordered by their synchronized like-source order

#### Scenario: User chooses publication time

- **WHEN** the user chooses `发布时间` for either likes or collections
- **THEN** the selected source is ordered by publication time from newest to oldest

#### Scenario: User switches between likes and collections

- **WHEN** the user assigns different sorting choices to likes and collections and later switches between them
- **THEN** the interface restores the locally remembered choice for each source

#### Scenario: User opens own works

- **WHEN** the user selects `我的作品`
- **THEN** the interface shows a non-interactive publication-time state and the works are ordered by publication time from newest to oldest

#### Scenario: A source item has no synchronized rank

- **WHEN** source-order sorting is requested and an item has no source rank
- **THEN** the system uses publication time as a stable fallback without failing the request
