## ADDED Requirements

### Requirement: Compact library first screen
The system SHALL omit the large promotional heading and description from the batch video library and SHALL prioritize the mode switch, connection state, source controls and video list.

#### Scenario: Desktop library opens
- **WHEN** a desktop user opens the batch video library
- **THEN** the source controls and first row of videos appear higher on the initial viewport than in the promotional-header layout

#### Scenario: Mobile library opens
- **WHEN** a mobile user opens the batch video library
- **THEN** no large repeated marketing copy pushes the source controls or videos below the first screen

### Requirement: Responsive compact controls
The system SHALL keep the content mode switch, login status and session actions readable and reachable at desktop and mobile widths.

#### Scenario: Wide viewport
- **WHEN** the viewport has sufficient width
- **THEN** mode switching and connection/session controls use a compact horizontal arrangement

#### Scenario: Narrow viewport
- **WHEN** the controls cannot fit horizontally
- **THEN** they wrap or stack without overlapping, clipping or reducing touch targets below 44 CSS pixels

### Requirement: Mobile-focused login panel
The system SHALL present the QR image, progress, same-device instructions and login actions in a viewport-safe panel.

#### Scenario: Mobile panel is open
- **WHEN** a user opens QR login on a narrow viewport
- **THEN** the panel fits within dynamic viewport and safe-area bounds while keeping its close and action buttons reachable
