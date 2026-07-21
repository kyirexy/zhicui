## ADDED Requirements

### Requirement: User-scoped note questions
The system SHALL expose an authenticated note question endpoint and MUST only answer against a note owned by the current user.

#### Scenario: Ask about an owned note
- **WHEN** an authenticated user submits a valid question for a note they own
- **THEN** the system returns a successful answer generated from that note's title, card summary, and transcript

#### Scenario: Ask about another user's note
- **WHEN** an authenticated user submits a question for a note they do not own
- **THEN** the system returns not found without revealing whether that note exists

### Requirement: Grounded and bounded answers
The system SHALL instruct the language model to use the note as the factual source, SHALL state when the source does not contain the requested information, and MUST bound question length, history length, transcript context, and answer length.

#### Scenario: Source contains the answer
- **WHEN** the note content contains information relevant to the question
- **THEN** the answer directly addresses the question using only source-supported details

#### Scenario: Source lacks the answer
- **WHEN** the note content does not support the requested detail
- **THEN** the answer explicitly says the original content did not mention it and does not invent a detail

#### Scenario: Oversized question
- **WHEN** a question exceeds the configured input limit
- **THEN** the API rejects the request with a validation response before invoking the model

### Requirement: Contextual page-session conversation
The system SHALL allow the client to send a bounded set of recent user and assistant messages to support follow-up questions without persisting chat messages in the database.

#### Scenario: Follow-up question
- **WHEN** a user asks a follow-up after receiving an answer in the same page session
- **THEN** the client sends recent conversation turns and the response remains grounded in the same note

#### Scenario: Page refresh
- **WHEN** the user refreshes or leaves the result page
- **THEN** the temporary conversation can be discarded without modifying the saved note

### Requirement: Responsive question interface
The system SHALL render a reusable question panel after saved-note cards with suggested prompts, message history, sending state, inline error handling, retry, and clear-conversation actions.

#### Scenario: First view
- **WHEN** a saved card is displayed and no question has been asked
- **THEN** the panel shows concise source-grounded guidance and touch-friendly suggested questions

#### Scenario: Sending a question
- **WHEN** the user submits a non-empty question
- **THEN** the UI immediately shows the user message, prevents duplicate submission, announces progress, and appends the answer when complete

#### Scenario: Request failure
- **WHEN** the question request fails
- **THEN** the UI preserves the user's message and shows an inline retry action without using a blocking alert
