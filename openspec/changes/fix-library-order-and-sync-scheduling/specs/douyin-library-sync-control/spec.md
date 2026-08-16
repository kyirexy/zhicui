## ADDED Requirements

### Requirement: Custom device-local automatic sync interval
The system SHALL allow an authenticated user to choose a preset automatic-sync interval or save a custom interval from 15 minutes through 7 days, and SHALL persist that interval only on the current device.

#### Scenario: User saves a custom interval
- **WHEN** the user enters a valid custom amount and chooses minutes, hours, or days
- **THEN** the scheduler stores the equivalent whole number of minutes and recalculates the next run

#### Scenario: User enters an out-of-range interval
- **WHEN** the calculated interval is below 15 minutes or above 7 days
- **THEN** the interface clamps or rejects the value and does not schedule outside the supported range

#### Scenario: User disables automatic synchronization
- **WHEN** the user selects the disabled preset
- **THEN** the next automatic run is cleared without preventing manual synchronization

### Requirement: Explicit source-interaction ordering
The system SHALL preserve independent source-order snapshots for likes and collections, SHALL refresh the relevant snapshot during source synchronization, and SHALL distinguish that ordering from video publish time.

#### Scenario: User synchronizes likes
- **WHEN** the user synchronizes the like source
- **THEN** the background job refreshes the like metadata and source ranks without downloading video files

#### Scenario: User synchronizes collections
- **WHEN** the user synchronizes the collection source
- **THEN** the background job refreshes the collection metadata and source ranks without changing the like snapshot

#### Scenario: User selects recent source order
- **WHEN** the user selects “最近喜欢” or “最近收藏”
- **THEN** the interface immediately returns items by ascending cached source rank without waiting for a remote request

#### Scenario: User selects publish time
- **WHEN** the user selects “发布时间”
- **THEN** the system returns items from newest to oldest video publish timestamp without refreshing source interaction order

### Requirement: Styled ordering menu
The collection interface SHALL present source-order choices in a theme-aware application menu rather than the operating system's native select popup.

#### Scenario: User opens the ordering menu
- **WHEN** the user activates the ordering control
- **THEN** the menu displays both ordering choices with their descriptions and marks the current choice

#### Scenario: User dismisses the menu
- **WHEN** the user presses Escape, clicks outside, or chooses an option
- **THEN** the menu closes and keyboard focus remains usable

### Requirement: Responsive isolated source loading
The system SHALL keep likes, collections, and posts isolated during navigation and SHALL avoid full-library reloads for intermediate synchronization progress.

#### Scenario: User switches sources before a previous request finishes
- **WHEN** an older source request completes after the user has selected another source
- **THEN** the system ignores the stale response and keeps the active source visible

#### Scenario: Synchronization reports progress
- **WHEN** a background synchronization job reports additional completed items
- **THEN** the interface updates the job counters without requesting and rendering the complete library again

#### Scenario: Synchronization finishes
- **WHEN** the source synchronization reaches a terminal state
- **THEN** the interface performs one refreshed library read for the active source

### Requirement: Metadata-first video synchronization
The system SHALL finish and present the requested video metadata snapshot before starting slower transcript preparation, and SHALL keep transcript preparation independent from source navigation.

#### Scenario: User synchronizes a video source
- **WHEN** the source metadata job succeeds
- **THEN** the interface reads and renders the complete requested snapshot before starting transcript preparation

#### Scenario: Transcript preparation continues in the background
- **WHEN** synchronized videos still need transcripts
- **THEN** the interface reports transcript progress separately while keeping source tabs, sorting, searching, and video browsing available

#### Scenario: User changes source during transcript preparation
- **WHEN** the user opens likes, collections, or posts while a transcript job is running
- **THEN** the active source changes immediately and the server-side transcript job continues without replacing the active list

### Requirement: Responsive on-demand media
The system SHALL render synchronized videos and gallery posts through on-demand media proxies without requiring persistent server media files.

#### Scenario: User opens a gallery post
- **WHEN** a synchronized item contains Douyin gallery images instead of video media
- **THEN** the detail workspace displays the available images with gallery navigation and does not report a missing playable file

#### Scenario: Browser requests multiple video ranges
- **WHEN** the browser requests additional byte ranges for the same video within the cache window
- **THEN** the sidecar reuses the resolved playback target instead of requesting the Douyin detail API for every range

#### Scenario: Library loads synchronized covers
- **WHEN** a cover URL exists in the synchronized metadata snapshot
- **THEN** the cover proxy uses that cached reference before attempting a fresh Douyin detail lookup
