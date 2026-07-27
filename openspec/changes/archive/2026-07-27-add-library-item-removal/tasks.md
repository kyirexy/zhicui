## 1. User-scoped persistence

- [x] 1.1 Add the portable `library_hidden_items` model with a unique user/work constraint
- [x] 1.2 Add idempotent service functions to list and hide bounded work IDs
- [x] 1.3 Ensure startup metadata includes the new table on SQLite and PostgreSQL

## 2. Authenticated removal API

- [x] 2.1 Filter hidden work IDs from library list and detail responses
- [x] 2.2 Add a validated 1–50 item batch-removal endpoint used by both UI paths
- [x] 2.3 Classify removal activity without logging titles, cookies, or other content
- [x] 2.4 Verify user isolation, persistence after synchronization, idempotency, and invalid batches

## 3. Shared web and Android interface

- [x] 3.1 Add a visible single-item removal action to each video card
- [x] 3.2 Add a batch removal action for selected videos
- [x] 3.3 Add an accessible confirmation dialog with explicit non-destructive copy and adjacent errors
- [x] 3.4 Remove successful IDs from local state and selection without disturbing generated Notes or plans
- [x] 3.5 Verify narrow layouts, touch targets, disabled/loading states, and selection behavior

## 4. Verification

- [x] 4.1 Run backend compilation and focused persistence/API contract regressions
- [x] 4.2 Run the Next.js production build
- [x] 4.3 Run the production Capacitor sync contract and restart local services
