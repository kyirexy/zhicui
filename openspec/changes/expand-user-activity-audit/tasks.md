## 1. Activity data model and privacy controls

- [x] 1.1 Add nullable structured-detail and idempotency-key fields plus portable startup migration
- [x] 1.2 Implement allowlisted detail sanitization, serialization, summaries, and idempotent activity writes

## 2. Authentication and synchronization events

- [x] 2.1 Record successful and failed registration/login outcomes without storing submitted credentials
- [x] 2.2 Record Douyin synchronization start events with source, requested count, and job identifier
- [x] 2.3 Record idempotent synchronization completion/failure events with final counts

## 3. Administrator reporting

- [x] 3.1 Extend the activity report API with user filtering and parsed detail summaries
- [x] 3.2 Add administrator user selection, event detail summaries, and readable outcomes to the activity timeline

## 4. Verification

- [x] 4.1 Verify model migration and activity sanitization/idempotency behavior on SQLite
- [x] 4.2 Run backend compilation, frontend production build, and inspect the final diff for sensitive data
