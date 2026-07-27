## Context

The library page currently sends `count` as a fixed `50 | 100` value and keeps automatic extraction as a separate client-side step. The backend and downloader already enforce a maximum synchronization range, but the user cannot choose a smaller custom range. Login status is read from the local Douyin downloader session, yet the product has no explicit way to clear that session before scanning a different account.

The database remains metadata-only. Account switching must not be implemented by deleting library records or downloaded media.

## Goals / Non-Goals

**Goals:**

- Make 50 and 100 visible as immediate presets while supporting an integer synchronization count from 1 to 100.
- Let users enter an automatic-processing count from 0 to the selected synchronization count.
- Enforce the same bounds in both frontend and backend.
- Provide explicit session sign-out and account rebinding without deleting knowledge data.
- Keep web and Capacitor behavior aligned.

**Non-Goals:**

- Synchronizing more than 100 items in one operation.
- Deleting historical library metadata or generated notes during logout.
- Managing more than one active Douyin account simultaneously.
- Storing Douyin video binaries in the application database.

## Decisions

### Use numeric request bounds rather than enumerated counts

`LibraryCollectRequest.count` will become a bounded integer (`1–100`). The two existing presets remain client conveniences, while the backend is the source of truth. This avoids maintaining separate contracts for presets and custom values.

### Treat automatic processing as a client-side post-sync limit

The collection job remains responsible only for synchronized metadata. After a successful synchronization, the client processes at most `min(process_count, synchronized_count)` eligible items. A value of zero or a disabled generation toggle performs no automatic extraction. This keeps collection resumable and avoids coupling long LLM/ASR work to the downloader job.

### Keep primary controls expanded

The range presets, custom range input, automatic-processing input, and generation toggle stay visible in the collection panel. Advanced or diagnostic details may remain collapsible, but the controls required to start a normal synchronization do not.

### Separate sign-out from destructive library actions

A new authenticated application endpoint delegates to a downloader session-clear operation. The downloader clears its persisted login cookies and current QR/login state, then reports disconnected status. Generated notes, plans, metadata manifests, and media files are untouched.

The UI presents:

- `退出抖音`: a destructive-session action that requires confirmation.
- `换绑账号`: performs the same session clear, then immediately opens the existing QR binding flow after a successful disconnect.

### Record only bounded activity metadata

The request middleware classifies logout/rebind as a Douyin account-session action. It records route, method, status, duration, user ID, and IP only; cookie content and account identifiers are never logged.

## Risks / Trade-offs

- **Downloader session file can be locked by an active login browser** → cancel or close the login worker before removing persisted cookies, and return a clear retryable error.
- **Processing count becomes larger after the user lowers the sync count** → clamp it immediately in the UI and again at execution time.
- **A user can sign out while collection is active** → reject session clearing while a collection/login job is actively mutating session state, or safely cancel that job before clearing cookies.
- **A stale connected status remains cached** → invalidate status after logout and re-fetch before starting QR login.

## Migration Plan

1. Deploy the downloader session-clear endpoint and application adapter support.
2. Deploy the bounded application API and shared frontend controls.
3. Existing clients that send 50 or 100 continue to work without migration.
4. Rollback restores the fixed literal contract; no data migration is required.

## Open Questions

None. The existing maximum of 100 and metadata-only storage policy remain authoritative.
