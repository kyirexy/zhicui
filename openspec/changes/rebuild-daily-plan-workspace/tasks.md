## 1. Plan schema and persistence

- [x] 1.1 Add nullable plan start/completion columns and cross-dialect startup migration
- [x] 1.2 Normalize schema-v3 task position, focus metadata, and completion timestamps across flat/day JSON
- [x] 1.3 Implement manual plan creation, metadata updates, completion timestamps, and task ordering services

## 2. Execution, review, and coaching APIs

- [x] 2.1 Extend overview with requested date, explicit focus, recommendations, and unscheduled tasks
- [x] 2.2 Implement atomic cross-plan focus selection and user-scoped weekly review
- [x] 2.3 Add manual plan, reorder, focus, review, and extended metadata request/response routes
- [x] 2.4 Implement no-write AI coaching preview and concurrency-safe apply while preserving completed tasks

## 3. Shared frontend contracts

- [x] 3.1 Extend TypeScript plan/review/coaching types and API client methods
- [x] 3.2 Add React 19-compatible dnd-kit dependencies and accessible sortable task primitives

## 4. Today action workspace

- [x] 4.1 Rebuild the plans route around Today, Plans, and truthful weekly Review views
- [x] 4.2 Add three-focus planning, direct optimistic completion, recommendations, other-today, and collapsed overdue sections
- [x] 4.3 Add one mobile-first quick capture sheet for manual plans and tasks
- [x] 4.4 Rework plan detail around execution, stable sorting, metadata, source context, and AI preview/apply

## 5. Visual quality and verification

- [x] 5.1 Consolidate plan presentation into a scoped warm-neutral/mint CSS Module with light/dark, desktop/mobile, focus, and reduced-motion states
- [x] 5.2 Verify legacy JSON compatibility, dual-user isolation, focus limits, order validation, weekly history, and stale coaching conflicts
- [x] 5.3 Run Python compile/regression checks, TypeScript, Next production/static builds, and OpenSpec strict validation
- [x] 5.4 Inspect 390px mobile, desktop web, and Electron plan surfaces; fix clipping, safe-area, keyboard, and 44px target regressions
