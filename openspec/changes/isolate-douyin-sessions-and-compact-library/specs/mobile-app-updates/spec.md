## ADDED Requirements

### Requirement: Resume-time Android update check
The Android application SHALL check the trusted latest-release manifest when it starts and whenever it returns to the foreground, while respecting a same-session dismissal for the same build.

#### Scenario: App starts
- **WHEN** the native Android application starts
- **THEN** it compares the installed build with the trusted public release manifest

#### Scenario: App returns to foreground
- **WHEN** the native Android application resumes after being in the background
- **THEN** it checks for a newer build again without interrupting the product when the network request fails

#### Scenario: User already dismissed the same build
- **WHEN** the user selected later for the currently published build during this app session
- **THEN** resuming the app does not reopen the same update prompt

#### Scenario: New build is available
- **WHEN** the published build is greater than the installed build
- **THEN** the app shows version details, release notes and a user-confirmed trusted APK download action
