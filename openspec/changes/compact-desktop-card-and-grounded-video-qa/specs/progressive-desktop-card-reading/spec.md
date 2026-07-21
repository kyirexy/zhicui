## ADDED Requirements

### Requirement: Desktop cards use progressive disclosure
The client SHALL constrain an overflowing card to a readable desktop viewport by default and SHALL provide accessible actions to expand the complete card and collapse it again.

#### Scenario: Long desktop card
- **WHEN** a rendered card exceeds the desktop reading viewport
- **THEN** the card is initially constrained with a continuation cue and an expand-complete-card action

#### Scenario: Expand and collapse
- **WHEN** the user expands or collapses an overflowing card
- **THEN** the complete content becomes visible or returns to the constrained view without losing the selected card style or density

#### Scenario: Short desktop card
- **WHEN** a card fits within the desktop reading viewport
- **THEN** the client does not show an unnecessary expand or collapse action

### Requirement: Mobile reading remains document-native
The client MUST NOT constrain card height below the desktop workspace breakpoint.

#### Scenario: Read on mobile
- **WHEN** the same long card is opened on a mobile or narrow viewport
- **THEN** the card renders in normal document flow without a clipped reading viewport

### Requirement: Progressive display preserves complete export
The card export SHALL contain the complete selected card even when its on-screen desktop viewport is collapsed.

#### Scenario: Export collapsed card
- **WHEN** the user exports a card while its desktop reading viewport is constrained
- **THEN** the generated image contains the full card body and excludes the expand controls

### Requirement: Wide results support the card and assistant
Saved or newly generated card results SHALL use enough desktop container width for the card and grounded assistant to form a readable two-column workspace.

#### Scenario: Desktop home result
- **WHEN** a generated saved card with an assistant is shown on a wide viewport
- **THEN** the parent result container does not force both columns into the previous narrow single-card width
