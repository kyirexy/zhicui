## 1. Sidecar resilience contract

- [x] 1.1 Add structured collection diagnostic fields and safe error classification to the sidecar contract
- [x] 1.2 Add user-scoped collection circuit breaker, bounded cooldown, and single-flight control
- [x] 1.3 Implement one-shot background browser XHR fallback for explicitly blocked collection API responses
- [x] 1.4 Advertise collection resilience capabilities and configuration in sidecar health and deployment files

## 2. Backend integration

- [x] 2.1 Preserve structured source diagnostics when starting and polling Douyin synchronization jobs
- [x] 2.2 Keep collection failure isolated from successful likes and own-post source results
- [x] 2.3 Map collection cooldown, verification, session, network, and connector failures to safe user-facing messages

## 3. Product feedback

- [x] 3.1 Show account connectivity separately from collection readability and suggested retry time
- [x] 3.2 Keep likes and own-post controls enabled when only collection is unavailable

## 4. Verification

- [x] 4.1 Add sidecar contract tests for API success, browser fallback, cooldown, verification, isolation, and sensitive-field filtering
- [x] 4.2 Add backend and frontend target tests for structured diagnostics and partial-source success
- [x] 4.3 Run focused backend tests and the Next.js production build
