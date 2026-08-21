## ADDED Requirements

### Requirement: Persistent quick synchronization parameters
The system SHALL persist a confirmed non-empty Douyin source selection and an integer synchronization count from 1 through 100 on the current device for later quick synchronization.

#### Scenario: User confirms synchronization in the dialog
- **WHEN** an authenticated user starts synchronization with valid selected sources and a bounded count
- **THEN** the system stores those parameters as the confirmed quick-sync preference before starting the request

#### Scenario: Stored values are invalid
- **WHEN** persisted source or count values cannot be parsed or fall outside the supported range
- **THEN** the interface uses safe bounded defaults and requires confirmation instead of starting an invalid request
