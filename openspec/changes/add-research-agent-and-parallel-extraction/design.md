## Context

Single-video Q&A currently performs transcript retrieval and one synthesis call. It correctly refuses to invent facts, but it cannot resolve a repository link, current fact, or external reference absent from the transcript. DeepSeek's OpenAI-compatible chat endpoint can reason and produce tool decisions, but live web access is not guaranteed by the model endpoint itself, so the application must provide the retrieval tool and validate its outputs.

Library processing currently loops over `POST /api/library/douyin/extract` in the browser. Each request performs media streaming, ASR, intent classification, optional plan generation, card generation, and persistence before the next item begins. The source videos remain outside the application database, but the sequential client loop makes a 20–50 item batch unnecessarily slow.

## Goals / Non-Goals

**Goals:**

- Let the existing DeepSeek-backed agent automatically decide when a bounded web lookup is useful.
- Return useful links and current facts with visible, clickable provenance while keeping transcript claims distinct.
- Start every selected extraction as one server-side job, overlap independent work, and expose per-item progress.
- Keep media ephemeral and preserve user scoping, idempotency, auditability, mobile usability, and current single-item APIs.

**Non-Goals:**

- Give the model unrestricted browser control or allow arbitrary tool execution.
- Crawl the open web recursively, bypass paywalls, authenticate to third-party websites, or promise that every mentioned entity can be identified.
- Persist video binaries or make the production server a permanent media host.
- Run all 50 ASR uploads and all LLM calls simultaneously without limits; every item starts immediately, but expensive stages remain bounded to protect reliability.

## Decisions

### Use an application-owned plan, retrieve, synthesize loop

The Q&A service will perform three explicit phases: determine whether external evidence is required, execute a bounded search/fetch tool, then synthesize from transcript context plus labelled web evidence. This is preferred over trusting provider-specific implicit browsing because it works with both DeepSeek presets and custom OpenAI-compatible models, produces deterministic provenance, and lets the application enforce network safety.

Automatic mode will trigger research for link-finding, current-information, verification, and explicit search language. A small LLM planning call may refine 1–3 search queries. Video-only mode bypasses the tool completely.

### Use a replaceable search service with a keyless fallback

`web_research.py` will expose a provider-neutral result schema. The initial implementation uses bounded public search retrieval and direct public-page verification with strict URL validation. Provider credentials can be added later without changing the agent contract. Search text is untrusted input and will be wrapped as evidence, never as instructions.

### Keep external citations separate from transcript evidence

Existing exact-quote validation remains authoritative for transcript evidence. Web results use a separate `web_sources` response field containing only results that came from the bounded retrieval tool. The UI renders those sources as external links instead of mixing them into the transcript quote expander.

### Add a server-side in-process batch job coordinator

A new batch endpoint will create a user-scoped job, submit every eligible work ID to a shared executor, and return immediately. Each worker opens its own short-lived SQLAlchemy session. Per-job semaphores bound ASR/media work and LLM work independently; all selected items enter the state machine immediately.

An in-process coordinator avoids a new Redis/Celery operational dependency and is proportionate to the current single-instance deployment. Completed Notes are durable; job progress is process-lifetime state. A future multi-instance deployment can move the same job contract to a durable queue.

### Preserve the existing single-item endpoint

The single-item endpoint and workspace preparation action remain supported. Shared extraction code will enforce a per-user/video lock and recheck for an existing Note before persistence so single and batch requests are idempotent.

### Use familiar product UI patterns

The Q&A surface will use one compact research-scope control, a stable scroll region, state-specific progress rows, separate source cards, and the existing bottom composer. It will not add nested decorative cards or hide core controls in a modal. Motion is limited to state transitions and respects reduced-motion preferences.

## Risks / Trade-offs

- [Public search endpoints can throttle or change markup] → Keep a provider boundary, short timeouts, bounded results, graceful video-only fallback, and safe error copy.
- [Search results can be wrong or malicious] → Validate URLs, label all web text as untrusted, require uncertainty language, and expose citations for user inspection.
- [Too much concurrency can exhaust ASR quota, sockets, or database connections] → Start all tasks but gate expensive stages independently, use short-lived DB sessions, retry only transient errors, and cap accepted items at 50.
- [In-memory job state is lost on backend restart] → Persist every completed Note immediately; after restart, refreshing the library reconstructs completed state and the user can retry only remaining items.
- [Concurrent requests can create duplicate Notes] → Lock on user/video, recheck inside the lock, and rely on an additional database uniqueness guard where dialect-safe.

## Migration Plan

1. Add the research service, expanded Q&A schemas, and batch coordinator behind compatible defaults.
2. Deploy backend first; existing clients continue using the single-item endpoint and video-only-compatible response fields.
3. Deploy the new frontend and Android build, then verify one video-only answer, one link-research answer, and a mixed-success concurrent batch.
4. Monitor ASR/LLM errors and adjust runtime concurrency defaults if production quotas require it.
5. Roll back the frontend to sequential extraction if needed; completed Notes remain valid and no media migration is required.

## Open Questions

- A later production iteration may add a paid search provider for higher recall and service-level guarantees.
- A future multi-instance backend will require durable job state and a distributed lock, likely PostgreSQL advisory locks plus a queue.
