## MODIFIED Requirements

### Requirement: Bounded automatic processing
The system SHALL automatically extract complete transcripts for every eligible item within the user-selected synchronization range of 1 through 100 items, SHALL never inspect or process items beyond that range, and SHALL require a separate explicit action before generating AI summaries, knowledge cards, or plans.

#### Scenario: Synchronization completes with missing transcripts
- **WHEN** synchronization completes and one or more eligible items in the selected range lack a transcript
- **THEN** the system starts transcript-only processing for those items without requiring another user action

#### Scenario: Synchronization finds existing metadata only
- **WHEN** the source reports no new records but an existing eligible item in the selected range lacks a transcript
- **THEN** the system still starts transcript-only processing for that item

#### Scenario: Every transcript is already ready
- **WHEN** synchronization completes and every eligible item in the selected range already has a transcript
- **THEN** the system reports that complete transcripts are ready and does not create duplicate work

#### Scenario: User has not requested AI initialization
- **WHEN** automatic transcript processing completes
- **THEN** the system does not generate an AI summary, knowledge card, or plan
