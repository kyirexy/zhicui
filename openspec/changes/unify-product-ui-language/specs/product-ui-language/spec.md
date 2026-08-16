## ADDED Requirements

### Requirement: Shared semantic visual language
The frontend SHALL render application surfaces from one shared set of semantic color, typography, spacing, radius, control-height, motion, and focus tokens in light and dark themes.

#### Scenario: User moves between application routes
- **WHEN** a user navigates between entry, workspace, settings, and administration routes
- **THEN** canvas, surface, border, text, accent, control, and focus styling follow the same semantic token system

#### Scenario: A feature needs a distinctive status
- **WHEN** a page communicates selection, danger, warning, success, or error
- **THEN** it uses the shared semantic status treatment rather than a new near-duplicate brand color or decorative surface system

### Requirement: Recognizable page hierarchy
Each application route SHALL present one primary page title, no more than one optional line of essential context, and a clear primary content region.

#### Scenario: User opens a normal application page
- **WHEN** the page has loaded successfully
- **THEN** the user can identify the feature from the primary title without reading a paragraph, eyebrow, or duplicated section title

#### Scenario: Domain layout differs
- **WHEN** a library, assistant, knowledge, plan, settings, or admin page requires a specialized content layout
- **THEN** the specialized layout remains available inside the shared page hierarchy

### Requirement: Consistent product terminology
User-facing navigation, page titles, links, and actions SHALL use one canonical product vocabulary and SHALL NOT expose internal implementation terms when a plain-language term exists.

#### Scenario: Same destination appears on multiple form factors
- **WHEN** a destination is shown in the Web header, desktop sidebar, mobile tab bar, page title, or cross-feature link
- **THEN** its label and meaning remain consistent across those surfaces

#### Scenario: User initiates an operation
- **WHEN** a button performs a primary object operation
- **THEN** its label uses a concise verb-plus-object form such as adding a video, creating knowledge, or creating a plan

### Requirement: Clear action priority
Each view SHALL expose at most one visually dominant primary action, while secondary, quiet, overflow, and destructive actions use distinct shared treatments.

#### Scenario: Page has several available actions
- **WHEN** a header or state offers multiple operations
- **THEN** only the most likely next step uses the filled accent treatment and the remaining operations are secondary or grouped under more actions

#### Scenario: Action is destructive
- **WHEN** an action deletes, permanently hides, disables, or otherwise destroys data
- **THEN** it is visually identified as destructive and the confirmation names the affected object and consequence

### Requirement: Concise contextual copy
Normal application states SHALL avoid repeated instructional paragraphs and SHALL place help only where it supports an immediate task, decision, empty state, or recovery.

#### Scenario: Feature is already usable
- **WHEN** data and controls are present
- **THEN** duplicated slogans, workflow explanations, and section descriptions are omitted from the persistent page chrome

#### Scenario: Information affects cost, privacy, security, or irreversible consequences
- **WHEN** a user must understand such information before deciding
- **THEN** the interface preserves the information near the relevant control or in a progressive disclosure region

### Requirement: Action-oriented states
Loading, empty, no-result, error, unavailable, and success states SHALL use consistent language and structure appropriate to the real content layout.

#### Scenario: Collection is empty
- **WHEN** a user has not created or synchronized any items
- **THEN** the state shows a concise title, no more than one useful context line, and exactly one primary next action

#### Scenario: Search has no result
- **WHEN** filters or a query return no matches
- **THEN** the state identifies the empty result and offers a single action to clear or change the current query

#### Scenario: Request fails
- **WHEN** content cannot be loaded or an operation fails
- **THEN** the state exposes a short actionable reason and a retry or recovery action without replacing useful diagnostic detail where it is required

#### Scenario: Content is loading
- **WHEN** a page is waiting for content
- **THEN** it uses a stable skeleton shaped like the destination layout or one short progress label, avoiding repeated spinners and explanatory logs in the primary view

### Requirement: Responsive and accessible controls
Interactive controls SHALL remain identifiable and operable with keyboard, pointer, touch, zoom, and assistive technology across Web, desktop application, and mobile layouts.

#### Scenario: User operates a control on a touch device
- **WHEN** a primary navigation, button, icon button, tab, dialog close action, or form control is rendered for touch
- **THEN** its interactive target is at least 44 by 44 CSS pixels unless it is an inline text link

#### Scenario: User operates a control with keyboard
- **WHEN** focus moves through navigation, controls, dialogs, or menus
- **THEN** visible focus, semantic labels, expected keyboard behavior, initial dialog focus, and focus restoration remain available

#### Scenario: User zooms the page
- **WHEN** browser or operating-system zoom is increased
- **THEN** the product does not disable user scaling and essential actions remain reachable without content overlap

### Requirement: Stable cross-platform layout contracts
Application pages SHALL use an explicit natural-flow or full-height workspace contract so that outer shells and inner scrolling regions do not create gaps, clipped content, or duplicated safe-area space.

#### Scenario: Desktop workspace uses independent panes
- **WHEN** a workspace contains independently scrolling lists, readers, or conversations
- **THEN** the viewport-height chain is deterministic and each intended pane remains scrollable without exposing an unintended canvas gap

#### Scenario: Mobile page uses document flow
- **WHEN** the same feature renders on a mobile viewport
- **THEN** content returns to document flow, reserves the navigation safe area once, and keeps the final action reachable

### Requirement: Stable overlay behavior
Application dialogs, confirmations, drawers, and sheets SHALL preserve React DOM ownership and provide consistent dismissal and focus behavior.

#### Scenario: User repeatedly opens and closes an overlay
- **WHEN** the overlay is opened, dismissed by its allowed mechanisms, reopened, or crossed by a route or hot update
- **THEN** no React-owned DOM node is manually moved or removed and the overlay restores focus safely

#### Scenario: Overlay operation is pending
- **WHEN** a save or destructive request is still running
- **THEN** dismissal mechanisms that would create an ambiguous result are disabled and progress is communicated on the triggering action

### Requirement: Density exceptions remain purposeful
Marketing and administration surfaces SHALL share brand and control foundations while retaining the information density necessary for their distinct tasks.

#### Scenario: Visitor opens the marketing page
- **WHEN** product value needs explanation before sign-in or installation
- **THEN** the page may retain concise evidence and platform information but avoids repeated value propositions and duplicate calls to action

#### Scenario: Administrator reviews operational data
- **WHEN** cost, usage, errors, audit events, permissions, or system settings are needed for a decision
- **THEN** the interface preserves the required columns and details using compact tables, grouping, filters, and progressive disclosure rather than deleting them
