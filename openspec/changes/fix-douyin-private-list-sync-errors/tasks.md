## 1. Sidecar private-list contract

- [x] 1.1 Add scoped private-list readiness that reports independent likes/collections booleans and allowlisted missing requirements without credential values.
- [x] 1.2 Port the verified metadata-only likes request template and strict success-shape validation into the existing pinned downloader sidecar.
- [x] 1.3 Classify missing UIFID, HTTP 403/risk control, verification, session expiry and malformed responses as stable job diagnostics instead of successful empty results.
- [x] 1.4 Ensure private-list request logs contain only endpoint paths, status, timing and bounded counts.

## 2. Backend propagation and aggregation

- [x] 2.1 Extend the Douyin companion adapter to normalize readiness and new safe error codes while remaining compatible with the old sidecar response.
- [x] 2.2 Prevent failed or needs-action sources from contributing to successful-source and confirmed-empty summaries, while preserving results from other sources.
- [x] 2.3 Add backend tests for likes success, collection UIFID preflight, 403 classification, confirmed empty results and sensitive-field redaction.

## 3. User experience

- [x] 3.1 Show source-specific readiness and account recovery guidance in the shared Web/desktop/mobile synchronization sheet.
- [x] 3.2 Replace ambiguous zero-item success feedback with separate empty, risk-controlled and account-reconnection messages.
- [x] 3.3 Add frontend unit coverage for mixed likes-success/collection-needs-action summaries and retry guidance.

## 4. Verification and delivery

- [x] 4.1 Run the targeted backend tests and frontend production build.
- [x] 4.2 Validate the patched sidecar contract with fake success/403/missing-UIFID responses and document the production smoke-test sequence.
