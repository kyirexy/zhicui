## 1. Knowledge outcome data

- [x] 1.1 Extend KnowledgeEntry with summary, canonical status, origin, and optional source Note linkage
- [x] 1.2 Add idempotent startup migration coverage for the new knowledge entry fields on SQLite and PostgreSQL
- [x] 1.3 Add serialization and candidate-to-page content normalization helpers

## 2. Knowledge API and service

- [x] 2.1 Replace mixed in-memory pagination with server-side pages and inbox views, search, counts, and pagination
- [x] 2.2 Add a user-scoped, idempotent endpoint that saves a video candidate as a knowledge page
- [x] 2.3 Preserve user ownership, CRUD validation, and legacy knowledge detail compatibility

## 3. Knowledge workspace interface

- [x] 3.1 Update frontend knowledge contracts for page and candidate outcomes
- [x] 3.2 Rebuild `/notes` with knowledge-page and inbox views, one primary action, accurate empty states, and no video-import or grid controls
- [x] 3.3 Add stable desktop list/reading layout and mobile list/full-detail behavior with accessible interactions
- [x] 3.4 Reuse the source video workspace from candidate actions and remove duplicate full-transcript presentation from knowledge details

## 4. Verification

- [x] 4.1 Add backend regression tests for candidate eligibility, view filtering, pagination, idempotent save, and ownership
- [x] 4.2 Run targeted backend tests, frontend TypeScript checks, and the production build
- [x] 4.3 Verify desktop and mobile loading, empty, error, save, edit, delete, deep-link, focus, and safe-area states in the rendered app
- [x] 4.4 Run strict OpenSpec validation for reset-my-knowledge-to-curated-outcomes

## 5. Full-width clarity redesign

- [x] 5.1 Remove the nested desktop width cap and compose one compact page header with a full-width list/reader workbench
- [x] 5.2 Move view/search/count controls into the list pane and simplify row hierarchy to title, summary, then useful metadata
- [x] 5.3 Left-align the reader within its pane, remove redundant zero-source/status metadata, and keep only contextual actions
- [x] 5.4 Preserve the mobile list/detail flow, touch targets, dialog focus, and safe-area behavior after the desktop redesign

## 6. Redesign verification

- [x] 6.1 Run frontend TypeScript checks and the production build
- [x] 6.2 Verify wide desktop, ordinary desktop, and mobile rendered states for width use, hierarchy, overflow, focus, CRUD, and deep links
- [x] 6.3 Run baseline UI checks and strict OpenSpec validation

## 7. Continuous full-height workspace refinement

- [x] 7.1 Replace the detached page intro and rounded workspace shell with one compact full-height desktop workbench
- [x] 7.2 Flatten list tabs and search hierarchy while preserving counts, server search, paging, and URL state
- [x] 7.3 Distribute reader content across header, content, and real source footer; center sparse manual content and deduplicate identical summary/body text
- [x] 7.4 Preserve mobile list/detail behavior, dialog ownership, focus, safe areas, and reader scroll reset

## 8. Refinement verification

- [x] 8.1 Run frontend TypeScript checks and the production build
- [x] 8.2 Verify desktop sparse-page balance, long candidate scrolling, mobile overflow, deep links, and CRUD interactions in the rendered app
- [x] 8.3 Run baseline UI pattern checks and strict OpenSpec validation

## 9. Desktop surface continuity

- [x] 9.1 Replace the Electron knowledge canvas percentage-height dependency with a definite flex height chain
- [x] 9.2 Verify the list divider and reader surface reach the desktop viewport bottom, then rerun frontend and OpenSpec checks

## 10. Continuous reader flow

- [x] 10.1 Remove sparse-content centering and full-height header/content/footer distribution so knowledge reads as one continuous document
- [x] 10.2 Verify short manual pages, sourced pages, long candidates, mobile behavior, frontend checks, and strict OpenSpec validation
