## ADDED Requirements

### Requirement: Categorized desktop settings workspace

The desktop application SHALL present settings as a dedicated workspace with a settings navigation rail and a separately scrollable active-section content area, while preserving all existing settings capabilities.

#### Scenario: User opens settings from the desktop application

- **WHEN** an authenticated desktop user opens `/settings`
- **THEN** the product navigation sidebar is replaced by a settings rail with a visible `返回应用` action and the active settings section

#### Scenario: User selects a settings category

- **WHEN** the user selects a category in the settings rail
- **THEN** only that category's heading, description, and existing settings controls are shown in the content area

#### Scenario: User refreshes a category URL

- **WHEN** the current category is represented by a valid `section` query parameter and the page reloads
- **THEN** the same category remains selected

#### Scenario: User opens an invalid category URL

- **WHEN** the `section` query parameter does not identify a known category
- **THEN** the workspace safely falls back to the general category

### Requirement: Searchable settings categories

The settings workspace SHALL let users filter settings categories by their names, descriptions, and relevant keywords without modifying any setting.

#### Scenario: Search finds categories

- **WHEN** the user enters text matching one or more category keywords
- **THEN** the settings rail shows the matching categories and preserves a clear active state

#### Scenario: Search finds no category

- **WHEN** the query matches no category
- **THEN** the rail displays an inline empty result and allows the query to be cleared

### Requirement: Account-anchored desktop menu

The desktop application SHALL open an account menu when the user activates the sidebar account area and SHALL expose only routes and actions available to that user.

#### Scenario: User opens the account menu

- **WHEN** the user clicks the sidebar avatar or account identity
- **THEN** a menu anchored above the account area displays the current identity, settings, AI routing, and sign-out actions

#### Scenario: Administrator opens the account menu

- **WHEN** the current user is an administrator
- **THEN** the account menu additionally displays the management entry

#### Scenario: User dismisses the account menu

- **WHEN** the user clicks outside the menu, presses Escape, or navigates through a menu item
- **THEN** the account menu closes and keyboard focus remains usable

#### Scenario: User signs out from the account menu

- **WHEN** the user activates `退出登录`
- **THEN** the existing logout flow runs and the account menu closes

### Requirement: Responsive settings navigation

The settings workspace SHALL remain operable on narrow web and mobile viewports without hiding settings content or creating nested horizontal page scrolling.

#### Scenario: User opens settings on a narrow viewport

- **WHEN** the viewport cannot accommodate the desktop two-column layout
- **THEN** category navigation becomes a compact top region and the active settings content remains vertically scrollable
