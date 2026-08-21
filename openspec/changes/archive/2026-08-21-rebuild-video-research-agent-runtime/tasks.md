## 1. Persistent Runtime Foundation

- [x] 1.1 Add AgentTurn, AgentEvent, AgentTurnSource and AgentMemoryCheckpoint models with SQLite/PostgreSQL-safe additive migration and sanitized serialization.
- [x] 1.2 Implement atomic turn creation/idempotency, ordered event append/projection, cancellation, retry, lease claim/heartbeat and stale-worker commit guards.
- [x] 1.3 Add the recoverable Agent runtime worker lifecycle to application startup and shutdown.

## 2. Research and Evidence Pipeline

- [x] 2.1 Add `auto` research routing with deterministic broad-question coverage and structured fallback classification; default web scope to video-only.
- [x] 2.2 Implement transparent layered source coverage so all sources are scanned, up to 100 transcript-ready sources are mapped, and deep-read counters remain distinct.
- [x] 2.3 Introduce structured Claim/Evidence normalization, independent-source support counts, exact-quote validation and at most two repair passes before answer rendering.
- [x] 2.4 Add structured long-conversation memory checkpoints and replace the fixed latest-six-message context path.

## 3. API and Compatibility

- [x] 3.1 Extend message requests and SSE progress with client turn IDs, auto mode, durable event sequence, resolved mode and layered counters while retaining legacy event types.
- [x] 3.2 Add user-scoped turn detail, cursor event list/stream, cancel and retry endpoints; reconnecting MUST reuse the existing turn and charge.
- [x] 3.3 Add administrator V2 enablement, allowlist and stable rollout percentage settings with V1 fallback before answer output.

## 4. Harness Experience

- [x] 4.1 Make Auto the default research mode and Video only the default evidence scope, retaining explicit advanced overrides.
- [x] 4.2 Render durable scan/map/deep-read/claim verification progress, resume active turns after refresh, and group validated evidence by Claim without DOM portals.

## 5. Verification and Rollout

- [x] 5.1 Add backend tests for the exact 37-video broad question, all-source coverage, invalid citation removal, idempotency, lease transfer, cancellation, retry, memory compaction, user isolation and V1 compatibility.
- [x] 5.2 Add frontend type/build verification and interaction tests for auto routing, reconnect/replay, truthful counters, explicit web opt-in and mobile controls.
- [x] 5.3 Run target backend tests, TypeScript checking, Next.js production build, OpenSpec validation and document MIT/Apache attribution for any directly ported code.
