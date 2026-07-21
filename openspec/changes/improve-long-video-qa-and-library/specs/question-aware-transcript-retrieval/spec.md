## ADDED Requirements

### Requirement: Question-aware long transcript context
The system SHALL construct a bounded question-specific context from the complete transcript when a note transcript exceeds the direct context limit.

#### Scenario: Question targets middle content
- **WHEN** a relevant phrase appears only in the middle of a long transcript
- **THEN** the selected context includes the matching middle segment instead of always omitting it

#### Scenario: Broad summary question
- **WHEN** the question has no useful specific retrieval signal
- **THEN** the selected context samples multiple positions across the complete transcript within the context budget

#### Scenario: Short transcript
- **WHEN** the complete transcript is within the direct context limit
- **THEN** the system supplies the transcript without segment selection

### Requirement: Bounded deterministic retrieval
The system MUST perform transcript selection locally without an additional model or external search request and MUST keep the combined selected transcript within a fixed size budget.

#### Scenario: Very long transcript
- **WHEN** the transcript contains many more segments than the context budget permits
- **THEN** the system selects only the highest-ranked bounded set and preserves their original document order

### Requirement: Evidence document position
The system SHALL calculate an approximate document position for each verified transcript evidence quote and SHALL NOT represent that position as a video timestamp.

#### Scenario: Verified middle quote
- **WHEN** a verified quote starts near the middle of the complete transcript
- **THEN** the API evidence item includes a `position_percent` near 50

#### Scenario: Summary evidence
- **WHEN** an evidence item comes from the structured summary
- **THEN** the evidence item does not claim a transcript position
