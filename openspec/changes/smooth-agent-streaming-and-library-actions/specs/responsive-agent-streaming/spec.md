## ADDED Requirements

### Requirement: Agent streams an immediate lifecycle response
When an authenticated user submits a valid Agent question, the stream SHALL emit a consumable lifecycle event as soon as the SSE response opens, before research or model work completes.

#### Scenario: Question enters the research pipeline
- **WHEN** the server accepts a valid question for an idle thread
- **THEN** the client receives a queued or reading progress event without waiting for the answer model to finish

#### Scenario: Long-running research remains observable
- **WHEN** planning, source scanning, optional research, synthesis, or verification takes time
- **THEN** the stream emits truthful stage changes or keep-alive frames and does not fabricate answer text

### Requirement: Common fast questions avoid an unnecessary planning round trip
The Agent SHALL use a deterministic local retrieval plan for an independent fast-mode question with the default answer output and no custom instruction. It SHALL retain model-assisted planning for deep research and requests that need conversation refinement or non-default output planning.

#### Scenario: Independent default fast question
- **WHEN** a user asks an independent question in fast mode with the default answer style and no custom instruction
- **THEN** retrieval begins from the question and deterministic coverage rules without waiting for a separate planning-model response

#### Scenario: Complex request still receives assisted planning
- **WHEN** the request is deep research, depends on conversation history, requests a non-default output style, or contains a custom instruction
- **THEN** the existing model-assisted research planner remains available before synthesis

### Requirement: Visible answer deltas use bounded event granularity
The server SHALL extract only the visible `answer` value from the provider's structured response and SHALL emit that text at provider-delta granularity rather than as one SSE event per character. JSON syntax, evidence fields, and unvalidated trailing data SHALL NOT be exposed as visible answer text.

#### Scenario: Provider delta contains several visible characters
- **WHEN** one provider chunk contributes multiple characters to the `answer` JSON string
- **THEN** those characters are decoded and delivered together in a single answer delta

#### Scenario: JSON escape crosses provider chunks
- **WHEN** an escape sequence begins in one provider chunk and ends in another
- **THEN** the stream preserves the intended visible character and flushes any safe remaining text before completion

### Requirement: Client commits streamed text at display cadence
After the first visible answer delta, the client SHALL buffer subsequent deltas and commit the accumulated text at most once per browser animation frame. It SHALL flush pending text before handling completion, cancellation cleanup, or failure cleanup.

#### Scenario: Many deltas arrive within one frame
- **WHEN** multiple answer deltas arrive before the next animation frame
- **THEN** the client performs one message-content update containing their concatenated text

#### Scenario: Stream completes with buffered text
- **WHEN** the done event arrives while text is still waiting in the client buffer
- **THEN** the pending text is committed before the provisional message is reconciled with the canonical server message

#### Scenario: First answer delta arrives
- **WHEN** the stream emits its first visible answer delta
- **THEN** the client displays it immediately and transitions from preparation feedback to visible answer content

### Requirement: Streaming status does not create a blank answer block
The UI SHALL communicate active generation without rendering an empty standalone box or a caret on a separate line after block-level Markdown.

#### Scenario: Answer ends in a paragraph or list while streaming
- **WHEN** the current streamed Markdown ends with a block-level paragraph or list
- **THEN** no root-level pseudo-caret creates an additional blank line or bordered whitespace area

#### Scenario: Answer has not produced text yet
- **WHEN** the stream is active but no visible answer delta has arrived
- **THEN** the existing lifecycle or author status communicates that generation is in progress

### Requirement: Stream completion and recovery preserve message semantics
The optimized stream SHALL preserve the existing done, approval-required, analysis-started, conflict, retry, and abort semantics without duplicating answer text.

#### Scenario: Provider answer was streamed live
- **WHEN** the canonical done payload arrives after live deltas
- **THEN** the final message contains exactly the server-persisted answer and its validated metadata, without replaying the answer a second time

#### Scenario: Stream fails or is aborted
- **WHEN** the stream ends with an error or the user aborts it
- **THEN** scheduled frames are cancelled, local buffers are cleared after the required flush, and the existing retry or cancellation state remains usable
