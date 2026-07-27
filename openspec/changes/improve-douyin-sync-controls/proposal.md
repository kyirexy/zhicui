## Why

The Douyin library currently restricts synchronization to two fixed counts and hides the primary range controls behind a settings disclosure. Users also cannot explicitly end the current Douyin session before connecting another account, making controlled tests and account switching unclear.

## What Changes

- Keep the 50 and 100 synchronization presets visible by default.
- Allow an authenticated user to enter any synchronization count from 1 through 100.
- Allow an independent automatic-processing count from 0 through the selected synchronization count.
- Keep the “generate transcript and knowledge card after sync” toggle and explain how its processing limit is applied.
- Add a clear Douyin sign-out action and a guided account-rebinding action.
- Signing out clears only the downloader login session; it does not delete synchronized metadata, extracted transcripts, cards, plans, or media files.
- Record the session action in the bounded user activity log.

## Capabilities

### New Capabilities

- `douyin-library-sync-control`: User-controlled bounded synchronization and processing counts, visible presets, and safe Douyin session logout/rebinding.

### Modified Capabilities

None.

## Impact

- Changes the library collection request contract from fixed 50/100 values to an integer range of 1–100.
- Adds a user-scoped backend endpoint for disconnecting the downloader session.
- Extends the downloader adapter and, if required, its local web-console session API.
- Updates the shared Next.js/Capacitor library interface and API client.
- Does not change the metadata-only database policy and does not add video storage.
