## 1. Client authentication gate

- [ ] 1.1 Make root-route public access runtime-aware so the browser homepage stays public while Windows and Android require authentication.
- [ ] 1.2 Hide desktop/mobile application shells and protected background schedulers until authentication restoration succeeds.
- [ ] 1.3 Make development-session bypass opt-in and preserve login/register redirect and logout behavior.
- [ ] 1.4 Add a neutral client startup/auth transition state that never exposes workspace skeletons.

## 2. Web build update delivery

- [ ] 2.1 Generate and serve a cache-resistant public web build version marker.
- [ ] 2.2 Add installed-client version checks on visibility/focus and a low-frequency interval with safe retry behavior.
- [ ] 2.3 Add a stable native dialog that lets users refresh to the latest web build without silently interrupting active work.

## 3. Windows native updates

- [ ] 3.1 Add startup, focus, and periodic single-flight native update checks without duplicating downloads.
- [ ] 3.2 Configure a controllable HTTPS generic update feed and document the atomic latest.yml, EXE, and blockmap publishing contract.
- [ ] 3.3 Keep update boundaries and manual recovery visible in desktop settings and release metadata.

## 4. Verification

- [ ] 4.1 Run frontend and desktop type checks plus a production Next.js build.
- [ ] 4.2 Verify anonymous and authenticated startup behavior for browser, desktop runtime, and Android runtime paths.
- [ ] 4.3 Verify version-check failure is non-blocking and native update checks remain idle in development.
