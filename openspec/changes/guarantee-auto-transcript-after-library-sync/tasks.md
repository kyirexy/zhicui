## 1. Synchronization behavior

- [x] 1.1 Remove the zero-new-record early return from the successful synchronization path
- [x] 1.2 Reload the selected library range and start transcript-only work for every eligible item without a transcript
- [x] 1.3 Preserve the already-ready and permanently-hidden completion messages when no transcript target remains

## 2. Progressive results and AI separation

- [x] 2.1 Verify each completed transcript updates its video card and Q&A eligibility before the batch finishes
- [x] 2.2 Verify automatic synchronization never initializes AI summaries, knowledge cards, or plans

## 3. Validation

- [x] 3.1 Run the frontend production build
- [x] 3.2 Validate the OpenSpec change in strict mode and confirm no database migration is required
