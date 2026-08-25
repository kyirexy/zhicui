## 1. Product language and data derivation

- [x] 1.1 Rename the product destination and visible Agent workspace labels to “知萃研伴” while keeping route and API compatibility.
- [x] 1.2 Add typed client-side result metadata helpers that derive persisted studio results from assistant messages and tolerate legacy messages without output-style metadata.

## 2. Three-panel workspace

- [x] 2.1 Reorganize the desktop Agent workspace into left video sources, center grounded conversation, and right result studio without changing existing source-snapshot behavior.
- [x] 2.2 Add result-type shortcuts for summary, comparison, action plan, and custom output by reusing the existing message request contract and real loading/error states.
- [x] 2.3 Implement result list, selected-result detail, copy/open actions, and empty/loading states from persisted thread messages.
- [x] 2.4 Preserve recent tasks, automations, feedback, answer settings, citations, follow-ups, and retry/edit behavior in the reorganized shell.

## 3. Responsive experience and polish

- [x] 3.1 Add tablet drawers and mobile “视频 / 对话 / 成果” navigation with accessible focus, labels, touch targets, reduced-motion handling, and safe-area spacing.
- [x] 3.2 Refine typography, surfaces, spacing, hover/focus states, and independent panel scrolling to match the existing light/dark design system.

## 4. Verification

- [x] 4.1 Run OpenSpec validation, frontend TypeScript/Next.js production build, and focused backend contract checks for the unchanged Agent API.
- [x] 4.2 Verify desktop and mobile layouts in a browser, including source search/selection, empty studio, restored historical results, and result generation states where local data allows.

## 5. Post-launch refinement

- [x] 5.1 Map running-thread message conflicts to HTTP 409, keep provider diagnostics best-effort, and add focused route/contract regression tests.
- [x] 5.2 Add a user-scoped smart source-search endpoint with bounded AI query expansion, deterministic title/author/summary/transcript ranking, exact snippets, and keyword fallback.
- [x] 5.3 Replace the six-card source scope chooser with a compact filter, explicit smart-search submission, real checkbox selection, and selection persistence across searches.
- [x] 5.4 Expand the desktop workspace to the full client canvas, rebalance side-panel widths, and reduce redundant padding, cards, and explanatory copy without removing required states.
- [x] 5.5 Run OpenSpec strict validation, frontend production build/type checks, backend smart-search/message contract tests, and diff checks.
- [x] 5.6 Verify the full-width desktop layout, smart search, cross-search selection, conflict feedback, and responsive drawers in the packaged or development desktop client.
