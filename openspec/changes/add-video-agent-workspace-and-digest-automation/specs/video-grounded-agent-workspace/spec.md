## ADDED Requirements

### Requirement: User can create a video-grounded Agent task
The system SHALL let an authenticated user create an Agent task from user-owned videos whose transcripts are ready.

#### Scenario: Create task from all ready transcripts
- **WHEN** a user selects “全部已有文案” and creates a task
- **THEN** the system stores a deduplicated snapshot of up to 100 most recent eligible Note IDs and returns the available count, selected count, and truncation state

#### Scenario: Reject another user's video
- **WHEN** a user submits a manually selected Note ID that is not owned by that user
- **THEN** the system rejects the request without revealing whether the Note exists

### Requirement: User can choose a meaningful source scope
The system SHALL expose scopes for all ready transcripts, yesterday's newly organized videos, Douyin collection, liked videos, the user's own posts, and manual selection.

#### Scenario: Filter by Douyin source mode
- **WHEN** a user chooses collection, liked videos, or own posts
- **THEN** only user-owned transcript-ready Notes with matching reliable source-ledger metadata are offered before the 100-video task limit is applied

#### Scenario: Use downloader source order before the limit
- **WHEN** a matching source contains more than 100 transcript-ready videos
- **THEN** the system orders ranked source-ledger memberships from newest to oldest before selecting the first 100, instead of ordering by knowledge-card creation time

#### Scenario: One video belongs to more than one source
- **WHEN** the same video appears in collection and liked-video syncs
- **THEN** the source ledger preserves both memberships without rewriting the Note's AI card JSON

#### Scenario: Legacy source lacks a mode
- **WHEN** an older Note has no reliable source mode
- **THEN** it remains available in the all-transcripts scope but is not falsely assigned to collection, liked videos, or own posts

#### Scenario: Yesterday scope is shown honestly
- **WHEN** a user chooses the yesterday scope
- **THEN** the UI describes the scope as videos newly organized into 知萃 yesterday rather than claiming an exact Douyin favorite time

### Requirement: Agent conversations are persistent and grounded
The system SHALL persist each user and assistant message and SHALL store the assistant's evidence, source context, web sources, and suggested follow-up questions.

#### Scenario: Continue an existing conversation
- **WHEN** a user reopens a previous Agent task and asks another question
- **THEN** the system uses the task's frozen video snapshot and recent conversation history while retaining the full stored message history

#### Scenario: Two questions target the same task concurrently
- **WHEN** a second question arrives while the first turn is still running
- **THEN** the system rejects the concurrent turn instead of interleaving users and answers

#### Scenario: View answer provenance
- **WHEN** an assistant answer is displayed
- **THEN** the user can see how many videos and transcript characters were considered and can inspect the returned transcript or web evidence

#### Scenario: Model wraps the response contract
- **WHEN** a provider returns the answer contract inside a Markdown fence, a doubly encoded string, or surrounding commentary
- **THEN** the system separates the visible answer, evidence, web sources, grounded state, and follow-up questions instead of exposing the internal JSON object

#### Scenario: Reopen a malformed legacy answer
- **WHEN** an existing assistant message contains recoverable answer and evidence fields inside malformed JSON
- **THEN** the client displays the recovered answer and evidence while leaving the stored historical record intact

#### Scenario: Research a 100-video snapshot with bounded model context
- **WHEN** a task snapshot contains 100 ready transcripts
- **THEN** retrieval scans all 100 server-side, reports the actually scanned IDs, and sends only globally selected excerpts from a bounded subset into synthesis

#### Scenario: User stops waiting for a synchronous answer
- **WHEN** a user stops the browser request while the backend turn is still running
- **THEN** the UI states that only waiting stopped, blocks a conflicting turn, polls the persisted task, and loads the final result when the backend finishes

#### Scenario: Change source scope after conversation starts
- **WHEN** a user applies a different source scope to an existing task
- **THEN** the system creates a new task with a new snapshot instead of silently changing the evidence behind previous answers

### Requirement: The Agent workspace is usable across supported clients
The system SHALL provide a dedicated Agent route with task history, a primary conversation area, source controls, and a composer that remains reachable.

#### Scenario: Desktop workspace
- **WHEN** the Agent route is opened in the Windows desktop client or a wide browser
- **THEN** task history and the conversation use the primary two-column area while the full source selector opens on demand without permanently reducing answer width

#### Scenario: Mobile workspace
- **WHEN** the Agent route is opened on a narrow browser or Android client
- **THEN** task history and source selection are available through compact panels while the composer remains above the safe area

#### Scenario: Render a structured answer
- **WHEN** an assistant message contains prose, lists, code, citations, processing stages, and follow-up questions
- **THEN** the workspace renders readable Markdown as the primary document and keeps evidence, web sources, and processing stages in separately labeled disclosure sections

### Requirement: Video files remain outside the knowledge database
The system SHALL persist only transcript text, source metadata, Agent messages, and generated results for this capability.

#### Scenario: Agent uses a video source
- **WHEN** a video is included in an Agent task
- **THEN** the system reads its existing transcript and metadata without copying the video file into the database or server storage
