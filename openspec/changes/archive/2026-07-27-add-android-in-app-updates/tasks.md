## 1. Release metadata and native dependencies

- [x] 1.1 Add the public latest-release manifest for Android version `1.1.0 (2)` with a Chinese changelog
- [x] 1.2 Install Capacitor App and Browser plugins and sync dependency metadata
- [x] 1.3 Make Gradle derive `versionName` and `versionCode` from the release manifest
- [x] 1.4 Add release-manifest validation and staging to the APK build script

## 2. Update discovery and download flow

- [x] 2.1 Implement strict release-manifest parsing, cache-resistant fetching and build comparison utilities
- [x] 2.2 Implement Android-only startup checking with session dismissal semantics
- [x] 2.3 Implement a responsive accessible update dialog with version details, changelog and adjacent errors
- [x] 2.4 Open only trusted HTTPS APK URLs through the Capacitor system browser

## 3. Settings and release history

- [x] 3.1 Show native installed version and manual update status on the settings page
- [x] 3.2 Keep release notes visible after the automatic prompt is dismissed
- [x] 3.3 Clearly identify browser sessions as the Web edition without triggering native checks

## 4. Verification and release

- [x] 4.1 Validate older/current/web decision paths and unsafe or malformed manifests
- [x] 4.2 Run frontend production build, Capacitor production sync and Android APK build
- [x] 4.3 Verify APK native version, public manifest, trusted download behavior and mobile layout
- [x] 4.4 Sync and archive the OpenSpec change after all checks pass
- [x] 4.5 Commit the final release, push both remotes, create/update `main`, deploy via `master`, and verify production
