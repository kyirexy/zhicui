## Why

Douyin collections often contain videos that are irrelevant, unsuitable, or not intended for the user's knowledge workflow. Users need a safe way to remove those items from the Zhicui library, including in bulk, without changing their Douyin favorites or deleting previously generated knowledge.

## What Changes

- Add a user-scoped persistent hidden-item record so removed videos stay out of the library after later synchronization.
- Add authenticated single-item and batch-removal APIs with bounded input and activity logging.
- Add a clear single-video removal action and a batch removal action for selected videos.
- Require confirmation and explain that removal does not unfavorite on Douyin or delete transcripts, knowledge cards, plans, or video files.
- Keep desktop, mobile web, and Capacitor behavior aligned.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `douyin-library-sync-control`: Add user-scoped, persistent, non-destructive single and batch removal from the Zhicui library.

## Impact

- Backend: a small user-scoped hidden-item table/model, library list filtering, authenticated removal endpoints, and activity classification.
- Frontend: video-card removal action, selected-items batch action, confirmation dialog, notices, and mobile layout.
- Data policy: stores only user ID, Douyin work ID, and timestamps; no video binary is stored or deleted.
