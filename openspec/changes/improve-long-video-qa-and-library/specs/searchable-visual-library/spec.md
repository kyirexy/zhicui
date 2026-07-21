## ADDED Requirements

### Requirement: User-scoped note search
The system SHALL allow an authenticated user to search only their own notes by a bounded keyword across note titles and structured summaries.

#### Scenario: Matching keyword
- **WHEN** the user submits a keyword that occurs in one of their note titles or summaries
- **THEN** the API returns matching user-owned notes and a total count based on the same filter

#### Scenario: Cross-user isolation
- **WHEN** another user's note matches the same keyword
- **THEN** that note is excluded from the results and total

### Requirement: Note type filtering
The system SHALL allow the user note list to be filtered by one supported card type and SHALL preserve normal unfiltered behavior when no type is provided.

#### Scenario: Filter insight notes
- **WHEN** `card_type=insight` is requested
- **THEN** every returned note belongs to the authenticated user and has the insight card type

#### Scenario: Combine search and type
- **WHEN** both keyword and card type filters are supplied
- **THEN** the API applies both filters before pagination

### Requirement: Searchable visual library interface
The client SHALL provide search, content-type filters, result count, loading state, filtered-empty state, and visually distinct note previews using the active card theme.

#### Scenario: Search from the library
- **WHEN** the user types a search phrase
- **THEN** the client performs a debounced server search, resets pagination, and updates the displayed result count

#### Scenario: Filtered empty result
- **WHEN** no notes match the active keyword or type
- **THEN** the client explains that no matching cards were found and offers a control to clear the filters

#### Scenario: Responsive visual cards
- **WHEN** results are viewed on desktop or mobile
- **THEN** each note shows a theme preview, type, title, excerpt, date, and clear detail action without horizontal overflow

#### Scenario: Open a legacy card
- **WHEN** a user opens a saved note whose section uses legacy `items` content or omits the current `content` field
- **THEN** the card detail normalizes the section and remains usable instead of crashing the whole page
