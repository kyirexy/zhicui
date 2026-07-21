## ADDED Requirements

### Requirement: Unified card workspace
The client SHALL present the card body, appearance controls, source actions, and note conversation as one responsive content workspace while keeping non-card controls outside the export target.

#### Scenario: Desktop note detail
- **WHEN** a note detail is viewed on a sufficiently wide desktop viewport
- **THEN** the card is the primary column and the note conversation is presented as a secondary companion column

#### Scenario: Mobile note detail
- **WHEN** a note detail is viewed on a mobile viewport
- **THEN** the card, actions, and conversation appear in a readable single-column order with touch targets of at least 44 pixels where practical

#### Scenario: Export card
- **WHEN** the user exports the rendered card
- **THEN** the exported image contains only the selected card design and excludes the appearance controls and conversation

### Requirement: In-context appearance controls
The client SHALL allow a user to switch the current note's card style and information density directly from the note workspace without overwriting the global default unless the selected value is the default.

#### Scenario: Temporary card style
- **WHEN** the user selects a non-default style in a note workspace
- **THEN** the current card updates immediately and the global style preference remains unchanged

#### Scenario: Mobile appearance sheet
- **WHEN** a mobile user opens the current appearance control
- **THEN** the grouped style and density choices are available in the existing bottom sheet

### Requirement: Grouped style gallery
The style picker SHALL organize all available card themes into understandable usage groups and SHALL identify recommended themes for the current card content type.

#### Scenario: Filter style group
- **WHEN** the user selects a style usage group
- **THEN** the picker shows only the themes assigned to that group and retains the current active state

#### Scenario: Content recommendation
- **WHEN** the picker is opened from a note card with a known card type
- **THEN** appropriate themes are marked as recommended without automatically changing the user's selection

#### Scenario: Full gallery access
- **WHEN** the user selects the all-themes filter
- **THEN** all nine existing themes are available with distinct preview treatments
