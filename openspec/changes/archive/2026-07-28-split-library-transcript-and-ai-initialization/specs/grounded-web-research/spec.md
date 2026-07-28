## ADDED Requirements

### Requirement: Transcript-only question answering
The system SHALL allow single-video and multi-video Q&A whenever a user-owned source has a non-empty complete transcript, regardless of whether a knowledge card or AI summary has been initialized.

#### Scenario: Single video has no AI summary
- **WHEN** the user asks a question about a transcript-ready video whose AI initialization is incomplete
- **THEN** the Agent retrieves and answers from the complete transcript, reports that no AI summary was used, and preserves transcript evidence validation

#### Scenario: Library contains mixed initialization states
- **WHEN** a multi-video question includes transcript-ready Notes with and without initialized AI summaries
- **THEN** all selected transcripts participate in retrieval while only initialized summaries contribute summary context

#### Scenario: Transcript does not contain the answer
- **WHEN** a transcript-only source lacks the requested fact
- **THEN** the existing automatic/video-only research policy applies without requiring card initialization and without inventing an answer
