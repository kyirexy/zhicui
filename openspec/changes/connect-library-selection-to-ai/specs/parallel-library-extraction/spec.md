## MODIFIED Requirements

### Requirement: AI processing requires an explicit user action

The library SHALL automatically transcribe every eligible video in the selected synchronization range, SHALL NOT run LLM classification, card generation, or plan initialization during that automatic transcript stage, and SHALL start AI initialization only after an explicit user action. The library SHALL expose the existing full operation as one explicit structured-copy action for the user's complete eligible selection snapshot and MUST NOT silently reduce that snapshot.

#### Scenario: User synchronizes favorites
- **WHEN** the user synchronizes liked, collected, or posted videos
- **THEN** metadata is updated and every eligible video in the requested range without a transcript enters a transcript-only batch job

#### Scenario: Automatic transcript completes
- **WHEN** ASR returns a non-empty transcript for a synchronized video
- **THEN** the transcript and source metadata are saved with AI initialization marked incomplete and no generated card or plan

#### Scenario: User asks a transcript-ready video
- **WHEN** a video has a saved transcript but AI initialization is incomplete
- **THEN** the video is available to single-video and multi-video Q&A without silently starting classification or card generation

#### Scenario: User explicitly initializes AI
- **WHEN** the user selects transcript-ready videos and activates “AI 总结与知识卡”
- **THEN** the system runs classification, card generation, and optional plan generation for those videos and marks AI initialization complete

#### Scenario: User explicitly extracts structured copy
- **WHEN** the user selects one or more eligible videos and activates “提取结构化文案”
- **THEN** the complete selection snapshot enters one full batch job that reuses existing transcript or AI stages and completes missing stages

#### Scenario: Structured selection includes an ineligible item
- **WHEN** any item in the structured-copy selection cannot be extracted
- **THEN** the client blocks the submission with an adjacent explanation instead of silently submitting a smaller set
