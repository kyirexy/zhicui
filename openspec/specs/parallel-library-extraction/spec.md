# parallel-library-extraction Specification

## Purpose

Define concurrent, user-scoped, text-only extraction for batches of library videos.

## Requirements

### Requirement: Concurrent batch start
The system SHALL accept 1–50 user-selected library videos as one extraction job and SHALL submit every eligible item to the job without a sequential client-side request loop.

#### Scenario: User processes 50 videos
- **WHEN** the user starts transcript generation for 50 eligible videos
- **THEN** one batch job is created, all 50 items immediately receive a queued or active state, and work proceeds concurrently

### Requirement: Stage-aware concurrency limits
The system SHALL apply independently configurable limits to media transcription and LLM processing while allowing all selected items to enter the job immediately.

#### Scenario: More items than an API stage can safely run
- **WHEN** the number of active items exceeds the configured ASR or LLM stage limit
- **THEN** excess items wait at that stage without blocking unrelated stages or causing the client to submit items sequentially

#### Scenario: Administrator changes a concurrency value
- **WHEN** an administrator updates a supported concurrency setting
- **THEN** newly created jobs use the new bounded value without requiring code changes

### Requirement: Per-item progress and partial success
The batch API SHALL expose job totals and per-item states for queued, transcribing, analyzing, complete, and failed work.

#### Scenario: Some items fail
- **WHEN** one or more videos cannot be transcribed or analyzed
- **THEN** successful items remain saved, failed items expose a safe error, and the overall job reports partial completion instead of discarding the batch

#### Scenario: Client reconnects while a job runs
- **WHEN** the page refreshes or temporarily loses its connection
- **THEN** the client can poll the job identifier and reconstruct current per-item progress while the server process remains active

### Requirement: Idempotent extraction
The batch orchestrator SHALL reuse an existing user-owned Note for an already extracted video and SHALL prevent duplicate Notes when the same video is submitted concurrently.

#### Scenario: Same video is submitted twice
- **WHEN** overlapping batch or single-item requests target the same user and video
- **THEN** at most one new Note is persisted and all callers receive the existing or newly created Note result

### Requirement: No durable video storage
The system MUST NOT store video binary content in PostgreSQL or other application database tables while processing concurrent extraction jobs.

#### Scenario: A concurrent transcription completes or fails
- **WHEN** temporary media has been consumed by ASR or an error stops processing
- **THEN** task-scoped temporary media is released and only metadata, transcript text, AI output, progress, and safe diagnostics may remain
