## Context

Automatic synchronization is device-local and already schedules the next run from an interval stored in `localStorage`, but the settings schema only accepts six fixed values. Library source ordering is represented by `source_rank`; the backend refreshes it only when every item lacks a rank, allowing an old snapshot to survive an explicit UI switch back to source order. The current transparent native `<select>` exposes an unstyled Windows menu.

## Goals / Non-Goals

**Goals:**

- Accept bounded custom intervals while retaining quick presets and current scheduler semantics.
- Refresh source-order snapshots during synchronization and make ordering switches local and immediate.
- Keep source snapshots isolated and prevent stale responses from replacing the active tab.
- Treat metadata synchronization and transcript preparation as independent user-visible phases so cards appear before slow extraction begins.
- Support both video and gallery media in the detail workspace without requiring persistent server-side media files.
- Provide a theme-aware custom ordering menu with keyboard and outside-click dismissal.

**Non-Goals:**

- Running synchronization while the desktop application is closed.
- Persisting scheduler preferences on the server.
- Inferring a like timestamp from the video's publish timestamp.

## Decisions

- Store the custom period as integer minutes, bounded to 15 minutes through 7 days. This keeps the existing scheduler and stored settings backward compatible while the UI can express minutes, hours, or days.
- Use the downloader's metadata-only catalog path for product synchronization. This avoids turning a metadata refresh into dozens of fragile media downloads.
- Normalize downloader `collection`, `collect`, and `collectmix` identifiers to the product's canonical `collect` source before ranking or filtering.
- Refresh source ranks inside the background sync job. The sort menu reads that snapshot and never blocks the list on a remote Douyin request.
- Guard list writes with a monotonically increasing request ID so a late response for another source cannot overwrite the active source.
- Poll job counters without reloading the full library; load the library once after the job reaches a terminal state.
- End the blocking synchronization phase only after the refreshed metadata snapshot has rendered, then start transcript preparation after a short handoff delay. Transcript polling may update progress but SHALL NOT disable source navigation or change the synchronization button into an extraction button.
- Persist only gallery image CDN references and counts in the device-local sidecar catalog. Expose them through signed same-origin image proxies so the frontend can render a gallery without exposing the loopback service.
- Resolve video stream targets once per user scope and work ID, cache the result briefly in memory, and reuse it across browser Range requests. Resolve covers from the synchronized catalog before falling back to a fresh Douyin detail request.
- Let the single-item detail player preload video metadata so the first remote target resolution overlaps with reading the page instead of beginning only after the play click.
- Replace the native select with a button-triggered inline menu. Each option includes a short explanation to distinguish source interaction order from video publish time.

## Risks / Trade-offs

- [Remote source refresh can take several seconds or fail] → Run it inside the visible sync job while retaining the prior local snapshot; sort switches remain instant.
- [Very short intervals could cause repeated extraction work] → Enforce a 15-minute minimum and retain the existing cross-tab lock.
- [Background transcript work can outlive the active source tab] → Keep the server job running, scope item patches by video ID, and reload authoritative extraction state whenever the user returns to a source.
- [Short-lived Douyin CDN URLs can expire] → Keep media caches brief, evict on upstream failure, and retry once with freshly resolved metadata.
- [Old stored union values coexist with arbitrary numbers] → Normalize all stored values to an integer within bounds during settings hydration.
