## 1. Synchronization contract

- [x] 1.1 Change the collection request count from fixed presets to a backend-validated integer range of 1–100
- [x] 1.2 Verify the downloader adapter passes the exact bounded count and retains the 100-item hard maximum
- [x] 1.3 Add activity classification for Douyin session logout and rebinding

## 2. Downloader account session

- [x] 2.1 Inspect the downloader cookie and login-worker lifecycle and implement a safe session-clear operation
- [x] 2.2 Add an authenticated application endpoint that delegates logout without deleting library or generated data
- [x] 2.3 Verify connected, disconnected, repeated logout, and active-login edge cases

## 3. Shared web and Android interface

- [x] 3.1 Keep 50/100 presets expanded and add a bounded custom synchronization number input
- [x] 3.2 Add a bounded automatic-processing input that clamps to the selected synchronization count
- [x] 3.3 Preserve the generation toggle and update explanatory copy and collection summary
- [x] 3.4 Add accessible sign-out and account-rebinding actions with confirmation and adjacent errors
- [x] 3.5 Verify narrow mobile layout, safe areas, loading states, and touch targets

## 4. Verification and delivery

- [x] 4.1 Run backend compilation and synchronization/logout API regressions
- [x] 4.2 Run the Next.js production build and inspect the shared Capacitor output contract
- [ ] 4.3 Commit scoped changes, push deployment remotes, and verify the production release
