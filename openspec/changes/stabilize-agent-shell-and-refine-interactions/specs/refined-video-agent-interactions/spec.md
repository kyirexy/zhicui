## ADDED Requirements

### Requirement: Failed questions remain recoverable
The Agent UI SHALL keep a failed user question visible and MUST offer an inline retry or edit action without losing the original text.

#### Scenario: Agent request fails
- **WHEN** a user sends a question and the API request fails
- **THEN** that question is marked as failed next to the message and can be restored to the composer or retried

### Requirement: Structured responses never leak raw envelopes
The Agent message renderer SHALL recognize supported structured response envelopes and MUST render their answer, evidence, sources, and follow-up questions as UI instead of raw JSON.

#### Scenario: Historical message contains JSON text
- **WHEN** a persisted assistant message contains a supported JSON envelope or fenced JSON
- **THEN** the renderer extracts and displays the human-readable answer and structured supporting sections

#### Scenario: Text is not a supported envelope
- **WHEN** an assistant message is ordinary Markdown or invalid JSON
- **THEN** the renderer displays it as ordinary text without discarding content

### Requirement: Conversation context is unambiguous
The Agent UI SHALL distinguish the source scope locked to the current conversation from the draft scope for a new task, and SHALL expose one primary context control in the conversation view.

#### Scenario: Existing conversation is open
- **WHEN** the conversation has a persisted source scope
- **THEN** the header shows that locked scope and the composer does not repeat conflicting scope descriptions

#### Scenario: New task scope is edited
- **WHEN** the user opens the source selector before sending the first question
- **THEN** changes apply only to the new-task draft until the task is created

### Requirement: Evidence types are described accurately
The Agent UI SHALL distinguish video transcript evidence, AI card context, and external web verification, and MUST NOT label web-only results as video evidence.

#### Scenario: Answer uses video and web sources
- **WHEN** an answer includes both transcript evidence and external web sources
- **THEN** the UI shows separate counts and sections for original video evidence and external verification

#### Scenario: Answer has no direct video evidence
- **WHEN** an answer only includes external web sources
- **THEN** the UI does not claim that the original video text supports the answer

### Requirement: Composer remains useful during a run
The composer SHALL preserve editable draft text while an answer is running, while the send action SHALL remain unavailable until the current run finishes.

#### Scenario: User drafts the next question
- **WHEN** an Agent answer is still running
- **THEN** the user can type and retain a next question but cannot submit it prematurely

### Requirement: Mobile Agent controls remain complete
The mobile Agent UI SHALL preserve output settings, use touch targets of at least 44 CSS pixels, respect bottom safe areas, and keep hidden panels out of keyboard navigation.

#### Scenario: Mobile answer settings
- **WHEN** the viewport is narrow
- **THEN** the user can still access answer mode and output type through a compact settings control

#### Scenario: Mobile source or history drawer is closed
- **WHEN** a drawer is visually closed
- **THEN** its interactive descendants are not reachable by keyboard or assistive navigation
