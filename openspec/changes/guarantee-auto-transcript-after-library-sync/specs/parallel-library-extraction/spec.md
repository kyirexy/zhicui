## MODIFIED Requirements

### Requirement: AI processing requires an explicit user action
The library SHALL automatically transcribe every eligible video in the selected synchronization range after every successful synchronization attempt, including when the source reports no newly collected metadata, SHALL NOT run LLM classification, card generation, or plan initialization during that automatic transcript stage, and SHALL start AI initialization only after an explicit user action.

#### Scenario: User synchronizes favorites
- **WHEN** the user synchronizes liked, collected, or posted videos
- **THEN** metadata is updated and every eligible video in the requested range without a transcript enters a transcript-only batch job

#### Scenario: Synchronization reports no new metadata
- **WHEN** a synchronization attempt completes with zero newly collected records while an eligible video in the requested range still lacks a transcript
- **THEN** the client reloads the existing library range and starts a transcript-only batch job for that video

#### Scenario: Automatic transcript completes
- **WHEN** ASR returns a non-empty transcript for a synchronized video
- **THEN** the transcript and source metadata are saved with AI initialization marked incomplete and no generated card or plan

#### Scenario: User asks a transcript-ready video
- **WHEN** a video has a saved transcript but AI initialization is incomplete
- **THEN** the video is available to single-video and multi-video Q&A without silently starting classification or card generation

#### Scenario: User explicitly initializes AI
- **WHEN** the user selects transcript-ready videos and activates “AI 总结与知识卡”
- **THEN** the system runs classification, card generation, and optional plan generation for those videos and marks AI initialization complete
