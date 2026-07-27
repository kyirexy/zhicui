## Context

The current `/library` page already reads source media from the optional `douyin-downloader`, enriches each manifest item with the current user's extraction state, and supports both batch research and `POST /api/notes/{note_id}/ask`. Notes persist transcripts and AI card data; plans persist flexible JSON fields, days, and tasks. The missing layer is a single-video workspace that composes these capabilities without turning the main app into another media store.

The frontend also ships as a Capacitor static export, so a dynamic App Router segment such as `/library/[id]` would require build-time route generation. A stable page plus query parameter is compatible with both the dev server and static export.

## Goals / Non-Goals

**Goals:**

- Make one video the center of a large desktop and mobile knowledge workspace.
- Reuse grounded note Q&A and the existing full-transcript viewer.
- Allow a plan Agent to create or revise flexible structured plans from natural-language instructions.
- Preserve completed task state across safe Agent revisions.
- Keep video files outside the application database and avoid schema migration.
- Preserve existing library batch selection and multi-video Agent flows.

**Non-Goals:**

- Uploading, transcoding, duplicating, or backing up video files in the main application.
- Replacing the existing plan workbench or every granular plan CRUD endpoint.
- Adding a chat-history database table in this change.
- Supporting a second downloader provider or remote production media hosting.

## Decisions

### Use a static `/library/detail?id=<aweme_id>` route

The library card links to a dedicated client page whose outer page provides a `Suspense` boundary and whose client workspace reads `useSearchParams`. This satisfies Next.js 16 static-export behavior and avoids enumerating downloader items at build time.

Alternative considered: `/library/[aweme_id]`. It is visually cleaner but incompatible with arbitrary post-build downloader IDs under the current Capacitor export unless every route is generated ahead of time.

### Add one composed detail endpoint

`GET /api/library/douyin/items/{aweme_id}` retrieves the normalized downloader item, looks up the current user's note by `video_id`, then looks up the user's plan by `note_id`. It returns:

- `item`: live media, cover, caption, author, source order, and extraction status;
- `note`: full current-user note or `null`;
- `plan`: linked current-user plan or `null`;
- `media_storage`: an explicit descriptor stating that media is externally served and not stored in the application database.

This keeps the frontend from coordinating three independent reads and centralizes ownership rules.

Alternative considered: reuse the full item list and find the ID client-side. That transfers an unbounded manifest for one detail view and still needs separate note and plan fetches.

### Keep media live and text durable

The main database schema remains unchanged. `media_url` and `cover_url` are resolved from the companion manifest at detail-read time. Existing note source fields can continue to contain URL strings and metadata, but no binary column or file ingestion is added. Playback uses the downloader's HTTP static route directly.

Alternative considered: copying videos into FastAPI-managed storage or a database BLOB. This violates the explicit storage boundary, duplicates large local files, and creates lifecycle and production-hosting responsibilities unrelated to knowledge extraction.

### Implement the plan Agent as a source-grounded full-plan upsert

`POST /api/notes/{note_id}/plan-agent` accepts a bounded natural-language instruction. The service gives the LLM the current date, transcript context, AI summary, and existing plan JSON, then requests strict JSON containing the entire desired plan and a short change summary. The existing plan normalizer validates flexible fields, sparse days, task scheduling, duration, frequency, details, and priority before persistence.

For new plans, the service creates a normal user-scoped plan linked to the note. For revisions, a dedicated replace operation updates the existing plan in place so external links stay stable. It reconciles completion state by exact existing task ID first and normalized task title second; unmatched new tasks remain incomplete. The endpoint returns the authoritative persisted plan.

Alternative considered: let the model emit arbitrary CRUD commands. A full-plan response is easier to validate, makes the final state explicit, and avoids partially applied multi-command failures.

### Separate workspace modes with tabs

Desktop uses an approximately 58/42 split inside a near-viewport-width container. The right pane has three top-level tabs: AI 问答, 完整文案, 行动计划. The page avoids nested card stacks; a single framed workspace, one media stage, and one knowledge surface create hierarchy. Mobile stacks the video stage above the same tab system.

The Q&A tab reuses `ContentChat`; the transcript tab reuses `TranscriptViewer`. The plan tab presents an instruction composer, a compact authoritative plan preview, Agent change feedback, and a link to `/plans?id=<plan_id>`.

### Keep existing extraction as the preparation gate

An unprocessed video can still be played, but transcript-dependent tabs display one preparation state and one clear extraction action. On success, the returned note ID triggers a composed-detail reload, exposing all knowledge capabilities without navigating away.

## Risks / Trade-offs

- [Downloader unavailable] → Show a specific recoverable state and retain a route back to the library; do not treat the database copy of source URLs as the canonical media catalog.
- [Long transcripts exceed one LLM context] → Reuse bounded transcript context construction and AI summary; report source size in the UI and never truncate the human-readable transcript.
- [Model returns malformed or destructive plan data] → Parse strict JSON, normalize every field/task, require at least one actionable task, preserve known completion state, and commit one complete validated state.
- [Concurrent plan edits] → The last successful Agent revision wins, matching current plan mutation semantics; the response returns `updated_at` and the authoritative state.
- [Static-export hydration failure] → Keep `useSearchParams` inside a client component wrapped by a page-level `Suspense` boundary and verify both normal and Capacitor builds.
- [Direct media URL becomes stale] → Re-read the downloader manifest every time the workspace is loaded instead of treating note URLs as canonical.

## Migration Plan

1. Add the composed detail and plan-Agent endpoints without database migration.
2. Add frontend types and API wrappers.
3. Add the static-compatible detail workspace and link cards to it.
4. Verify an unprocessed video, an extracted video without a plan, and an extracted video with an existing plan.
5. Rollback consists only of reverting endpoints/page/card link because no schema or stored media migration occurs.

## Open Questions

None for this iteration. Persisted Agent conversation history and remote media hosting can be designed separately if later required.
