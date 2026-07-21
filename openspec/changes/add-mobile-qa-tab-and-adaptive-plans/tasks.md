## 1. Mobile result tabs

- [x] 1.1 Extend the result workspace state and accessible navigation to include a mobile AI question tab
- [x] 1.2 Keep a single mounted assistant instance and preserve the desktop right-column layout
- [x] 1.3 Add responsive three-tab styles and mobile panel visibility rules

## 2. Adaptive plan generation

- [x] 2.1 Replace fixed-count plan prompt rules with AI-controlled fields, groups, sparse days and task metadata
- [x] 2.2 Normalize AI plan days, tasks, date-times, duration, frequency and custom details without discarding safe fields
- [x] 2.3 Preserve legacy plan generation and storage compatibility

## 3. Fine-grained plan API

- [x] 3.1 Accept date-only or minute-level task schedules plus optional duration and frequency
- [x] 3.2 Persist, update and clear fine-grained task metadata while syncing flat tasks and days
- [x] 3.3 Keep overview date comparison and ordering compatible with both schedule formats

## 4. Plan workbench UI

- [x] 4.1 Extend shared plan types and API mutation payloads for adaptive fields and task metadata
- [x] 4.2 Display schedule time, duration, frequency and AI details in task rows and today's focus
- [x] 4.3 Add minute-level schedule, duration and frequency controls to the task editor
- [x] 4.4 Group AI-defined plan fields and safely render unknown field types

## 5. Validation and runtime

- [x] 5.1 Review changed UI against baseline and React quality guidance
- [x] 5.2 Run focused Python plan normalization/API checks and TypeScript checking
- [x] 5.3 Run a production frontend build and strict OpenSpec validation
- [x] 5.4 Restart frontend 3003 and backend 8011 and verify real plan/result routes
