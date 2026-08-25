## 1. Import flow behavior

- [x] 1.1 Replace the local card result with guarded automatic navigation to the saved video detail route
- [x] 1.2 Add a missing-note-id completion fallback and preserve retry, cancellation and stale-result safety

## 2. Single-link interface

- [x] 2.1 Rewrite card-oriented copy and workflow labels around video import, transcript, summary and opening the video
- [x] 2.2 Remove card and plan result UI styles and add a restrained opening-video transition state

## 3. Verification

- [x] 3.1 Add focused tests for detail URL construction and stale-result navigation gating
- [x] 3.2 Run frontend tests, TypeScript production build, strict OpenSpec validation and diff checks

## 4. Progressive video and transcript preview

- [x] 4.1 Emit safe video preview metadata at parse completion and the complete transcript at transcription completion
- [x] 4.2 Persist intermediate preview data in the global extraction context and clear it on new, cancelled or failed work
- [x] 4.3 Render the original video and complete transcript progressively on the import page without navigating before final save
- [x] 4.4 Add stream contract tests and rerun backend/frontend builds and strict validation

## 5. Saved video playback repair

- [x] 5.1 Persist single-link source metadata and retain the original page URL when saving the generated note
- [x] 5.2 Make legacy direct-extraction notes fall back to their stored video URL in the shared detail workspace
- [x] 5.3 Wire the player retry action to refresh an expired Douyin media URL and return updated metadata
- [x] 5.4 Add regression coverage and rerun frontend/backend verification

## 6. Bilibili playback

- [x] 6.1 Add a strict BVID-to-official-player URL helper with regression tests
- [x] 6.2 Use the official Bilibili player for both progressive import preview and saved video detail
- [x] 6.3 Stop treating a Bilibili webpage URL as a direct media URL and rerun builds and validation
- [x] 6.4 Give the Bilibili player a responsive 16:9 stage so the actual picture fills the available width
