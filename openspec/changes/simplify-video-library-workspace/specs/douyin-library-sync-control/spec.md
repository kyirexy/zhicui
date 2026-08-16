## MODIFIED Requirements

### Requirement: Visible bounded synchronization controls

The system SHALL display the effective synchronization count with the primary synchronization action, SHALL provide presets for 50 and 100 items plus an authenticated custom integer from 1 through 100 inside a clearly named on-demand synchronization setting, and SHALL not require navigation away from the collection interface.

#### Scenario: User views the default synchronization action

- **WHEN** the collection interface is opened
- **THEN** the primary synchronization action and its effective item count are visible
- **AND** the 50-item, 100-item, and custom controls do not occupy the default task surface

#### Scenario: User selects an on-demand preset

- **WHEN** the user opens synchronization settings and chooses the 50-item or 100-item preset
- **THEN** the next synchronization request uses the selected bounded count

#### Scenario: User enters a custom range

- **WHEN** the user opens synchronization settings and enters an integer from 1 through 100
- **THEN** the next synchronization request uses that exact bounded count

#### Scenario: Backend rejects an invalid range

- **WHEN** a client submits a count below 1 or above 100
- **THEN** the backend rejects the request without starting a downloader job
