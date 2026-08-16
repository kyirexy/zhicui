## Why

The library currently offers only fixed automatic-sync intervals, and switching to “最近喜欢” can reuse stale source ranks so the list still resembles publish-time order. The native Windows select popup also breaks the visual consistency of the library toolbar.

## What Changes

- Allow users to set a custom automatic-sync interval in addition to presets, with safe minimum and maximum bounds.
- Refresh Douyin source-order metadata as part of source synchronization, while keeping sort switching local and immediate.
- Keep likes, collections, and posts in independent metadata snapshots without downloading video files during synchronization.
- Prevent stale source requests and progress polling from overwriting or repeatedly reloading the active library.
- Complete and render the full video metadata snapshot before starting transcript preparation, and keep that slower work non-blocking.
- Render Douyin gallery posts as image collections instead of reporting a missing video file, and reuse synchronized media metadata for fast cover/playback requests.
- Replace the native sort select with a styled, keyboard-accessible menu that explains each ordering mode.
- Preserve “我的作品” as publish-time order and preserve user sort preferences locally.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `douyin-library-sync-control`: Add custom device-local sync intervals and explicit source-order refresh behavior for likes and collections.

## Impact

- Frontend settings types/context, automatic-sync scheduler UI, library synchronization pipeline, sort control, and library API client.
- Backend Douyin library list/media routes and downloader adapter.
- No new dependency and no database migration.
