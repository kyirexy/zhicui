## 1. Backend workspace composition

- [x] 1.1 Add current-user composed video-detail endpoint with downloader item, note, linked plan, and explicit external-media storage metadata
- [x] 1.2 Add request/response validation and ownership-safe not-found behavior for single-video workspace resources

## 2. Plan Agent

- [x] 2.1 Add source-grounded plan create/revise generation using transcript, AI summary, current date, user instruction, and existing plan
- [x] 2.2 Add validated plan replacement that preserves matching task completion state and stable plan identity
- [x] 2.3 Add authenticated plan-Agent endpoint returning the persisted plan and concise change summary

## 3. Frontend detail experience

- [x] 3.1 Add video-detail and plan-Agent frontend types and API wrappers
- [x] 3.2 Make video card primary surfaces navigate to the detail workspace without breaking selection or destructive controls
- [x] 3.3 Build static-export-compatible large desktop/mobile video workspace with preparation state
- [x] 3.4 Add tabbed single-video AI Q&A, full transcript, and actionable plan Agent UI
- [x] 3.5 Add responsive styling, focus states, loading/error states, and reduced-motion behavior

## 4. Verification

- [x] 4.1 Verify backend compile and service normalization/ownership behavior
- [x] 4.2 Verify regular Next.js build and Capacitor static export compatibility
- [x] 4.3 Verify desktop and mobile interactions in browser, including playback source, Q&A/transcript tabs, plan creation/revision, and navigation
- [x] 4.4 Audit ORM and workspace code to confirm that no video binary storage was introduced
