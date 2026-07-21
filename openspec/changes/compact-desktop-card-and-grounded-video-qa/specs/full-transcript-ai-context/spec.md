## ADDED Requirements

### Requirement: Question answering combines transcript and AI understanding
The system SHALL answer note questions using both the saved video transcript and a bounded semantic representation of the AI-generated card when those sources are available.

#### Scenario: Structured AI card exists
- **WHEN** a note has AI-generated sections, conclusion, insight, quote, statistics, or risk judgment
- **THEN** the question context contains a readable bounded representation of those fields instead of an arbitrary raw JSON prefix

#### Scenario: AI summary cannot be parsed
- **WHEN** a stored AI summary is not valid structured JSON
- **THEN** the system uses a bounded plain-text fallback without failing the question request

### Requirement: Complete transcript is covered transparently
The system SHALL inspect the complete saved transcript for every question and SHALL report whether the model received the full transcript directly or a bounded set of relevant excerpts selected after a complete local scan.

#### Scenario: Short transcript
- **WHEN** the transcript is within the direct context limit
- **THEN** `source_context` reports full mode with the complete transcript length

#### Scenario: Long transcript
- **WHEN** the transcript exceeds the direct context limit
- **THEN** the system scores every transcript chunk, sends only a bounded ordered selection, and reports retrieved mode with scanned and selected chunk counts

#### Scenario: No transcript
- **WHEN** a note has no saved transcript but has an AI summary
- **THEN** `source_context` reports no transcript and identifies that AI summary context was used

### Requirement: Source context is backward-compatible
The note question endpoint SHALL add an optional structured `source_context` result without changing the existing answer, grounded, evidence, or follow-up fields.

#### Scenario: Receive source context
- **WHEN** a current client receives a successful structured answer
- **THEN** it can read transcript characters, transcript mode, scanned chunks, selected chunks, and AI summary usage from `source_context`

#### Scenario: Invalid model response
- **WHEN** the model response cannot be parsed as structured JSON
- **THEN** the endpoint still returns source context alongside the plain fallback answer

### Requirement: Client communicates source coverage
The question interface SHALL explain that answers search the complete video transcript and combine AI card understanding, and SHALL show per-answer coverage details when provided.

#### Scenario: Retrieved long transcript answer
- **WHEN** an answer reports retrieved mode
- **THEN** the client states that the complete transcript was scanned and relevant original excerpts were selected

#### Scenario: Full short transcript answer
- **WHEN** an answer reports full mode
- **THEN** the client states that the complete transcript was read directly

#### Scenario: Restore conversation
- **WHEN** a conversation with source context is restored in the same browser tab
- **THEN** the restored answer retains its source coverage display

### Requirement: Evidence remains verifiable
The system MUST keep only evidence quotes found verbatim in the transcript context supplied to the model or the structured AI understanding context.

#### Scenario: Unsupported evidence
- **WHEN** the model returns a quote absent from both supplied contexts
- **THEN** the quote is removed and cannot cause the answer to be marked grounded
