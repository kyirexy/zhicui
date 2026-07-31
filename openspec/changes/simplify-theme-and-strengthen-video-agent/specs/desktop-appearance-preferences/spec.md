## ADDED Requirements

### Requirement: Desktop appearance reuses the global theme
The desktop client SHALL use the same follow-system, light, and dark global theme preference as the web and Android clients instead of maintaining a competing sidebar color theme.

#### Scenario: Change theme in desktop settings
- **WHEN** a desktop user changes the global theme in settings
- **THEN** the sidebar, top bar, workspaces, dialogs, and Agent surface update together

#### Scenario: Existing sidebar preference is present
- **WHEN** an upgraded client finds a legacy desktop sidebar appearance preference
- **THEN** it preserves other settings, migrates a valid light or dark value to the global theme only when no global preference exists, and no longer presents the legacy preference as a separate theme editor

### Requirement: Layout density remains subordinate
The desktop client SHALL keep comfortable and compact density as a separate optional layout control without mixing it with color theme selection.

#### Scenario: Appearance settings are opened
- **WHEN** a desktop user views the appearance section
- **THEN** the three theme choices are primary and the two density choices appear as a smaller, clearly labeled layout preference
