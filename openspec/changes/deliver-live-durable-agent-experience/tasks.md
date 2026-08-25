## 1. Durable event protocol

- [x] 1.1 Add persisted answer-start/delta and Map batch lifecycle event helpers with lease checks and bounded payloads
- [x] 1.2 Project lifecycle events and answer deltas through the durable SSE replay endpoint without duplicate canonical output
- [x] 1.3 Add backend tests for event ordering, replay, chunk coalescing, cancellation and lease loss

## 2. Faster deep research

- [x] 2.1 Refactor transcript Map into bounded concurrent batches with copied request context and coordinator-thread progress updates
- [x] 2.2 Add per-batch coverage, failure and duration progress plus deterministic ordered reduction
- [x] 2.3 Bound final synthesis context around verified Map findings and top-ranked source excerpts
- [x] 2.4 Add backend tests for concurrency caps, out-of-order completion, partial failure and reduced synthesis input

## 3. Live Harness interface

- [x] 3.1 Extend Agent SSE types and callbacks with event identity, lifecycle metadata and replay-safe sequence handling
- [x] 3.2 Replace the empty streaming assistant state with a stable compact activity timeline and current-stage status
- [x] 3.3 Apply answer deltas to the same provisional message on initial send and recovered Turn streams, then reconcile canonical completion once
- [x] 3.4 Add responsive and reduced-motion styling plus focused frontend tests for projection, deduplication and delta replay

## 4. Verification

- [x] 4.1 Run focused backend and frontend tests, TypeScript checking and Next.js production build
- [x] 4.2 Verify a real 37-video desktop Turn for visible actions, faster Map wall time, answer deltas, refresh recovery and cancellation
- [x] 4.3 Update attribution notes with the concrete Codex/DeepSeek Harness patterns adapted in this change and validate OpenSpec strictly

## 5. Codex-first streaming polish

- [x] 5.1 Bound the first and subsequent durable answer chunks to a small replay-safe size, stream safe claim narrative fields, and extend backend tests
- [x] 5.2 Recompose the running Turn as a Codex-style collapsible execution summary before the single streaming answer, with no duplicate generation labels
- [x] 5.3 Add streaming cursor, responsive/reduced-motion states, frontend projection tests and desktop visual verification
- [x] 5.4 Repair concurrent event sequencing and retry cleanup, add friendly terminal errors, and route exact enumeration to focused deep research
- [x] 5.5 Reconcile terminal Turn ghost-running threads and stop client polling when no authoritative active Turn exists
- [x] 5.6 Add one reusable frame-coalesced adaptive answer queue for initial and recovered Turn streams
- [x] 5.7 Reduce durable SSE follow latency and guarantee stale scheduled frames cannot overwrite terminal canonical messages
- [x] 5.8 Add deterministic stream pacing tests, rerun frontend/backend verification, and verify the desktop experience
- [x] 5.9 Keep the running activity trace collapsed by default, disclose recent actions only on demand, and remove fixed task-surface occupancy
- [x] 5.10 Reduce durable delta size and retune the client pump for continuous paced text without empty Markdown scaffolds
- [x] 5.11 Preserve multi-claim depth for single-video summaries and return explicit full-transcript requests verbatim
- [x] 5.12 Rename the running action to stop generation, hide zero-of-requested citation coverage, and complete regression verification
