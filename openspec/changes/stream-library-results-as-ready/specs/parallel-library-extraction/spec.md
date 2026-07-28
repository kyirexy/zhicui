## MODIFIED Requirements

### Requirement: Per-item progress and partial success
The batch API SHALL expose job totals and per-item states for queued, transcribing, analyzing, complete, and failed work. The library client SHALL update a video's card, transcript-ready state, question-answering availability, and visible batch summary as soon as a polled job snapshot reports that item complete, without waiting for the remaining batch items to finish.

#### Scenario: First transcript completes in a large batch
- **WHEN** the first video in a 50-item or 100-item transcript job reaches the complete state
- **THEN** that video immediately appears as transcript-ready in the library, is included in eligible Q&A sources, and is shown in the live completion summary while the rest of the batch continues

#### Scenario: Batch remains in progress
- **WHEN** some videos are complete while other videos are queued or transcribing
- **THEN** the client shows separate completed, active, queued, and failed counts and does not block access to completed results

#### Scenario: Some items fail
- **WHEN** one or more videos cannot be transcribed or analyzed
- **THEN** successful items remain saved and visible, failed items expose a safe adjacent error, and the overall job reports partial completion instead of discarding the batch

#### Scenario: Client reconnects while a job runs
- **WHEN** the page refreshes or temporarily loses its connection
- **THEN** the client can poll the job identifier and reconstruct current per-item progress while the server process remains active
