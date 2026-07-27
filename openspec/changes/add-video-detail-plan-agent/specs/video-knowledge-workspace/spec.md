## ADDED Requirements

### Requirement: Video cards open a dedicated knowledge workspace
The system SHALL make the primary surface of every video library card navigate to a dedicated single-video workspace while preserving selection, deletion, and other card controls as independent actions.

#### Scenario: Open one video from the library
- **WHEN** an authenticated user activates the primary surface of a video card
- **THEN** the system opens a dedicated workspace for that video's stable Douyin work ID
- **AND** the card's selection and destructive controls do not navigate when activated

#### Scenario: Open an unavailable video
- **WHEN** the requested work ID is absent from the downloader manifest
- **THEN** the workspace shows a recoverable not-found state with a route back to the video library

### Requirement: Workspace presents a large responsive two-pane experience
The system SHALL use most of the available viewport for the detail workspace, with a prominent video area and an adjacent knowledge area on desktop, and SHALL preserve all capabilities in a touch-friendly stacked layout on mobile.

#### Scenario: Desktop workspace
- **WHEN** the viewport has room for a two-column layout
- **THEN** the video occupies the main left pane
- **AND** AI Q&A, full transcript, and action plan are available as tabs in the right pane

#### Scenario: Mobile workspace
- **WHEN** the viewport is narrow
- **THEN** the video appears above the tabbed knowledge area
- **AND** the Q&A, transcript, and plan controls remain usable without horizontal page scrolling

### Requirement: Workspace data is composed without storing video files
The system SHALL resolve playable media and cover URLs from the downloader at request time and SHALL only persist user-owned text, source metadata, AI results, and structured plans in the main application database.

#### Scenario: Load workspace data
- **WHEN** the user opens a video workspace
- **THEN** the detail response combines the live downloader item with the current user's extracted note and linked plan
- **AND** the response indicates that media is externally served

#### Scenario: Preserve the media storage boundary
- **WHEN** workspace, extraction, Q&A, or plan Agent operations complete
- **THEN** no video bytes are written to any main-database column
- **AND** no media BLOB, BYTEA, or LargeBinary field is introduced

### Requirement: Unprocessed videos can be prepared in place
The workspace SHALL allow a user to start the existing automated transcript and knowledge-card extraction for a video that has not yet been processed, then continue in the same workspace after success.

#### Scenario: Prepare an unprocessed video
- **WHEN** the workspace has a playable downloader item but no current-user note
- **THEN** the knowledge pane explains that Q&A, transcript, and plan creation require preparation
- **AND** provides one clear action to generate the transcript and knowledge card

#### Scenario: Preparation completes
- **WHEN** extraction succeeds
- **THEN** the workspace refreshes to expose the transcript, single-video Q&A, and plan Agent without returning to the library

### Requirement: Q&A is grounded in the complete video knowledge source
The workspace SHALL provide single-video conversational Q&A based on the video's complete extracted transcript together with the generated AI summary, and SHALL surface evidence and source-coverage information returned by the existing grounded Q&A service.

#### Scenario: Ask about one video
- **WHEN** the user submits a question in the AI Q&A tab
- **THEN** the system answers using only that user's selected video note
- **AND** displays evidence, follow-up prompts, and available transcript-coverage information

#### Scenario: Read the full transcript
- **WHEN** the user opens the transcript tab
- **THEN** the system displays the complete stored transcript with search and copy affordances

### Requirement: Plan Agent creates and revises an executable linked plan
The system SHALL allow an authenticated user to instruct an Agent in natural language to create or revise the structured plan linked to the current video note. The Agent SHALL consider the transcript, AI summary, current date, user instruction, and any existing linked plan.

#### Scenario: Create a plan from a video
- **WHEN** no linked plan exists and the user gives a plan instruction
- **THEN** the Agent generates a flexible-field plan with only source-grounded or user-requested fields, stages, and tasks
- **AND** persists it for the current user with the current note as its source

#### Scenario: Revise an existing plan
- **WHEN** a linked plan exists and the user requests a change
- **THEN** the Agent returns and persists the complete revised plan
- **AND** returns a concise summary of the applied changes

#### Scenario: Preserve execution progress
- **WHEN** the Agent revises a plan containing completed tasks
- **THEN** the system preserves completion state for semantically unchanged tasks whenever they can be matched safely
- **AND** does not silently mark newly introduced tasks complete

#### Scenario: Continue in the plan workbench
- **WHEN** a linked plan exists
- **THEN** the workspace provides direct navigation to that plan in the plan workbench

### Requirement: User ownership protects workspace knowledge and mutations
The system SHALL enforce the current user's ownership for extracted notes, Q&A context, linked plans, and all Agent mutations.

#### Scenario: Cross-user note or plan access
- **WHEN** a user requests or mutates a note or plan owned by another user
- **THEN** the system returns the same not-found behavior used for a missing resource
- **AND** reveals no cross-user resource details
