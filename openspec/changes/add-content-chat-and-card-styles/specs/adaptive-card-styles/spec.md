## ADDED Requirements

### Requirement: Nine selectable card styles
The system SHALL provide nine card display styles, retaining the existing six and adding aurora, blueprint, and paper layouts that all support the existing card data and density levels.

#### Scenario: Select a new style
- **WHEN** a user selects aurora, blueprint, or paper for a displayed note
- **THEN** the same note content renders in the selected layout without losing sections, conclusion, source attribution, or high-density transcript access

#### Scenario: Existing saved preference
- **WHEN** a returning user has one of the original six style keys in local storage
- **THEN** the application continues to render that style without migration or reset

### Requirement: Visual style previews
The system SHALL show a visually distinct preview, icon, label, and description for every style in the desktop toolbar, mobile picker, and standalone style page.

#### Scenario: Compare styles on desktop
- **WHEN** a desktop user opens the style controls
- **THEN** the user can compare all nine styles using visual previews rather than text-only chips

#### Scenario: Compare styles on mobile
- **WHEN** a mobile user opens the style bottom sheet
- **THEN** the picker presents touch-friendly preview tiles without clipping labels or requiring precision taps

### Requirement: Animated icon system
The system SHALL use a consistent Phosphor duotone icon set for style selection and SHALL animate icons only with transform and opacity based effects.

#### Scenario: Hover or select a style
- **WHEN** a pointer user hovers a style or any user selects it
- **THEN** the associated icon and preview provide restrained motion feedback and a clear selected state

#### Scenario: Reduced motion preference
- **WHEN** the operating system requests reduced motion
- **THEN** repeating, entrance, hover, and selection animations are disabled or reduced to immediate state changes

### Requirement: Cross-device accessible interaction
The system SHALL provide keyboard focus visibility, pressed-state semantics, readable contrast, and at least 44px primary touch targets for card style controls.

#### Scenario: Keyboard selection
- **WHEN** a keyboard user tabs to a style tile and activates it
- **THEN** the style changes and the tile exposes a visible focus and selected state

#### Scenario: Export after style change
- **WHEN** a user changes style and exports the card
- **THEN** the exported image contains the currently selected card layout and excludes the surrounding selector and chat interface
