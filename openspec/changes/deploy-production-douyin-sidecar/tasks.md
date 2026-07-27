## 1. Headless QR protocol

- [x] 1.1 Add virtual-display-compatible Playwright login and in-memory QR-only capture to the companion
- [x] 1.2 Add bounded QR status/version and PNG endpoint without exposing Cookie values
- [x] 1.3 Extend companion tests for QR readiness, binary access, success and safe failure

## 2. Zhicui proxy and interface

- [x] 2.1 Extend the backend adapter and authenticated routes to proxy safe QR status and bounded PNG data
- [x] 2.2 Extend frontend API types and add a responsive accessible QR login card to the video library
- [x] 2.3 Run backend compile, Next.js production build, OpenSpec validation and desktop/mobile browser verification

## 3. Reproducible production sidecar

- [x] 3.1 Generate a pinned-upstream Zhicui sidecar patch containing all required local modifications
- [x] 3.2 Add a repeatable installer, hardened loopback-only systemd unit and operating notes
- [x] 3.3 Install the patched companion, venv, Chromium and protected Cookie/metadata-only config on the production server
- [x] 3.4 Verify selectable 50/100 metadata sync, ordering, ephemeral media access and zero persistent server video/audio files

## 4. Mobile and release

- [x] 4.1 Build production Capacitor resources and a new Android APK containing the QR flow
- [x] 4.2 Review scope, commit product/deployment/OpenSpec/APK changes and push GitHub plus Gitee master
- [x] 4.3 Confirm Jenkins, final production commit, services, authenticated connector status, QR login path and APK artifact
