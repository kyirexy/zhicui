## ADDED Requirements

### Requirement: Production sidecar is private and durable
The production environment SHALL run the Zhicui-patched Douyin companion as a systemd service bound only to loopback, and SHALL persist its configuration, Cookie file, manifest, collection order, covers, and media outside the Zhicui database.

#### Scenario: Production service starts
- **WHEN** the server boots or the sidecar unit is restarted
- **THEN** `127.0.0.1:9000` serves the health API and the Zhicui backend can connect without exposing port 9000 through Nginx

#### Scenario: Sensitive and binary data placement
- **WHEN** the companion stores a login or downloads media
- **THEN** Cookie values remain in an owner-only sidecar file and video bytes remain in the sidecar media directory rather than PostgreSQL

### Requirement: Local library is migrated completely
The deployment SHALL copy the current local `Downloaded/` library, manifest, and collection-order metadata to the production sidecar and SHALL verify the migration using file count, byte count, manifest count, and media access checks.

#### Scenario: Initial production library
- **WHEN** the first sidecar deployment completes
- **THEN** the production items API returns the same migrated item set and ordering metadata as the local companion

### Requirement: Sidecar installation is reproducible
The repository SHALL contain a pinned-upstream patch, systemd unit, and installation script that can create a new sidecar release without destructively resetting the active source directory.

#### Scenario: Reinstall sidecar
- **WHEN** an operator runs the installation script again
- **THEN** a fresh patched release and reusable venv are prepared, the `current` link is switched, and systemd is restarted while persistent Cookie and media directories remain intact
