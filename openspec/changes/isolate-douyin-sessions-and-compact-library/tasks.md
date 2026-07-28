## 1. Binding persistence

- [x] 1.1 Add the user-scoped Douyin binding model with unique opaque scope and safe lifecycle fields
- [x] 1.2 Register the model at startup and add a binding service for create/read/status updates

## 2. Scoped backend adapter

- [x] 2.1 Pass the current binding scope through all sidecar status, login, logout, sync, item and job calls
- [x] 2.2 Bind temporary media URL signatures and sidecar media requests to the originating scope
- [x] 2.3 Update route handlers to persist safe binding metadata and prevent cross-user task/item access

## 3. Scoped sidecar

- [x] 3.1 Add validated per-scope Cookie, QR and metadata-directory session state to the reference sidecar
- [x] 3.2 Scope login, logout, synchronization, item, job and media endpoints and filter job access by scope
- [x] 3.3 Add sidecar coverage for independent users, scoped jobs and session clearing
- [x] 3.4 Regenerate the production sidecar patch and update installer directory permissions

## 4. Compact and mobile library UI

- [x] 4.1 Remove the promotional library header and place the content mode switch in a compact responsive toolbar
- [x] 4.2 Add save/share QR and open-Douyin actions with honest same-device instructions
- [x] 4.3 Keep the mobile QR panel within dynamic viewport and safe-area bounds with accessible touch targets

## 5. Verification

- [x] 5.1 Run backend syntax/import checks and sidecar tests for scoped session behavior
- [x] 5.2 Run the Next.js production build and Capacitor production export/sync
- [x] 5.3 Verify no Cookie values or video binaries are stored in the Zhicui database paths

## 6. Native Android binding and lifecycle recovery

- [x] 6.1 Add a narrow Android bridge for saving login QR images to the system gallery and launching the Douyin package
- [x] 6.2 Recover a pending or completed QR login when the app returns to the foreground, with an honest mobile-browser fallback
- [x] 6.3 Recheck the Android release manifest on foreground resume while respecting same-session dismissal
- [x] 6.4 Validate the OpenSpec change, Next.js build, Capacitor sync and Android compilation

## 7. QR challenge recovery

- [x] 7.1 Detect Douyin security-verification pages, keep headed desktop login stable and fail fast in headless mode
- [x] 7.2 Add a user-scoped login cancellation path and show live challenge progress inside the QR panel
- [x] 7.3 Add sidecar coverage, regenerate the production patch, rebuild the frontend and verify a real challenge state

## 8. Chrome-directed desktop login

- [x] 8.1 Launch the installed Chrome visibly and report browser-open state through the scoped login API
- [x] 8.2 Keep headed login alive without a mirrored QR and make the desktop UI direct the user to scan inside Chrome
- [x] 8.3 Add coverage, regenerate the production patch, rebuild and verify that Chrome visibly opens

## 9. Android desktop-binding handoff

- [x] 9.1 Replace Android and mobile-web QR startup with an explicit same-account desktop-binding guide
- [x] 9.2 Refresh scoped binding status when the Android App resumes without cancelling or mutating an informational guide
- [x] 9.3 Distinguish local visible Chrome from production remote QR capture without misleading the user
- [x] 9.4 Bump the Android release, build the APK, validate the change and deploy the production revision

## 10. Production login and deploy recovery

- [x] 10.1 Make scoped login cancellation await browser-worker cleanup and make duplicate starts idempotent
- [x] 10.2 Forward browser mode through the backend and add one automatic QR restart plus an explicit retry fallback
- [x] 10.3 Retain bounded previous-build chunks and add one-shot stale-chunk recovery in the client bootstrap
- [x] 10.4 Run sidecar/frontend verification, regenerate the production patch and deploy the repaired flow

## 11. Mobile completion and concurrent login hardening

- [x] 11.1 Recognize current authenticated Douyin Cookie variants and expose only safe completion counters
- [x] 11.2 Reconcile binding status during login polling and add bounded Android foreground confirmation
- [x] 11.3 Add per-scope single-flight plus a process-wide bounded login-browser queue
- [x] 11.4 Add completion/concurrency coverage, regenerate the sidecar patch and deploy the verified repair

## 12. Local-browser binding authority and offline recovery

- [x] 12.1 Expose the connector login browser mode through health and backend connection status
- [x] 12.2 Start login only for a same-device visible Chrome connector and replace remote QR capture with a signed loopback handoff
- [x] 12.3 Make every service-worker fetch failure resolve with a typed offline response
- [x] 12.4 Add coverage, regenerate the sidecar patch, rebuild, restart local services and deploy the verified change

## 13. One-action Douyin login

- [x] 13.1 Remove connector, port and remote-browser terminology from user-facing library UI
- [x] 13.2 Open Chrome directly, auto-close the temporary launch document and use bounded completion reconciliation
- [x] 13.3 Add coverage, rebuild, restart local services and deploy the verified flow
