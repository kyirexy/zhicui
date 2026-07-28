## 1. Persistent stage model

- [x] 1.1 Add a backward-compatible Note AI-initialization flag and startup migration
- [x] 1.2 Add transcript-only persistence and in-place AI update helpers
- [x] 1.3 Ensure Q&A ignores placeholder summaries while accepting complete transcripts

## 2. Stage-aware batch backend

- [x] 2.1 Split library item processing into transcript, AI, and compatible full operations
- [x] 2.2 Add operation and AI state to batch requests, jobs, and library item responses
- [x] 2.3 Accept 100 items for transcript jobs while preserving 50-item AI/full limits and stage gates

## 3. Transcript-first product UI

- [x] 3.1 Automatically start transcript-only processing for all eligible videos after synchronization
- [x] 3.2 Add transcript-ready and AI-initialized states plus explicit batch AI actions
- [x] 3.3 Let the detail workspace ask from transcripts and explicitly initialize AI summaries/cards

## 4. Verification and local handoff

- [x] 4.1 Extend focused verification for transcript-only persistence, stage idempotency, Q&A, and 100-item admission
- [x] 4.2 Run OpenSpec validation, backend verification, and the frontend production build
- [x] 4.3 Restart local services and smoke-test the library and health routes

## 5. Multi-user ASR capacity and release

- [x] 5.1 Raise the process executor and persisted ASR concurrency range/default to 200 while keeping each transcript batch at 100
- [x] 5.2 Expose ASR/LLM maxima in the admin API and make the admin input use the server-provided bounds
- [x] 5.3 Verify the 200-worker contract, backend schemas, frontend production build, and no-media invariant
- [x] 5.4 Build a versioned production Android APK with updated release notes
