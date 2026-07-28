## ADDED Requirements

### Requirement: Processing count follows the sync range by default
The library UI SHALL default to synchronizing 50 items and processing 50 items, and SHALL derive a new default processing count as the lesser of the selected sync range and the 50-item batch limit whenever the sync range changes.

#### Scenario: User opens processing settings
- **WHEN** the user opens the library with fresh page state
- **THEN** the settings show a sync range of 50 and an automatic processing count of 50

#### Scenario: User selects a smaller custom range
- **WHEN** the user changes the sync range to a value below 50
- **THEN** the automatic processing count follows that value and remains manually adjustable

#### Scenario: User selects a 100-item sync range
- **WHEN** the user changes the sync range to 100
- **THEN** the automatic processing count defaults to 50 and the submitted extraction job contains no more than 50 items

#### Scenario: Default processing starts
- **WHEN** synchronization completes with 50 eligible unprocessed videos and automatic processing is enabled
- **THEN** all 50 videos are submitted in one concurrent batch job rather than a sequential client-side loop
