## 1. Shared marquee interaction

- [x] 1.1 Implement a reusable mouse-only marquee hook with threshold, clipped geometry, replace/additive selection, limits, cancellation, and click suppression
- [x] 1.2 Add a body-portal marquee overlay that follows the existing emerald visual system without intercepting input

## 2. Video library integration

- [x] 2.1 Mark selectable Douyin cards and attach the marquee surface to the real library list container
- [x] 2.2 Connect preview selection, 50-item feedback, processing lock, and final preview focus to the existing library selection Set
- [x] 2.3 Confirm Bilibili/Xiaohongshu rows and explicit card controls remain outside marquee selection

## 3. Agent source integration

- [x] 3.1 Mark Agent source options and attach the marquee surface to the scrollable source list
- [x] 3.2 Atomically commit the candidate Set after release, preserve stable selected/unselected grouping during drag, and enforce the 100-source limit
- [x] 3.3 Cancel a pending gesture on loading, scroll, Escape, pointer cancellation, or window blur without breaking existing source interactions

## 4. Verification

- [x] 4.1 Run frontend TypeScript validation and inspect the affected diffs for interaction and accessibility regressions
- [x] 4.2 Run strict OpenSpec validation and verify the development library and Agent routes remain available
