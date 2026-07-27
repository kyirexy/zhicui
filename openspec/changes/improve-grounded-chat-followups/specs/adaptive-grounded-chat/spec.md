## ADDED Requirements

### Requirement: Adaptive grounded and creative answer modes

The single-note assistant SHALL classify each current user request as either grounded fact answering or creative assistance. Grounded requests SHALL be answered only from the supplied transcript and structured summary. Explicit requests for examples, prompts, rewrites, drafts, simulations, or brainstorming SHALL produce a useful creative answer instead of refusing solely because the exact output is absent from the source.

#### Scenario: Missing factual detail remains unavailable

- **WHEN** the user asks for a factual detail that is not present in the supplied transcript or structured summary
- **THEN** the assistant states that the original content does not provide that detail
- **AND** it does not invent the missing fact

#### Scenario: User requests an example prompt

- **WHEN** the source mentions using a prompt but does not contain the prompt text
- **AND** the user asks for an example or says to generate any usable example
- **THEN** the assistant directly returns a usable prompt based on the source goal
- **AND** the response is marked as AI-generated rather than quoted source content

#### Scenario: Latest correction controls the response

- **WHEN** a user corrects a previous misunderstanding with an explicit creative instruction such as “随便给一个”
- **THEN** the assistant follows the latest instruction
- **AND** it does not repeat the previous source-insufficiency refusal

### Requirement: Verifiable source boundary

The service SHALL preserve verbatim evidence validation for all answers and SHALL expose the server-selected answer mode to the client.

#### Scenario: Creative output is not treated as evidence

- **WHEN** the assistant generates a new example, prompt, rewrite, or draft
- **THEN** the generated text is not included as an evidence quote
- **AND** any returned evidence quote must still match the supplied transcript or structured summary verbatim

#### Scenario: Client receives answer mode

- **WHEN** a single-note answer is returned
- **THEN** the result includes `answer_mode` with either `grounded` or `creative`
- **AND** the existing `grounded` boolean continues to represent validated evidence availability

### Requirement: Persistent bottom composer

The single-note chat interface SHALL keep the question composer at the bottom of the right-side Q&A panel while messages and evidence scroll independently.

#### Scenario: Long desktop conversation

- **WHEN** the desktop Q&A panel contains enough messages or evidence to overflow
- **THEN** only the conversation content region scrolls
- **AND** the question textarea remains visible at the bottom of the panel

#### Scenario: Mobile Q&A tab

- **WHEN** the Q&A interface is shown on a mobile device
- **THEN** the composer remains the final fixed region of the chat panel
- **AND** its bottom padding respects the device safe area

### Requirement: Clear creative-response labeling

The client SHALL visually distinguish creative assistance from source-grounded factual answering.

#### Scenario: Creative answer state

- **WHEN** a response has `answer_mode` equal to `creative`
- **THEN** the answer displays an AI-generated example label
- **AND** it does not display the source-insufficiency warning merely because the generated portion has no verbatim evidence
