## ADDED Requirements

### Requirement: Compact library first screen
The system SHALL omit the large promotional heading and description from the batch video library and SHALL prioritize the mode switch, connection state, source controls and video list.

#### Scenario: Desktop library opens
- **WHEN** a desktop user opens the batch video library
- **THEN** the source controls and first row of videos appear higher on the initial viewport than in the promotional-header layout

#### Scenario: Mobile library opens
- **WHEN** a mobile user opens the batch video library
- **THEN** no large repeated marketing copy pushes the source controls or videos below the first screen

### Requirement: Responsive compact controls
The system SHALL keep the content mode switch, login status and session actions readable and reachable at desktop and mobile widths.

#### Scenario: Wide viewport
- **WHEN** the viewport has sufficient width
- **THEN** mode switching and connection/session controls use a compact horizontal arrangement

#### Scenario: Narrow viewport
- **WHEN** the controls cannot fit horizontally
- **THEN** they wrap or stack without overlapping, clipping or reducing touch targets below 44 CSS pixels

### Requirement: Mobile-focused login panel
The system SHALL present the QR image, progress, same-device instructions and login actions in a viewport-safe panel.

#### Scenario: Mobile panel is open
- **WHEN** a user opens QR login on a narrow viewport
- **THEN** the panel fits within dynamic viewport and safe-area bounds while keeping its close and action buttons reachable

### Requirement: Deploy-safe client assets
The production deployment SHALL avoid stranding an already-open page on removed Next.js chunks.

#### Scenario: A deployment replaces the active frontend
- **WHEN** a browser still references chunk hashes from the immediately previous production build
- **THEN** those assets remain available during a bounded compatibility window

#### Scenario: A chunk is no longer available
- **WHEN** the browser receives a load error for a Next.js JavaScript or CSS asset
- **THEN** the client clears stale service-worker caches and performs at most one controlled reload

### Requirement: Bounded service-worker network failures
The service worker SHALL resolve failed fetch handling with a typed fallback response instead of leaving an unhandled rejected promise.

#### Scenario: A cached static asset is unavailable offline
- **WHEN** neither the cache nor the network can provide a requested static asset
- **THEN** the service worker returns a bounded `503` response and no uncaught `Failed to fetch` promise is emitted

#### Scenario: A navigation or API request fails
- **WHEN** a controlled navigation or API fetch cannot reach the network and has no cached response
- **THEN** the service worker returns an appropriate HTML or JSON offline response with status `503`

#### Scenario: Local development has a stale worker
- **WHEN** the application runs on localhost
- **THEN** existing service-worker registrations and their caches are removed so development requests are not intercepted by an old production worker
