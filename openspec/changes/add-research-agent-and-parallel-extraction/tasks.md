## 1. Research agent backend

- [x] 1.1 Add a bounded, SSRF-safe web search and page verification service with normalized source metadata
- [x] 1.2 Add automatic/video-only research planning to single-video and multi-video Q&A
- [x] 1.3 Return separate web citations, research scope, and agent trace fields without weakening transcript evidence validation

## 2. Concurrent extraction backend

- [x] 2.1 Extract reusable idempotent single-video processing logic with task-scoped database sessions
- [x] 2.2 Add a user-scoped 1–50 item batch job coordinator with separate ASR and LLM stage gates
- [x] 2.3 Add batch start/status endpoints with per-item progress, partial success, and safe errors

## 3. Frontend product UI

- [x] 3.1 Replace the sequential browser extraction loop with one batch start plus progress polling
- [x] 3.2 Add automatic/video-only scope control, research progress, and clickable external sources to video Q&A
- [x] 3.3 Refine desktop/mobile Q&A typography, spacing, states, accessibility, and anchored composer behavior

## 4. Operations and delivery

- [x] 4.1 Add focused backend verification for search safety, research provenance, concurrency, idempotency, and no-media persistence
- [x] 4.2 Run OpenSpec validation, backend checks, TypeScript production build, and local service smoke tests
- [ ] 4.3 Build the updated Android package, restart local services, commit to master, deploy, and verify production
