## ADDED Requirements

### Requirement: Global theme selection remains intentionally simple
The system SHALL provide exactly three global appearance choices: follow system, light, and dark, without exposing a per-color theme editor.

#### Scenario: First use defaults to light
- **WHEN** a user opens the product on a device with no saved global theme preference
- **THEN** the application renders the light theme before interactive hydration and persists light as the effective default

#### Scenario: User chooses a theme
- **WHEN** a user selects follow system, light, or dark in the appearance settings
- **THEN** the choice applies immediately across the current client and remains selected after a restart

#### Scenario: System theme changes
- **WHEN** the saved preference is follow system and the operating-system color scheme changes
- **THEN** the application updates the effective light or dark theme without requiring a reload

### Requirement: Light theme uses restrained brand color
The light theme SHALL use white and neutral surfaces for the majority of the interface and reserve a single light mint accent for selected, active, and success states.

#### Scenario: Render a primary workspace
- **WHEN** the user opens a knowledge, plan, or Agent workspace in light mode
- **THEN** the dominant surfaces remain white or neutral and mint does not become a large decorative background

### Requirement: Theme control remains accessible
The theme selector MUST expose its current value, remain keyboard-operable, and provide touch targets of at least 44 CSS pixels on touch clients.

#### Scenario: Select a theme without a pointer
- **WHEN** a keyboard or assistive-technology user reaches the theme control
- **THEN** all three choices have readable names, visible focus, and can be selected without pointer-only interaction
