## ADDED Requirements

### Requirement: Windows users can install the complete Zhicui application
The system SHALL provide an x64 Windows installer that opens the existing Zhicui product with the same authenticated account and production data as the web and mobile clients.

#### Scenario: User starts the installed app
- **WHEN** the user launches Zhicui on Windows
- **THEN** the app SHALL open the trusted Zhicui product URL in a single application instance

#### Scenario: A second app instance is launched
- **WHEN** Zhicui is already running and the user launches it again
- **THEN** the existing window SHALL be restored and focused instead of creating an independent session

### Requirement: Desktop privileged APIs are isolated
The desktop application MUST disable renderer Node access and SHALL expose only a typed, minimal preload bridge to trusted Zhicui origins.

#### Scenario: Main window navigates
- **WHEN** the renderer attempts to navigate outside the configured Zhicui origin
- **THEN** the application SHALL block in-app navigation and open permitted external links in the system browser

#### Scenario: Untrusted renderer invokes IPC
- **WHEN** an IPC request originates from a URL outside the trusted production or local development origins
- **THEN** the main process SHALL reject the request

### Requirement: Installed app supports deep links
The Windows installer SHALL register the `zhicui://` protocol and the app SHALL route a received deep link to the existing application window.

#### Scenario: Web user opens a Zhicui deep link
- **WHEN** Windows dispatches `zhicui://douyin-login` to the installed app
- **THEN** the app SHALL focus the existing instance and open the video library login destination

### Requirement: Desktop app has an update foundation
The packaged application SHALL expose its version and SHALL be able to check a configured GitHub Release feed for a newer installer.

#### Scenario: A newer release exists
- **WHEN** the packaged app checks for updates and a newer published version is available
- **THEN** the updater SHALL download or notify according to the configured update policy without disrupting the current session
