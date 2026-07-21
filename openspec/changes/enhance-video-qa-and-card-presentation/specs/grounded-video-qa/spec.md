## ADDED Requirements

### Requirement: Structured grounded answer
The system SHALL answer a user-owned note question using only the note title, structured summary, transcript, and bounded recent conversation, and SHALL return a structured result containing an answer, grounded status, evidence list, and follow-up questions.

#### Scenario: Answer with verified evidence
- **WHEN** the model returns evidence text that exists in the supplied note transcript or summary
- **THEN** the API returns the answer with at most three verified evidence items and marks the result as grounded

#### Scenario: Unsupported question
- **WHEN** the supplied note does not contain enough information to answer the question
- **THEN** the answer states that the original content does not mention the requested fact and the API does not present unverified evidence as grounded

#### Scenario: Invalid model structure
- **WHEN** the model response cannot be parsed as the requested JSON structure
- **THEN** the API returns the available response as a plain answer with an empty evidence list and `grounded=false`

### Requirement: Evidence provenance validation
The system MUST validate every returned evidence quote against the exact source material supplied to the model and MUST label each retained item as transcript or summary evidence.

#### Scenario: Hallucinated quote
- **WHEN** an evidence quote is not found in either supplied source
- **THEN** the system removes that quote before returning the response to the client

#### Scenario: Duplicate evidence
- **WHEN** the model returns the same evidence quote more than once
- **THEN** the system returns it only once

### Requirement: Continuous note conversation
The client SHALL provide bounded recent conversation turns to the note question endpoint and SHALL preserve the current note conversation for the active browser-tab session.

#### Scenario: Follow-up with pronoun reference
- **WHEN** a user asks a follow-up question referring to a previous answer
- **THEN** the client sends the recent conversation so the service can resolve the reference against the same note

#### Scenario: Refresh current note
- **WHEN** the user refreshes a note detail page in the same browser tab
- **THEN** the client restores the recent local conversation for that note

#### Scenario: Clear conversation
- **WHEN** the user activates the clear action
- **THEN** the visible conversation and its session storage entry are removed

### Requirement: Contextual follow-up suggestions
The system SHALL return up to three concise follow-up questions that remain answerable or useful within the same note context.

#### Scenario: Continue from an answer
- **WHEN** a structured answer includes follow-up questions
- **THEN** the client displays them as actions that can submit the selected question
