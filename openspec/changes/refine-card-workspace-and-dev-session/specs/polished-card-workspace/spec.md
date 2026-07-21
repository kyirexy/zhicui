## ADDED Requirements

### Requirement: Unified card control surface
The card detail SHALL present workspace identity, export/source actions, and appearance selection as one visually continuous control region without removing existing actions.

#### Scenario: Desktop controls
- **WHEN** a saved card is viewed on a desktop viewport
- **THEN** the control region clearly exposes the active theme, information density, export action, source action, and appearance selector with visible keyboard focus

#### Scenario: Mobile controls
- **WHEN** the same card is viewed on a narrow mobile viewport
- **THEN** controls wrap into reachable rows with at least 44px interactive targets and no page-level horizontal overflow

### Requirement: Editorial spotlight card hierarchy
The spotlight card SHALL organize the content type, title, lead quote, metrics, key insight, sections, takeaway, reliability indicator, and source attribution into a readable editorial hierarchy using one card-type accent.

#### Scenario: Complete card
- **WHEN** a card contains all adaptive profile fields
- **THEN** every field appears in the intended reading order with balanced headings, readable body text, tabular metrics, and a single semantic accent

#### Scenario: Sparse card
- **WHEN** optional quote, insight, transcript, or reliability content is absent
- **THEN** the remaining sections close up naturally without blank ornamental regions

### Requirement: Lightweight and accessible motion
The spotlight card MUST avoid layout-property animation and long-running entrance effects, SHALL keep interaction feedback at 200ms or less, and SHALL respect reduced-motion preferences.

#### Scenario: Normal interaction
- **WHEN** a pointer or keyboard user focuses or activates a card control
- **THEN** feedback uses only short transform or opacity transitions without delaying content readability

#### Scenario: Reduced motion
- **WHEN** the operating system requests reduced motion
- **THEN** optional card and workspace motion is effectively disabled

### Requirement: Responsive card and assistant workspace
The card workspace SHALL use a two-column card/assistant layout when space permits and a single-column reading order on smaller viewports.

#### Scenario: Wide viewport
- **WHEN** the viewport is at least the desktop workspace breakpoint
- **THEN** the card and grounded assistant appear side by side and the assistant may remain sticky

#### Scenario: Mobile viewport
- **WHEN** the viewport is below the desktop workspace breakpoint
- **THEN** the assistant follows the complete card, both share the available width, and the page has no horizontal overflow
