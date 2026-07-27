## 1. Error data and capture

- [x] 1.1 Add indexed application error model and register it at startup
- [x] 1.2 Implement centralized redaction, bounded metadata and failure-safe persistence
- [x] 1.3 Capture HTTP, unhandled backend and validation failures without changing normal responses
- [x] 1.4 Capture LiteLLM provider failures with safe operation metadata
- [x] 1.5 Add authenticated client runtime error reporting

## 2. Administrator APIs and UI

- [x] 2.1 Add administrator error report API with filters, aggregates and pagination
- [x] 2.2 Extend frontend API types and add the global client error reporter
- [x] 2.3 Add detailed error logs to the existing observability workspace
- [x] 2.4 Apply baseline UI accessibility, typography, empty-state and mobile table checks

## 3. Verification and mobile sync

- [x] 3.1 Verify redaction, aggregation, permissions and error-capture failure isolation
- [x] 3.2 Run backend compile, strict OpenSpec validation and Next.js production build
- [x] 3.3 Verify admin error logs in desktop and mobile browser widths
- [x] 3.4 Build production Capacitor resources and Android APK

## 4. Release

- [x] 4.1 Review and stage only intended product, OpenSpec and APK changes
- [ ] 4.2 Commit the completed workspace and push origin plus Gitee master
- [ ] 4.3 Confirm Jenkins deployment and production API/site health
- [ ] 4.4 Verify production admin availability and APK download artifact
