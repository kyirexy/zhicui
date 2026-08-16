## 1. Persistence and contracts

- [x] 1.1 Add creator source, source item and persistent run models with user isolation, uniqueness, tombstones and safe serializers
- [x] 1.2 Register the models at startup and add user/admin request-response contracts plus frontend types

## 2. Connector and worker services

- [x] 2.1 Implement strict three-platform profile normalization, profile resolution and bounded public-work discovery adapters
- [x] 2.2 Extend the Douyin and XHS loopback adapter contracts and deployment documentation without exposing credentials or media paths
- [x] 2.3 Implement idempotent creator source CRUD, durable runs, cancellation, per-platform concurrency and restart recovery
- [x] 2.4 Reuse existing import/transcript pipelines for new work while skipping reused, removed and non-video XHS items

## 3. API and administration

- [x] 3.1 Add authenticated creator source and creator sync run APIs with feature gating and active-run recovery
- [x] 3.2 Add encrypted connector settings, health tests and admin API/UI controls in the existing configuration surface
- [x] 3.3 Integrate permanent-removal hooks so creator-synced items never silently reappear

## 4. User experience

- [x] 4.1 Add “我的账号 / 指定博主” to the existing sync Sheet with inline resolve, save, select, remove and 20/50/100 controls
- [x] 4.2 Restore active creator runs in the global background experience and show checked/new/reused/failed completion summaries

## 5. Verification

- [x] 5.1 Add backend coverage for validation, isolation, idempotency, partial failure, cancellation, recovery, tombstones and secret redaction
- [x] 5.2 Run backend unittest, frontend and desktop type checks/builds, connector smoke checks and strict OpenSpec validation
