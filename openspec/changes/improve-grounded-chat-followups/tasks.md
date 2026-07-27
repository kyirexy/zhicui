## 1. Adaptive answer service

- [x] 1.1 Add deterministic single-note request-mode detection for grounded facts and explicit creative assistance
- [x] 1.2 Update the single-note prompt and response contract so creative requests are fulfilled and clearly labeled
- [x] 1.3 Preserve verbatim evidence validation and return the server-selected `answer_mode`

## 2. Chat interface

- [x] 2.1 Extend frontend chat types and stored-message compatibility for `answer_mode`
- [x] 2.2 Render a distinct AI-generated state for creative answers
- [x] 2.3 Refactor the Q&A panel into fixed top, independently scrolling conversation, and persistent bottom composer regions
- [x] 2.4 Verify the bottom composer layout on desktop and mobile breakpoints

## 3. Verification and delivery

- [x] 3.1 Run targeted backend regressions for missing facts, example prompts, follow-up corrections, and evidence validation
- [x] 3.2 Run the frontend production build and inspect the key Q&A screens
- [x] 3.3 Commit the scoped change, push it to the deployment branch, and verify the production release
