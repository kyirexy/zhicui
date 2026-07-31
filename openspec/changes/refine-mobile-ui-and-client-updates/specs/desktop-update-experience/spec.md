## ADDED Requirements

### Requirement: Packaged desktop client automatically checks for updates

The packaged Windows client SHALL check its configured trusted release source after startup and SHALL automatically download a newer release without blocking the current product session.

#### Scenario: New release is available
- **WHEN** a packaged desktop client starts and the release source reports a newer version
- **THEN** the client downloads the update in the background and reports bounded progress to the renderer

#### Scenario: Update check fails
- **WHEN** the release source is unavailable or returns an error
- **THEN** the current session remains usable and settings exposes a retryable, sanitized error

### Requirement: Downloaded desktop update is visible and installable

The desktop UI SHALL notify the user when an update has finished downloading and SHALL provide an explicit action to restart and install it.

#### Scenario: Download finishes
- **WHEN** the updater reports the new version is downloaded
- **THEN** the UI displays the target version and offers “重启并安装”

#### Scenario: User postpones installation
- **WHEN** the user dismisses the downloaded-update prompt
- **THEN** the current session continues and the update remains available from settings or installs on normal app exit

### Requirement: Desktop updater bridge is minimal and trusted

The renderer SHALL access update state only through the context-isolated preload bridge, and the main process SHALL validate trusted IPC senders before checking or installing updates.

#### Scenario: Renderer requests installation
- **WHEN** a trusted Zhicui renderer requests update installation after download completion
- **THEN** the main process invokes the updater install action
- **AND** no filesystem, shell or arbitrary process API is exposed to the renderer
