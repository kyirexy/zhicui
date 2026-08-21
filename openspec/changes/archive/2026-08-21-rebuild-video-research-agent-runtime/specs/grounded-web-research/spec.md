## MODIFIED Requirements

### Requirement: Explicit research scope
The system SHALL let an authenticated user explicitly choose web-assisted research or video-only answering for single-video and multi-video questions, and video-only answering SHALL be the default when the client omits the setting.

#### Scenario: User explicitly enables automatic web research
- **WHEN** the user selects automatic web research
- **THEN** the agent evaluates whether the supplied transcripts and AI summaries are sufficient before deciding whether to search the web
- **AND** any web-derived claim is kept structurally separate from video evidence

#### Scenario: Video-only scope is selected or omitted
- **WHEN** the user selects video-only answering or submits no web scope
- **THEN** the agent MUST NOT make an external web request
- **AND** the answer uses only the frozen video sources and states any resulting limitation

### Requirement: Research progress and citations UI
The Q&A workspace SHALL show the resolved research depth, active research scope, durable stage progress, distinct source coverage layers, external citations, retry behavior, and a composer that remains available at the bottom of the panel.

#### Scenario: Layered video research is running
- **WHEN** the agent is scanning, mapping, deep-reading, clustering, verifying, or repairing
- **THEN** the UI shows the current durable stage and its true counters without replacing the existing conversation
- **AND** metadata scanning is visually distinct from transcript mapping and deep reading

#### Scenario: Web research is explicitly enabled and running
- **WHEN** the user enabled web research and the agent is planning or searching
- **THEN** the UI shows concise state-specific web progress without implying that webpages are video evidence

#### Scenario: Research answer is complete
- **WHEN** a response includes validated video evidence or web sources
- **THEN** the UI groups evidence under its Claim and exposes readable video/source cards
- **AND** web cards retain title, domain, and external link separately from transcript evidence

#### Scenario: Mobile user asks a question
- **WHEN** the workspace is rendered on a mobile viewport
- **THEN** research controls remain touch-accessible, the answer remains readable, and the composer stays anchored below the scrollable conversation
