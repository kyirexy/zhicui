## MODIFIED Requirements

### Requirement: Concurrent batch start
The system SHALL accept 1–100 videos for a transcript-only synchronization job, SHALL accept 1–50 user-selected videos for an AI-initialization or full extraction job, and SHALL submit every eligible item to the job without a sequential client-side request loop.

#### Scenario: Synchronization starts transcripts for 100 videos
- **WHEN** a completed source synchronization contains 100 eligible videos without saved transcripts
- **THEN** one transcript job is created, all 100 items immediately receive a queued or active state, and ASR work proceeds under the configured stage limit

#### Scenario: User initializes AI for 50 videos
- **WHEN** the user explicitly starts AI initialization for 50 transcript-ready videos
- **THEN** one AI job is created, all 50 items immediately receive a queued or active state, and LLM work proceeds concurrently under the configured stage limit

### Requirement: AI processing requires an explicit user action
The library SHALL automatically transcribe every eligible video in the selected synchronization range, SHALL NOT run LLM classification, card generation, or plan initialization during that automatic transcript stage, and SHALL start AI initialization only after an explicit user action.

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

### Requirement: Idempotent extraction
The batch orchestrator SHALL reuse an existing user-owned Note and its completed transcript or AI stage, SHALL update a transcript-only Note in place during AI initialization, and SHALL prevent duplicate Notes when the same video and stage are submitted concurrently.

#### Scenario: Same transcript is requested twice
- **WHEN** overlapping transcript jobs target the same user and video
- **THEN** ASR runs at most once, at most one Note is persisted, and all callers receive the existing or newly created transcript result

#### Scenario: AI initializes a transcript-only Note
- **WHEN** AI initialization targets an existing user-owned Note with a complete transcript
- **THEN** no ASR call is made, the same Note is updated with AI output, and no duplicate Note is created

#### Scenario: Completed AI is requested again
- **WHEN** AI initialization targets a Note already marked complete
- **THEN** the stored result is reused without another classification or card-generation call

### Requirement: Administrator-controlled multi-user ASR capacity
The system SHALL default ASR extraction concurrency to 200, SHALL let an administrator persist a value from 1 through 200 without restarting the service, SHALL expose the supported ASR and LLM limits to the admin client, and SHALL retain the independent 1–50 LLM concurrency range.

#### Scenario: Administrator saves 200 ASR workers
- **WHEN** an administrator saves ASR concurrency as 200
- **THEN** the API accepts and persists 200, newly created transcript jobs report that configured limit, and the process executor can run work for two 100-item transcript batches without a 100-worker process ceiling

#### Scenario: Administrator enters an unsupported ASR value
- **WHEN** an administrator submits ASR concurrency below 1 or above 200
- **THEN** the API rejects the request and leaves the existing runtime setting unchanged

#### Scenario: Admin client renders concurrency controls
- **WHEN** the admin client loads extraction configuration
- **THEN** it uses the server-provided maximum of 200 for ASR, keeps the server-provided maximum of 50 for LLM, and explains that each transcript batch is still limited to 100 videos
