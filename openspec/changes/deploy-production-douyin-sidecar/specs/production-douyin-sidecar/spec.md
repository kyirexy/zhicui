## ADDED Requirements

### Requirement: Production sidecar is private and metadata-only
The production environment SHALL run the Zhicui-patched Douyin companion as a systemd service bound only to loopback, persist its protected Cookie and bounded library metadata, and SHALL NOT persist video or audio files.

#### Scenario: Production service starts
- **WHEN** the server boots or the sidecar unit is restarted
- **THEN** `127.0.0.1:9000` serves the health API and the Zhicui backend can connect without exposing port 9000 through Nginx

#### Scenario: Sensitive and binary data placement
- **WHEN** the companion stores a login or a user plays/transcribes a video
- **THEN** Cookie values remain in an owner-only sidecar file, media is streamed ephemerally, and no video bytes remain in PostgreSQL or a persistent server directory

### Requirement: Collection scope is explicitly bounded
The deployment SHALL let the user choose 50 or 100 current items for a source and SHALL reject or normalize any request above 100 without downloading media.

#### Scenario: User synchronizes default collection
- **WHEN** the user selects 50 or 100 and starts collection synchronization
- **THEN** only that most-recent range is stored as metadata in Douyin order and no video file is created

### Requirement: Sidecar installation is reproducible
The repository SHALL contain a pinned-upstream patch, systemd unit, and installation script that can create a new sidecar release without destructively resetting the active source directory.

#### Scenario: Reinstall sidecar
- **WHEN** an operator runs the installation script again
- **THEN** a fresh patched release and reusable venv are prepared, production metadata-only config is enforced, old persistent media is purged, the `current` link is switched, and systemd is restarted while the protected Cookie remains intact
